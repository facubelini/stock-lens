"""Record/replay de la red del pipeline (scripts/generar_datos.py) para el
test golden.

Grabar corre el pipeline REAL (yfinance + planilla de Comafi) y guarda cada
respuesta en una fixture comprimida; reproducir vuelve a correr el pipeline
sin red, con las respuestas grabadas y el reloj congelado en el instante de
la grabacion, y devuelve todos los archivos que escribio. Asi un refactor se
puede verificar byte a byte contra la salida anterior.

Lo que se intercepta (grep de lo que usa el pipeline):
  - yf.download(...)                        -> historicos en lote
  - yf.Ticker(sym).info / .insider_transactions / .funds_data.top_holdings
  - pd.read_excel("https://...")            -> ratios CEDEAR de Comafi
  - requests.get("https://...")             -> precio de CEDEAR y CCL de data912
Ademas se congelan en la fixture data/ratios_cedear_manual.json y
comparables_universo.INDUSTRIA_COMPARABLES (config que se edita a mano: si
cambia, no tiene que romper el golden).

Escenarios de la reproduccion (misma carpeta de salida/estado):
  esc1: corrida limpia (carpetas vacias) en el instante grabado.
  esc2: un dia despues, con la descarga de KO fallando -> ejercita el
        arrastre (stale), el historial de 2 dias y el cache de peers.

Uso:
    python tests/golden/grabacion.py grabar       # red real -> fixture + salida esperada
    python tests/golden/grabacion.py actualizar   # regenera SOLO la salida esperada (cambio de comportamiento a proposito)
    python tests/golden/grabacion.py grabar --universo excel --estado-inicial ... --fixture X --salida Y
"""

import argparse
import copy
import gzip
import json
import pickle
import shutil
import sys
import tempfile
import threading
import time
from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

RAIZ = Path(__file__).resolve().parents[2]
DIR_SCRIPTS = RAIZ / "scripts"
if str(DIR_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(DIR_SCRIPTS))

import requests  # noqa: E402
import yfinance as yf  # noqa: E402

DIR_FIXTURES = RAIZ / "tests" / "fixtures"
FIXTURE_RED = DIR_FIXTURES / "golden_red.pkl.gz"
FIXTURE_SALIDA = DIR_FIXTURES / "golden_salida.json.gz"
TZ_AR = ZoneInfo("America/Argentina/Buenos_Aires")

# Universo chico pero variado: acciones USA, ADRs con moneda contable
# distinta (KEP, TSM), CEDEAR/local BYMA (GGAL vs GGAL.BA, YPFD.BA), ETFs
# (SPY = benchmark, ESGU, SMH con holdings), ALUA y PETR4 (resuelven por
# sufijo .BA/.SA, PETR4 pide el FX USDBRL), AL30 (bono: basura por regla) y
# un simbolo inexistente (cache de invalidos + reintentos).
UNIVERSO_GOLDEN = [
    "NVDA", "AAPL", "MSFT", "KO", "GGAL", "GGAL.BA", "YPFD.BA", "KEP", "SPY", "ESGU",
    "TSM", "OKLO", "SMH", "HOG", "GLNG", "ABBV", "ALUA", "PETR4", "AL30", "ZZQXWV",
]
TICKER_FALLA_ESC2 = "KO"

VERSION_FIXTURE = 2  # +requests.get (data912)


# ---------------------------------------------------------------------------
# Codec de DataFrames: arrays numpy + listas (nada de pickles de pandas, asi
# la fixture no depende de la version exacta de pandas)
# ---------------------------------------------------------------------------
def _cod_indice(idx):
    if isinstance(idx, pd.MultiIndex):
        return {"t": "multi", "tuplas": list(idx), "names": list(idx.names)}
    if isinstance(idx, pd.DatetimeIndex):
        return {"t": "dt", "i8": np.asarray(idx.asi8).copy(), "unit": idx.unit,
                "tz": str(idx.tz) if idx.tz is not None else None, "name": idx.name}
    if isinstance(idx, pd.RangeIndex):
        return {"t": "rango", "start": idx.start, "stop": idx.stop, "step": idx.step, "name": idx.name}
    return {"t": "plano", "valores": idx.to_numpy(dtype=object).tolist(), "dtype": str(idx.dtype), "name": idx.name}


