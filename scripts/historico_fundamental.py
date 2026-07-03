"""Historico de ratios fundamentales (P/E, EV/Sales, P/S) "LTM" (trailing
twelve months) para hasta 10 tickers elegidos a mano, usando datos oficiales
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

Uso:
    python scripts/historico_fundamental.py
"""

import json
import time
from datetime import datetime, date
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests
import yfinance as yf

RAIZ = Path(__file__).resolve().parent.parent
ARCHIVO_TICKERS = RAIZ / "data" / "historico_tickers.json"
DIR_SALIDA = RAIZ / "public" / "data"
TZ = ZoneInfo("America/Argentina/Buenos_Aires")

LIMITE_TICKERS = 10
PERIODO_PRECIO = "5y"

# La SEC exige identificarse (nombre + email) o devuelve 403. Ver
# https://www.sec.gov/os/webmaster-faq#developers
SEC_HEADERS = {"User-Agent": "Stock Lens (facundo.belini@raona.com)"}
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SEC_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"

# Tags XBRL candidatos por concepto (se prueba el primero que exista). Varian
# segun la empresa/taxonomia usada al presentar el reporte.
TAGS_EPS = ["EarningsPerShareDiluted", "EarningsPerShareBasic"]
TAGS_REVENUE = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
]
TAGS_SHARES = ["CommonStockSharesOutstanding", "EntityCommonStockSharesOutstanding"]
TAGS_CASH = [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
]
TAGS_DEUDA_LARGO = ["LongTermDebtNoncurrent", "LongTermDebt"]
TAGS_DEUDA_CORTO = ["LongTermDebtCurrent", "DebtCurrent"]

DIAS_TRIMESTRE = (75, 100)
DIAS_ANUAL = (350, 380)


def leer_tickers_historico():
    if not ARCHIVO_TICKERS.exists():
        return []
    try:
        tickers = json.loads(ARCHIVO_TICKERS.read_text(encoding="utf-8"))
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


def _obtener_companyfacts(cik):
    url = SEC_FACTS_URL.format(cik=cik)
    r = requests.get(url, headers=SEC_HEADERS, timeout=25)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def _concepto_combinado(facts, tags):
    """Combina TODOS los tags candidatos que existan (no solo el primero):
    varias empresas cambian de tag XBRL en algun anio (ej. NVDA reporto
    ventas como "RevenueFromContractWithCustomerExcludingAssessedTax" hasta
    2022 y despues paso a "Revenues") — quedarse con uno solo corta el
    historico a la mitad. El dedup por fecha en _serie_instantanea/
    _trimestres_reportados ya resuelve solapamientos entre tags."""
    usgaap = (facts or {}).get("facts", {}).get("us-gaap", {})
    unidades_combinadas = {}
    for tag in tags:
        concepto = usgaap.get(tag)
        if not concepto:
            continue
        for unidad, entradas in concepto.get("units", {}).items():
            unidades_combinadas.setdefault(unidad, []).extend(entradas)
    if not unidades_combinadas:
        return None
    return {"units": unidades_combinadas}


def _serie_instantanea(concepto, unidad_preferida="USD"):
    """Conceptos de balance (foto a una fecha): shares/cash/deuda. Devuelve
    lista de (fecha, valor) sin duplicados, quedandose con la presentacion
    mas reciente (`filed`) para cada fecha de corte."""
    if not concepto:
        return []
    unidades = concepto.get("units", {})
    entradas = unidades.get(unidad_preferida) or next(iter(unidades.values()), [])
    por_fecha = {}
    for e in entradas:
        if "start" in e:  # es de duracion, no instantaneo; ignorar
            continue
        fin = e["end"]
        anterior = por_fecha.get(fin)
        if anterior is None or e.get("filed", "") >= anterior.get("filed", ""):
            por_fecha[fin] = e
    return sorted(((k, v["val"]) for k, v in por_fecha.items()), key=lambda x: x[0])


