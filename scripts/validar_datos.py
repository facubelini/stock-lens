"""Contrato de datos de public/data: se corre en los workflows DESPUES de
generar los JSON y ANTES de commitearlos, asi un dato roto nunca llega a
Pages (el frontend no valida: un NaN o un campo faltante rompe la pagina).

Reglas:
  - Todos los .json (recursivo) parsean como JSON estricto: sin NaN/Infinity.
  - Forma de primer nivel y campos obligatorios por archivo (listado,
    medias, fundamentales, screener, scanner_setups, comparables,
    warren_score, senales, meta; y si existen mercado_macro,
    historico_fundamental, fundamental/indice.json, oportunidades_historial,
    backtest_*).
  - Rangos: rsi 0-100, total_score 0-100, pts de cada pilar entre 0 y su
    max, dividend_yield 0-25, market_cap(_usd) >= 0, veredictos/estados
    dentro de los valores conocidos. |var_pct| > 60 es solo un AVISO (no
    bloquea el commit: un movimiento real de 60%+ existe, ej. splits o
    noticias fuertes, y no hay que perderlo).
  - historial/<TICKER>.json y mensual/<TICKER>.json para cada ticker del
    listado.
  - meta coherente con listado (n_tickers, n_frescos) y n_frescos sin caer
    mas de 30% contra el meta.json anterior (por defecto el de
    `git show HEAD:<carpeta>/meta.json`).
Sale con codigo 1 y la lista de errores si algo no cumple.

Uso:
    python scripts/validar_datos.py [public/data]
    python scripts/validar_datos.py public/data --solo backtest_screener,backtest_score
    python scripts/validar_datos.py public/data --solo fundamental
    python scripts/validar_datos.py /tmp/sl --meta-previo /tmp/meta_vieja.json   (o --sin-previo)
"""

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent

# Caida maxima de n_frescos contra la corrida anterior (el pipeline ya aborta
# solo por debajo del 50% de los intentados; esto agarra una caida grande
# que igual pase ese umbral).
MAX_CAIDA_FRESCOS = 0.30
RANGO_VAR_PCT = 60.0
DIVIDEND_YIELD_MAX = 25.0  # mismo tope que pipeline/fundamentales.py
MAX_PILARES = {"tendencia": 20, "fuerza": 25, "contraccion": 35, "gatillo": 20}
VEREDICTOS = {"COMPRA", "CERCA", "VENTA", "EXTENDIDO", "NEUTRAL"}
STATUS_SCANNER = {"SETUP_LONG", "NEAR_SETUP", "OK", "NO_DATA"}
STATUS_GLOBAL = {"BUY_BOTH", "BUY_CORTO", "BUY_LARGO", "NEAR_BOTH", "NEAR_CORTO", "NEAR_LARGO", "OK"}
ESTADOS_VCP = {
    "Armado", "Formándose", "Recién rompió", "Rompió y confirmó", "Rompió sin confirmar", "Rompió y falló",
    "Falló antes de romper",
}

BASE_TICKER = ["ticker", "nombre", "industria", "pais", "stale"]
CAMPOS = {
    "listado": BASE_TICKER + ["var_pct", "rsi", "spark", "high_52w", "low_52w", "vol_hoy", "vol_prom20", "vol_ratio",
                              "vol_fecha", "gap_pct"],
    "medias": BASE_TICKER + ["precio", "dist_ema21", "dist_ema50", "dist_ema150", "dist_sma200", "cedear_ticker",
                             "cedear_precio", "cedear_ratio", "cedear_ccl_implicito"],
    "fundamentales": BASE_TICKER + ["per_trailing", "per_forward", "peg", "ev_sales", "pb", "ps", "market_cap",
                                    "market_cap_usd", "moneda", "dividend_yield", "beta", "sector", "upside_pct"],
    "screener": BASE_TICKER + ["diario", "semanal", "mensual"],
    "scanner_setups": BASE_TICKER + ["corto", "largo", "status_global"],
    "warren": ["ticker", "nombre", "total_score", "datos_suficientes"],
    "meta": ["ultima_actualizacion", "n_tickers", "n_frescos", "n_intentados", "tickers_invalidos", "tickers_descartados"],
    "backtest": ["actualizado", "horizontes_dias", "n_tickers_evaluados", "stats"],
}
ARCHIVOS_DATOS = ["listado", "medias", "fundamentales", "screener", "scanner_setups", "comparables", "warren_score",
                  "senales", "meta"]