def _dec_indice(d):
    if d["t"] == "multi":
        return pd.MultiIndex.from_tuples(d["tuplas"], names=d["names"])
    if d["t"] == "dt":
        idx = pd.DatetimeIndex(pd.to_datetime(d["i8"], unit=d["unit"], utc=True)).as_unit(d["unit"])
        idx = idx.tz_convert(d["tz"]) if d["tz"] else idx.tz_localize(None)
        return idx.rename(d["name"])
    if d["t"] == "rango":
        return pd.RangeIndex(d["start"], d["stop"], d["step"], name=d["name"])
    idx = pd.Index(d["valores"], dtype=object, name=d["name"])
    return idx if d["dtype"] == "object" else idx.astype(d["dtype"])


def _cod_columna(s):
    dt = s.dtype
    if isinstance(dt, pd.DatetimeTZDtype):
        return {"k": "dtz", "i8": s.array.asi8.copy() if hasattr(s.array, "asi8") else s.astype("int64").to_numpy(),
                "unit": dt.unit, "tz": str(dt.tz), "nat": s.isna().to_numpy()}
    if isinstance(dt, np.dtype) and dt.kind in "biufcmM":
        return {"k": "np", "valores": s.to_numpy().copy()}
    return {"k": "obj", "valores": s.to_numpy(dtype=object).tolist(), "dtype": str(dt)}


def _dec_columna(d, index):
    if d["k"] == "np":
        return pd.Series(d["valores"].copy(), index=index)
    if d["k"] == "dtz":
        s = pd.Series(pd.to_datetime(d["i8"], unit=d["unit"], utc=True).as_unit(d["unit"]).tz_convert(d["tz"]), index=index)
        s[d["nat"]] = pd.NaT
        return s
    s = pd.Series(d["valores"], index=index, dtype=object)
    return s if d["dtype"] == "object" else s.astype(d["dtype"])


def codificar_df(df):
    return {
        "index": _cod_indice(df.index),
        "columns": _cod_indice(df.columns),
        "datos": [_cod_columna(df.iloc[:, i]) for i in range(df.shape[1])],
    }


def decodificar_df(d):
    index = _dec_indice(d["index"])
    columnas = _dec_indice(d["columns"])
    if not d["datos"]:
        return pd.DataFrame(index=index, columns=columnas)
    series = [_dec_columna(c, index) for c in d["datos"]]
    df = pd.concat(series, axis=1, ignore_index=True)
    df.columns = columnas
    return df


def codificar(valor):
    """Codifica un valor devuelto por yfinance/pandas. Verifica en el acto
    que el DataFrame decodificado sea identico al original (si no, la
    grabacion falla en vez de dejar una fixture que miente)."""
    if isinstance(valor, pd.DataFrame):
        cod = codificar_df(valor)
        pd.testing.assert_frame_equal(decodificar_df(cod), valor, check_exact=True, check_index_type="equiv",
                                      check_column_type="equiv", check_freq=False)
        return ("df", cod)
    return ("py", copy.deepcopy(valor))


def decodificar(cod):
    tipo, v = cod
    return decodificar_df(v) if tipo == "df" else copy.deepcopy(v)


def _clave_download(tickers, kw):
    simbolos = tuple(tickers) if isinstance(tickers, (list, tuple)) else (tickers,)
    return (simbolos, kw.get("period"), kw.get("interval"), kw.get("group_by"), kw.get("auto_adjust"), kw.get("actions"))


# ---------------------------------------------------------------------------
# Parches sobre los modulos del pipeline
# ---------------------------------------------------------------------------
def _modulos_pipeline():
    return [
        m for n, m in list(sys.modules.items())
        if m is not None and (n in ("generar_datos", "comun") or n == "pipeline" or n.startswith("pipeline."))
    ]


@contextmanager
def parche_atributo(obj, nombre, valor):
    viejo = getattr(obj, nombre)
    setattr(obj, nombre, valor)
    try:
        yield
    finally:
        setattr(obj, nombre, viejo)


@contextmanager
def parche_en_modulos(nombre, valor):
    """Pisa 'nombre' en TODOS los modulos del pipeline que lo tengan (la
    constante vive en generar_datos antes del refactor y en pipeline.* despues:
    asi el harness no depende de donde este definida)."""
    tocados = [(m, getattr(m, nombre)) for m in _modulos_pipeline() if hasattr(m, nombre)]
    if not tocados:
        raise RuntimeError(f"ningun modulo del pipeline define {nombre}")
    for m, _ in tocados:
        setattr(m, nombre, valor)
    try:
        yield
    finally:
        for m, v in tocados:
            setattr(m, nombre, v)