def _trimestres_reportados(concepto, unidad_preferida="USD"):
    """Extrae los valores de UN trimestre (duracion ~90 dias) ya reportados
    directamente (Q1/Q2/Q3 de los 10-Q). Devuelve dict fecha_fin -> valor."""
    if not concepto:
        return {}
    unidades = concepto.get("units", {})
    entradas = unidades.get(unidad_preferida) or next(iter(unidades.values()), [])
    por_fecha = {}
    for e in entradas:
        if "start" not in e:
            continue
        dias = (date.fromisoformat(e["end"]) - date.fromisoformat(e["start"])).days
        if not (DIAS_TRIMESTRE[0] <= dias <= DIAS_TRIMESTRE[1]):
            continue
        fin = e["end"]
        anterior = por_fecha.get(fin)
        if anterior is None or e.get("filed", "") >= anterior.get("filed", ""):
            por_fecha[fin] = e
    return {k: v["val"] for k, v in por_fecha.items()}


def _anuales_reportados(concepto, unidad_preferida="USD"):
    """Valores de un anio fiscal completo (10-K, duracion ~365 dias). Devuelve
    dict fecha_fin -> (fecha_inicio, valor)."""
    if not concepto:
        return {}
    unidades = concepto.get("units", {})
    entradas = unidades.get(unidad_preferida) or next(iter(unidades.values()), [])
    por_fecha = {}
    for e in entradas:
        if "start" not in e:
            continue
        dias = (date.fromisoformat(e["end"]) - date.fromisoformat(e["start"])).days
        if not (DIAS_ANUAL[0] <= dias <= DIAS_ANUAL[1]):
            continue
        fin = e["end"]
        anterior = por_fecha.get(fin)
        if anterior is None or e.get("filed", "") >= anterior.get("filed", ""):
            por_fecha[fin] = e
    return {k: (v["start"], v["val"]) for k, v in por_fecha.items()}


def _completar_cuarto_trimestre(trimestres, anuales):
    """Muchas empresas no presentan un 10-Q para el 4to trimestre (queda
    "adentro" del 10-K anual). Lo reconstruye como anual - (T1+T2+T3) cuando
    esos 3 trimestres del mismo anio fiscal ya estan disponibles."""
    trimestres = dict(trimestres)
    fines_trim = sorted(trimestres.keys())
    for fin_anual, (inicio_anual, valor_anual) in anuales.items():
        if fin_anual in trimestres:
            continue
        # Trimestres cuyo fin cae estrictamente dentro del anio fiscal.
        del_anio = [f for f in fines_trim if inicio_anual < f < fin_anual]
        if len(del_anio) != 3:
            continue
        suma = sum(trimestres[f] for f in del_anio)
        trimestres[fin_anual] = valor_anual - suma
    return trimestres


def _serie_ttm(concepto, unidad_preferida="USD"):
    """TTM (suma de los ultimos 4 trimestres) por fecha de corte. Solo emite
    un punto cuando hay 4 trimestres consecutivos sin huecos grandes."""
    trims = _trimestres_reportados(concepto, unidad_preferida)
    anuales = _anuales_reportados(concepto, unidad_preferida)
    trims = _completar_cuarto_trimestre(trims, anuales)
    fechas = sorted(trims.keys())

    ttm = []
    for i in range(3, len(fechas)):
        ult4 = fechas[i - 3 : i + 1]
        # Que esten razonablemente espaciados (evita sumar trimestres con
        # huecos de anios por datos faltantes).
        primero, ultimo = date.fromisoformat(ult4[0]), date.fromisoformat(ult4[-1])
        if not (250 <= (ultimo - primero).days <= 420):
            continue
        ttm.append((ult4[-1], sum(trims[f] for f in ult4)))
    return ttm


def _forward_fill_a_fechas(serie, fechas_objetivo):
    """serie: lista de (fecha_iso, valor) ordenada. Devuelve un array alineado
    a `fechas_objetivo` (pandas Timestamps) con el ultimo valor conocido a esa
    fecha (o NaN si todavia no habia dato)."""
    if not serie:
        return pd.Series(np.nan, index=fechas_objetivo)
    s = pd.Series(
        [v for _, v in serie],
        index=pd.to_datetime([f for f, _ in serie]),
    ).sort_index()
    return s.reindex(s.index.union(fechas_objetivo)).ffill().reindex(fechas_objetivo)


