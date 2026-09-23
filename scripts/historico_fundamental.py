"""Historico de ratios fundamentales (P/E, EV/Sales, P/S) "LTM" (trailing
twelve months) para hasta 20 tickers elegidos a mano, usando datos oficiales
de SEC EDGAR (XBRL) combinados con el historico de precio de yfinance.

Por que EDGAR y no yfinance para esto: yfinance solo expone unos pocos
trimestres de estados financieros (~1-2 anios). EDGAR tiene el historial XBRL
completo que la empresa haya presentado (10+ anios para la mayoria de las
grandes). Limitacion inherente: solo cubre empresas que reportan a la SEC
(listadas en EEUU o ADRs con 10-K/10-Q) — acciones que cotizan *solo* en
Merval (sin ADR) no van a tener datos aca.

No se calculan versiones "NTM" (forward): eso requeriria estimaciones de
analistas historicas, que no existen gratis. Tampoco se calcula PEG: es un
derivado de PER + crecimiento, y sumarle mas aproximaciones lo hace poco
confiable comparado con los otros tres ratios.

Sin look-ahead: cada dato contable se usa recien desde la fecha en que se
PRESENTO (`filed` del 10-Q/10-K), no desde el cierre del trimestre (`end`):
el P/E de una semana solo usa balances que el mercado ya conocia esa semana.
Por la misma razon se toma, para cada trimestre, el valor tal como se
presento originalmente (el primer `filed`), no la re-expresion posterior.
Splits: los precios son los de cierre sin ajuste por dividendos
(auto_adjust=False; el Close de Yahoo ya viene ajustado por splits) y EPS/
acciones se llevan a la base de acciones actual con tk.splits.

Uso:
    python scripts/historico_fundamental.py [--out CARPETA]
"""

import argparse
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, date
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import yfinance as yf

from comun import DIR_DATOS_PUBLICOS, RAIZ, TZ, escribir_json, leer_json

ARCHIVO_TICKERS = RAIZ / "data" / "historico_tickers.json"
CACHE_CIK = RAIZ / "data" / "cik_cache.json"

LIMITE_TICKERS = 20
PERIODO_PRECIO = "5y"
WORKERS = 5  # tickers en paralelo (I/O-bound: la espera de red es el costo, no CPU)

# La SEC exige identificarse (nombre + email) o devuelve 403. Ver
# https://www.sec.gov/os/webmaster-faq#developers
SEC_HEADERS = {"User-Agent": "Stock Lens (facundo.belini@raona.com)"}
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SEC_CONCEPT_URL = "https://data.sec.gov/api/xbrl/companyconcept/CIK{cik:010d}/{taxonomia}/{tag}.json"


class LimitadorTasa:
    """Limita la tasa de requests a data.sec.gov entre TODOS los threads (la
    SEC permite ~10 req/s). Antes se pedia companyfacts (1 request pesado,
    con TODO el historial de la empresa); ahora se pide companyconcept por
    tag (varios requests livianos) en paralelo entre tickers, asi que hace
    falta un limitador compartido en vez de un simple time.sleep() por ticker."""

    def __init__(self, req_por_seg):
        self.intervalo = 1.0 / req_por_seg
        self.lock = threading.Lock()
        self.ultimo = 0.0

    def esperar(self):
        with self.lock:
            ahora = time.monotonic()
            espera = self.ultimo + self.intervalo - ahora
            if espera > 0:
                time.sleep(espera)
            self.ultimo = time.monotonic()


LIMITADOR_SEC = LimitadorTasa(8)  # margen bajo el limite real de la SEC

# Tags XBRL candidatos por concepto (se prueba el primero que exista). Varian
# segun la empresa/taxonomia usada al presentar el reporte.
TAGS_EPS = ["EarningsPerShareDiluted", "EarningsPerShareBasic"]
TAGS_REVENUE = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
]
# EntityCommonStockSharesOutstanding es de la portada del reporte: vive en
# la taxonomia "dei", no en "us-gaap" (antes se pedia en us-gaap y daba 404
# siempre, asi que ese fallback nunca funcionaba).
TAGS_SHARES = ["CommonStockSharesOutstanding", ("dei", "EntityCommonStockSharesOutstanding")]
TAGS_CASH = [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
]
TAGS_DEUDA_LARGO = ["LongTermDebtNoncurrent", "LongTermDebt"]
TAGS_DEUDA_CORTO = ["LongTermDebtCurrent", "DebtCurrent"]
TAGS_NET_INCOME = ["NetIncomeLoss", "ProfitLoss"]