def _importar_pipeline():
    import generar_datos  # noqa: F401  (carga tambien pipeline.* si existe)
    return sys.modules["generar_datos"]


# ---------------------------------------------------------------------------
# Grabacion (red real)
# ---------------------------------------------------------------------------
class Grabadora:
    def __init__(self):
        self.lock = threading.Lock()
        self.download = {}
        self.ticker = {}
        self.excel = {}
        self.requests = {}

    def _guardar(self, dic, clave, valor):
        with self.lock:
            dic[clave] = valor

    @contextmanager
    def activa(self):
        real_download = yf.download
        real_ticker = yf.Ticker
        real_excel = pd.read_excel
        real_get = requests.get
        grab = self

        def get(url, *a, **kw):
            try:
                r = real_get(url, *a, **kw)
            except Exception as e:  # noqa: BLE001
                grab._guardar(grab.requests, url, ("error", f"{type(e).__name__}: {e}"))
                raise
            grab._guardar(grab.requests, url, ("ok", r.status_code, r.text))
            return r

        def download(tickers, *a, **kw):
            clave = _clave_download(tickers, kw)
            try:
                df = real_download(tickers, *a, **kw)
            except Exception as e:  # noqa: BLE001
                grab._guardar(grab.download, clave, ("error", f"{type(e).__name__}: {e}"))
                raise
            grab._guardar(grab.download, clave, ("ok", codificar(df) if df is not None else ("py", None)))
            return df

        class Fondos:
            def __init__(self, dueno):
                self._d = dueno

            @property
            def top_holdings(self):
                return self._d._grabar("funds_data.top_holdings", lambda: self._d._real.funds_data.top_holdings)

        class TickerGrabando:
            def __init__(self, sym, *a, **kw):
                self._sym = sym
                self._real = real_ticker(sym, *a, **kw)

            def _grabar(self, attr, fn):
                clave = (self._sym, attr)
                try:
                    v = fn()
                except Exception as e:  # noqa: BLE001
                    grab._guardar(grab.ticker, clave, ("error", f"{type(e).__name__}: {e}"))
                    raise
                grab._guardar(grab.ticker, clave, ("ok", codificar(v)))
                return v

            @property
            def info(self):
                return self._grabar("info", lambda: self._real.info)

            @property
            def insider_transactions(self):
                return self._grabar("insider_transactions", lambda: self._real.insider_transactions)

            @property
            def funds_data(self):
                return Fondos(self)

            def __getattr__(self, nombre):  # cualquier otra cosa: sin grabar (no la usa el pipeline)
                return getattr(self._real, nombre)

        def read_excel(io, *a, **kw):
            if isinstance(io, str) and io.startswith("http"):
                clave = (io, repr(a), repr(sorted(kw.items())))
                try:
                    df = real_excel(io, *a, **kw)
                except Exception as e:  # noqa: BLE001
                    grab._guardar(grab.excel, clave, ("error", f"{type(e).__name__}: {e}"))
                    raise
                grab._guardar(grab.excel, clave, ("ok", codificar(df)))
                return df
            return real_excel(io, *a, **kw)

        with ExitStack() as pila:
            pila.enter_context(parche_atributo(yf, "download", download))
            pila.enter_context(parche_atributo(yf, "Ticker", TickerGrabando))
            pila.enter_context(parche_atributo(pd, "read_excel", read_excel))
            pila.enter_context(parche_atributo(requests, "get", get))
            yield self


