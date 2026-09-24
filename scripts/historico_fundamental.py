"""Historico fundamental "estilo Koyfin" para TODO el universo (public/data/
listado.json): series trimestrales/TTM de SEC EDGAR (XBRL companyfacts) +
precio semanal de yfinance -> multiplos de valuacion semanales.

Salida (minificada, via comun.escribir_json):
  public/data/fundamental/<TICKER>.json   una por ticker con datos
  public/data/fundamental/indice.json     listado liviano (disponible/motivo,
                                          valor actual y percentil 5 anios)

Cobertura: todo ticker del listado que reporte a la SEC (10-K/10-Q de EEUU,
20-F/40-F de ADRs, con hechos us-gaap o ifrs-full). Los que cotizan solo en
Merval/B3 (.BA/.SA), los ETF y los que no tienen estados contables en EDGAR
quedan en el indice como "no disponible" con el motivo.

Sin look-ahead: cada dato contable se usa recien desde la fecha en que se
PRESENTO (`filed` del 10-Q/10-K), no desde el cierre del trimestre (`end`).
Para cada periodo se toma el valor tal como se presento originalmente (el
primer `filed`), no la re-expresion posterior.

Splits: los precios son los de cierre sin ajuste por dividendos
(auto_adjust=False; el Close de Yahoo ya viene ajustado por splits) y EPS /
acciones se llevan a la base de acciones actual con los splits de Yahoo,
segun la fecha de presentacion de cada dato (un 10-Q presentado despues de un
split ya viene expresado post-split).

Cache: companyfacts pesa varios MB por empresa. Se guarda una version
"flaca" (solo los conceptos que se usan) en data/edgar_cache/<CIK>.json.gz y
solo se vuelve a bajar cuando la empresa presento un 10-K/10-Q/20-F/40-F
nuevo (endpoint submissions) o el cache tiene mas de TTL_CACHE_DIAS.

Uso:
    python scripts/historico_fundamental.py [--tickers NVDA,AAPL] [--out CARPETA]
"""

import argparse
import gzip
import json
import os
import threading
import time
import zlib
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import yfinance as yf

from comun import DIR_DATOS_PUBLICOS, DIR_ESTADO, TZ, escribir_json, leer_json, num, sig

CACHE_CIK = DIR_ESTADO / "cik_cache.json"
DIR_CACHE_EDGAR = DIR_ESTADO / "edgar_cache"
ARCHIVO_LISTADO = DIR_DATOS_PUBLICOS / "listado.json"
ARCHIVO_FUNDAMENTALES = DIR_DATOS_PUBLICOS / "fundamentales.json"

ANIOS_HISTORIA = 15
INICIO_PRECIO = "2008-01-01"  # antes del primer XBRL (2009): cubre splits viejos
TTL_CACHE_DIAS = 100  # aunque no haya filing nuevo, se refresca cada ~trimestre
FRESCO_DIAS = 6  # cache bajado hace < 6 dias: ni se consulta submissions
WORKERS = 6

# La SEC pide identificarse con un User-Agent descriptivo (fair access). Se
# puede pisar con la variable de entorno SEC_USER_AGENT (ej. para agregar un
# email de contacto desde un secret de Actions sin commitearlo).
SEC_HEADERS = {
    "User-Agent": os.environ.get("SEC_USER_AGENT") or "Stock Lens (facundo.belini@raona.com)",
    "Accept-Encoding": "gzip, deflate",
}
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SEC_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"
SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"

FORMS_PERIODICOS = {"10-K", "10-Q", "20-F", "40-F", "10-K/A", "10-Q/A", "20-F/A", "40-F/A", "10-KT", "10-QT"}
FORMS_EXTRANJEROS = {"20-F", "40-F", "20-F/A", "40-F/A"}

# Tickers cuyo CIK actual es una entidad nueva (reorganizacion en holding) y
# cuya historia XBRL quedo en el CIK anterior. Se completa a mano: la SEC no
# publica el vinculo entre CIKs.
PREDECESORES = {"XOM": [34088]}

DIAS_TRIMESTRE = (75, 100)
DIAS_ANUAL = (350, 380)


# ---------------------------------------------------------------------------
# Acceso a la SEC: limitador de tasa compartido + reintentos con backoff
# ---------------------------------------------------------------------------
class LimitadorTasa:
    """Limita la tasa de requests a la SEC entre TODOS los threads (la SEC
    permite ~10 req/s; se usa 8 de margen)."""

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


LIMITADOR_SEC = LimitadorTasa(8)
_sesion = threading.local()
_bloqueo_sec = {"n403": 0}


class SecNoDisponible(Exception):
    pass


def _http():
    if not hasattr(_sesion, "s"):
        _sesion.s = requests.Session()
        _sesion.s.headers.update(SEC_HEADERS)
    return _sesion.s


def get_sec(url, timeout=60, intentos=5):
    """GET con limitador + reintentos (429/5xx/timeout: backoff 2,4,8,16 s).
    Devuelve el JSON o None si es 404. Un 403 de la SEC es el bloqueo por
    tasa/User-Agent ("Request Rate Threshold Exceeded", dura ~10 min): tras
    varios seguidos se deja de insistir (SecNoDisponible) y cada ticker usa
    su cache o su ultimo JSON publicado."""
    if _bloqueo_sec["n403"] >= 6:
        raise SecNoDisponible("SEC devolvio 403 (bloqueo por tasa) varias veces seguidas")
    ultimo_error = None
    for i in range(intentos):
        LIMITADOR_SEC.esperar()
        try:
            r = _http().get(url, timeout=timeout)
        except requests.RequestException as e:
            ultimo_error = e
            time.sleep(2 ** (i + 1))
            continue
        if r.status_code == 404:
            return None
        if r.status_code == 403:
            _bloqueo_sec["n403"] += 1
            ultimo_error = RuntimeError("HTTP 403 (SEC: rate threshold / User-Agent)")
            if _bloqueo_sec["n403"] >= 6:
                break
            time.sleep(5 * (i + 1))
            continue
        if r.status_code == 429 or r.status_code >= 500:
            ultimo_error = RuntimeError(f"HTTP {r.status_code}")
            time.sleep(2 ** (i + 1))
            continue
        r.raise_for_status()
        _bloqueo_sec["n403"] = 0
        return r.json()
    if _bloqueo_sec["n403"] >= 6:
        raise SecNoDisponible(str(ultimo_error))
    raise RuntimeError(f"SEC sin respuesta ({url}): {ultimo_error}")


# ---------------------------------------------------------------------------
# Universo y CIKs
# ---------------------------------------------------------------------------
def leer_universo():
    """[(ticker, nombre, industria)] de listado.json (todo el universo)."""
    data = leer_json(ARCHIVO_LISTADO, {}) or {}
    filas = data.get("acciones", []) if isinstance(data, dict) else data
    salida, vistos = [], set()
    for f in filas or []:
        t = str(f.get("ticker") or "").strip().upper()
        if t and t not in vistos:
            vistos.add(t)
            salida.append((t, f.get("nombre") or t, f.get("industria")))
    return salida