DIAS_TRIMESTRE = (75, 100)
DIAS_ANUAL = (350, 380)


def leer_tickers_historico():
    if not ARCHIVO_TICKERS.exists():
        return []
    try:
        tickers = leer_json(ARCHIVO_TICKERS, [])
    except Exception:  # noqa: BLE001
        return []
    if not isinstance(tickers, list):
        return []
    return [str(t).strip().upper() for t in tickers if str(t).strip()][:LIMITE_TICKERS]


def _mapa_ticker_a_cik():
    r = requests.get(SEC_TICKERS_URL, headers=SEC_HEADERS, timeout=20)
    r.raise_for_status()
    data = r.json()
    return {v["ticker"].upper(): int(v["cik_str"]) for v in data.values()}


def _sin_sufijo(ticker):
    """EDGAR solo conoce el ticker "pelado" de EEUU: sacamos sufijos .BA/.SA
    que usamos internamente para CEDEARs/acciones de Brasil-Argentina."""
    return ticker.split(".")[0]


def _cargar_cache_cik():
    return leer_json(CACHE_CIK, {}) or {}


def _guardar_cache_cik(cache):
    escribir_json(CACHE_CIK, cache)


def resolver_ciks(tickers):
    """company_tickers.json pesa ~800KB — cacheamos ticker->CIK localmente
    (casi no cambia) para no volver a bajarlo en cada corrida semanal, solo
    cuando aparece un ticker nuevo que todavia no esta en el cache."""
    cache = _cargar_cache_cik()
    simbolos = [_sin_sufijo(t) for t in tickers]
    faltantes = [s for s in simbolos if s not in cache]
    if faltantes:
        print(f"CIK nuevos a resolver: {faltantes}")
        mapa_completo = _mapa_ticker_a_cik()
        for s in faltantes:
            if s in mapa_completo:
                cache[s] = mapa_completo[s]
        _guardar_cache_cik(cache)
    else:
        print("Todos los tickers ya tenian CIK en cache (no hizo falta bajar company_tickers.json).")
    return cache


def _obtener_companyconcept(cik, tag, taxonomia="us-gaap"):
    """Un solo concepto XBRL (ej. solo EPS), no el companyfacts completo de
    la empresa (que trae cientos de conceptos que no usamos — para AAPL son
    varios MB). Mucho mas liviano por request, a costa de mas requests (uno
    por tag candidato) — compensado con el limitador de tasa compartido."""
    LIMITADOR_SEC.esperar()
    url = SEC_CONCEPT_URL.format(cik=cik, tag=tag, taxonomia=taxonomia)
    r = requests.get(url, headers=SEC_HEADERS, timeout=20)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def _concepto_combinado(cik, tags):
    """Combina TODOS los tags candidatos que existan (no solo el primero):
    varias empresas cambian de tag XBRL en algun anio (ej. NVDA reporto
    ventas como "RevenueFromContractWithCustomerExcludingAssessedTax" hasta
    2022 y despues paso a "Revenues") — quedarse con uno solo corta el
    historico a la mitad. El dedup por fecha en _serie_instantanea/
    _trimestres_reportados ya resuelve solapamientos entre tags. Devuelve
    (concepto_combinado_o_None, nombre_de_la_entidad_o_None)."""
    unidades_combinadas = {}
    nombre = None
    for tag in tags:
        taxonomia, tag = tag if isinstance(tag, tuple) else ("us-gaap", tag)
        concepto = _obtener_companyconcept(cik, tag, taxonomia)
        if not concepto:
            continue
        nombre = nombre or concepto.get("entityName")
        for unidad, entradas in concepto.get("units", {}).items():
            unidades_combinadas.setdefault(unidad, []).extend(entradas)
    if not unidades_combinadas:
        return None, nombre
    return {"units": unidades_combinadas}, nombre


def _entradas(concepto, unidad_preferida):
    if not concepto:
        return []
    unidades = concepto.get("units", {})
    return unidades.get(unidad_preferida) or next(iter(unidades.values()), [])


