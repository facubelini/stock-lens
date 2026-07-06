"""Pipeline de datos de Stock Lens.

Lee data/tickers.xlsx, descarga datos diarios con yfinance, calcula los
indicadores y escribe los JSON estaticos que consume el frontend en
public/data/. No requiere API keys.

Uso:
    python scripts/generar_datos.py
"""

import json
import math
import re
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yfinance as yf

from comparables_universo import INDUSTRIA_COMPARABLES

# --- Rutas y constantes ---
RAIZ = Path(__file__).resolve().parent.parent
ARCHIVO_TICKERS = RAIZ / "data" / "tickers.xlsx"
DIR_SALIDA = RAIZ / "public" / "data"
TZ = ZoneInfo("America/Argentina/Buenos_Aires")

# Claves de ratios usadas tanto para la mediana de industria en Fundamentales
# como para la mediana del universo de comparables.
CLAVES_BENCH = [
    "per_trailing", "per_forward", "peg", "ev_sales", "pb", "ps", "market_cap",
    "eps", "profit_margin", "roe", "dividend_yield", "beta", "debt_to_equity", "current_ratio",
]

# Encabezados aceptados para la columna de tickers (se normalizan sin acentos).
NOMBRES_TICKER = ["ticker", "codigo", "symbol", "simbolo", "code", "tickers"]
# 5y (no cuesta requests extra, es el mismo history() con mas filas): hace
# falta para que semanal (SMA52 ~ 1 ano) y mensual (SMA36 ~ 3 anos) del
# screener tengan velas suficientes. 2y ya alcanzaba para SMA200/EMA150 diario.
PERIODO_HISTORICO = "5y"
# Si el ticker "pelado" no trae datos, se reintenta con estos sufijos:
# .SA = B3 (Brasil), .BA = BYMA (Argentina).
SUFIJOS = ["", ".SA", ".BA"]
RUTA_HISTORIAL = DIR_SALIDA / "screener_historial.json"
DIAS_HISTORIAL = 90


# ---------------------------------------------------------------------------
# Lectura del Excel de entrada
# ---------------------------------------------------------------------------
def _norm(s):
    """Normaliza un encabezado: sin acentos, minúsculas, sin espacios extra."""
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode("ascii")
    return s.strip().lower()


def leer_tickers():
    """Lee data/tickers.xlsx. Sólo la columna de tickers es obligatoria
    (acepta encabezados Ticker, Codigo, Symbol, etc.). Industria, Pais y
    Nombre son opcionales: si faltan, se derivan de yfinance (sector/country/
    nombre) en el procesamiento. Devuelve un DataFrame Ticker/Industria/Pais/Nombre."""
    if not ARCHIVO_TICKERS.exists():
        raise SystemExit(
            f"No se encontro {ARCHIVO_TICKERS}.\n"
            "Subi tu Excel de tickers (ver columnas en el README)."
        )

    df = pd.read_excel(ARCHIVO_TICKERS, engine="openpyxl")
    df.columns = [str(c).strip() for c in df.columns]
    norm_map = {_norm(c): c for c in df.columns}

    col_ticker = next((norm_map[n] for n in NOMBRES_TICKER if n in norm_map), None)
    if col_ticker is None:
        if len(df.columns) == 1:
            col_ticker = df.columns[0]  # una sola columna => es la de tickers
        else:
            raise SystemExit(
                "No encontre la columna de tickers. Usa un encabezado como "
                f"'Ticker' o 'Codigo'. Columnas: {list(df.columns)}"
            )

    def opcional(nombre):
        c = norm_map.get(nombre)
        return df[c].astype(str).str.strip() if c is not None else ""

    out = pd.DataFrame(
        {"Ticker": df[col_ticker].astype(str).str.upper().str.replace(r"\s+", "", regex=True)}
    )
    out["Industria"] = opcional("industria")
    out["Pais"] = opcional("pais")
    out["Nombre"] = opcional("nombre")
    for c in ("Industria", "Pais", "Nombre"):
        out[c] = out[c].replace({"nan": "", "NAN": "", "None": ""})

    out = out[out["Ticker"].str.len() > 0]
    out = out[~out["Ticker"].str.lower().isin(["nan", "none"])]
    out = out.drop_duplicates(subset="Ticker")
    return out.reset_index(drop=True)