# ---------------------------------------------------------------------------
# Reproduccion (sin red)
# ---------------------------------------------------------------------------
class Reproductora:
    def __init__(self, red, falla=()):
        self.red = red
        self.falla = set(falla)  # simbolos cuya descarga "falla" (escenario de arrastre)
        self.faltantes = []

    @staticmethod
    def _devolver(entrada):
        estado, v = entrada
        if estado == "error":
            raise Exception(f"(grabado) {v}")  # noqa: TRY002
        return decodificar(v)

    @contextmanager
    def activa(self):
        rep = self

        def download(tickers, *a, **kw):
            clave = _clave_download(tickers, kw)
            if clave not in rep.red["download"]:
                # Lote que no se grabo tal cual (esc2: el universo cambia por
                # el cache de invalidos y los simbolos ya resueltos): se arma
                # con las columnas de cada simbolo de los lotes grabados.
                rep.faltantes.append(("download", clave))
                df = rep._componer(clave)
            else:
                df = rep._devolver(rep.red["download"][clave])
            if df is not None and rep.falla and isinstance(df.columns, pd.MultiIndex):
                df = df.loc[:, [c for c in df.columns if c[0] not in rep.falla]]
            return df

        class Fondos:
            def __init__(self, sym):
                self._sym = sym

            @property
            def top_holdings(self):
                return rep._ticker(self._sym, "funds_data.top_holdings")

        class TickerFalso:
            def __init__(self, sym, *a, **kw):
                self._sym = sym

            @property
            def info(self):
                return rep._ticker(self._sym, "info")

            @property
            def insider_transactions(self):
                return rep._ticker(self._sym, "insider_transactions")

            @property
            def funds_data(self):
                return Fondos(self._sym)

        real_excel = pd.read_excel

        def read_excel(io, *a, **kw):
            if isinstance(io, str) and io.startswith("http"):
                clave = (io, repr(a), repr(sorted(kw.items())))
                if clave not in rep.red["excel"]:
                    rep.faltantes.append(("excel", clave))
                    raise Exception("(sin grabar) " + io)  # noqa: TRY002
                return rep._devolver(rep.red["excel"][clave])
            return real_excel(io, *a, **kw)

        class _RespuestaFalsa:
            def __init__(self, status_code, texto):
                self.status_code = status_code
                self.text = texto

            def json(self):
                return json.loads(self.text)

            def raise_for_status(self):
                if self.status_code >= 400:
                    raise requests.HTTPError(f"{self.status_code} error falso (grabado)")

        def get(url, *a, **kw):
            entrada = rep.red.get("requests", {}).get(url)
            if entrada is None:
                rep.faltantes.append(("requests", url))
                raise Exception("(sin grabar) GET " + url)  # noqa: TRY002
            if entrada[0] == "error":
                raise Exception(f"(grabado) {entrada[1]}")  # noqa: TRY002
            _, status_code, texto = entrada
            return _RespuestaFalsa(status_code, texto)

        with ExitStack() as pila:
            pila.enter_context(parche_atributo(yf, "download", download))
            pila.enter_context(parche_atributo(yf, "Ticker", TickerFalso))
            pila.enter_context(parche_atributo(pd, "read_excel", read_excel))
            pila.enter_context(parche_atributo(requests, "get", get))
            pila.enter_context(parche_atributo(time, "sleep", lambda *_a, **_k: None))
            yield self

    def _componer(self, clave):
        simbolos, params = clave[0], clave[1:]
        if not hasattr(self, "_por_simbolo"):
            self._por_simbolo = {}
            for (syms, *p), entrada in self.red["download"].items():
                if entrada[0] != "ok":
                    continue
                df = decodificar(entrada[1])
                if df is None or df.empty or not isinstance(df.columns, pd.MultiIndex):
                    continue
                for s in syms:
                    if s in df.columns.get_level_values(0):
                        sub = df[s]
                        sub = sub[sub.notna().any(axis=1)]
                        if len(sub):
                            self._por_simbolo.setdefault((s, tuple(p)), sub)
        partes = {s: self._por_simbolo[(s, params)] for s in simbolos if (s, params) in self._por_simbolo}
        if not partes:
            return pd.DataFrame()
        return pd.concat(partes, axis=1, names=["Ticker", "Price"], sort=True)

    def _ticker(self, sym, attr):
        clave = (sym, attr)
        if clave not in self.red["ticker"]:
            self.faltantes.append(("ticker", clave))
            raise Exception(f"(sin grabar) {sym}.{attr}")  # noqa: TRY002
        return self._devolver(self.red["ticker"][clave])


# ---------------------------------------------------------------------------
# Corridas
# ---------------------------------------------------------------------------
def _argv(universo, out, estado):
    argv = ["--out", str(out), "--estado", str(estado)]
    if universo:
        argv += ["--tickers", ",".join(universo)]
    return argv


def instantanea(*carpetas_con_prefijo):
    """{ruta_relativa: texto} de todos los .json de las carpetas (el estado
    inicial copiado puede traer el Excel u otros binarios)."""
    out = {}
    for prefijo, carpeta in carpetas_con_prefijo:
        for f in sorted(Path(carpeta).rglob("*.json")):
            if f.is_file():
                out[f"{prefijo}/{f.relative_to(carpeta).as_posix()}"] = f.read_bytes().decode("utf-8")
    return out