def _primera_presentacion(entradas, filtro):
    """Para cada fecha de corte (`end`) se queda con la PRIMERA presentacion
    (menor `filed`): es el dato tal como lo conocio el mercado ese dia. Las
    re-expresiones posteriores (comparativos del año siguiente) aparecen
    con un `filed` un año mas tarde y, si se usaran, correrian el dato hacia
    adelante o meterian informacion que en esa fecha no existia."""
    por_fecha = {}
    for e in entradas:
        if not filtro(e) or not e.get("filed"):
            continue
        fin = e["end"]
        anterior = por_fecha.get(fin)
        if anterior is None or e["filed"] < anterior["filed"]:
            por_fecha[fin] = e
    return por_fecha


def _factor_splits(splits):
    """Devuelve f(fecha_iso) = producto de los splits POSTERIORES a esa fecha
    (cuantas acciones de hoy equivale una acción de ese momento). EPS
    presentado en esa fecha / f = EPS en base de acciones actual."""
    if splits is None or len(splits) == 0:
        return lambda _f: 1.0
    s = splits[splits > 0]
    fechas = [pd.Timestamp(d).tz_localize(None) if pd.Timestamp(d).tzinfo else pd.Timestamp(d) for d in s.index]
    ratios = list(s.values)

    def f(fecha_iso):
        d = pd.Timestamp(fecha_iso)
        factor = 1.0
        for fs, r in zip(fechas, ratios):
            if fs > d:
                factor *= float(r)
        return factor

    return f


def _serie_instantanea(concepto, unidad_preferida="USD", ajuste=None):
    """Conceptos de balance (foto a una fecha): shares/cash/deuda. Devuelve
    lista de (fecha_presentacion, valor), un punto por fecha de corte
    (primera presentacion). 'ajuste(valor, filed)' lleva el valor a la base
    de acciones actual (solo para shares)."""
    por_fecha = _primera_presentacion(_entradas(concepto, unidad_preferida), lambda e: "start" not in e)
    puntos = []
    for fin, e in sorted(por_fecha.items()):
        val = ajuste(e["val"], e["filed"]) if ajuste else e["val"]
        puntos.append((e["filed"], fin, val))
    return _por_presentacion(puntos)


def _por_presentacion(puntos):
    """puntos: [(filed, end, valor)]. Ordena por fecha de presentacion y
    descarta los que llegan despues pero son de un corte MAS VIEJO que el
    ya publicado (no deben pisar un dato mas nuevo)."""
    salida, ultimo_fin = [], ""
    for filed, fin, val in sorted(puntos):
        if fin < ultimo_fin:
            continue
        ultimo_fin = fin
        salida.append((filed, val))
    return salida


def _duracion(e):
    return (date.fromisoformat(e["end"]) - date.fromisoformat(e["start"])).days


def _trimestres_reportados(concepto, unidad_preferida="USD", ajuste=None):
    """Valores de UN trimestre (duracion ~90 dias) reportados directamente
    (Q1/Q2/Q3 de los 10-Q). dict fecha_fin -> (valor, filed)."""
    por_fecha = _primera_presentacion(
        _entradas(concepto, unidad_preferida),
        lambda e: "start" in e and DIAS_TRIMESTRE[0] <= _duracion(e) <= DIAS_TRIMESTRE[1],
    )
    return {
        k: ((ajuste(v["val"], v["filed"]) if ajuste else v["val"]), v["filed"]) for k, v in por_fecha.items()
    }


def _anuales_reportados(concepto, unidad_preferida="USD", ajuste=None):
    """Valores de un anio fiscal completo (10-K, ~365 dias). dict fecha_fin
    -> (fecha_inicio, valor, filed)."""
    por_fecha = _primera_presentacion(
        _entradas(concepto, unidad_preferida),
        lambda e: "start" in e and DIAS_ANUAL[0] <= _duracion(e) <= DIAS_ANUAL[1],
    )
    return {
        k: (v["start"], (ajuste(v["val"], v["filed"]) if ajuste else v["val"]), v["filed"])
        for k, v in por_fecha.items()
    }