def leer_fundamentales_yahoo():
    """ticker -> fila de fundamentales.json (market cap de Yahoo: sirve para
    estimar el ratio ADR/accion ordinaria y como control de cordura)."""
    filas = leer_json(ARCHIVO_FUNDAMENTALES, []) or []
    if isinstance(filas, dict):
        filas = filas.get("acciones", [])
    return {str(f.get("ticker", "")).upper(): f for f in filas if isinstance(f, dict)}


def simbolo_sec(ticker):
    """EDGAR usa el ticker "pelado" de EEUU con guion para clases (BRK-B).
    None para los que cotizan solo en Merval/B3 (.BA/.SA)."""
    if ticker.endswith((".BA", ".SA")):
        return None
    return ticker.replace(".", "-")


def resolver_ciks(simbolos):
    """company_tickers.json (~800 KB) se baja solo si aparece un simbolo que
    no esta en data/cik_cache.json. Devuelve (cache, completo): completo=False
    si no se pudo bajar el mapa (los que faltan quedan "sin saber", no "sin
    CIK": no se debe publicar que no reportan a la SEC)."""
    cache = leer_json(CACHE_CIK, {}) or {}
    faltantes = [s for s in simbolos if s not in cache]
    completo = True
    if faltantes:
        try:
            data = get_sec(SEC_TICKERS_URL, timeout=30) or {}
            mapa = {v["ticker"].upper(): int(v["cik_str"]) for v in data.values()}
            nuevos = {s: mapa[s] for s in faltantes if s in mapa}
            print(f"CIK: {len(nuevos)} nuevos resueltos, {len(faltantes) - len(nuevos)} sin CIK en la SEC.")
            cache.update(nuevos)
            escribir_json(CACHE_CIK, dict(sorted(cache.items())))
        except Exception as e:  # noqa: BLE001
            print(f"  ! no se pudo bajar company_tickers.json ({e}); se usa solo el cache de CIKs")
            completo = False
    return cache, completo


# ---------------------------------------------------------------------------
# Conceptos XBRL (tags candidatos por concepto, en orden de prioridad)
# ---------------------------------------------------------------------------
G, I, D = "us-gaap", "ifrs-full", "dei"
CONCEPTOS = {
    "revenue": [
        (G, "Revenues"), (G, "RevenueFromContractWithCustomerExcludingAssessedTax"),
        (G, "RevenueFromContractWithCustomerIncludingAssessedTax"), (G, "RevenuesNetOfInterestExpense"),
        (G, "SalesRevenueNet"), (G, "SalesRevenueGoodsNet"), (G, "SalesRevenueServicesNet"),
        (I, "Revenue"), (I, "RevenueFromContractsWithCustomers"),
        # Bancos IFRS (ej. GGAL): no hay "Revenue"; el equivalente es el
        # ingreso operativo total (intereses netos + comisiones + otros).
        (I, "RevenueAndOperatingIncome"),
    ],
    "gross": [(G, "GrossProfit"), (I, "GrossProfit")],
    "op": [(G, "OperatingIncomeLoss"), (I, "ProfitLossFromOperatingActivities")],
    "ni": [
        (G, "NetIncomeLoss"), (G, "NetIncomeLossAvailableToCommonStockholdersBasic"), (G, "ProfitLoss"),
        (I, "ProfitLossAttributableToOwnersOfParent"), (I, "ProfitLoss"),
    ],
    "da": [
        (G, "DepreciationDepletionAndAmortization"), (G, "DepreciationAmortizationAndAccretionNet"),
        (G, "DepreciationAndAmortization"), (G, "Depreciation"),
        (I, "DepreciationAndAmortisationExpense"), (I, "AdjustmentsForDepreciationAndAmortisationExpense"),
        (I, "DepreciationAmortisationAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss"),
        # Ultimo recurso (ej. TSM): solo depreciacion, sin amortizaciones
        # (EBITDA levemente subestimado).
        (I, "DepreciationExpense"),
    ],
    "eps": [
        (G, "EarningsPerShareDiluted"), (G, "EarningsPerShareBasicAndDiluted"), (G, "EarningsPerShareBasic"),
        # IFRS los llama "EarningsLossPerShare" (con "Loss").
        (I, "DilutedEarningsLossPerShare"), (I, "BasicAndDilutedEarningsLossPerShare"),
        (I, "BasicEarningsLossPerShare"), (I, "DilutedEarningsLossPerShareFromContinuingOperations"),
        (I, "BasicAndDilutedEarningsLossPerShareFromContinuingOperations"),
    ],
    "shares_dil": [
        (G, "WeightedAverageNumberOfDilutedSharesOutstanding"),
        (G, "WeightedAverageNumberOfShareOutstandingBasicAndDiluted"),
        (G, "WeightedAverageNumberOfSharesOutstandingBasic"),
        (I, "AdjustedWeightedAverageShares"), (I, "WeightedAverageShares"),
    ],
    "shares_out": [(D, "EntityCommonStockSharesOutstanding")],
    "shares_out_bs": [(G, "CommonStockSharesOutstanding"), (I, "NumberOfSharesOutstanding")],
    "cfo": [
        (G, "NetCashProvidedByUsedInOperatingActivities"),
        (G, "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"),
        (I, "CashFlowsFromUsedInOperatingActivities"),
    ],
    "capex": [
        (G, "PaymentsToAcquirePropertyPlantAndEquipment"), (G, "PaymentsToAcquireProductiveAssets"),
        (G, "PaymentsForCapitalImprovements"),
        (I, "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"),
        (I, "PurchaseOfPropertyPlantAndEquipment"),
    ],
    "cash": [
        (G, "CashAndCashEquivalentsAtCarryingValue"),
        (G, "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"), (G, "Cash"),
        (I, "CashAndCashEquivalents"),
    ],
    "inv_cp": [
        (G, "ShortTermInvestments"), (G, "MarketableSecuritiesCurrent"),
        (G, "AvailableForSaleSecuritiesDebtSecuritiesCurrent"), (I, "CurrentFinancialAssetsAtFairValueThroughProfitOrLoss"),
    ],
    "deuda_lp": [
        (G, "LongTermDebtNoncurrent"), (G, "LongTermDebtAndCapitalLeaseObligations"),
        (G, "LongTermDebtAndFinanceLeaseObligationsNoncurrent"), (G, "LongTermNotesPayable"),
        (I, "NoncurrentPortionOfNoncurrentBorrowings"), (I, "LongtermBorrowings"),
        (I, "NoncurrentPortionOfNoncurrentBondsIssued"), (I, "NoncurrentBorrowings"),
    ],
    "deuda_total_lp": [(G, "LongTermDebt"), (I, "Borrowings")],
    "deuda_cp": [
        (G, "DebtCurrent"), (G, "LongTermDebtAndCapitalLeaseObligationsCurrent"), (G, "LongTermDebtCurrent"),
        (I, "CurrentPortionOfLongtermBorrowings"), (I, "CurrentBorrowings"),
        (I, "CurrentPortionOfNoncurrentBorrowings"),
    ],
    "deuda_st": [(G, "ShortTermBorrowings"), (G, "CommercialPaper"), (I, "ShorttermBorrowings")],
    "equity": [
        (G, "StockholdersEquity"), (G, "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"),
        (I, "EquityAttributableToOwnersOfParent"), (I, "Equity"),
    ],
}
TAGS_USADOS = {f"{tax}/{tag}" for lista in CONCEPTOS.values() for tax, tag in lista}
# Huella de la lista de tags: si se agrega un tag candidato, el cache flaco
# (que solo guardo los tags de antes) queda invalido y se vuelve a bajar.
HUELLA_TAGS = format(zlib.crc32("|".join(sorted(TAGS_USADOS)).encode()), "08x")