# ---------------------------------------------------------------------------
# Indicadores
# ---------------------------------------------------------------------------
def num(v, dec=2):
    """Redondea a 'dec' decimales; None si no es un numero finito."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, dec)


def rsi_wilder(closes, period=14):
    """RSI de Wilder (suavizado exponencial 1/period, con semilla = media simple
    de las primeras 'period' variaciones). Devuelve el ultimo valor o None."""
    closes = np.asarray(closes, dtype="float64")
    if len(closes) < period + 1:
        return None
    deltas = np.diff(closes)
    semilla = deltas[:period]
    avg_gain = semilla[semilla > 0].sum() / period
    avg_loss = -semilla[semilla < 0].sum() / period
    for d in deltas[period:]:
        gain = d if d > 0 else 0.0
        loss = -d if d < 0 else 0.0
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def dist_pct(precio, media):
    """Distancia porcentual del precio a una media: (precio/media - 1) * 100."""
    if media is None or (isinstance(media, float) and (math.isnan(media) or media == 0)):
        return None
    return (precio / media - 1) * 100


# ---------------------------------------------------------------------------
# Screener multi-temporalidad (Estado/Trend/Score/Setup del indicador Pine)
# ---------------------------------------------------------------------------
# Perfiles de medias por temporalidad. "clave" es el indice (en "medias") de
# la media usada para pullback/extension/tendencia (equivalente a "maKey" del
# indicador: la media "media" en diario, la "larga" en semanal/mensual).
# Los periodos de semanal/mensual son mas cortos que los del Pine original
# (EMA40/SMA100/SMA200) porque ese usa el timeframe que tengas abierto en
# TradingView (con anios de historial atras); aca se recalculan las 3
# temporalidades juntas a partir de 5y de velas diarias, asi que se escalan
# para tener margen real de velas (SMA52 semanal ~ 1 ano, SMA36 mensual ~ 3
# anos) en vez de pedir de mas (SMA200 mensual pediria ~17 anos de historial).
PERFIL_DIARIO = {
    "medias": [("EMA21", "ema", 21), ("EMA50", "ema", 50), ("EMA150", "ema", 150)],
    "clave": 1,
    "slope_lookback": 10,
}
PERFIL_SEMANAL = {
    "medias": [("EMA10", "ema", 10), ("EMA26", "ema", 26), ("SMA52", "sma", 52)],
    "clave": 2,
    "slope_lookback": 8,
}
PERFIL_MENSUAL = {
    "medias": [("EMA6", "ema", 6), ("EMA18", "ema", 18), ("SMA36", "sma", 36)],
    "clave": 2,
    "slope_lookback": 3,
}

# Confluencia adoptada del "analizador v8" (scanner de CEDEARs/MERVAL del
# usuario, perfil LARGO): en vez de un score aditivo, exige TODO a la vez
# (MACD + SMI + RSI + tendencia) para la señal fuerte, y una zona de pullback
# mas robusta (OR entre la media clave y el ASL, no un solo nivel).
MACD_FAST, MACD_SLOW, MACD_SIGNAL = 12, 26, 9
SMI_LEN, SMI_SMOOTH, SMI_SIGNAL = 14, 3, 3
ASL_LEN = 21  # "Adaptive Support Line": promedio de EMA y WMA lineal, mismo periodo

TOL_ASL = 3.0  # % de distancia al ASL para considerar "en pullback"
TOL_CLAVE = 5.0  # % de distancia a la media clave para considerar "en pullback"
TOL_EXTENSION = 8.0  # % de distancia (a ambas referencias) para considerar "extendido"
NEAR_FACTOR = 1.5  # tolerancia x1.5 para el veredicto "CERCA"
RSI_BULL, RSI_BEAR = 50, 45


def _texto_tendencia(estado):
    return {"Bull": "alcista", "Bear": "bajista"}.get(estado, "neutral")


def _construir_motivo(estado, verdict, nombre_clave, dist_clave, rsi, macd_bull, smi_bull):
    partes = [f"Tendencia {_texto_tendencia(estado)}"]
    if dist_clave is not None:
        lado = "sobre" if dist_clave >= 0 else "bajo"
        partes.append(f"precio {lado} {nombre_clave} ({dist_clave:+.1f}%)")
    if rsi is not None:
        partes.append(f"RSI {rsi:.0f}")
    partes.append(f"MACD {'alcista' if macd_bull else 'bajista'}")
    partes.append(f"SMI {'alcista' if smi_bull else 'bajista'}")
    extra = {
        "COMPRA": "en zona de pullback (media/ASL), listo para entrar",
        "CERCA": "acercándose a la zona de pullback",
        "VENTA": "confluencia bajista confirmada",
        "EXTENDIDO": "muy extendido de ambas referencias, esperar retroceso",
    }.get(verdict)
    if extra:
        partes.append(extra)
    return " · ".join(partes)


def _wma_lineal(serie, periodo):
    """WMA con pesos lineales crecientes (1,2,3...), igual que el analizador v8."""
    return serie.rolling(window=periodo, min_periods=1).apply(
        lambda x: np.average(x, weights=np.arange(1, len(x) + 1)), raw=True
    )


def _calcular_asl(closes, periodo=ASL_LEN):
    ema = closes.ewm(span=periodo, adjust=False).mean()
    wma = _wma_lineal(closes, periodo)
    return (ema + wma) / 2


def _calcular_macd(closes):
    ema_fast = closes.ewm(span=MACD_FAST, adjust=False).mean()
    ema_slow = closes.ewm(span=MACD_SLOW, adjust=False).mean()
    macd = ema_fast - ema_slow
    señal = macd.ewm(span=MACD_SIGNAL, adjust=False).mean()
    return macd, señal


def _calcular_smi(highs, lows, closes, length=SMI_LEN, smooth=SMI_SMOOTH, signal=SMI_SIGNAL):
    """Stochastic Momentum Index doblemente suavizado con EMA (formula del v8)."""
    h_high = highs.rolling(length).max()
    l_low = lows.rolling(length).min()
    mid = (h_high + l_low) / 2

    diff = closes - mid
    diff_e1 = diff.ewm(span=smooth, adjust=False).mean()
    diff_e2 = diff_e1.ewm(span=smooth, adjust=False).mean()

    rng = h_high - l_low
    rng_e1 = rng.ewm(span=smooth, adjust=False).mean()
    rng_e2 = rng_e1.ewm(span=smooth, adjust=False).mean()

    with np.errstate(divide="ignore", invalid="ignore"):
        smi = (diff_e2 / (rng_e2 / 2.0)) * 100
    smi = smi.replace([np.inf, -np.inf], np.nan)
    señal = smi.ewm(span=signal, adjust=False).mean()
    return smi, señal


def perfil_setup(df, medias, clave, slope_lookback):
    """Veredicto de una temporalidad (diaria/semanal/mensual ya resampleada,
    con columnas High/Low/Close). Combina la tendencia por medias adaptativas
    (indicador Pine) con la confluencia MACD+SMI+RSI y la zona de pullback
    ASL/media clave del analizador v8. Devuelve None si no hay velas
    suficientes todavia para esa temporalidad."""
    closes = df["Close"]
    periodo_max = max(p[2] for p in medias)
    minimo = max(periodo_max + slope_lookback, ASL_LEN, MACD_SLOW, SMI_LEN) + 1
    if len(closes) < minimo:
        return None

    series = {}
    for nombre, tipo, periodo in medias:
        series[nombre] = (
            closes.ewm(span=periodo, adjust=False).mean()
            if tipo == "ema"
            else closes.rolling(periodo).mean()
        )

    nombre_clave = medias[clave][0]
    serie_clave = series[nombre_clave]
    ma_clave = serie_clave.iloc[-1]
    ma_clave_prev = serie_clave.iloc[-1 - slope_lookback]
    if pd.isna(ma_clave) or pd.isna(ma_clave_prev):
        return None

    precio = float(closes.iloc[-1])
    rsi = rsi_wilder(closes.values, 14)
    if rsi is None:
        return None

    asl = _calcular_asl(closes).iloc[-1]
    macd, macd_sig = _calcular_macd(closes)
    smi, smi_sig = _calcular_smi(df["High"], df["Low"], closes)
    macd_bull = macd.iloc[-1] > macd_sig.iloc[-1]
    smi_val, smi_sig_val = smi.iloc[-1], smi_sig.iloc[-1]
    smi_bull = not pd.isna(smi_val) and not pd.isna(smi_sig_val) and smi_val > smi_sig_val
    smi_bear = not pd.isna(smi_val) and not pd.isna(smi_sig_val) and smi_val < smi_sig_val

    trend_up = ma_clave > ma_clave_prev
    trend_dn = ma_clave < ma_clave_prev
    tendencia_alcista = precio >= ma_clave and trend_up
    tendencia_bajista = precio < ma_clave and trend_dn
    estado = "Bull" if tendencia_alcista else ("Bear" if tendencia_bajista else "Neutral")

    dist_clave = dist_pct(precio, ma_clave)
    dist_asl = dist_pct(precio, asl) if not pd.isna(asl) else None

    en_zona = (dist_clave is not None and abs(dist_clave) <= TOL_CLAVE) or (
        dist_asl is not None and abs(dist_asl) <= TOL_ASL
    )
    cerca_zona = (dist_clave is not None and abs(dist_clave) <= TOL_CLAVE * NEAR_FACTOR) or (
        dist_asl is not None and abs(dist_asl) <= TOL_ASL * NEAR_FACTOR
    )
    extendido = (dist_clave is None or abs(dist_clave) >= TOL_EXTENSION) and (
        dist_asl is None or abs(dist_asl) >= TOL_EXTENSION
    )

    confluencia_alcista = tendencia_alcista and macd_bull and smi_bull and rsi >= RSI_BULL
    confluencia_bajista = tendencia_bajista and (not macd_bull) and smi_bear and rsi <= RSI_BEAR

    if confluencia_alcista and en_zona:
        verdict = "COMPRA"
    elif confluencia_alcista and cerca_zona:
        verdict = "CERCA"
    elif confluencia_bajista:
        verdict = "VENTA"
    elif tendencia_alcista and extendido:
        verdict = "EXTENDIDO"
    else:
        verdict = "NEUTRAL"

    return {
        "verdict": verdict,
        "estado": estado,
        "rsi": num(rsi, 1),
        "dist_clave": num(dist_clave, 2),
        "dist_asl": num(dist_asl, 2),
        "ma_clave": nombre_clave,
        "motivo": _construir_motivo(estado, verdict, nombre_clave, dist_clave, rsi, macd_bull, smi_bull),
    }


def calcular_screener(hist):
    """Arma el veredicto diario/semanal/mensual a partir del historico diario
    ya descargado (resamplea High/Low/Close a semanal/mensual, no pide datos
    nuevos)."""
    ohlc = hist[["High", "Low", "Close"]].dropna()
    semanales = ohlc.resample("W-FRI").agg({"High": "max", "Low": "min", "Close": "last"}).dropna()
    mensuales = ohlc.resample("ME").agg({"High": "max", "Low": "min", "Close": "last"}).dropna()
    return {
        "diario": perfil_setup(ohlc, **PERFIL_DIARIO),
        "semanal": perfil_setup(semanales, **PERFIL_SEMANAL),
        "mensual": perfil_setup(mensuales, **PERFIL_MENSUAL),
    }


def extraer_fundamentales(info):
    """Extrae los fundamentales de yf.Ticker(t).info, tolerando faltantes.
    Margenes/ROE/Dividend yield se devuelven ya en formato porcentual."""

    def g(k):
        v = info.get(k)
        if isinstance(v, bool):  # algunos campos vienen como bool por error
            return None
        if isinstance(v, (int, float)) and not (isinstance(v, float) and math.isnan(v)):
            return float(v)
        return None

    # Dividend yield: yfinance es inconsistente entre versiones. Preferimos
    # trailingAnnualDividendYield (siempre fraccion) y caemos a dividendYield.
    dy_frac = g("trailingAnnualDividendYield")
    if dy_frac is not None:
        dividend_yield = dy_frac * 100
    else:
        dy = g("dividendYield")
        # Si parece fraccion (<1) la pasamos a %, si ya viene en % la dejamos.
        dividend_yield = (dy * 100 if dy < 1 else dy) if dy is not None else None

    pm = g("profitMargins")
    roe = g("returnOnEquity")
    peg = g("trailingPegRatio")
    if peg is None:
        peg = g("pegRatio")

    return {
        "per_trailing": g("trailingPE"),
        "per_forward": g("forwardPE"),
        "peg": peg,
        "ev_sales": g("enterpriseToRevenue"),
        "pb": g("priceToBook"),
        "ps": g("priceToSalesTrailing12Months"),
        "market_cap": g("marketCap"),
        "eps": g("trailingEps"),
        "profit_margin": pm * 100 if pm is not None else None,
        "roe": roe * 100 if roe is not None else None,
        "dividend_yield": dividend_yield,
        "beta": g("beta"),
        "debt_to_equity": g("debtToEquity"),
        "current_ratio": g("currentRatio"),
        # Consenso de analistas (gratis via yfinance, sin key). recommendation_key
        # es texto ("buy"/"hold"/etc.), se maneja aparte de los campos numericos.
        "target_mean_price": g("targetMeanPrice"),
        "n_analistas": g("numberOfAnalystOpinions"),
        "recommendation_key": info.get("recommendationKey") or None,
    }


def obtener_holdings_etf(tk, quote_type):
    """Top holdings (composicion) de un ETF: que activos tiene adentro y con
    que peso. Solo tiene sentido pedirlo para quoteType == "ETF" (una accion
    comun tira error/vacio). Tolerante a fallos: yfinance a veces no tiene
    este dato para ETFs chicos o de renta fija."""
    if quote_type != "ETF":
        return None
    try:
        top = tk.funds_data.top_holdings
        if top is None or top.empty:
            return None
        out = []
        for simbolo, fila in top.iterrows():
            out.append(
                {
                    "ticker": str(simbolo),
                    "nombre": str(fila.get("Name") or ""),
                    "peso_pct": num(float(fila.get("Holding Percent", 0)) * 100, 2),
                }
            )
        return out or None
    except Exception:  # noqa: BLE001
        return None


TAGS_INSIDER_COMPRA = ("purchase", "buy")
TAGS_INSIDER_VENTA = ("sale", "sell")
DIAS_INSIDER = 180


def resumen_insider(tk):
    """Resumen de transacciones de insiders (directivos/directores comprando o
    vendiendo sus propias acciones) de los ultimos ~6 meses. yfinance no
    clasifica la columna "Transaction" de forma confiable: se interpreta el
    texto libre de "Text" (ej. "Sale at price 295.14 per share.",
    "Purchase at price..."). Compra insider fuerte suele ser señal alcista;
    tolerante a fallos porque esta info es menos estable que precio/info."""
    try:
        df = tk.insider_transactions
    except Exception:  # noqa: BLE001
        return None
    if df is None or df.empty or "Start Date" not in df.columns:
        return None
    try:
        corte = pd.Timestamp.now(tz=None) - pd.Timedelta(days=DIAS_INSIDER)
        fechas = pd.to_datetime(df["Start Date"], errors="coerce")
        reciente = df[fechas >= corte].copy()
        if reciente.empty:
            return {"n_compras": 0, "n_ventas": 0, "valor_compras": 0.0, "valor_ventas": 0.0}
        texto = reciente.get("Text", "").astype(str).str.lower()
        es_compra = texto.str.contains("|".join(TAGS_INSIDER_COMPRA), na=False)
        es_venta = texto.str.contains("|".join(TAGS_INSIDER_VENTA), na=False)
        valores = pd.to_numeric(reciente.get("Value"), errors="coerce").fillna(0)
        return {
            "n_compras": int(es_compra.sum()),
            "n_ventas": int(es_venta.sum()),
            "valor_compras": float(valores[es_compra].sum()),
            "valor_ventas": float(valores[es_venta].sum()),
        }
    except Exception:  # noqa: BLE001
        return None


def _normalizar_industria(s):
    """Normaliza un nombre de industria para matchear contra
    INDUSTRIA_COMPARABLES sin depender del caracter de guion exacto que
    devuelva Yahoo ("-", "–" o "—")."""
    if not s:
        return ""
    s = str(s).replace("—", "-").replace("–", "-")
    s = re.sub(r"\s*-\s*", " - ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip().lower()


def mediana_de(filas, clave):
    vals = sorted(f[clave] for f in filas if f.get(clave) is not None)
    if not vals:
        return None
    n = len(vals)
    m = n // 2
    return vals[m] if n % 2 else (vals[m - 1] + vals[m]) / 2


def construir_comparables(fundamentales):
    """Para cada industria presente en tus tickers que tenga peers curados en
    comparables_universo.INDUSTRIA_COMPARABLES, descarga fundamentales de esos
    peers (livianos: solo .info, sin history) y arma la mediana del grupo."""
    por_industria = {}
    for f in fundamentales:
        por_industria.setdefault(f["industria"], []).append(f)

    tickers_propios = {f["ticker"] for f in fundamentales}
    resultado, sin_mapeo = [], []

    for industria, propios in sorted(por_industria.items()):
        clave = _normalizar_industria(industria)
        peers_curados = INDUSTRIA_COMPARABLES.get(clave)
        if not peers_curados:
            sin_mapeo.append(industria)
            continue

        pares = [{**p, "en_portfolio": True} for p in propios]
        vistos = set(tickers_propios)
        for peer in peers_curados:
            if peer in vistos:
                continue
            vistos.add(peer)
            try:
                info = yf.Ticker(peer).info or {}
            except Exception:  # noqa: BLE001
                continue
            if not info:
                continue
            nombre = info.get("shortName") or info.get("longName") or peer
            fund = extraer_fundamentales(info)
            mc = fund.pop("market_cap")
            pares.append(
                {
                    "ticker": peer,
                    "nombre": nombre,
                    "industria": industria,
                    "en_portfolio": False,
                    **{k: num(v, 2) for k, v in fund.items()},
                    "market_cap": int(mc) if mc else None,
                    "sector": info.get("sector") or None,
                }
            )

        resultado.append(
            {
                "industria": industria,
                "pares": pares,
                "mediana": {k: num(mediana_de(pares, k), 2) for k in CLAVES_BENCH},
            }
        )

    if sin_mapeo:
        print(f"\n(Sin comparables curados para: {', '.join(sin_mapeo)})")

    return resultado


# ---------------------------------------------------------------------------
# Escritura de salidas
# ---------------------------------------------------------------------------
def escribir(nombre, obj):
    ruta = DIR_SALIDA / nombre
    with open(ruta, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    print(f"  -> {ruta.relative_to(RAIZ)}")


def _base_ticker(sym):
    """Le saca el sufijo .SA/.BA a un simbolo resuelto, para poder matchear
    contra el ticker "pelado" del Excel."""
    return re.sub(r"\.(SA|BA)$", "", str(sym))


def cargar_lista_previa(nombre, clave=None):
    """Carga un JSON de la corrida anterior (si existe), indexado por ticker
    pelado. Sirve para arrastrar el ultimo dato bueno de un ticker que falla
    en la corrida actual (yfinance flaky / rate-limit puntual) en vez de que
    desaparezca del todo hasta la proxima corrida exitosa."""
    ruta = DIR_SALIDA / nombre
    if not ruta.exists():
        return {}
    try:
        data = json.loads(ruta.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    lista = data.get(clave) if clave else data
    if not isinstance(lista, list):
        return {}
    return {_base_ticker(f["ticker"]): f for f in lista if f.get("ticker")}


def actualizar_historial_screener(screener_actual, ahora):
    """Agrega (o pisa, si ya se corrio hoy) la entrada de hoy en el historial
    de veredictos del screener, y recorta lo mas viejo que DIAS_HISTORIAL.
    Solo guarda el verdict por temporalidad (no el detalle completo) para que
    el JSON no crezca de mas."""
    historial = []
    if RUTA_HISTORIAL.exists():
        try:
            historial = json.loads(RUTA_HISTORIAL.read_text(encoding="utf-8"))
            if not isinstance(historial, list):
                historial = []
        except Exception:  # noqa: BLE001
            historial = []

    hoy = ahora.strftime("%Y-%m-%d")
    historial = [h for h in historial if h.get("fecha") != hoy]
    tickers_hoy = {
        f["ticker"]: {
            tf: (f.get(tf) or {}).get("verdict")
            for tf in ("diario", "semanal", "mensual")
            if f.get(tf)
        }
        for f in screener_actual
    }
    historial.append({"fecha": hoy, "tickers": tickers_hoy})

    corte = (ahora - timedelta(days=DIAS_HISTORIAL)).strftime("%Y-%m-%d")
    historial = [h for h in historial if h.get("fecha", "") >= corte]
    historial.sort(key=lambda h: h["fecha"])
    return historial


def resolver_ticker(t):
    """Descarga el historico probando el ticker tal cual y, si no hay datos,
    con sufijos .SA (Brasil) y .BA (Argentina). Devuelve
    (simbolo_resuelto, tk, hist, closes) o (None, None, None, None)."""
    for suf in SUFIJOS:
        sym = f"{t}{suf}"
        try:
            tk = yf.Ticker(sym)
            hist = tk.history(period=PERIODO_HISTORICO, interval="1d", auto_adjust=True)
        except Exception:  # noqa: BLE001
            continue
        if hist is None or hist.empty or "Close" not in hist.columns:
            continue
        closes = hist["Close"].dropna()
        if len(closes) >= 2:
            return sym, tk, hist, closes
    return None, None, None, None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    DIR_SALIDA.mkdir(parents=True, exist_ok=True)
    tickers = leer_tickers()
    print(f"Procesando {len(tickers)} tickers (periodo {PERIODO_HISTORICO})...\n")

    ahora = datetime.now(TZ)
    ahora_iso = ahora.isoformat()

    # Datos de la corrida anterior, para arrastrar el ultimo dato bueno de un
    # ticker que falla hoy (yfinance flaky) en vez de que desaparezca del
    # listado hasta la proxima corrida exitosa.
    prev_listado = cargar_lista_previa("listado.json", clave="acciones")
    prev_medias = cargar_lista_previa("medias.json")
    prev_fundamentales = cargar_lista_previa("fundamentales.json")
    prev_screener = cargar_lista_previa("screener.json")

    listado, medias, fundamentales, screener, invalidos = [], [], [], [], []

    for _, fila in tickers.iterrows():
        t = fila["Ticker"]

        sym, tk, hist, closes = resolver_ticker(t)
        if sym is None:
            invalidos.append(t)
            previo = prev_listado.get(t)
            if previo:
                print(f"  ~ {t}: sin datos ahora, se mantiene el ultimo dato ({previo.get('actualizado', '?')})")
                listado.append({**previo, "stale": True})
                if t in prev_medias:
                    medias.append({**prev_medias[t], "stale": True})
                if t in prev_fundamentales:
                    fundamentales.append({**prev_fundamentales[t], "stale": True})
                if t in prev_screener:
                    screener.append({**prev_screener[t], "stale": True})
            else:
                print(f"  ! {t}: sin datos (probe .SA / .BA)")
            continue

        # info (fundamentales) — tolerante a fallos de red / campos faltantes.
        try:
            info = tk.info or {}
        except Exception:  # noqa: BLE001
            info = {}

        # Industria/Pais/Nombre: del Excel si vienen; si no, se derivan de yfinance.
        # "industry" es la clasificacion granular de Yahoo (ej. "Semiconductors"),
        # mas especifica que "sector" (ej. "Technology"). Si falta, cae a sector.
        nombre = fila["Nombre"] or info.get("shortName") or info.get("longName") or sym
        industria = fila["Industria"] or info.get("industry") or info.get("sector") or "Sin clasificar"
        pais = fila["Pais"] or info.get("country") or "Sin país"

        precio = float(closes.iloc[-1])
        anterior = float(closes.iloc[-2])
        var_pct = (precio / anterior - 1) * 100 if anterior else None
        rsi = rsi_wilder(closes.values, 14)

        ema21 = closes.ewm(span=21, adjust=False).mean().iloc[-1]
        ema50 = closes.ewm(span=50, adjust=False).mean().iloc[-1]
        ema150 = closes.ewm(span=150, adjust=False).mean().iloc[-1]
        sma200 = closes.rolling(200).mean().iloc[-1] if len(closes) >= 200 else None

        base = {
            "ticker": sym,
            "nombre": nombre,
            "industria": industria,
            "pais": pais,
            "actualizado": ahora_iso,
            "stale": False,
        }

        # Sparkline: ultimas ~180 ruedas (~8-9 meses) de cierre. El sparkline
        # chico de las tarjetas de Listado usa las mismas ~180 (se ve igual,
        # mas denso) y la vista de detalle de ticker lo agranda para que
        # sirva como grafico de precio real.
        spark = [round(float(x), 2) for x in closes.tail(180).tolist()]
        # Rango de 52 semanas (o lo que haya, para tickers con poco historial).
        ventana_52w = closes.tail(min(len(closes), 252))
        high_52w = float(ventana_52w.max())
        low_52w = float(ventana_52w.min())

        listado.append(
            {
                **base,
                "var_pct": num(var_pct, 2),
                "rsi": num(rsi, 2),
                "spark": spark,
                "high_52w": num(high_52w, 2),
                "low_52w": num(low_52w, 2),
            }
        )

        medias.append(
            {
                **base,
                "precio": num(precio, 2),
                "dist_ema21": num(dist_pct(precio, ema21), 2),
                "dist_ema50": num(dist_pct(precio, ema50), 2),
                "dist_ema150": num(dist_pct(precio, ema150), 2),
                "dist_sma200": num(dist_pct(precio, sma200), 2),
            }
        )

        fund = extraer_fundamentales(info)
        mc = fund.pop("market_cap")
        recommendation_key = fund.pop("recommendation_key")  # texto, no pasa por num()
        target_mean_price = fund.get("target_mean_price")
        upside_pct = ((target_mean_price / precio - 1) * 100) if target_mean_price and precio else None
        insider = resumen_insider(tk)
        holdings = obtener_holdings_etf(tk, info.get("quoteType"))
        fundamentales.append(
            {
                **base,
                **{k: num(v, 2) for k, v in fund.items()},
                "market_cap": int(mc) if mc else None,
                "sector": info.get("sector") or None,
                "recommendation_key": recommendation_key,
                "upside_pct": num(upside_pct, 2),
                "insider": insider,
                "holdings": holdings,
            }
        )

        screener.append({**base, **calcular_screener(hist)})

        print(f"  ok {sym} ({nombre})")

    # Promedios por industria para listado.json
    promedios = []
    if listado:
        df_l = pd.DataFrame(listado)
        for industria, g in df_l.groupby("industria", sort=True):
            promedios.append(
                {
                    "industria": industria,
                    "rsi_promedio": num(g["rsi"].mean(), 2),
                    "var_pct_promedio": num(g["var_pct"].mean(), 2),
                    "n": int(len(g)),
                }
            )

    # Salvaguarda: si esta corrida consiguio datos FRESCOS (no arrastrados) de
    # muchos menos tickers que la ultima (tipico de un rate-limit de Yahoo en
    # CI), no pisar los datos buenos. Se mide sobre frescos, no sobre el total
    # con arrastre, porque con arrastre el listado se ve "completo" aunque
    # yfinance haya fallado para casi todos hoy.
    anterior_frescos = 0
    meta_prev = DIR_SALIDA / "meta.json"
    if meta_prev.exists():
        try:
            meta_datos_prev = json.loads(meta_prev.read_text(encoding="utf-8"))
            anterior_frescos = int(meta_datos_prev.get("n_frescos", meta_datos_prev.get("n_tickers", 0)) or 0)
        except Exception:  # noqa: BLE001
            anterior_frescos = 0

    n_frescos = sum(1 for f in listado if not f.get("stale"))
    if anterior_frescos and n_frescos < anterior_frescos * 0.5:
        print(
            f"\nABORTO la escritura: {n_frescos} frescos vs {anterior_frescos} previos "
            "(posible rate-limit). Se conservan los datos anteriores."
        )
        return

    n_arrastrados = sum(1 for f in listado if f.get("stale"))
    meta = {
        "ultima_actualizacion": ahora_iso,
        "n_tickers": len(listado),
        "n_frescos": n_frescos,
        "tickers_invalidos": invalidos,
    }

    print("\nArmando comparables por industria...")
    comparables = construir_comparables(fundamentales)

    n_compra = sum(
        1 for f in screener if any((f.get(tf) or {}).get("verdict") == "COMPRA" for tf in ("diario", "semanal", "mensual"))
    )
    print(f"Screener: {n_compra} ticker(s) con señal de COMPRA en alguna temporalidad.")

    print("\nActualizando historial de señales...")
    historial = actualizar_historial_screener(screener, ahora)

    print("\nEscribiendo JSON:")
    escribir("listado.json", {"acciones": listado, "promedios_por_industria": promedios})
    escribir("medias.json", medias)
    escribir("fundamentales.json", fundamentales)
    escribir("comparables.json", comparables)
    escribir("screener.json", screener)
    escribir("screener_historial.json", historial)
    escribir("meta.json", meta)

    print(f"\nListo. {n_frescos} frescos, {n_arrastrados} arrastrados, {len(invalidos)} invalidos.")
    if invalidos:
        print(f"Invalidos: {invalidos}")


if __name__ == "__main__":
    main()
