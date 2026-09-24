"""Descargas contra Yahoo/Comafi/data912: historicos en lote (yf.download)
con reintentos, .info/insiders/holdings en paralelo, tipos de cambio, precio
de los CEDEAR (data912 primero, Yahoo .BA de respaldo) y ratios de
conversion CEDEAR."""

import json
import time
from concurrent.futures import ThreadPoolExecutor

import pandas as pd
import requests
import yfinance as yf

from comun import RAIZ

from .fundamentales import obtener_holdings_etf, resumen_insider


ARCHIVO_RATIOS_MANUAL = RAIZ / "data" / "ratios_cedear_manual.json"

# 5y (no cuesta requests extra, es el mismo history() con mas filas): hace
# falta para que semanal (SMA52 ~ 1 ano) y mensual (SMA36 ~ 3 anos) del
# screener tengan velas suficientes. 2y ya alcanzaba para SMA200/EMA150 diario.
PERIODO_HISTORICO = "5y"

# Descarga en lote (yf.download) en vez de un history() por ticker: la
# corrida pasa de ~10 min a unos pocos. Los simbolos que fallan se
# reintentan con espera creciente antes de darlos por perdidos.
TAM_LOTE_DESCARGA = 80
ESPERAS_REINTENTO = [5, 20]  # segundos antes de cada reintento
WORKERS_INFO = 4  # tk.info/insiders en paralelo (I/O); mas alto arriesga rate-limit


def _descargar_lote(simbolos, periodo, auto_adjust=True):
    """Un yf.download para varios simbolos. dict sym -> DataFrame diario
    (Open/High/Low/Close/Volume/Dividends/Stock Splits, indice sin tz);
    los simbolos sin datos simplemente no aparecen. Mismo ajuste que el
    history(auto_adjust=True) de antes."""
    if not simbolos:
        return {}
    try:
        df = yf.download(
            list(simbolos),
            period=periodo,
            interval="1d",
            group_by="ticker",
            auto_adjust=auto_adjust,
            actions=True,
            threads=True,
            progress=False,
        )
    except Exception as e:  # noqa: BLE001
        print(f"  ! yf.download fallo para un lote de {len(simbolos)}: {e}")
        return {}
    if df is None or df.empty:
        return {}
    if not isinstance(df.columns, pd.MultiIndex):
        df = pd.concat({simbolos[0]: df}, axis=1)
    presentes = set(df.columns.get_level_values(0))
    out = {}
    for sym in simbolos:
        if sym not in presentes:
            continue
        h = df[sym]
        if "Close" not in h.columns:
            continue
        # El indice es la union de fechas de todo el lote (NYSE + BYMA + B3):
        # se quedan solo las ruedas en las que ESTE simbolo opero.
        h = h[h["Close"].notna()].copy()
        if h.index.tz is not None:
            h.index = h.index.tz_localize(None)
        if len(h) >= 2:
            out[sym] = h
    return out


def descargar_historicos(simbolos, periodo=PERIODO_HISTORICO, esperas=ESPERAS_REINTENTO, auto_adjust=True):
    """Descarga en lotes y reintenta (con espera creciente) los simbolos que
    no trajeron datos: un 404/timeout puntual de Yahoo no alcanza para dar
    un ticker por perdido."""
    pendientes = list(dict.fromkeys(simbolos))
    resultado = {}
    for intento in range(len(esperas) + 1):
        if intento:
            espera = esperas[intento - 1]
            print(f"  reintento {intento}/{len(esperas)}: {len(pendientes)} simbolo(s) sin datos, espero {espera}s...")
            time.sleep(espera)
        for i in range(0, len(pendientes), TAM_LOTE_DESCARGA):
            resultado.update(_descargar_lote(pendientes[i : i + TAM_LOTE_DESCARGA], periodo, auto_adjust))
        pendientes = [s for s in pendientes if s not in resultado]
        if not pendientes:
            break
    return resultado