# ---------------------------------------------------------------------------
# Cache de companyfacts ("flaco": solo los tags usados)
# ---------------------------------------------------------------------------
def _ruta_cache(cik):
    return DIR_CACHE_EDGAR / f"{int(cik)}.json.gz"


def _leer_cache(cik):
    ruta = _ruta_cache(cik)
    if not ruta.exists():
        return None
    try:
        with gzip.open(ruta, "rt", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def _guardar_cache(cik, obj):
    """gzip con mtime=0: si el contenido no cambio, los bytes tampoco (no
    genera diff en git)."""
    ruta = _ruta_cache(cik)
    ruta.parent.mkdir(parents=True, exist_ok=True)
    texto = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    nuevo = gzip.compress(texto, compresslevel=9, mtime=0)
    if ruta.exists() and ruta.read_bytes() == nuevo:
        return
    tmp = ruta.with_suffix(".tmp")
    tmp.write_bytes(nuevo)
    os.replace(tmp, ruta)


def _adelgazar(facts_json):
    """companyfacts -> {"tax/tag": {unidad: [[start, end, val, filed, form], ...]}}"""
    salida = {}
    for tax, conceptos in (facts_json.get("facts") or {}).items():
        for tag, cuerpo in conceptos.items():
            clave = f"{tax}/{tag}"
            if clave not in TAGS_USADOS:
                continue
            unidades = {}
            for unidad, entradas in (cuerpo.get("units") or {}).items():
                filas = [
                    [e.get("start"), e["end"], e["val"], e["filed"], e.get("form")]
                    for e in entradas
                    if e.get("end") and e.get("filed") and e.get("val") is not None
                ]
                if filas:
                    unidades[unidad] = filas
            if unidades:
                salida[clave] = unidades
    return salida


def _ultimo_filing(submissions):
    """(fecha del ultimo 10-K/10-Q/20-F/40-F, form) segun submissions."""
    rec = ((submissions or {}).get("filings") or {}).get("recent") or {}
    mejor = ("", "")
    for form, fecha in zip(rec.get("form", []), rec.get("filingDate", [])):
        if form in FORMS_PERIODICOS and fecha > mejor[0]:
            mejor = (fecha, form)
    return mejor


def obtener_hechos(cik):
    """Devuelve el cache flaco de la empresa, bajandolo de nuevo solo si hace
    falta. Si la SEC falla y hay cache, se usa el cache (marcado)."""
    cache = _leer_cache(cik)
    if cache and cache.get("huella_tags") != HUELLA_TAGS:
        cache = None
    hoy = date.today()
    if cache:
        edad = (hoy - date.fromisoformat(cache.get("descargado", "2000-01-01"))).days
        if edad < FRESCO_DIAS:
            return cache
    try:
        sub = get_sec(SEC_SUBMISSIONS_URL.format(cik=int(cik)), timeout=30)
        ultimo, form = _ultimo_filing(sub)
        if cache:
            edad = (hoy - date.fromisoformat(cache.get("descargado", "2000-01-01"))).days
            if cache.get("ultimo_filing") == ultimo and edad < TTL_CACHE_DIAS:
                cache["descargado_chequeo"] = hoy.isoformat()
                return cache
        facts = get_sec(SEC_FACTS_URL.format(cik=int(cik)), timeout=90)
        if facts is None:
            obj = {"cik": int(cik), "nombre": (sub or {}).get("name"), "descargado": hoy.isoformat(),
                   "ultimo_filing": ultimo, "ultimo_form": form, "facts": {}, "huella_tags": HUELLA_TAGS}
        else:
            obj = {
                "cik": int(cik),
                "nombre": facts.get("entityName") or (sub or {}).get("name"),
                "descargado": hoy.isoformat(),
                "ultimo_filing": ultimo,
                "ultimo_form": form,
                "facts": _adelgazar(facts),
                "huella_tags": HUELLA_TAGS,
            }
        _guardar_cache(cik, obj)
        return obj
    except Exception as e:  # noqa: BLE001
        if cache:
            cache["_desde_cache"] = str(e)
            return cache
        raise


# ---------------------------------------------------------------------------
# Series contables
# ---------------------------------------------------------------------------
def _dias(a, b):
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def _elegir_moneda(facts):
    """Moneda en la que reporta la empresa: la unidad monetaria con mas
    datos de ventas/resultado en los ultimos ~4 anios."""
    conteo = defaultdict(int)
    corte = (date.today() - timedelta(days=4 * 365)).isoformat()
    for clave in ("revenue", "ni", "op", "cfo"):
        for tax, tag in CONCEPTOS[clave]:
            for unidad, filas in (facts.get(f"{tax}/{tag}") or {}).items():
                if "/" in unidad or not unidad.isalpha() or len(unidad) != 3:
                    continue
                conteo[unidad] += sum(1 for f in filas if f[1] >= corte)
    if not conteo:
        return "USD"
    return max(conteo.items(), key=lambda kv: kv[1])[0]


def _filas(facts, clave, unidad):
    """Filas (start, end, val, filed, rango_tag) de todos los tags candidatos
    del concepto, en la unidad pedida."""
    salida = []
    for rango, (tax, tag) in enumerate(CONCEPTOS[clave]):
        for s, e, v, f, _form in (facts.get(f"{tax}/{tag}") or {}).get(unidad, []):
            salida.append((s, e, float(v), f, rango))
    return salida


def _primera_presentacion(filas, ajuste=None, instantaneo=False):
    """Para cada periodo (start, end) se queda con la PRIMERA presentacion
    (menor `filed`): el dato tal como lo conocio el mercado ese dia; las
    re-expresiones posteriores (comparativos del anio siguiente) tienen un
    `filed` mas tardio. Con dos tags en la misma presentacion gana el de
    mayor prioridad. 'ajuste(val, filed)' lleva el valor a la base de
    acciones actual (splits). dict (start, end) -> (val, filed)."""
    por = {}
    for s, e, v, f, rango in filas:
        if instantaneo != (s is None):
            continue
        k = (s, e)
        clave_orden = (f, rango)
        if k not in por or clave_orden < por[k][2]:
            por[k] = (v, f, clave_orden)
    return {k: ((ajuste(v, f) if ajuste else v), f) for k, (v, f, _o) in por.items()}


def trimestres_discretos(filas, ajuste=None, modo="flujo"):
    """Valores de UN trimestre por fecha de cierre -> (valor, filed).

    - Directos: periodos de ~90 dias (columna "tres meses" del 10-Q).
    - modo "flujo" (ventas, cash flow...): el estado de flujo de efectivo de
      los 10-Q viene ACUMULADO en el anio (6M, 9M): Q2 = 6M - 3M, Q3 = 9M -
      6M, Q4 = anual - 9M (mismo inicio de ejercicio).
    - Q4 que solo existe en el 10-K: anual - (Q1+Q2+Q3) si los tres estan.
      Para EPS (modo "por_accion") esto es la aproximacion habitual.
    - modo "promedio" (acciones promedio ponderadas): no se restan; el Q4
      faltante toma el promedio anual.
    Cada trimestre derivado se conoce recien con la presentacion mas tardia
    de las que lo componen. Devuelve (trimestres, anuales)."""
    per = _primera_presentacion(filas, ajuste)
    trim, anual = {}, {}
    for (s, e), (v, f) in per.items():
        d = _dias(s, e)
        if DIAS_TRIMESTRE[0] <= d <= DIAS_TRIMESTRE[1]:
            if e not in trim or f < trim[e][1]:
                trim[e] = (v, f)
        elif DIAS_ANUAL[0] <= d <= DIAS_ANUAL[1]:
            if e not in anual or f < anual[e][2]:
                anual[e] = (s, v, f)
    if modo == "flujo":
        por_inicio = defaultdict(list)
        for (s, e), (v, f) in per.items():
            if _dias(s, e) <= DIAS_ANUAL[1]:
                por_inicio[s].append((e, v, f))
        for s, lista in por_inicio.items():
            lista.sort()
            for (e1, v1, f1), (e2, v2, f2) in zip(lista, lista[1:]):
                if e2 in trim or _dias(s, e1) < DIAS_TRIMESTRE[0]:
                    continue
                if DIAS_TRIMESTRE[0] <= _dias(e1, e2) <= DIAS_TRIMESTRE[1]:
                    trim[e2] = (v2 - v1, max(f1, f2))
    for e_a, (s_a, v_a, f_a) in anual.items():
        if e_a in trim:
            continue
        if modo == "promedio":
            trim[e_a] = (v_a, f_a)
            continue
        del_anio = [e for e in trim if s_a < e < e_a and _dias(s_a, e) >= DIAS_TRIMESTRE[0] - 10]
        if len(del_anio) == 3:
            trim[e_a] = (v_a - sum(trim[e][0] for e in del_anio), max([f_a] + [trim[e][1] for e in del_anio]))
    return trim, anual


def serie_ttm(trim, anual):
    """TTM = suma de los ultimos 4 trimestres consecutivos, fechado en el
    cierre del ultimo y "conocido" con la presentacion mas tardia de los 4.
    Para los fines de ejercicio sin 4 trimestres (20-F/40-F anuales, o
    conceptos que solo aparecen en el 10-K) se usa el valor anual. dict
    end -> (valor, filed)."""
    fechas = sorted(trim)
    ttm = {}
    for i in range(3, len(fechas)):
        ult4 = fechas[i - 3 : i + 1]
        if not (250 <= _dias(ult4[0], ult4[-1]) <= 300):
            continue
        ttm[ult4[-1]] = (sum(trim[f][0] for f in ult4), max(trim[f][1] for f in ult4))
    for e, (_s, v, f) in anual.items():
        if e not in ttm:
            ttm[e] = (v, f)
    return ttm


def instantaneos(filas, ajuste=None, sumar_clases=False):
    """Conceptos de balance (foto a una fecha). dict end -> (valor, filed),
    primera presentacion. sumar_clases: la portada (dei) trae una fila por
    clase de accion en la misma presentacion (ej. GOOGL A/B/C): se suman los
    valores distintos de una misma (fecha, presentacion)."""
    if sumar_clases:
        grupos = defaultdict(set)
        rangos = {}
        for s, e, v, f, rango in filas:
            if s is None:
                grupos[(e, f)].add(v)
                rangos[(e, f)] = min(rango, rangos.get((e, f), 99))
        filas = [(None, e, sum(vs), f, rangos[(e, f)]) for (e, f), vs in grupos.items()]
    per = _primera_presentacion(filas, ajuste, instantaneo=True)
    return {e: vf for (_s, e), vf in per.items()}


def conocidos(puntos):
    """dict end -> (valor, filed) -> lista [(filed, end, valor)] ordenada por
    presentacion, descartando los que llegan despues pero son de un cierre
    MAS VIEJO que el ya publicado (no deben pisar un dato mas nuevo)."""
    salida, ultimo_fin = [], ""
    for e, (v, f) in sorted(puntos.items(), key=lambda kv: (kv[1][1], kv[0])):
        if e < ultimo_fin:
            continue
        ultimo_fin = e
        salida.append((f, e, v))
    return salida


def _vigencia_dias(puntos):
    """Cuanto tiempo se "arrastra" el ultimo dato conocido: ~200 dias si la
    serie es trimestral, ~460 si es anual (20-F). Pasado eso se corta (una
    empresa que dejo de reportar no queda con un P/E eterno)."""
    fines = sorted(puntos)
    if len(fines) < 3:
        return 460
    gaps = sorted(_dias(a, b) for a, b in zip(fines, fines[1:]))
    return 200 if gaps[len(gaps) // 2] < 130 else 460


def a_semanal(puntos, fechas, vigencia=None):
    """Serie alineada a `fechas` (semanal) con el ultimo valor YA PRESENTADO
    a esa fecha (merge_asof hacia atras), vigente hasta `vigencia` dias."""
    lista = conocidos(puntos)
    if not lista:
        return pd.Series(np.nan, index=fechas)
    vig = vigencia or _vigencia_dias(puntos)
    # Misma resolucion (ns) en las dos claves: pandas 3 no mezcla s/us/ns.
    df = pd.DataFrame({"f": pd.to_datetime([f for f, _e, _v in lista]).astype("datetime64[ns]"), "v": [v for _f, _e, v in lista]})
    df = df.drop_duplicates("f", keep="last").sort_values("f")
    base = pd.DataFrame({"f": pd.DatetimeIndex(fechas).astype("datetime64[ns]")})
    m = pd.merge_asof(base, df, on="f", direction="backward", tolerance=pd.Timedelta(days=vig))
    return pd.Series(m["v"].to_numpy(), index=fechas)


# ---------------------------------------------------------------------------
# Precio (yfinance), splits, FX
# ---------------------------------------------------------------------------
def _factor_splits(splits):
    """f(fecha_iso) = producto de los splits POSTERIORES a esa fecha (cuantas
    acciones de hoy equivale una accion de ese momento). EPS presentado en
    esa fecha / f = EPS en base de acciones actual."""
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


def _historia_yahoo(simbolo, intentos=3):
    ultimo = None
    for i in range(intentos):
        try:
            h = yf.Ticker(simbolo).history(start=INICIO_PRECIO, interval="1d", auto_adjust=False, actions=True)
            if h is not None and not h.empty:
                if h.index.tz is not None:
                    h = h.copy()
                    h.index = h.index.tz_localize(None)
                return h
            ultimo = "historial vacio"
        except Exception as e:  # noqa: BLE001
            ultimo = e
        time.sleep(3 * (i + 1))
    raise RuntimeError(f"yfinance {simbolo}: {ultimo}")


_fx_cache = {}
_fx_lock = threading.Lock()


def fx_por_usd(moneda):
    """Serie diaria de unidades de `moneda` por 1 USD (Yahoo "<MON>=X")."""
    with _fx_lock:
        if moneda in _fx_cache:
            return _fx_cache[moneda]
    h = _historia_yahoo(f"{moneda}=X")
    s = h["Close"].where(h["Close"] > 0).dropna()
    with _fx_lock:
        _fx_cache[moneda] = s
    return s


RATIOS_ADR = [1 / 10, 1 / 5, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100, 200, 300, 400, 500, 1000]


def _ratio_adr(acciones_ord, market_cap_usd, precio_actual):
    """Acciones ordinarias por cada ADR, estimado como acciones (EDGAR) /
    (market cap de Yahoo / precio del ADR) y redondeado al ratio "redondo"
    mas cercano si esta a menos de 15%. None si no se puede estimar."""
    if not acciones_ord or not market_cap_usd or not precio_actual:
        return None, False
    crudo = acciones_ord / (market_cap_usd / precio_actual)
    if crudo <= 0:
        return None, False
    cercano = min(RATIOS_ADR, key=lambda r: abs(np.log(crudo / r)))
    if abs(crudo / cercano - 1) < 0.15:
        return cercano, False
    return float(f"{crudo:.3g}"), True


# ---------------------------------------------------------------------------
# Calculo por ticker
# ---------------------------------------------------------------------------
def _yoy(ttm):
    """Crecimiento interanual de un TTM: vs. el TTM con cierre 330-400 dias
    antes. (actual - anterior) / |anterior| x 100; con cambio de signo (o
    base 0) no tiene sentido -> None. dict end -> (pct, filed)."""
    fines = sorted(ttm)
    salida = {}
    for e in fines:
        previos = [p for p in fines if 330 <= _dias(p, e) <= 400]
        if not previos:
            continue
        p = min(previos, key=lambda x: abs(_dias(x, e) - 365))
        actual, anterior = ttm[e][0], ttm[p][0]
        if anterior == 0 or (anterior < 0 < actual) or (actual < 0 < anterior):
            continue
        salida[e] = ((actual - anterior) / abs(anterior) * 100, ttm[e][1])
    return salida


def _margen(num_ttm, rev_ttm, lim=(-1000, 100)):
    """margen % = concepto TTM / revenue TTM (misma fecha de cierre).
    Guardarail: fuera de [-1000, 100]% el denominador esta mal taggeado (ej.
    bancos que taggean solo comisiones como "revenue")."""
    salida = {}
    for e, (v, f) in num_ttm.items():
        if e in rev_ttm and rev_ttm[e][0] > 0:
            m = v / rev_ttm[e][0] * 100
            if lim[0] < m < lim[1]:
                salida[e] = (m, max(f, rev_ttm[e][1]))
    return salida


def _combinar(a, b, fn):
    """Combina dos dict end -> (valor, filed) en los cierres comunes."""
    return {e: (fn(a[e][0], b[e][0]), max(a[e][1], b[e][1])) for e in a if e in b}


def _sig4(v):
    """4 cifras significativas; los montos grandes como entero (en JSON
    "750500000000" pesa menos que "750500000000.0")."""
    f = sig(v, 4)
    if f is not None and abs(f) >= 1e4:
        return int(f)
    return f


def _elegir_acciones(facts, acciones, shd_q, extranjero, yahoo_fila, precio_hoy):
    """Serie de acciones para el market cap. Candidatas, en orden: portada
    del reporte (dei, suma las clases), balance (CommonStockSharesOutstanding)
    y promedio diluido del trimestre. Se descartan las que dejaron de
    reportarse hace mas de 2 anios (ej. IBKR: dei solo hasta 2011).

    Control con Yahoo (empresas de EEUU): referencia = market cap / precio de
    hoy. Se toma la primera candidata a menos de x2 de la referencia; el
    promedio diluido a veces viene mal escalado en el XBRL (en miles o
    millones con unidad "shares": MCD 711.1, TEM 182397) y se corrige x1e3 /
    x1e6 si asi cae en rango. Si ninguna cae en rango se usa la primera
    disponible. Sin ninguna (ej. V, solo reporta por clase) se usan las
    acciones de hoy segun Yahoo, constantes para toda la serie (aproximacion:
    ignora recompras/emisiones).
    Devuelve (serie, fuente, acciones_constantes_o_None)."""
    corte = (date.today() - timedelta(days=730)).isoformat()
    candidatas = []
    dei = instantaneos(_filas(facts, "shares_out", "shares"), acciones, sumar_clases=True)
    bs = instantaneos(_filas(facts, "shares_out_bs", "shares"), acciones)
    for fuente, serie in (("portada", dei), ("balance", bs), ("diluidas", dict(shd_q))):
        if serie and max(serie) >= corte:
            candidatas.append((fuente, serie))
    mcap_y = (yahoo_fila or {}).get("market_cap_usd")
    ref = mcap_y / precio_hoy if (mcap_y and precio_hoy and not extranjero) else None
    if ref:
        for fuente, serie in candidatas:
            ult = serie[max(serie)][0]
            for escala in ((1, 1e3, 1e6) if fuente == "diluidas" else (1,)):
                if ult and 0.5 <= ult * escala / ref <= 2:
                    if escala != 1:
                        serie = {e: (v * escala, f) for e, (v, f) in serie.items()}
                        fuente = f"diluidas_x{int(escala)}"
                    return serie, fuente, None
    if candidatas:
        fuente, serie = candidatas[0]
        # Sin referencia (ADRs: el ratio ADR se estima a partir de estas
        # mismas acciones): la portada/balance tiene que ser coherente con el
        # promedio diluido (a veces la portada cuenta ADS u otra clase, ej.
        # BABA); si no, se usa el diluido.
        if not ref and fuente != "diluidas" and shd_q:
            ult, ult_dil = serie[max(serie)][0], shd_q[max(shd_q)][0]
            if ult_dil and not (0.7 <= ult / ult_dil <= 1.3):
                return dict(shd_q), "diluidas", None
        return serie, fuente, None
    if mcap_y and precio_hoy:
        return {}, "yahoo_actual", mcap_y / precio_hoy
    return {}, "ninguna", None


def calcular_ticker(ticker, nombre, cik, yahoo_fila):
    if not cik:
        return {"ticker": ticker, "nombre": nombre, "disponible": False, "motivo": "No figura en el registro de la SEC (sin CIK)."}
    hechos = obtener_hechos(cik)
    facts = hechos.get("facts") or {}
    for cik_viejo in PREDECESORES.get(ticker, []):
        # Reorganizaciones con CIK nuevo (ej. XOM 2026): la historia quedo en
        # el CIK anterior. Se suman los hechos (la "primera presentacion" ya
        # resuelve los periodos repetidos).
        viejos = obtener_hechos(cik_viejo).get("facts") or {}
        facts = {k: dict(facts.get(k, {})) for k in set(facts) | set(viejos)}
        for k, unidades in viejos.items():
            for u, filas in unidades.items():
                facts[k][u] = facts[k].get(u, []) + filas
    if not facts:
        return {"ticker": ticker, "nombre": nombre, "disponible": False,
                "motivo": "La SEC no tiene estados contables XBRL de esta empresa."}
    moneda = _elegir_moneda(facts)
    extranjero = (hechos.get("ultimo_form") or "") in FORMS_EXTRANJEROS or moneda != "USD"

    hist = _historia_yahoo(ticker)
    splits = hist["Stock Splits"] if "Stock Splits" in hist.columns else None
    factor = _factor_splits(splits)

    def por_accion(v, filed):
        return v / factor(filed)

    def acciones(v, filed):
        return v * factor(filed)

    unidad_ps = f"{moneda}/shares"

    def flujo(clave):
        trim, anual = trimestres_discretos(_filas(facts, clave, moneda))
        return trim, serie_ttm(trim, anual)

    rev_q, rev_ttm = flujo("revenue")
    gross_q, gross_ttm = flujo("gross")
    op_q, op_ttm = flujo("op")
    ni_q, ni_ttm = flujo("ni")
    da_q, da_ttm = flujo("da")
    cfo_q, cfo_ttm = flujo("cfo")
    capex_q, capex_ttm = flujo("capex")
    eps_trim, eps_anual = trimestres_discretos(_filas(facts, "eps", unidad_ps), por_accion, modo="por_accion")
    eps_ttm = serie_ttm(eps_trim, eps_anual)
    shd_q, _ = trimestres_discretos(_filas(facts, "shares_dil", "shares"), acciones, modo="promedio")

    if not rev_ttm and not eps_ttm and not ni_ttm:
        return {"ticker": ticker, "nombre": nombre, "disponible": False,
                "motivo": f"Sin ventas/resultados en EDGAR (moneda {moneda}): ¿fondo o formato no estandar?"}

    ebitda_q = _combinar(op_q, da_q, lambda a, b: a + b)
    ebitda_ttm = _combinar(op_ttm, da_ttm, lambda a, b: a + b)
    # Capex: si la empresa nunca lo informa (bancos, aseguradoras) se toma 0.
    if capex_ttm:
        fcf_q = _combinar(cfo_q, capex_q, lambda a, b: a - b)
        fcf_ttm = _combinar(cfo_ttm, capex_ttm, lambda a, b: a - b)
    else:
        fcf_q, fcf_ttm = dict(cfo_q), dict(cfo_ttm)

    # Balance
    cash = instantaneos(_filas(facts, "cash", moneda))
    inv_cp = instantaneos(_filas(facts, "inv_cp", moneda))
    caja = {e: (v + inv_cp[e][0], max(f, inv_cp[e][1])) if e in inv_cp else (v, f) for e, (v, f) in cash.items()}
    lp = instantaneos(_filas(facts, "deuda_lp", moneda))
    lp_total = instantaneos(_filas(facts, "deuda_total_lp", moneda))
    cp = instantaneos(_filas(facts, "deuda_cp", moneda))
    st = instantaneos(_filas(facts, "deuda_st", moneda))
    deuda = {}
    for e in set(lp) | set(lp_total) | set(cp) | set(st):
        partes = []
        if e in lp:
            partes.append(lp[e])
            if e in cp:
                partes.append(cp[e])
            elif e in st:
                partes.append(st[e])
        elif e in lp_total:
            partes.append(lp_total[e])
            if e in st:
                partes.append(st[e])
        else:
            partes += [x[e] for x in (cp, st) if e in x][:1]
        if partes:
            deuda[e] = (sum(p[0] for p in partes), max(p[1] for p in partes))
    equity = instantaneos(_filas(facts, "equity", moneda))

    # Acciones para market cap (ver _elegir_acciones).
    precio_hoy = float(hist["Close"].dropna().iloc[-1]) if hist["Close"].notna().any() else None
    sh_out, fuente_acciones, acciones_constantes = _elegir_acciones(
        facts, acciones, shd_q, extranjero, yahoo_fila, precio_hoy
    )

    frecuencia = "trimestral" if _vigencia_dias(rev_ttm or ni_ttm) < 300 else "anual"
    # La API XBRL de la SEC (companyfacts) a veces no incorpora los hechos de
    # un reporte aunque ya este presentado (visto en 2026 con los 20-F/6-K en
    # IFRS: TSM, GGAL). Se detecta comparando el ultimo filing periodico
    # (submissions) contra el ultimo `filed` de ventas/resultado/EPS: si hay
    # mas de 45 dias de diferencia, los datos contables estan atrasados.
    ultimo_dato = max((f for d in (rev_ttm, ni_ttm, eps_ttm) for _v, f in d.values()), default=None)
    ultimo_filing = hechos.get("ultimo_filing") or ""
    atraso = None
    if ultimo_dato and ultimo_filing and _dias(ultimo_dato, ultimo_filing) > 45:
        atraso = {"ultimo_filing": ultimo_filing, "ultimo_form": hechos.get("ultimo_form"), "ultimo_dato": ultimo_dato}
    # Reportante anual con un 20-F que la API no tiene: desde que ese reporte
    # se presento, el ultimo dato disponible ya tiene un anio de atraso real
    # (el mercado conocia el ejercicio nuevo). Los multiplos se cortan ahi en
    # vez de mostrar, por ejemplo, un P/E contra el EPS de hace dos ejercicios.
    # (Trimestrales: solo se marca; el atraso es de un trimestre.)
    corte = atraso["ultimo_filing"] if atraso and frecuencia == "anual" else None

    # --- Semanal ---
    hoy = pd.Timestamp(date.today())
    inicio = hoy - pd.DateOffset(years=ANIOS_HISTORIA)
    diario = hist[hist.index >= inicio - pd.Timedelta(days=10)]
    fechas = pd.date_range(max(diario.index.min(), inicio), diario.index.max(), freq="W-FRI")
    if diario.index.max() > fechas[-1]:
        fechas = fechas.append(pd.DatetimeIndex([diario.index.max().normalize()]))
    precio = diario["Close"].reindex(diario.index.union(fechas)).ffill().reindex(fechas)
    divs = hist["Dividends"] if "Dividends" in hist.columns else pd.Series(dtype=float)
    divs = divs[divs > 0]
    div_12m = pd.Series([divs[(divs.index > f - pd.Timedelta(days=365)) & (divs.index <= f)].sum() for f in fechas], index=fechas)

    if moneda == "USD":
        fx = pd.Series(1.0, index=fechas)
    else:
        fx_d = fx_por_usd(moneda)
        fx = fx_d.reindex(fx_d.index.union(fechas)).ffill().reindex(fechas)

    precio_actual = float(precio.dropna().iloc[-1]) if precio.notna().any() else None
    ratio_adr, ratio_estimado = 1.0, False
    if extranjero:
        ult_acc = sh_out[max(sh_out)][0] if sh_out else None
        ratio_adr, ratio_estimado = _ratio_adr(ult_acc, (yahoo_fila or {}).get("market_cap_usd"), precio_actual)
        if acciones_constantes or ratio_adr is None:
            ratio_adr, ratio_estimado = 1.0, True

    w = lambda pts: a_semanal(pts, fechas)  # noqa: E731
    if acciones_constantes:
        acc_w = pd.Series(acciones_constantes, index=fechas)  # ya en ADR/USD de Yahoo
    else:
        # Las acciones cambian poco: se arrastran hasta 2 anios (un 20-F
        # atrasado en la API no deja al ADR sin market cap).
        acc_w = a_semanal(sh_out, fechas, vigencia=730) / ratio_adr  # acciones equivalentes en ADR
    mcap = precio * acc_w
    deuda_usd = w(deuda).fillna(0) / fx
    caja_usd = w(caja).fillna(0) / fx
    ev = mcap + deuda_usd - caja_usd
    rev_w = w(rev_ttm) / fx
    ebitda_w = w(ebitda_ttm) / fx
    fcf_w = w(fcf_ttm) / fx
    eq_w = w(equity) / fx
    eps_w = w(eps_ttm) * ratio_adr / fx  # EPS por ADR en USD

    positivo = lambda s: s.where(s > 0)  # noqa: E731
    if eps_ttm:
        pe = precio / positivo(eps_w)
    else:
        # Sin EPS en EDGAR (ej. V: lo reporta solo por clase de accion, con
        # dimensiones que companyfacts no trae): P/E = market cap / resultado
        # neto TTM, que es lo mismo sin pasar por "por accion".
        pe = mcap / positivo(w(ni_ttm) / fx)
    ps = mcap / positivo(rev_w)
    # EV <= 0 (caja > market cap + deuda: bancos, holdings con mucha caja)
    # tampoco da un multiplo interpretable.
    ev_sales = positivo(ev) / positivo(rev_w)
    ev_ebitda = positivo(ev) / positivo(ebitda_w)
    p_fcf = mcap / positivo(fcf_w)
    pb = mcap / positivo(eq_w)
    fcf_yield = fcf_w / mcap * 100
    div_yield = (div_12m / precio * 100).where(precio > 0)
    if corte:
        despues = fechas > pd.Timestamp(corte)
        for serie_m in (ev, pe, ps, ev_sales, ev_ebitda, p_fcf, pb, fcf_yield):
            serie_m[despues] = np.nan
    # Sin cobertura de EPS (ej. ADR sin EPS por ADR) el P/E queda vacio; si
    # hay precio pero ningun multiplo en toda la serie, no sirve.
    # Empresas sin ventas y con perdidas (mineras/nucleares pre-ingresos, ej.
    # LAC, OKLO) no tienen P/E ni P/S, pero si market cap, P/B y FCF yield.
    if not any(s.notna().any() for s in (pe, ps, ev_sales, pb, mcap)):
        motivo = ("Hay estados contables pero no se pudo armar ni el market cap: "
                  "EDGAR no trae la cantidad de acciones de esta empresa.")
        return {"ticker": ticker, "nombre": nombre, "disponible": False, "motivo": motivo}

    # Recorte: la serie arranca en la primera semana con algun multiplo.
    validos = pe.notna() | ps.notna() | ev_sales.notna() | pb.notna() | mcap.notna()
    primero = validos.idxmax()
    sel = fechas >= primero
    fechas_out = fechas[sel]

    def col(s, fn):
        return [fn(v) for v in s[sel].tolist()]

    m2 = lambda v: num(v, 2)  # noqa: E731
    m4 = _sig4
    semanal = {
        "inicio": fechas_out[0].strftime("%Y-%m-%d"),
        # Todas las semanas son viernes consecutivos salvo la ultima (dato
        # del dia): se publican las fechas explicitas de esa ultima.
        "ultima": fechas_out[-1].strftime("%Y-%m-%d"),
        "precio": col(precio, m4),
        # market cap y EV en MILLONES de USD (13 digitos -> 7 por semana)
        "mcap": col(mcap / 1e6, m4),
        "ev": col(ev / 1e6, m4),
        "pe": col(pe, m2),
        "ps": col(ps, m2),
        "ev_sales": col(ev_sales, m2),
        "ev_ebitda": col(ev_ebitda, m2),
        "p_fcf": col(p_fcf, m2),
        "pb": col(pb, m2),
        "fcf_yield": col(fcf_yield, m2),
        "div_yield": col(div_yield, m2),
    }

    # --- Trimestral / TTM (por fecha de cierre, con fecha "conocido") ---
    corte_fin = (inicio - pd.DateOffset(years=1)).strftime("%Y-%m-%d")
    fines_q = sorted(e for e in set(rev_q) | set(ni_q) | set(eps_trim) | set(cfo_q) if e >= corte_fin)
    conocido_q = {}
    for d in (rev_q, ni_q, eps_trim, op_q, cfo_q):
        for e, (_v, f) in d.items():
            conocido_q[e] = min(f, conocido_q.get(e, f))

    def qcol(d, fn=m4):
        return [fn(d[e][0]) if e in d else None for e in fines_q]

    trimestres = {
        "fin": fines_q,
        "conocido": [conocido_q.get(e) for e in fines_q],
        "revenue": qcol(rev_q), "gross": qcol(gross_q), "op": qcol(op_q), "ni": qcol(ni_q),
        "da": qcol(da_q), "ebitda": qcol(ebitda_q), "eps": qcol(eps_trim, lambda v: num(v, 3)),
        "shares": qcol(shd_q), "cfo": qcol(cfo_q), "capex": qcol(capex_q), "fcf": qcol(fcf_q),
        "deuda": qcol(deuda), "caja": qcol(caja), "equity": qcol(equity),
    }

    m_bruto = _margen(gross_ttm, rev_ttm)
    m_oper = _margen(op_ttm, rev_ttm)
    m_neto = _margen(ni_ttm, rev_ttm)
    m_fcf = _margen(fcf_ttm, rev_ttm)
    rev_yoy = _yoy(rev_ttm)
    eps_yoy = _yoy(eps_ttm)
    series_ttm = {
        "revenue": rev_ttm, "gross": gross_ttm, "op": op_ttm, "ni": ni_ttm, "ebitda": ebitda_ttm,
        "eps": eps_ttm, "fcf": fcf_ttm, "m_bruto": m_bruto, "m_oper": m_oper, "m_neto": m_neto,
        "m_fcf": m_fcf, "rev_yoy": rev_yoy, "eps_yoy": eps_yoy,
    }
    # Cada serie TTM va como lista de [fin, conocido, valor] ya filtrada por
    # conocidos() (sin "datos viejos que llegan tarde"): el front la arrastra
    # semana a semana igual que aca, por fecha de presentacion.
    # corte: el front no arrastra los TTM mas alla de esta fecha (ver arriba).
    ttm = {"vigencia": {}, "corte": corte}
    for clave, pts in series_ttm.items():
        pts = {e: v for e, v in pts.items() if e >= corte_fin}
        fmt = (lambda v: num(v, 3)) if clave == "eps" else (m2 if clave.startswith(("m_", "rev_yoy", "eps_yoy")) else m4)
        ttm[clave] = [[e, f, fmt(v)] for f, e, v in conocidos(pts)]
        ttm["vigencia"][clave] = _vigencia_dias(pts) if pts else 460

    return {
        "ticker": ticker,
        "nombre": nombre or hechos.get("nombre") or ticker,
        "disponible": True,
        "cik": int(cik),
        "entidad": hechos.get("nombre"),
        "moneda": moneda,
        "extranjero": extranjero,
        "adr_ratio": ratio_adr,
        "adr_ratio_estimado": ratio_estimado,
        "acciones_fuente": fuente_acciones,
        "frecuencia": frecuencia,
        "ultimo_filing": hechos.get("ultimo_filing"),
        "ultimo_form": hechos.get("ultimo_form"),
        "desde_cache": hechos.get("_desde_cache"),
        "atraso_sec": atraso,
        "semanal": semanal,
        "trimestres": trimestres,
        "ttm": ttm,
    }


# ---------------------------------------------------------------------------
# Indice (listado liviano con valor actual + percentil 5 anios)
# ---------------------------------------------------------------------------
CLAVES_INDICE = ["pe", "ps", "ev_sales", "ev_ebitda", "p_fcf", "pb", "fcf_yield", "div_yield"]


def percentil(valores, actual):
    """% de observaciones por debajo del valor actual (los empates cuentan
    la mitad). Misma definicion que el front (historicoDerivados.js)."""
    if actual is None or not valores:
        return None
    menores = sum(1 for v in valores if v < actual)
    iguales = sum(1 for v in valores if v == actual)
    return round((menores + 0.5 * iguales) / len(valores) * 100)


def resumen_indice(r):
    base = {"ticker": r["ticker"], "nombre": r.get("nombre"), "disponible": bool(r.get("disponible"))}
    if not r.get("disponible"):
        base["motivo"] = r.get("motivo")
        return base
    sem = r["semanal"]
    n = len(sem["precio"])
    inicio = date.fromisoformat(sem["inicio"])
    fechas = [inicio + timedelta(days=7 * i) for i in range(n)]
    corte = date.today() - timedelta(days=5 * 365)
    actual, pctl = {}, {}
    for k in CLAVES_INDICE:
        serie = sem[k]
        ult = serie[-1] if serie else None
        actual[k] = ult
        v5 = [v for f, v in zip(fechas, serie) if f >= corte and v is not None]
        pctl[k] = percentil(v5, ult) if len(v5) >= 26 else None
    base.update(
        {
            "moneda": r.get("moneda"),
            "frecuencia": r.get("frecuencia"),
            "desde": sem["inicio"],
            "hasta": sem["ultima"],
            "actual": actual,
            "percentil_5y": pctl,
        }
    )
    if r.get("atraso_sec"):
        base["atraso_sec"] = r["atraso_sec"]
    if r.get("stale"):
        base["stale"] = True
    return base


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def _procesar(ticker, nombre, industria, cik, yahoo_fila, ciks_completos=True):
    if simbolo_sec(ticker) is None:
        return {"ticker": ticker, "nombre": nombre, "disponible": False,
                "motivo": "Cotiza solo en Merval/B3: no reporta a la SEC."}
    if (industria or "").upper() == "ETF" or (yahoo_fila or {}).get("industria") == "ETF":
        return {"ticker": ticker, "nombre": nombre, "disponible": False,
                "motivo": "ETF / fondo: no tiene estados contables propios."}
    if not cik and not ciks_completos:
        return {"ticker": ticker, "nombre": nombre, "disponible": False,
                "motivo": "Error: no se pudo consultar el registro de CIKs de la SEC", "_error": True}
    try:
        return calcular_ticker(ticker, nombre, cik, yahoo_fila)
    except Exception as e:  # noqa: BLE001
        return {"ticker": ticker, "nombre": nombre, "disponible": False, "motivo": f"Error: {e}", "_error": True}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Historico fundamental (SEC EDGAR + yfinance) -> public/data/fundamental/")
    ap.add_argument("--out", type=Path, default=DIR_DATOS_PUBLICOS / "fundamental")
    ap.add_argument("--tickers", help="lista separada por comas (default: todo listado.json)")
    ap.add_argument("--workers", type=int, default=WORKERS)
    args = ap.parse_args(argv)
    t0 = time.monotonic()
    args.out.mkdir(parents=True, exist_ok=True)
    # La carpeta del cache tiene que existir aunque no se baje nada: el paso
    # de commit del workflow la nombra y git falla con un pathspec vacio.
    DIR_CACHE_EDGAR.mkdir(parents=True, exist_ok=True)
    (DIR_CACHE_EDGAR / ".gitkeep").touch()
    ruta_indice = args.out / "indice.json"

    universo = leer_universo()
    if args.tickers:
        pedidos = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        nombres = {t: (n, ind) for t, n, ind in universo}
        universo = [(t, *nombres.get(t, (t, None))) for t in pedidos]
    print(f"Historico fundamental: {len(universo)} ticker(s)")
    yahoo = leer_fundamentales_yahoo()
    simbolos = sorted({simbolo_sec(t) for t, _n, _i in universo if simbolo_sec(t)})
    ciks, ciks_completos = resolver_ciks(simbolos)

    previo_indice = {r.get("ticker"): r for r in (leer_json(ruta_indice, {}) or {}).get("tickers", []) if isinstance(r, dict)}
    resultados = {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futuros = {
            pool.submit(_procesar, t, n, ind, ciks.get(simbolo_sec(t) or ""), yahoo.get(t), ciks_completos): t
            for t, n, ind in universo
        }
        for i, fut in enumerate(as_completed(futuros), 1):
            t = futuros[fut]
            r = fut.result()
            ruta_t = args.out / f"{t}.json"
            if r.pop("_error", False):
                # Un error puntual (SEC/Yahoo caidos) no borra lo publicado:
                # queda el JSON anterior y el indice lo marca stale.
                print(f"  ! {t}: {r['motivo']}")
                prev = previo_indice.get(t)
                if prev and prev.get("disponible") and ruta_t.exists():
                    resultados[t] = {**prev, "stale": True}
                    continue
                resultados[t] = resumen_indice(r)
                continue
            if r.get("disponible"):
                r["actualizado"] = datetime.now(TZ).isoformat()
                escribir_json(ruta_t, r, ignorar_claves=("actualizado", "desde_cache"), silencioso=True)
            elif ruta_t.exists():
                ruta_t.unlink()
            resultados[t] = resumen_indice(r)
            if i % 25 == 0:
                print(f"  {i}/{len(universo)} ({time.monotonic() - t0:.0f}s)")

    # Indice: en corridas parciales (--tickers) se conservan los demas.
    if args.tickers:
        combinado = {**previo_indice, **resultados}
    else:
        combinado = resultados
        vigentes = set(combinado) | {"indice"}
        for archivo in args.out.glob("*.json"):
            if archivo.stem not in vigentes:
                archivo.unlink()
    orden = sorted(combinado.values(), key=lambda r: (not r.get("disponible"), r["ticker"]))
    escribir_json(ruta_indice, {"actualizado": datetime.now(TZ).isoformat(), "tickers": orden}, ignorar_claves=("actualizado",))

    disp = sum(1 for r in resultados.values() if r.get("disponible"))
    motivos = defaultdict(int)
    for r in resultados.values():
        if not r.get("disponible"):
            motivos[(r.get("motivo") or "?").split(":")[0][:60]] += 1
    print(f"Listo en {time.monotonic() - t0:.0f}s: {disp}/{len(resultados)} disponibles.")
    for m, c in sorted(motivos.items(), key=lambda kv: -kv[1]):
        print(f"  no disponible x{c}: {m}")


if __name__ == "__main__":
    main()