@contextmanager
def config_congelada(red, tmp):
    """Pisa la config editable a mano con la copia de la fixture."""
    ruta_manual = Path(tmp) / "ratios_cedear_manual.json"
    ruta_manual.write_text(red["ratios_manual"], encoding="utf-8")
    with ExitStack() as pila:
        pila.enter_context(parche_en_modulos("ARCHIVO_RATIOS_MANUAL", ruta_manual))
        pila.enter_context(parche_en_modulos("INDUSTRIA_COMPARABLES", copy.deepcopy(red["industria_comparables"])))
        yield


def _preparar_estado(dest, estado_inicial):
    out, est = Path(dest) / "out", Path(dest) / "estado"
    for d in (out, est):
        if d.exists():
            shutil.rmtree(d)
    if estado_inicial:
        shutil.copytree(Path(estado_inicial) / "out", out)
        shutil.copytree(Path(estado_inicial) / "estado", est)
    out.mkdir(parents=True, exist_ok=True)
    est.mkdir(parents=True, exist_ok=True)
    return out, est


def reproducir(red, dest, escenarios=("esc1", "esc2"), estado_inicial=None):
    """Corre el pipeline offline. Devuelve (instantanea, faltantes por escenario)."""
    import time_machine

    gd = _importar_pipeline()
    t0 = datetime.fromisoformat(red["ahora"]).astimezone(TZ_AR)
    universo = red["universo"]
    dest = Path(dest)
    out, est = _preparar_estado(dest, estado_inicial)
    salida, faltantes = {}, {}
    with config_congelada(red, dest):
        for esc in escenarios:
            instante = t0 if esc == "esc1" else t0 + timedelta(days=1)
            falla = () if esc == "esc1" else (TICKER_FALLA_ESC2,)
            rep = Reproductora(red, falla=falla)
            with rep.activa(), time_machine.travel(instante, tick=False):
                gd.main(_argv(universo, out, est))
            faltantes[esc] = rep.faltantes
            salida.update(instantanea((f"{esc}/out", out), (f"{esc}/estado", est)))
    return salida, faltantes


def grabar(universo, estado_inicial=None, dest=None):
    """Corre el pipeline con red real grabando todo. Devuelve (red, salida de la corrida en vivo)."""
    gd = _importar_pipeline()
    comparables_universo = sys.modules["comparables_universo"]
    manual = next(m.ARCHIVO_RATIOS_MANUAL for m in _modulos_pipeline() if hasattr(m, "ARCHIVO_RATIOS_MANUAL"))
    dest = Path(dest or tempfile.mkdtemp(prefix="golden-grabar-"))
    out, est = _preparar_estado(dest, estado_inicial)
    ahora = datetime.now(timezone.utc).replace(microsecond=0)
    g = Grabadora()
    with g.activa():
        gd.main(_argv(universo, out, est))
    red = {
        "version": VERSION_FIXTURE,
        "ahora": ahora.isoformat(),
        "universo": universo,
        "download": g.download,
        "ticker": g.ticker,
        "excel": g.excel,
        "requests": g.requests,
        "ratios_manual": Path(manual).read_text(encoding="utf-8"),
        "industria_comparables": copy.deepcopy(comparables_universo.INDUSTRIA_COMPARABLES),
    }
    return red, instantanea(("esc1/out", out), ("esc1/estado", est))


def guardar_red(red, ruta):
    ruta = Path(ruta)
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(ruta, "wb", compresslevel=9) as f:
        pickle.dump(red, f, protocol=4)


def cargar_red(ruta=FIXTURE_RED):
    with gzip.open(ruta, "rb") as f:
        red = pickle.load(f)
    if red.get("version") != VERSION_FIXTURE:
        raise RuntimeError(f"fixture version {red.get('version')} != {VERSION_FIXTURE}")
    return red


def guardar_salida(salida, ruta):
    ruta = Path(ruta)
    ruta.parent.mkdir(parents=True, exist_ok=True)
    texto = json.dumps(salida, ensure_ascii=False, sort_keys=True, indent=0)
    with gzip.GzipFile(ruta, "wb", compresslevel=9, mtime=0) as f:
        f.write(texto.encode("utf-8"))