def pedir_info(sym):
    """.info + insiders + holdings (si es ETF) de un simbolo. Son los unicos
    requests por ticker que quedan (el historico ya vino en lote); se
    corren en paralelo con WORKERS_INFO hilos."""
    tk = yf.Ticker(sym)
    try:
        info = tk.info or {}
    except Exception:  # noqa: BLE001
        info = {}
    # Yahoo a veces devuelve un dict "vacio" con solo trailingPegRatio/símbolo.
    if not (info.get("shortName") or info.get("longName") or info.get("quoteType")):
        info = {}
    insider = resumen_insider(tk) if info else None
    holdings = obtener_holdings_etf(tk, info.get("quoteType")) if info else None
    return sym, info, insider, holdings


def obtener_fx(monedas, ccl):
    """dict moneda -> unidades por 1 USD. ARS usa el CCL implicito mediano
    de la corrida (lo que vale el dolar para un CEDEAR); el resto sale de
    los pares USD{M}=X de Yahoo (USDBRL=X, etc.). Monedas menores (GBp,
    ILA, ZAc) se pasan a la mayor dividiendo por 100."""
    fx = {"USD": 1.0}
    if ccl:
        fx["ARS"] = ccl
    # Case-sensitive a proposito: Yahoo usa "GBp" (peniques) y "GBP" (libras).
    menores = {"GBp": ("GBP", 100), "GBX": ("GBP", 100), "ILA": ("ILS", 100), "ZAc": ("ZAR", 100)}
    necesarias = set()
    for m in monedas:
        if not m or m in fx:
            continue
        mayor = menores.get(m, (str(m).upper(), 1))[0]
        if mayor not in fx and mayor != "ARS":
            necesarias.add(mayor)
    if necesarias:
        h = descargar_historicos([f"USD{m}=X" for m in sorted(necesarias)], periodo="5d", esperas=[5])
        for m in necesarias:
            serie = h.get(f"USD{m}=X")
            if serie is not None and len(serie["Close"].dropna()):
                fx[m] = float(serie["Close"].dropna().iloc[-1])
    for m in monedas:
        if m and m not in fx:
            mayor, factor = menores.get(m, (str(m).upper(), 1))
            if mayor in fx and factor != 1 and m != mayor:
                fx[m] = fx[mayor] * factor
    return fx


# URL del listado oficial de ratios de conversion CEDEAR de Banco Comafi
# (uno de los custodios que administra la mayoria de los programas; el ratio
# en si lo define la CNV, no Comafi). Es un Excel publico, se lee directo con
# pandas sin requests extra. Fila 7 en adelante son datos (filas 0-6 son
# titulo/encabezado de la planilla), columna 2 = ticker ("Codigo Caja de
# Valores", coincide con el simbolo yfinance sin sufijo), columna 7 = ratio
# como texto "N:1" o "N : 1" (N certificados CEDEAR = 1 accion).
URL_RATIOS_CEDEAR = "https://www.comafi.com.ar/custodiaglobal/Multimedios/otros/14779.xlsx"


def descargar_ratios_cedear():
    """dict {ticker: ratio_int}. Tolerante a fallos (red o cambio de formato
    de la planilla) — si algo falla, devuelve {} y el enriquecimiento de
    CEDEAR simplemente no se agrega esa corrida, no rompe el resto del
    pipeline."""
    try:
        df = pd.read_excel(URL_RATIOS_CEDEAR, header=None, skiprows=7)
        out = {}
        for _, fila in df.iterrows():
            ticker = str(fila.get(2, "")).strip().upper()
            # Casi siempre "N:1" o "N : 1", pero alguna fila de la planilla
            # trae "N.1" (typo de carga, visto en ORCL) — se acepta cualquiera
            # de los dos separadores para no perder esos casos.
            ratio_raw = str(fila.get(7, "")).strip()
            sep = ":" if ":" in ratio_raw else ("." if "." in ratio_raw else None)
            if not ticker or sep is None:
                continue
            try:
                n = int(ratio_raw.split(sep)[0].strip())
            except ValueError:
                continue
            out[ticker] = n
        return out
    except Exception as e:  # noqa: BLE001
        print(f"  ! No se pudo descargar ratios CEDEAR de Comafi: {e}")
        return {}