def _completar_cuarto_trimestre(trimestres, anuales):
    """Muchas empresas no presentan un 10-Q para el 4to trimestre (queda
    "adentro" del 10-K anual). Lo reconstruye como anual - (T1+T2+T3) cuando
    esos 3 trimestres del mismo anio fiscal ya estan disponibles; se conoce
    recien cuando se presenta el 10-K."""
    trimestres = dict(trimestres)
    fines_trim = sorted(trimestres.keys())
    for fin_anual, (inicio_anual, valor_anual, filed_anual) in anuales.items():
        if fin_anual in trimestres:
            continue
        del_anio = [f for f in fines_trim if inicio_anual < f < fin_anual]
        if len(del_anio) != 3:
            continue
        suma = sum(trimestres[f][0] for f in del_anio)
        filed = max([filed_anual] + [trimestres[f][1] for f in del_anio])
        trimestres[fin_anual] = (valor_anual - suma, filed)
    return trimestres


def _serie_ttm(concepto, unidad_preferida="USD", ajuste=None):
    """TTM (suma de los ultimos 4 trimestres). Cada punto queda fechado en
    la presentacion del ULTIMO de los 4 trimestres que lo componen (antes
    del cual ese TTM no se podia calcular). Solo emite un punto cuando hay 4
    trimestres consecutivos sin huecos grandes."""
    trims = _trimestres_reportados(concepto, unidad_preferida, ajuste)
    anuales = _anuales_reportados(concepto, unidad_preferida, ajuste)
    trims = _completar_cuarto_trimestre(trims, anuales)
    fechas = sorted(trims.keys())

    puntos = []
    for i in range(3, len(fechas)):
        ult4 = fechas[i - 3 : i + 1]
        primero, ultimo = date.fromisoformat(ult4[0]), date.fromisoformat(ult4[-1])
        if not (250 <= (ultimo - primero).days <= 420):
            continue
        filed = max(trims[f][1] for f in ult4)
        puntos.append((filed, ult4[-1], sum(trims[f][0] for f in ult4)))
    return _por_presentacion(puntos)


def _forward_fill_a_fechas(serie, fechas_objetivo):
    """serie: lista de (fecha_presentacion_iso, valor). Devuelve una Serie
    alineada a `fechas_objetivo` con el ultimo valor YA PRESENTADO a esa
    fecha (o NaN si todavia no habia dato)."""
    if not serie:
        return pd.Series(np.nan, index=fechas_objetivo)
    s = pd.Series(
        [v for _, v in serie],
        index=pd.to_datetime([f for f, _ in serie]),
    )
    s = s[~s.index.duplicated(keep="last")].sort_index()
    return s.reindex(s.index.union(fechas_objetivo)).ffill().reindex(fechas_objetivo)