def cargar_salida(ruta=FIXTURE_SALIDA):
    with gzip.open(ruta, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def diferencias(esperado, obtenido, max_detalle=5):
    """Lista legible de archivos distintos/faltantes/sobrantes."""
    msgs = []
    for k in sorted(set(esperado) | set(obtenido)):
        a, b = esperado.get(k), obtenido.get(k)
        if a == b:
            continue
        if a is None:
            msgs.append(f"SOBRA  {k}")
        elif b is None:
            msgs.append(f"FALTA  {k}")
        else:
            i = next((j for j in range(min(len(a), len(b))) if a[j] != b[j]), min(len(a), len(b)))
            msgs.append(f"DIFIERE {k} (byte {i}): esperado ...{a[max(0, i - 60):i + 60]!r}... "
                        f"obtenido ...{b[max(0, i - 60):i + 60]!r}...")
    if len(msgs) > max_detalle:
        msgs = msgs[:max_detalle] + [f"... y {len(msgs) - max_detalle} mas"]
    return msgs


# Campos que dependen del reloj de pared de la corrida en vivo (la
# reproduccion congela el reloj en el instante de inicio de la grabacion).
CLAVES_RELOJ = {"ultima_actualizacion", "actualizado", "pre_actualizado", "post_actualizado"}


def _sin_reloj(obj):
    if isinstance(obj, dict):
        return {k: _sin_reloj(v) for k, v in obj.items() if k not in CLAVES_RELOJ}
    if isinstance(obj, list):
        return [_sin_reloj(v) for v in obj]
    return obj


def comparar_sin_reloj(vivo, reproducido):
    """Fidelidad de la grabacion: la salida en vivo y la reproducida (esc1)
    tienen que coincidir salvo los timestamps."""
    distintos = []
    for k in sorted(set(vivo) | {x for x in reproducido if x.startswith("esc1/")}):
        a, b = vivo.get(k), reproducido.get(k)
        if a is None or b is None:
            distintos.append(k)
        elif a != b and _sin_reloj(json.loads(a)) != _sin_reloj(json.loads(b)):
            distintos.append(k)
    return distintos


def _main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("accion", choices=["grabar", "actualizar", "reproducir"])
    ap.add_argument("--universo", default="golden", help="'golden' (UNIVERSO_GOLDEN) o 'excel' (data/tickers.xlsx)")
    ap.add_argument("--estado-inicial", type=Path, help="carpeta con out/ y estado/ de arranque (copia de public/data y data)")
    ap.add_argument("--fixture", type=Path, default=FIXTURE_RED)
    ap.add_argument("--salida", type=Path, default=FIXTURE_SALIDA)
    ap.add_argument("--dest", type=Path, help="carpeta de trabajo (default: temporal)")
    ap.add_argument("--escenarios", default="esc1,esc2")
    args = ap.parse_args()
    universo = UNIVERSO_GOLDEN if args.universo == "golden" else None
    escenarios = tuple(args.escenarios.split(","))
    dest = args.dest or Path(tempfile.mkdtemp(prefix="golden-"))

    if args.accion == "grabar":
        red, vivo = grabar(universo, args.estado_inicial, dest / "vivo")
        guardar_red(red, args.fixture)
        print(f"\nFixture: {args.fixture} ({args.fixture.stat().st_size / 1e6:.2f} MB)")
        salida, faltantes = reproducir(red, dest / "rep", escenarios, args.estado_inicial)
        distintos = comparar_sin_reloj(vivo, salida)
        print(f"Fidelidad vivo vs reproducido (sin timestamps): {len(distintos)} archivo(s) distintos {distintos[:10]}")
    else:
        red = cargar_red(args.fixture)
        salida, faltantes = reproducir(red, dest / "rep", escenarios, args.estado_inicial)
    print(f"Faltantes en la reproduccion: { {k: len(v) for k, v in faltantes.items()} }")
    if args.accion in ("grabar", "actualizar"):
        guardar_salida(salida, args.salida)
        print(f"Salida esperada: {args.salida} ({len(salida)} archivos, {args.salida.stat().st_size / 1e6:.2f} MB)")
    else:
        esperado = cargar_salida(args.salida)
        msgs = diferencias(esperado, salida)
        print("IDENTICO" if not msgs else "\n".join(msgs))
        sys.exit(1 if msgs else 0)


if __name__ == "__main__":
    _main()