def cargar_ratios_cedear_manuales():
    """dict {ticker: ratio_int} de data/ratios_cedear_manual.json. Complementa
    el listado de Comafi, que cubre solo los programas de ese custodio (~357
    especies): CEDEARs de otros custodios y varios ETFs no figuran ahi. Las
    claves que empiezan con _ son comentarios del archivo y se ignoran.
    Tolerante a fallos, igual que la descarga de Comafi."""
    if not ARCHIVO_RATIOS_MANUAL.exists():
        return {}
    try:
        crudo = json.loads(ARCHIVO_RATIOS_MANUAL.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        print(f"  ! No se pudo leer {ARCHIVO_RATIOS_MANUAL.name}: {e}")
        return {}
    out = {}
    for k, v in crudo.items():
        if k.startswith("_"):
            continue
        try:
            n = int(v)
        except (TypeError, ValueError):
            print(f"  ! Ratio manual invalido para {k}: {v!r} (se ignora)")
            continue
        if n > 0:
            out[str(k).strip().upper()] = n
    return out


def combinar_ratios_cedear(automaticos, manuales):
    """Une ambas fuentes. Comafi gana: es la oficial y se re-descarga en cada
    corrida, asi que refleja cambios de ratio (splits) sin que haya que tocar
    el JSON. El manual solo rellena huecos; los conflictos se avisan por
    consola para poder limpiar la entrada manual que quedo vieja."""
    combinado = dict(manuales)
    for t, r in automaticos.items():
        if t in manuales and manuales[t] != r:
            print(f"  ! Ratio de {t}: manual {manuales[t]}:1 vs Comafi {r}:1 -> uso Comafi")
        combinado[t] = r
    return combinado


def obtener_precios_cedear(tickers_base):
    """dict ticker_base -> ultimo cierre de '{ticker}.BA', todo en UN
    yf.download de 5 dias (antes era un history() por ticker, con
    reintento, dentro del loop principal). Los que fallan se reintentan
    una vez con espera (casos reales: VRTX, USO, ANET fallaban de forma
    transitoria en corridas largas). Respaldo de obtener_precios_cedear_fuente
    cuando data912 no trae el ticker."""
    h = descargar_historicos([f"{t}.BA" for t in tickers_base], periodo="5d", esperas=[5])
    out = {}
    for t in tickers_base:
        serie = h.get(f"{t}.BA")
        if serie is not None:
            closes = serie["Close"].dropna()
            if len(closes):
                out[t] = float(closes.iloc[-1])
    return out


TIMEOUT_DATA912 = 10
URL_DATA912_CEDEARS = "https://data912.com/live/arg_cedears"
URL_DATA912_MEP = "https://data912.com/live/mep"


def _descargar_data912(url, timeout=TIMEOUT_DATA912):
    """GET generico a data912.com (API publica, sin key). Tolerante a
    cualquier fallo (red, timeout, JSON invalido, servicio caido): devuelve
    [] y esa fuente simplemente no se usa esta corrida, igual que
    descargar_ratios_cedear con la planilla de Comafi. La corrida NUNCA
    tiene que fallar por esto."""
    try:
        r = requests.get(url, timeout=timeout)
        r.raise_for_status()
        datos = r.json()
        return datos if isinstance(datos, list) else []
    except Exception as e:  # noqa: BLE001
        print(f"  ! No se pudo descargar {url} (data912): {type(e).__name__}: {e}")
        return []


def obtener_precios_cedear_data912(tickers_base):
    """dict ticker_base -> {"precio": ARS, "volumen": nominales} desde
    data912 (/live/arg_cedears, un solo GET, sin key). El campo 'symbol' de
    data912 ya es el ticker base (sin '.BA'), como 'ratios_cedear'. Filtra
    precio invalido (<=0, dato corrupto raro)."""
    filas = _descargar_data912(URL_DATA912_CEDEARS)
    quiere = set(tickers_base)
    out = {}
    for fila in filas:
        sym = str(fila.get("symbol") or "").strip().upper()
        precio = fila.get("c")
        if sym in quiere and isinstance(precio, (int, float)) and not isinstance(precio, bool) and precio > 0:
            vol = fila.get("v")
            out[sym] = {"precio": float(precio), "volumen": float(vol) if isinstance(vol, (int, float)) and vol > 0 else None}
    return out


def obtener_precios_cedear_combinado(tickers_base):
    """Precio de CEDEAR por ticker: data912 primero (fuente primaria, mas
    rapida y sin costo de request de yfinance), Yahoo (.BA) de respaldo para
    los que data912 no trae o vienen con precio invalido. dict ticker_base ->
    {"precio": ARS, "fuente": "data912"|"yahoo", "volumen": nominales|None}."""
    d912 = obtener_precios_cedear_data912(tickers_base)
    faltan = [t for t in tickers_base if t not in d912]
    yahoo = obtener_precios_cedear(faltan) if faltan else {}
    out = {}
    for t in tickers_base:
        if t in d912:
            out[t] = {"precio": d912[t]["precio"], "fuente": "data912", "volumen": d912[t]["volumen"]}
        elif t in yahoo:
            out[t] = {"precio": yahoo[t], "fuente": "yahoo", "volumen": None}
    print(
        f"  Precio de CEDEAR: {len(d912)} de data912, {len(yahoo)} de Yahoo (respaldo), "
        f"{len(tickers_base) - len(out)} sin dato en ninguna de las dos."
    )
    return out


def obtener_ccl_data912():
    """Mediana del CCL implicito de data912 (/live/mep, panel 'cedear': el
    CCL que surge de cada CEDEAR vs. su especie en USD) para cruzar contra
    la mediana implicita que ya calcula el pipeline (medias.json). None si
    data912 no responde o no trae ningun valor valido."""
    filas = _descargar_data912(URL_DATA912_MEP)
    valores = sorted(
        float(f["close"]) for f in filas
        if f.get("panel") == "cedear" and isinstance(f.get("close"), (int, float)) and f["close"] > 0
    )
    if not valores:
        return None
    n = len(valores)
    m = n // 2
    return valores[m] if n % 2 else (valores[m - 1] + valores[m]) / 2


def cargar_ratios_cedear():
    """Ratios CEDEAR de la corrida: Comafi + manuales (ver
    combinar_ratios_cedear)."""
    print("Descargando ratios de CEDEAR (Comafi)...")
    ratios_comafi = descargar_ratios_cedear()
    ratios_manuales = cargar_ratios_cedear_manuales()
    ratios_cedear = combinar_ratios_cedear(ratios_comafi, ratios_manuales)
    print(
        f"  {len(ratios_cedear)} ratios de CEDEAR cargados "
        f"({len(ratios_comafi)} de Comafi + {len(ratios_cedear) - len(ratios_comafi)} manuales)."
    )
    return ratios_cedear


def obtener_benchmark(resueltos):
    """Cierres de SPY (benchmark de beta/correlacion/RS). Si SPY esta en el
    universo se reusa (antes se bajaba dos veces)."""
    bench_closes = None
    for sym, h in resueltos.values():
        if sym == "SPY":
            bench_closes = h["Close"].dropna()
    if bench_closes is None:
        h = descargar_historicos(["SPY"]).get("SPY")
        bench_closes = h["Close"].dropna() if h is not None else None
    if bench_closes is None or bench_closes.empty:
        print("  ! No se pudo descargar SPY: beta/correlacion/RS van a quedar en None.")
    return bench_closes


def _pedir_seguro(sym):
    try:
        return pedir_info(sym)
    except Exception:  # noqa: BLE001
        return sym, {}, None, None


def pedir_infos(simbolos):
    """pedir_info de todos los simbolos con WORKERS_INFO hilos: dict sym ->
    (sym, info, insider, holdings). Un fallo deja info vacia (no corta)."""
    print(f"Pidiendo .info/insiders de {len(simbolos)} simbolos ({WORKERS_INFO} en paralelo)...")
    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=WORKERS_INFO) as pool:
        infos = {r[0]: r for r in pool.map(_pedir_seguro, simbolos)}
    print(f"  listo en {time.monotonic() - t0:.0f}s ({sum(1 for r in infos.values() if not r[1])} sin .info).")
    return infos


def candidatos_cedear(resueltos, ratios_cedear, excel, infos):
    """Tickers resueltos en su plaza de origen (USD) que tienen CEDEAR. Si
    "{t}.BA" es una fila propia del Excel (AGRO.BA = Agrometal, SEMI.BA =
    Molinos Semino), ese simbolo es una accion local, no el CEDEAR de t."""
    return [
        t for t, (sym, _) in resueltos.items()
        if not sym.endswith(".BA")
        and t in ratios_cedear
        and f"{t}.BA" not in excel
        and (infos[sym][1].get("currency") or "USD") == "USD"
    ]