def calcular_historico_ticker(ticker, mapa_cik):
    sym = _sin_sufijo(ticker)
    cik = mapa_cik.get(sym)
    if not cik:
        return {"ticker": ticker, "disponible": False, "motivo": "No reporta a la SEC (sin CIK)."}

    facts = _obtener_companyfacts(cik)
    if not facts:
        return {"ticker": ticker, "disponible": False, "motivo": "SEC no tiene datos XBRL para este CIK."}

    hist = yf.Ticker(ticker).history(period=PERIODO_PRECIO, interval="1d", auto_adjust=True)
    if hist is None or hist.empty:
        return {"ticker": ticker, "disponible": False, "motivo": "Sin historial de precio (yfinance)."}
    if hist.index.tz is not None:
        hist = hist.copy()
        hist.index = hist.index.tz_localize(None)  # simplifica: fechas EDGAR ya son naive

    eps_ttm = _serie_ttm(_concepto_combinado(facts, TAGS_EPS), "USD/shares")
    rev_ttm = _serie_ttm(_concepto_combinado(facts, TAGS_REVENUE), "USD")
    shares = _serie_instantanea(_concepto_combinado(facts, TAGS_SHARES), "shares")
    cash = _serie_instantanea(_concepto_combinado(facts, TAGS_CASH), "USD")
    deuda_lp = _serie_instantanea(_concepto_combinado(facts, TAGS_DEUDA_LARGO), "USD")
    deuda_cp = _serie_instantanea(_concepto_combinado(facts, TAGS_DEUDA_CORTO), "USD")

    if not eps_ttm and not rev_ttm:
        return {"ticker": ticker, "disponible": False, "motivo": "Sin EPS/ventas trimestrales en EDGAR."}

    # Downsample semanal (viernes) para que el JSON no sea gigante. date_range
    # ya hereda el timezone de hist.index (sus limites son tz-aware).
    fechas = pd.date_range(hist.index.min(), hist.index.max(), freq="W-FRI")
    precio = hist["Close"].reindex(hist.index.union(fechas)).ffill().reindex(fechas)

    eps_serie = _forward_fill_a_fechas(eps_ttm, fechas)
    rev_serie = _forward_fill_a_fechas(rev_ttm, fechas)
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

    serie = []
    for f in fechas:
        if pd.isna(precio.get(f)):
            continue
        serie.append(
            {
                "fecha": f.strftime("%Y-%m-%d"),
                "per_ltm": _num(per_ltm.get(f)),
                "ev_sales_ltm": _num(ev_sales_ltm.get(f)),
                "ps_ltm": _num(ps_ltm.get(f)),
            }
        )

    return {
        "ticker": ticker,
        "nombre": facts.get("entityName") or ticker,
        "disponible": True,
        "serie": serie,
    }


def _num(v, dec=4):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(f):
        return None
    return round(f, dec)


def main():
    DIR_SALIDA.mkdir(parents=True, exist_ok=True)
    tickers = leer_tickers_historico()
    print(f"Historico fundamental para {len(tickers)} ticker(s): {tickers}")
    if not tickers:
        print("Nada que hacer (data/historico_tickers.json vacio o inexistente).")
        return

    print("Resolviendo ticker -> CIK contra SEC...")
    mapa_cik = _mapa_ticker_a_cik()

    resultados = []
    for t in tickers:
        print(f"  procesando {t}...")
        try:
            resultados.append(calcular_historico_ticker(t, mapa_cik))
        except Exception as e:  # noqa: BLE001
            resultados.append({"ticker": t, "disponible": False, "motivo": f"Error: {e}"})
        time.sleep(0.3)  # cortesia con la API de la SEC (limite ~10 req/s)

    salida = {
        "actualizado": datetime.now(TZ).isoformat(),
        "tickers": resultados,
    }
    ruta = DIR_SALIDA / "historico_fundamental.json"
    with open(ruta, "w", encoding="utf-8") as f:
        json.dump(salida, f, ensure_ascii=False, indent=2)
    print(f"-> {ruta.relative_to(RAIZ)}")

    disponibles = sum(1 for r in resultados if r.get("disponible"))
    print(f"Listo: {disponibles}/{len(resultados)} con datos disponibles.")


if __name__ == "__main__":
    main()