ARCHIVOS_OPCIONALES = ["mercado_macro", "historico_fundamental", "fundamental", "oportunidades_historial",
                       "backtest_screener", "backtest_score"]


def _es_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _constante_invalida(c):
    raise ValueError(f"constante no JSON: {c}")


class Validador:
    def __init__(self, carpeta):
        self.carpeta = Path(carpeta)
        self.errores = []
        self.avisos = []
        self.datos = {}
        self._parseados = {}

    # --- helpers ---
    def error(self, msg):
        self.errores.append(msg)

    def aviso(self, msg):
        self.avisos.append(msg)

    def cargar(self, nombre, obligatorio=True):
        ruta = self.carpeta / f"{nombre}.json"
        if not ruta.exists():
            if obligatorio:
                self.error(f"{nombre}.json: falta el archivo")
            return None
        if nombre not in self.datos:
            self.datos[nombre] = self._parsear(ruta)
        return self.datos[nombre]

    def _parsear(self, ruta):
        """JSON estricto (sin NaN/Infinity); cada archivo se lee una sola vez."""
        ruta = Path(ruta)
        if ruta not in self._parseados:
            try:
                self._parseados[ruta] = json.loads(ruta.read_text(encoding="utf-8"), parse_constant=_constante_invalida)
            except (ValueError, UnicodeDecodeError) as e:
                self.error(f"{ruta.relative_to(self.carpeta).as_posix()}: JSON invalido ({e})")
                self._parseados[ruta] = None
        return self._parseados[ruta]

    def rango(self, donde, campo, v, lo, hi, nulo_ok=True):
        if v is None:
            if not nulo_ok:
                self.error(f"{donde}.{campo} es null")
            return
        if not _es_num(v) or math.isnan(v) or not (lo <= v <= hi):
            self.error(f"{donde}.{campo} = {v!r} fuera de rango [{lo}, {hi}]")

    def en(self, donde, campo, v, validos, nulo_ok=False):
        if v is None and nulo_ok:
            return
        if v not in validos:
            self.error(f"{donde}.{campo} = {v!r} no es uno de {sorted(validos)}")

    def rango_aviso(self, donde, campo, v, lo, hi):
        """Como .rango() pero un valor fuera de rango es solo un AVISO (no
        bloquea el commit): para reglas donde un valor real y correcto puede
        legitimamente estar fuera del rango "normal" (ej. |var_pct| > 60 en
        un split/noticia fuerte de verdad)."""
        if v is None:
            return
        if not _es_num(v) or math.isnan(v):
            self.error(f"{donde}.{campo} = {v!r} no es un numero valido")
            return
        if not (lo <= v <= hi):
            self.aviso(f"{donde}.{campo} = {v!r} fuera del rango habitual [{lo}, {hi}] (revisar, no bloquea)")

    def lista_de_filas(self, nombre, lista, campos, donde=None):
        """Chequea que sea lista de dicts con los campos obligatorios y
        tickers unicos. Devuelve [(donde, fila)] para seguir validando."""
        donde = donde or f"{nombre}.json"
        if not isinstance(lista, list):
            self.error(f"{donde}: se esperaba una lista, vino {type(lista).__name__}")
            return []
        if not lista:
            self.error(f"{donde}: lista vacia")
        salida, vistos = [], set()
        for i, f in enumerate(lista):
            etiqueta = f"{donde}[{i}]"
            if not isinstance(f, dict):
                self.error(f"{etiqueta}: se esperaba un objeto")
                continue
            etiqueta = f"{donde}[{i}] ({f.get('ticker', '?')})"
            faltan = [c for c in campos if c not in f]
            if faltan:
                self.error(f"{etiqueta}: faltan campos {faltan}")
            t = f.get("ticker")
            if "ticker" in campos:
                if not isinstance(t, str) or not t:
                    self.error(f"{etiqueta}: ticker invalido {t!r}")
                elif t in vistos:
                    self.error(f"{etiqueta}: ticker duplicado")
                vistos.add(t)
            if f.get("stale") and not f.get("actualizado"):
                self.error(f"{etiqueta}: fila stale sin 'actualizado'")
            salida.append((etiqueta, f))
        return salida

    # --- 1. todo parsea, sin NaN ---
    def json_estrictos(self):
        for ruta in sorted(self.carpeta.rglob("*.json")):
            rel = ruta.relative_to(self.carpeta).as_posix()
            if "/" not in rel:
                self.datos.setdefault(ruta.stem, self._parsear(ruta))
            else:
                self._parsear(ruta)

    # --- 2. por archivo ---
    def listado(self):
        d = self.cargar("listado")
        if d is None:
            return
        if not isinstance(d, dict) or not isinstance(d.get("acciones"), list):
            self.error("listado.json: se esperaba {acciones: [...], promedios_por_industria: [...]}")
            return
        for donde, f in self.lista_de_filas("listado", d["acciones"], CAMPOS["listado"], "listado.json acciones"):
            self.rango(donde, "rsi", f.get("rsi"), 0, 100)
            self.rango_aviso(donde, "var_pct", f.get("var_pct"), -RANGO_VAR_PCT, RANGO_VAR_PCT)
            for c in ("high_52w", "low_52w", "vol_hoy", "vol_prom20", "vol_ratio"):
                self.rango(donde, c, f.get(c), 0, math.inf)
            if not isinstance(f.get("spark"), list) or any(x is not None and not _es_num(x) for x in f.get("spark") or []):
                self.error(f"{donde}.spark: se esperaba una lista de numeros")
        promedios = d.get("promedios_por_industria")
        if not isinstance(promedios, list):
            self.error("listado.json: falta promedios_por_industria (lista)")
        else:
            for i, p in enumerate(promedios):
                donde = f"listado.json promedios_por_industria[{i}]"
                if not isinstance(p, dict) or "industria" not in p:
                    self.error(f"{donde}: se esperaba {{industria, rsi_promedio, var_pct_promedio, n}}")
                    continue
                self.rango(donde, "rsi_promedio", p.get("rsi_promedio"), 0, 100)

    def medias(self):
        d = self.cargar("medias")
        for donde, f in self.lista_de_filas("medias", d, CAMPOS["medias"]) if d is not None else []:
            self.rango(donde, "precio", f.get("precio"), 0, math.inf)
            self.rango(donde, "cedear_ccl_implicito", f.get("cedear_ccl_implicito"), 0, math.inf)

    def fundamentales(self):
        d = self.cargar("fundamentales")
        for donde, f in self.lista_de_filas("fundamentales", d, CAMPOS["fundamentales"]) if d is not None else []:
            self.rango(donde, "dividend_yield", f.get("dividend_yield"), 0, DIVIDEND_YIELD_MAX)
            self.rango(donde, "market_cap", f.get("market_cap"), 0, math.inf)
            self.rango(donde, "market_cap_usd", f.get("market_cap_usd"), 0, math.inf)
            if f.get("moneda") is not None and not isinstance(f.get("moneda"), str):
                self.error(f"{donde}.moneda = {f.get('moneda')!r} no es texto")

    def screener(self):
        d = self.cargar("screener")
        for donde, f in self.lista_de_filas("screener", d, CAMPOS["screener"]) if d is not None else []:
            for tf in ("diario", "semanal", "mensual"):
                v = f.get(tf)
                if v is None:
                    continue
                if not isinstance(v, dict):
                    self.error(f"{donde}.{tf}: se esperaba objeto o null")
                    continue
                self.en(f"{donde}.{tf}", "verdict", v.get("verdict"), VEREDICTOS)
                self.rango(f"{donde}.{tf}", "rsi", v.get("rsi"), 0, 100)

    def scanner_setups(self):
        d = self.cargar("scanner_setups")
        for donde, f in self.lista_de_filas("scanner_setups", d, CAMPOS["scanner_setups"]) if d is not None else []:
            for perfil in ("corto", "largo"):
                v = f.get(perfil)
                if not isinstance(v, dict):
                    self.error(f"{donde}.{perfil}: se esperaba un objeto")
                    continue
                self.en(f"{donde}.{perfil}", "status", v.get("status"), STATUS_SCANNER)
                self.rango(f"{donde}.{perfil}", "rsi", v.get("rsi"), 0, 100)
            self.en(donde, "status_global", f.get("status_global"), STATUS_GLOBAL)

    def comparables(self):
        d = self.cargar("comparables")
        if d is None:
            return
        if not isinstance(d, list):
            self.error("comparables.json: se esperaba una lista de industrias")
            return
        for i, g in enumerate(d):
            donde = f"comparables.json[{i}] ({g.get('industria', '?') if isinstance(g, dict) else '?'})"
            if not isinstance(g, dict) or not {"industria", "pares", "mediana"} <= set(g):
                self.error(f"{donde}: se esperaba {{industria, pares, mediana}}")
                continue
            if not isinstance(g["mediana"], dict):
                self.error(f"{donde}.mediana: se esperaba un objeto")
            for dd, p in self.lista_de_filas("comparables", g["pares"], ["ticker", "en_portfolio"], f"{donde}.pares"):
                self.rango(dd, "dividend_yield", p.get("dividend_yield"), 0, DIVIDEND_YIELD_MAX)
                self.rango(dd, "market_cap_usd", p.get("market_cap_usd"), 0, math.inf)

    def warren_score(self):
        d = self.cargar("warren_score")
        if d is None:
            return
        if not isinstance(d, dict) or "actualizado" not in d:
            self.error("warren_score.json: se esperaba {actualizado, tickers: [...]}")
            return
        filas = self.lista_de_filas("warren_score", d.get("tickers"), CAMPOS["warren"], "warren_score.json tickers")
        for donde, f in filas:
            self.rango(donde, "total_score", f.get("total_score"), 0, 100)
            if f.get("datos_suficientes") != (f.get("total_score") is not None):
                self.error(f"{donde}: datos_suficientes no coincide con total_score")
            for nombre, p in (f.get("pilares") or {}).items():
                if p is None:
                    continue
                maximo = MAX_PILARES.get(nombre)
                if maximo is None:
                    self.error(f"{donde}.pilares: pilar desconocido {nombre!r}")
                    continue
                if p.get("max") != maximo:
                    self.error(f"{donde}.pilares.{nombre}.max = {p.get('max')!r} (esperado {maximo})")
                self.rango(f"{donde}.pilares.{nombre}", "pts", p.get("pts"), 0, maximo, nulo_ok=False)
            if f.get("total_score") is not None:
                self.rango(donde, "rank", f.get("rank"), 1, f.get("total") or 0, nulo_ok=False)

    def senales(self):
        d = self.cargar("senales")
        if d is None:
            return
        if not isinstance(d, dict) or not {"actualizado", "ema200", "vcp", "rsi_semanal"} <= set(d):
            self.error("senales.json: se esperaba {actualizado, ema200, vcp, rsi_semanal}")
            return
        for tf in ("diario", "semanal"):
            for tipo in ("rebote", "cruce"):
                lista = (d["ema200"].get(tf) or {}).get(tipo) if isinstance(d["ema200"], dict) else None
                if not isinstance(lista, list):
                    self.error(f"senales.json ema200.{tf}.{tipo}: se esperaba una lista")
                    continue
                for i, x in enumerate(lista):
                    for c in ("rs_hoy", "rs_contacto"):
                        self.rango(f"senales.json ema200.{tf}.{tipo}[{i}] ({x.get('ticker')})", c, x.get(c), 0, 100)
        for i, x in enumerate(d["vcp"] if isinstance(d["vcp"], list) else []):
            donde = f"senales.json vcp[{i}] ({x.get('ticker')})"
            self.en(donde, "estado", x.get("estado"), ESTADOS_VCP)
            self.rango(donde, "score", x.get("score"), 0, 100)
        rsi = d["rsi_semanal"]
        for tipo in ("alcista", "bajista"):
            lista = rsi.get(tipo) if isinstance(rsi, dict) else None
            if not isinstance(lista, list):
                self.error(f"senales.json rsi_semanal.{tipo}: se esperaba una lista")
                continue
            for i, x in enumerate(lista):
                donde = f"senales.json rsi_semanal.{tipo}[{i}] ({x.get('ticker')})"
                self.rango(donde, "rsi", x.get("rsi"), 0, 100)
                self.rango(donde, "sma14", x.get("sma14"), 0, 100)

    def meta(self, meta_previo):
        m = self.cargar("meta")
        if m is None:
            return
        if not isinstance(m, dict):
            self.error("meta.json: se esperaba un objeto")
            return
        faltan = [c for c in CAMPOS["meta"] if c not in m]
        if faltan:
            self.error(f"meta.json: faltan campos {faltan}")
            return
        acciones = (self.datos.get("listado") or {}).get("acciones") if isinstance(self.datos.get("listado"), dict) else None
        if isinstance(acciones, list):
            frescos = sum(1 for f in acciones if isinstance(f, dict) and not f.get("stale"))
            if m["n_tickers"] != len(acciones):
                self.error(f"meta.json n_tickers = {m['n_tickers']} pero listado tiene {len(acciones)} filas")
            if m["n_frescos"] != frescos:
                self.error(f"meta.json n_frescos = {m['n_frescos']} pero listado tiene {frescos} filas no-stale")
        if _es_num(m["n_frescos"]) and _es_num(m["n_intentados"]) and m["n_frescos"] > m["n_intentados"]:
            self.error(f"meta.json n_frescos ({m['n_frescos']}) > n_intentados ({m['n_intentados']})")
        prev = (meta_previo or {}).get("n_frescos")
        if _es_num(prev) and prev > 0 and _es_num(m["n_frescos"]):
            if m["n_frescos"] < prev * (1 - MAX_CAIDA_FRESCOS):
                self.error(
                    f"meta.json n_frescos cayo de {prev} a {m['n_frescos']} "
                    f"(> {MAX_CAIDA_FRESCOS:.0%} menos que la corrida anterior: posible rate-limit/Yahoo caido)"
                )

    def mercado_macro(self):
        d = self.cargar("mercado_macro", obligatorio=False)
        if d is None:
            return
        if not isinstance(d, dict) or not isinstance(d.get("actualizado"), str):
            self.error("mercado_macro.json: se esperaba un objeto con 'actualizado'")
            return
        for k, v in d.items():
            if k != "actualizado" and v is not None and not isinstance(v, dict):
                self.error(f"mercado_macro.json {k}: se esperaba un objeto o null")
        vix = (d.get("vix") or {}).get("valor")
        self.rango("mercado_macro.json vix", "valor", vix, 0, 200)
        for k in ("fear_greed_cripto", "fear_greed_acciones"):
            self.rango(f"mercado_macro.json {k}", "valor", (d.get(k) or {}).get("valor"), 0, 100)

    def historico_fundamental(self):
        # Formato en reescritura: solo se exige un objeto (y, si trae
        # 'tickers', que sea una lista de objetos con 'ticker').
        d = self.cargar("historico_fundamental", obligatorio=False)
        if d is None:
            return
        if not isinstance(d, dict):
            self.error("historico_fundamental.json: se esperaba un objeto")
            return
        if "tickers" in d:
            if not isinstance(d["tickers"], list) or any(not isinstance(t, dict) or "ticker" not in t for t in d["tickers"]):
                self.error("historico_fundamental.json tickers: se esperaba una lista de objetos con 'ticker'")

    def fundamental(self, obligatorio=False):
        # Layout nuevo del historico fundamental: fundamental/<TICKER>.json +
        # indice.json. Los .json ya pasaron por el parseo estricto; aca solo
        # la forma del indice.
        carpeta = self.carpeta / "fundamental"
        if not carpeta.is_dir():
            if obligatorio:
                self.error("fundamental/: falta la carpeta")
            return
        indice = self._parsear(carpeta / "indice.json") if (carpeta / "indice.json").exists() else None
        if indice is None:
            self.error("fundamental/indice.json: falta o no parsea")
            return
        if (not isinstance(indice, dict) or not isinstance(indice.get("actualizado"), str)
                or not isinstance(indice.get("tickers"), list)
                or any(not isinstance(t, dict) or "ticker" not in t for t in indice["tickers"])):
            self.error("fundamental/indice.json: se esperaba {actualizado, tickers: [{ticker, ...}]}")

    def oportunidades_historial(self):
        d = self.cargar("oportunidades_historial", obligatorio=False)
        if d is None:
            return
        if not isinstance(d, list) or any(
            not isinstance(h, dict) or not isinstance(h.get("fecha"), str) or not isinstance(h.get("tickers"), list)
            for h in d
        ):
            self.error("oportunidades_historial.json: se esperaba [{fecha, tickers: [...]}]")

    def backtest(self, nombre):
        d = self.cargar(nombre, obligatorio=False)
        if d is None:
            return
        if not isinstance(d, dict):
            self.error(f"{nombre}.json: se esperaba un objeto")
            return
        faltan = [c for c in CAMPOS["backtest"] if c not in d]
        if faltan:
            self.error(f"{nombre}.json: faltan campos {faltan}")
            return
        if not isinstance(d["stats"], dict) or "BASELINE" not in d["stats"]:
            self.error(f"{nombre}.json stats: falta BASELINE")
            return
        horizontes = d["horizontes_dias"]
        for grupo, por_h in d["stats"].items():
            for h, st in (por_h or {}).items():
                donde = f"{nombre}.json stats.{grupo}.{h}"
                if not isinstance(st, dict):
                    self.error(f"{donde}: se esperaba un objeto")
                    continue
                self.rango(donde, "n", st.get("n"), 0, math.inf)
                self.rango(donde, "hit_rate", st.get("hit_rate"), 0, 100)
        if not isinstance(horizontes, list) or not all(isinstance(h, int) for h in horizontes):
            self.error(f"{nombre}.json horizontes_dias: se esperaba una lista de enteros")

    # --- 3. archivos por ticker ---
    def por_ticker(self):
        d = self.datos.get("listado")
        acciones = d.get("acciones") if isinstance(d, dict) else None
        if not isinstance(acciones, list):
            return
        vigentes = {f.get("ticker") for f in acciones if isinstance(f, dict)}
        for sub, campos in (("historial", ("fecha",)), ("mensual", ("fecha", "cierre"))):
            carpeta = self.carpeta / sub
            existentes = {p.stem for p in carpeta.glob("*.json")} if carpeta.exists() else set()
            faltan = sorted(t for t in vigentes if t not in existentes)
            if faltan:
                self.error(f"{sub}/: falta el archivo de {len(faltan)} ticker(s) del listado: {faltan[:10]}")
            huerfanos = sorted(existentes - vigentes)
            if huerfanos:
                self.aviso(f"{sub}/: {len(huerfanos)} archivo(s) de tickers que ya no estan en el listado: {huerfanos[:10]}")
            for t in sorted(vigentes & existentes):
                serie = self._parsear(carpeta / f"{t}.json")
                if serie is None:
                    continue
                if not isinstance(serie, list) or any(not isinstance(x, dict) or not all(c in x for c in campos) for x in serie):
                    self.error(f"{sub}/{t}.json: se esperaba una lista de {{{', '.join(campos)}}}")

    def coherencia_tickers(self):
        listado = self.datos.get("listado")
        base = {f.get("ticker") for f in (listado or {}).get("acciones", [])} if isinstance(listado, dict) else None
        if not base:
            return
        for nombre in ("medias", "fundamentales", "screener", "scanner_setups"):
            d = self.datos.get(nombre)
            if isinstance(d, list):
                otros = {f.get("ticker") for f in d if isinstance(f, dict)}
                if otros != base:
                    self.aviso(f"{nombre}.json: tickers distintos del listado "
                               f"(sobran {sorted(otros - base)[:5]}, faltan {sorted(base - otros)[:5]})")