def calcular_historico_ticker(ticker, cik):
    if not cik:
        return {"ticker": ticker, "disponible": False, "motivo": "No reporta a la SEC (sin CIK)."}

    eps_concepto, nombre_a = _concepto_combinado(cik, TAGS_EPS)
    rev_concepto, nombre_b = _concepto_combinado(cik, TAGS_REVENUE)
    shares_concepto, nombre_c = _concepto_combinado(cik, TAGS_SHARES)
    cash_concepto, _ = _concepto_combinado(cik, TAGS_CASH)
    dlp_concepto, _ = _concepto_combinado(cik, TAGS_DEUDA_LARGO)
    dcp_concepto, _ = _concepto_combinado(cik, TAGS_DEUDA_CORTO)
    ni_concepto, _ = _concepto_combinado(cik, TAGS_NET_INCOME)
    nombre = nombre_a or nombre_b or nombre_c or ticker

    tk = yf.Ticker(ticker)
    # auto_adjust=False: Close ajustado solo por splits (no por dividendos),
    # que es el precio real de mercado en base de acciones actual.
    hist = tk.history(period=PERIODO_PRECIO, interval="1d", auto_adjust=False)
    if hist is None or hist.empty:
        return {"ticker": ticker, "disponible": False, "motivo": "Sin historial de precio (yfinance)."}
    if hist.index.tz is not None:
        hist = hist.copy()
        hist.index = hist.index.tz_localize(None)  # simplifica: fechas EDGAR ya son naive
    try:
        splits = tk.splits
    except Exception:  # noqa: BLE001
        splits = hist["Stock Splits"] if "Stock Splits" in hist.columns else None
    factor = _factor_splits(splits)

    def ajuste_por_accion(val, filed):
        return val / factor(filed)

    def ajuste_acciones(val, filed):
        return val * factor(filed)

    eps_ttm = _serie_ttm(eps_concepto, "USD/shares", ajuste_por_accion)
    rev_ttm = _serie_ttm(rev_concepto, "USD")
    ni_ttm = _serie_ttm(ni_concepto, "USD")
    shares = _serie_instantanea(shares_concepto, "shares", ajuste_acciones)
    cash = _serie_instantanea(cash_concepto, "USD")
    deuda_lp = _serie_instantanea(dlp_concepto, "USD")
    deuda_cp = _serie_instantanea(dcp_concepto, "USD")

    if not eps_ttm and not rev_ttm:
        return {"ticker": ticker, "disponible": False, "motivo": "Sin EPS/ventas trimestrales en EDGAR."}

    # Downsample semanal (viernes) para que el JSON no sea gigante.
    fechas = pd.date_range(hist.index.min(), hist.index.max(), freq="W-FRI")
    precio = hist["Close"].reindex(hist.index.union(fechas)).ffill().reindex(fechas)

    eps_serie = _forward_fill_a_fechas(eps_ttm, fechas)
    rev_serie = _forward_fill_a_fechas(rev_ttm, fechas)
    ni_serie = _forward_fill_a_fechas(ni_ttm, fechas)
    shares_serie = _forward_fill_a_fechas(shares, fechas)
    cash_serie = _forward_fill_a_fechas(cash, fechas)
    dlp_serie = _forward_fill_a_fechas(deuda_lp, fechas)
    dcp_serie = _forward_fill_a_fechas(deuda_cp, fechas)
    deuda_total = dlp_serie.fillna(0) + dcp_serie.fillna(0)

    market_cap = precio * shares_serie
    ev = market_cap + deuda_total - cash_serie.fillna(0)

    per_ltm = precio / eps_serie.where(eps_serie > 0)
    ev_sales_ltm = ev / rev_serie.where(rev_serie > 0)
    ps_ltm = market_cap / rev_serie.where(rev_serie > 0)
    margen_neto_ttm = (ni_serie / rev_serie.where(rev_serie > 0)) * 100
    # Guardarail: bancos/fintechs (ej. SOFI) taggean su "Revenues" en XBRL como
    # solo la parte de ingresos por comisiones (ASC 606), sin el ingreso por
    # intereses que es la mayor parte de su negocio — el denominador queda
    # incompleto y el margen calculado se dispara a valores que ninguna
    # empresa real sostiene (ni las mas rentables del mundo superan ~55-60%
    # de margen neto). Se oculta en vez de mostrar un numero que se sabe esta
    # mal por una limitacion de los tags, no por el negocio en si.
    margen_neto_ttm = margen_neto_ttm.where((margen_neto_ttm > -500) & (margen_neto_ttm < 60))

    serie = []
    for f in fechas:
        if pd.isna(precio.get(f)):
            continue
        serie.append(
            {
                "fecha": f.strftime("%Y-%m-%d"),
                # Precio de cierre semanal — ya se descarga junto con todo lo
                # demas, solo faltaba exponerlo. Sirve para graficar precio +
                # crecimiento superpuestos (GraficoCrecimiento en el front).
                "precio": _num(precio.get(f), 2),
                "per_ltm": _num(per_ltm.get(f)),
                "ev_sales_ltm": _num(ev_sales_ltm.get(f)),
                "ps_ltm": _num(ps_ltm.get(f)),
                # "denominadores" absolutos (no el multiplo): sirven para ver si
                # un ratio se movio por precio o por fundamentals, y para
                # calcular crecimiento interanual en el frontend.
                "eps_ttm": _num(eps_serie.get(f), 2),
                "revenue_ttm": _num(rev_serie.get(f), 0),
                # margen neto TTM en % (net income / revenue). No se calcula
                # PEG: el crecimiento historico de EPS puede ser muy ruidoso o
                # negativo (empresas que recien se vuelven rentables), y
                # dividir el PER por eso da un numero sin sentido la mayoria
                # de las veces.
                "margen_neto_ttm": _num(margen_neto_ttm.get(f), 2),
            }
        )

    series_por_campo = {
        "per": [p["per_ltm"] for p in serie],
        "ev_sales": [p["ev_sales_ltm"] for p in serie],
        "ps": [p["ps_ltm"] for p in serie],
        "eps": [p["eps_ttm"] for p in serie],
        "revenue": [p["revenue_ttm"] for p in serie],
        "margen_neto": [p["margen_neto_ttm"] for p in serie],
    }
    percentiles = {k: _percentil_actual(v) for k, v in series_por_campo.items()}
    promedios = {k: _promedio_historico(v) for k, v in series_por_campo.items()}

    return {
        "ticker": ticker,
        "nombre": nombre,
        "disponible": True,
        "serie": serie,
        "percentiles": percentiles,
        "promedios": promedios,
    }


def _percentil_actual(valores):
    """Percentil (0-100) del valor MAS RECIENTE dentro de toda su propia
    serie historica — "el PER de hoy es mas barato que el X% de los valores
    que tuvo este mismo ticker en los ultimos ~5 anios". Complementa la
    comparacion contra la industria (Comparables/Oportunidades) con una
    comparacion contra el propio pasado (mean reversion). None si hay poco
    historial (<12 puntos, ~3 meses semanales) o el ultimo dato es nulo."""
    limpios = [v for v in valores if v is not None]
    if len(limpios) < 12 or valores[-1] is None:
        return None
    actual = valores[-1]
    menores = sum(1 for v in limpios if v < actual)
    return round((menores / len(limpios)) * 100)


def _promedio_historico(valores):
    """Promedio simple de toda la serie historica disponible (no ponderado
    por tiempo) — un ancla mas directa que el percentil: "el PER promedio de
    esta empresa en los ultimos ~5 anios fue X"."""
    limpios = [v for v in valores if v is not None]
    if len(limpios) < 12:
        return None
    return round(sum(limpios) / len(limpios), 2)


def _num(v, dec=4):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(f):
        return None
    return round(f, dec)


def _calcular_seguro(ticker, cik):
    try:
        return calcular_historico_ticker(ticker, cik)
    except Exception as e:  # noqa: BLE001
        return {"ticker": ticker, "disponible": False, "motivo": f"Error: {e}", "_error": True}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Historico fundamental (SEC EDGAR) -> historico_fundamental.json")
    ap.add_argument("--out", type=Path, default=DIR_DATOS_PUBLICOS)
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    ruta = args.out / "historico_fundamental.json"

    tickers = leer_tickers_historico()
    print(f"Historico fundamental para {len(tickers)} ticker(s): {tickers}")
    previos = {r.get("ticker"): r for r in (leer_json(ruta, {}) or {}).get("tickers", []) if isinstance(r, dict)}

    resultados = []
    if tickers:
        cache_cik = resolver_ciks(tickers)
        # Paralelo entre tickers: son requests de red (I/O), y el limitador
        # de tasa compartido ya evita pasarse del limite de la SEC aunque
        # varios tickers pidan conceptos al mismo tiempo.
        por_ticker = {}
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            futuros = {
                pool.submit(_calcular_seguro, t, cache_cik.get(_sin_sufijo(t))): t for t in tickers
            }
            for fut in as_completed(futuros):
                t = futuros[fut]
                r = fut.result()
                # Un error puntual (SEC/Yahoo caidos, timeout) no borra lo
                # que ya habia: se conserva el ultimo resultado bueno del
                # ticker, marcado stale. Los "no disponible" legitimos (sin
                # CIK, sin datos en EDGAR) si se publican tal cual.
                previo = previos.get(t)
                if r.pop("_error", False) and previo and previo.get("disponible"):
                    print(f"  ~ {t}: {r['motivo']} -> se conserva el dato anterior")
                    r = {**previo, "stale": True}
                print(f"  listo: {t}")
                por_ticker[t] = r
        resultados = [por_ticker[t] for t in tickers]  # mantener el orden original
    else:
        print("Lista vacia: se escribe igual un JSON valido (sin tickers) para que el front no vea 404.")

    salida = {
        "actualizado": datetime.now(TZ).isoformat(),
        "tickers": resultados,
    }
    if not escribir_json(ruta, salida, ignorar_claves=("actualizado",)):
        print("historico_fundamental.json sin cambios.")

    disponibles = sum(1 for r in resultados if r.get("disponible"))
    print(f"Listo: {disponibles}/{len(resultados)} con datos disponibles.")


if __name__ == "__main__":
    main()