def meta_de_git(carpeta):
    """meta.json de la corrida anterior, para comparar n_frescos. Desde la
    migracion a la rama huerfana `datos` (ver README, seccion "Rama de
    datos"), public/data/ ya NO vive en main: se busca primero en
    origin/datos (lo que trajo el workflow con "git archive origin/datos"
    antes de correr los scripts) y en refs/heads/datos (dev local con
    `npm run datos`); HEAD queda como ultimo fallback por si se corre esto
    en un checkout viejo, sin la rama datos."""
    try:
        raiz = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=carpeta, capture_output=True,
                                   text=True, check=True).stdout.strip())
        rel = (Path(carpeta).resolve() / "meta.json").relative_to(raiz.resolve()).as_posix()
        for ref in ("refs/remotes/origin/datos", "refs/heads/datos", "HEAD"):
            existe = subprocess.run(["git", "cat-file", "-e", f"{ref}"], cwd=raiz, capture_output=True)
            if existe.returncode != 0:
                continue
            r = subprocess.run(["git", "show", f"{ref}:{rel}"], cwd=raiz, capture_output=True, text=True, encoding="utf-8")
            if r.returncode == 0:
                return json.loads(r.stdout)
        return None
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None


def validar(carpeta, solo=None, meta_previo=None):
    """Corre las reglas y devuelve el Validador (con .errores / .avisos)."""
    v = Validador(carpeta)
    if not v.carpeta.is_dir():
        v.error(f"{carpeta}: no existe la carpeta")
        return v
    v.json_estrictos()
    reglas = {
        "listado": v.listado, "medias": v.medias, "fundamentales": v.fundamentales, "screener": v.screener,
        "scanner_setups": v.scanner_setups, "comparables": v.comparables, "warren_score": v.warren_score,
        "senales": v.senales, "meta": lambda: v.meta(meta_previo), "mercado_macro": v.mercado_macro,
        "historico_fundamental": v.historico_fundamental, "oportunidades_historial": v.oportunidades_historial,
        "fundamental": lambda: v.fundamental(obligatorio=bool(solo)),
        "backtest_screener": lambda: v.backtest("backtest_screener"), "backtest_score": lambda: v.backtest("backtest_score"),
    }
    elegidos = solo or (ARCHIVOS_DATOS + ARCHIVOS_OPCIONALES)
    desconocidos = [n for n in elegidos if n not in reglas]
    if desconocidos:
        v.error(f"--solo: archivo(s) sin reglas {desconocidos}")
    for nombre in ARCHIVOS_DATOS + ARCHIVOS_OPCIONALES:
        if nombre in elegidos:
            if solo and nombre in ARCHIVOS_OPCIONALES and nombre != "fundamental":
                v.cargar(nombre)  # pedido explicitamente: tiene que existir
            reglas[nombre]()
    if not solo or "listado" in solo:
        v.por_ticker()
        v.coherencia_tickers()
    return v


def main(argv=None):
    ap = argparse.ArgumentParser(description="Valida el contrato de los JSON de public/data antes de commitearlos.")
    ap.add_argument("carpeta", nargs="?", type=Path, default=RAIZ / "public" / "data")
    ap.add_argument("--solo", help="valida solo estos archivos (sin .json, separados por coma)")
    ap.add_argument("--meta-previo", type=Path, help="meta.json de la corrida anterior (default: git show HEAD)")
    ap.add_argument("--sin-previo", action="store_true", help="no compara n_frescos contra la corrida anterior")
    args = ap.parse_args(argv)

    solo = [s.strip() for s in args.solo.split(",") if s.strip()] if args.solo else None
    if args.sin_previo:
        previo = None
    elif args.meta_previo:
        previo = json.loads(args.meta_previo.read_text(encoding="utf-8"))
    else:
        previo = meta_de_git(args.carpeta)
    v = validar(args.carpeta, solo, previo)

    for a in v.avisos:
        print(f"::warning::{a}")
    if v.errores:
        for e in v.errores[:200]:
            print(f"::error::{e}")
        if len(v.errores) > 200:
            print(f"::error::... y {len(v.errores) - 200} error(es) mas")
        print(f"\nValidacion de {args.carpeta}: {len(v.errores)} error(es). No commitear estos datos.")
        return 1
    alcance = ", ".join(solo) if solo else "todos los archivos"
    previo_txt = f"n_frescos previo {previo.get('n_frescos')}" if previo else "sin meta previo"
    print(f"Validacion de {args.carpeta} OK ({alcance}; {len(v.avisos)} aviso(s); {previo_txt}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
