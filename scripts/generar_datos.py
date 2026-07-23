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
RUTA_HISTORIAL_OPORTUNIDADES = DIR_SALIDA / "oportunidades_historial.json"
# Los mismos 3 ratios que src/lib/valuacion.js (calcularDescuento) — si se
# toca uno, tocar el otro para que no se desincronicen.
RATIOS_VALOR_OPORTUNIDADES = ["per_trailing", "ev_sales", "ps"]


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
    ohlc = hist[["High", "Low", "Close", "Volume"]].dropna()
    semanales = ohlc.resample("W-FRI").agg(
        {"High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
    ).dropna()
    mensuales = ohlc.resample("ME").agg(
        {"High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
    ).dropna()
    return {
        "diario": perfil_setup(ohlc, **PERFIL_DIARIO),
        "semanal": perfil_setup(semanales, **PERFIL_SEMANAL),
        "mensual": perfil_setup(mensuales, **PERFIL_MENSUAL),
        "divergencia_ad": detectar_divergencia_ad(ohlc),
        "divergencia_rsi": detectar_divergencia_rsi(ohlc["Close"]),
        "cruce_medias": detectar_cruce_medias(ohlc["Close"]),
        # Corto plazo: EMA9 x EMA21, misma logica pero mas sensible — se
        # cruzan mucho mas seguido que EMA50/SMA200, asi que la vigencia es
        # bastante mas corta para que no quede "siempre encendido".
        "cruce_corto": detectar_cruce_medias(
            ohlc["Close"], corto=9, largo=21, tipo_corto="ema", tipo_largo="ema", vigencia_ruedas=4
        ),
    }


def extraer_proximo_earnings(info):
    """Fecha del proximo reporte de resultados. Viene gratis dentro de
    tk.info (earningsTimestamp*), no es un request nuevo. isEarningsDateEstimate
    indica si Yahoo todavia no tiene la fecha confirmada por la empresa."""
    ts_inicio = info.get("earningsTimestampStart") or info.get("earningsTimestamp")
    if not ts_inicio:
        return None
    ts_fin = info.get("earningsTimestampEnd")
    try:
        fecha = datetime.fromtimestamp(ts_inicio, tz=TZ).strftime("%Y-%m-%d")
        fecha_fin = (
            datetime.fromtimestamp(ts_fin, tz=TZ).strftime("%Y-%m-%d")
            if ts_fin and ts_fin != ts_inicio
            else None
        )
    except (TypeError, ValueError, OSError):
        return None
    return {"fecha": fecha, "fecha_fin": fecha_fin, "estimado": bool(info.get("isEarningsDateEstimate", False))}


def extraer_dividendos(hist):
    """Historial de dividendos de los ultimos ~5 anios, de la columna
    'Dividends' que ya viene en el hist descargado (no es un request nuevo
    — tk.dividends por separado si lo seria, y trae todo el historico desde
    el IPO, mucho mas de lo que hace falta para ver una tendencia)."""
    if "Dividends" not in hist.columns:
        return None
    pagos = hist["Dividends"]
    pagos = pagos[pagos > 0]
    if pagos.empty:
        return None

    lista = [{"fecha": f.strftime("%Y-%m-%d"), "monto": num(float(v), 4)} for f, v in pagos.items()]

    # Cuantos pagos entran en ~1 anio, inferido del espaciado tipico entre
    # pagos (trimestral/semestral/anual) — mas robusto que una ventana fija
    # de 365 dias: las fechas de pago se corren unos dias de un anio a otro,
    # asi que una ventana de dias puede agarrar 5 pagos de un lado y 3 del
    # otro e inventar un crecimiento que no existe (visto con AAPL: daba
    # +75% cuando en realidad crecio ~4% ese anio).
    valores = pagos.to_numpy()
    ultimos_12m = crecimiento_yoy = None
    if len(pagos) >= 3:
        dias = np.diff(pagos.index.values).astype("timedelta64[D]").astype(int)
        espaciado = float(np.median(dias)) if len(dias) else 365.0
        por_anio = max(1, round(365 / espaciado)) if espaciado > 0 else 4
        if len(valores) >= por_anio:
            ultimos_12m = float(valores[-por_anio:].sum())
            if len(valores) >= por_anio * 2:
                anio_anterior = float(valores[-por_anio * 2 : -por_anio].sum())
                crecimiento_yoy = ((ultimos_12m / anio_anterior) - 1) * 100 if anio_anterior > 0 else None

    return {
        "pagos": lista[-20:],
        "total_ultimos_12m": num(ultimos_12m, 4),
        "crecimiento_yoy": num(crecimiento_yoy, 2),
    }


def extraer_pre_post_market(info):
    """Precio de pre/post-market, gratis dentro de tk.info (mismo request de
    siempre, sin nada nuevo). Solo tiene sentido mostrarlo si el snapshot se
    tomo realmente durante esa sesion (marketState PRE/POST) — el resto del
    tiempo Yahoo puede dejar esos campos con datos viejos de la sesion
    anterior, y mostrarlos ahi confundiria mas de lo que ayuda."""
    estado = info.get("marketState")
    return {
        "estado": estado,
        "pre_precio": num(info.get("preMarketPrice"), 2) if estado == "PRE" else None,
        "pre_cambio_pct": num(info.get("preMarketChangePercent"), 2) if estado == "PRE" else None,
        "post_precio": num(info.get("postMarketPrice"), 2) if estado == "POST" else None,
        "post_cambio_pct": num(info.get("postMarketChangePercent"), 2) if estado == "POST" else None,
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

    # Para valor intrinseco (Graham Number + calculadora DCF): bookValue y
    # freeCashflow ya vienen gratis dentro de info, no hace falta un request
    # nuevo. FCF por accion se calcula aca (no en el frontend) para no repetir
    # la division en cada componente que lo use.
    fcf = g("freeCashflow")
    shares = g("sharesOutstanding")
    fcf_por_accion = (fcf / shares) if fcf is not None and shares else None

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
        "book_value": g("bookValue"),
        "fcf_por_accion": fcf_por_accion,
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


def _descuento_valor(fila, mediana):
    """Version Python de calcularDescuento (src/lib/valuacion.js): promedio
    del descuento % en PER/EV-Sales/P-S contra la mediana de industria. Solo
    se usa para armar el historial de Oportunidades del lado del pipeline —
    la vista en vivo la calcula el frontend con los mismos 3 ratios."""
    if not mediana:
        return None
    descuentos = []
    for k in RATIOS_VALOR_OPORTUNIDADES:
        v = fila.get(k)
        m = mediana.get(k)
        if v is None or m is None or v <= 0 or m <= 0:
            continue
        descuentos.append(((m - v) / m) * 100)
    if not descuentos:
        return None
    return sum(descuentos) / len(descuentos)


def calcular_oportunidades_hoy(fundamentales, comparables, screener):
    """Tickers que hoy cumplen las dos condiciones de la pestaña
    Oportunidades (barato vs. industria + señal tecnica), para poder armar
    un historial de "hace cuantos dias que esta en la lista"."""
    mediana_por_industria = {g["industria"]: g["mediana"] for g in comparables}
    screener_por_ticker = {f["ticker"]: f for f in screener}
    calificados = []
    for f in fundamentales:
        mediana = mediana_por_industria.get(f["industria"])
        descuento = _descuento_valor(f, mediana)
        if descuento is None or descuento <= 0:
            continue
        sf = screener_por_ticker.get(f["ticker"])
        if not sf:
            continue
        tiene_señal = any(
            (sf.get(tf) or {}).get("verdict") in ("COMPRA", "CERCA")
            for tf in ("diario", "semanal", "mensual")
        )
        if tiene_señal:
            calificados.append(f["ticker"])
    return calificados


def actualizar_historial_oportunidades(calificados_hoy, ahora):
    """Mismo patron que actualizar_historial_screener: un snapshot por dia
    (se pisa si ya corrio hoy), recortado a DIAS_HISTORIAL."""
    historial = []
    if RUTA_HISTORIAL_OPORTUNIDADES.exists():
        try:
            historial = json.loads(RUTA_HISTORIAL_OPORTUNIDADES.read_text(encoding="utf-8"))
            if not isinstance(historial, list):
                historial = []
        except Exception:  # noqa: BLE001
            historial = []

    hoy = ahora.strftime("%Y-%m-%d")
    historial = [h for h in historial if h.get("fecha") != hoy]
    historial.append({"fecha": hoy, "tickers": calificados_hoy})

    corte = (ahora - timedelta(days=DIAS_HISTORIAL)).strftime("%Y-%m-%d")
    historial = [h for h in historial if h.get("fecha", "") >= corte]
    historial.sort(key=lambda h: h["fecha"])
    return historial


def _retornos_diarios(closes, ventana=252):
    """Retornos diarios simples de las ultimas 'ventana' ruedas (~1 anio por
    defecto). Se le saca el timezone al indice: tickers de distintas plazas
    (NYSE vs B3/BYMA) traen tz distinto y eso rompe el join por fecha contra
    el benchmark si no se normaliza."""
    sub = closes.tail(ventana + 1)
    ret = sub.pct_change().dropna()
    if ret.index.tz is not None:
        ret.index = ret.index.tz_localize(None)
    return ret


def calcular_beta_sharpe(closes, bench_closes, ventana=252):
    """Beta realizado y correlacion contra el benchmark (SPY) + Sharpe y
    volatilidad anualizada del propio ticker, todo sobre el ultimo anio de
    ruedas. Reusa el historico de 5y ya descargado (closes), no pide nada
    nuevo salvo el benchmark (una sola vez por corrida, no por ticker)."""
    vacio = {"beta_realizado": None, "correlacion_mercado": None, "sharpe_1y": None, "volatilidad_1y": None}
    ret = _retornos_diarios(closes, ventana)
    if len(ret) < 30:
        return vacio

    desvio = ret.std()
    sharpe = (ret.mean() / desvio) * math.sqrt(252) if desvio else None
    volatilidad = desvio * math.sqrt(252) * 100

    beta = corr = None
    if bench_closes is not None and not bench_closes.empty:
        ret_bench = _retornos_diarios(bench_closes, ventana)
        conjunto = pd.concat([ret, ret_bench], axis=1, join="inner").dropna()
        if len(conjunto) >= 30:
            r_t, r_b = conjunto.iloc[:, 0], conjunto.iloc[:, 1]
            var_b = r_b.var()
            if var_b:
                beta = r_t.cov(r_b) / var_b
            corr = r_t.corr(r_b)

    return {
        "beta_realizado": num(beta, 2),
        "correlacion_mercado": num(corr, 2),
        "sharpe_1y": num(sharpe, 2),
        "volatilidad_1y": num(volatilidad, 1),
    }


def calcular_estacionalidad_y_mensual(closes):
    """Devuelve (precios_mensuales, estacionalidad):
    - precios_mensuales: cierre de fin de mes de los ultimos 5y, liviano
      (~60 puntos) para el simulador de DCA retrospectivo.
    - estacionalidad: retorno promedio y % de meses positivos por mes
      calendario (Ene..Dic), o None si hay menos de 2 anios de datos."""
    precios_me = closes.resample("ME").last().dropna()
    mensual_out = [
        {"fecha": idx.strftime("%Y-%m-%d"), "cierre": num(float(v), 2)} for idx, v in precios_me.items()
    ]

    # El mes en curso queda etiquetado con el cierre de fin de mes aunque el
    # mes no haya terminado — no sirve para "el retorno de ese mes" (compara
    # un mes completo contra uno parcial). Se descarta solo para el calculo
    # de estacionalidad, no para el historico de precios (ahi sí interesa
    # el ultimo precio disponible).
    precios_cerrados = precios_me
    hoy = datetime.now()
    if len(precios_me) and (precios_me.index[-1].year, precios_me.index[-1].month) == (hoy.year, hoy.month):
        precios_cerrados = precios_me.iloc[:-1]

    retornos_m = precios_cerrados.pct_change().dropna() * 100
    estacionalidad = None
    if len(retornos_m) >= 24:
        df = pd.DataFrame({"retorno": retornos_m.values, "mes": retornos_m.index.month})
        filas = []
        for mes in range(1, 13):
            sub = df.loc[df["mes"] == mes, "retorno"]
            if len(sub) == 0:
                continue
            filas.append(
                {
                    "mes": mes,
                    "retorno_prom": num(sub.mean(), 2),
                    "positivos_pct": num((sub > 0).mean() * 100, 0),
                    "n": int(len(sub)),
                }
            )
        estacionalidad = filas or None

    return mensual_out, estacionalidad


def _rsi_serie(closes, periodo=14):
    """RSI de Wilder vectorizado (serie completa). rsi_wilder() solo da el
    ultimo valor; para detectar divergencias contra el precio hace falta la
    serie entera."""
    delta = closes.diff()
    ganancia = delta.clip(lower=0)
    perdida = -delta.clip(upper=0)
    avg_gain = ganancia.ewm(alpha=1 / periodo, adjust=False).mean()
    avg_loss = perdida.ewm(alpha=1 / periodo, adjust=False).mean()
    rs = avg_gain / avg_loss
    rsi = 100 - 100 / (1 + rs)
    rsi[avg_loss == 0] = 100.0
    return rsi


def _pivots(serie, ventana=5):
    """Posiciones donde 'serie' es minimo/maximo local dentro de +-ventana
    ruedas. Devuelve (pivots_bajos, pivots_altos) como listas de posiciones."""
    bajos, altos = [], []
    n = len(serie)
    for i in range(ventana, n - ventana):
        local = serie.iloc[i - ventana : i + ventana + 1]
        v = serie.iloc[i]
        if v == local.min():
            bajos.append(i)
        if v == local.max():
            altos.append(i)
    return bajos, altos


def detectar_divergencia_rsi(closes, lookback=90, ventana_pivot=5, vigencia_ruedas=20):
    """Divergencia precio/RSI en los ultimos 'lookback' dias: alcista si el
    precio hace un minimo mas bajo que el pivot bajo anterior pero el RSI
    hace uno mas alto (o viceversa para bajista). Heuristica basada en
    pivots locales, no una señal infalible — solo reporta si el pivot mas
    reciente cayo dentro de 'vigencia_ruedas' para que no se marque algo
    viejo como si fuera actual."""
    if len(closes) < lookback + ventana_pivot * 2 + 20:
        return None
    rsi = _rsi_serie(closes)
    tramo = lookback + ventana_pivot * 2
    sub_closes = closes.tail(tramo).reset_index(drop=True)
    sub_rsi = rsi.tail(tramo).reset_index(drop=True)

    bajos, altos = _pivots(sub_closes, ventana_pivot)
    n = len(sub_closes)

    if len(bajos) >= 2:
        i1, i2 = bajos[-2], bajos[-1]
        hace = n - 1 - i2
        if hace <= vigencia_ruedas and sub_closes.iloc[i2] < sub_closes.iloc[i1] and sub_rsi.iloc[i2] > sub_rsi.iloc[i1]:
            return {"tipo": "alcista", "hace_ruedas": int(hace)}
    if len(altos) >= 2:
        i1, i2 = altos[-2], altos[-1]
        hace = n - 1 - i2
        if hace <= vigencia_ruedas and sub_closes.iloc[i2] > sub_closes.iloc[i1] and sub_rsi.iloc[i2] < sub_rsi.iloc[i1]:
            return {"tipo": "bajista", "hace_ruedas": int(hace)}
    return None


def _calcular_ad_line(ohlc):
    """Accumulation/Distribution Line (Chaikin): acumula "Money Flow Volume"
    (Close Location Value x Volumen) — sube cuando el cierre queda mas cerca
    del maximo del dia con volumen alto (presion compradora, "acumulacion"
    en el sentido Wyckoff), baja cuando queda mas cerca del minimo
    ("distribucion"). Es el proxy realmente automatizable a la idea de
    Wyckoff: las fases completas (springs, upthrusts, el "hombre
    compuesto") son lectura discrecional de un trader, no una formula."""
    rango = (ohlc["High"] - ohlc["Low"]).replace(0, np.nan)
    clv = ((ohlc["Close"] - ohlc["Low"]) - (ohlc["High"] - ohlc["Close"])) / rango
    money_flow_volume = clv.fillna(0) * ohlc["Volume"]
    return money_flow_volume.cumsum()


def detectar_divergencia_ad(ohlc, lookback=90, ventana_pivot=5, vigencia_ruedas=20):
    """Divergencia precio vs. A/D Line en los ultimos pivots — mismo criterio
    que detectar_divergencia_rsi: "acumulacion" si el precio hace un minimo
    mas bajo pero la A/D Line no (no la están vendiendo tanto como cae el
    precio), "distribucion" si el precio hace un maximo mas alto pero la
    A/D Line no (no la estan comprando tanto como sube el precio)."""
    closes = ohlc["Close"]
    if len(closes) < lookback + ventana_pivot * 2 + 20:
        return None
    ad = _calcular_ad_line(ohlc)
    tramo = lookback + ventana_pivot * 2
    sub_closes = closes.tail(tramo).reset_index(drop=True)
    sub_ad = ad.tail(tramo).reset_index(drop=True)

    bajos, altos = _pivots(sub_closes, ventana_pivot)
    n = len(sub_closes)

    if len(bajos) >= 2:
        i1, i2 = bajos[-2], bajos[-1]
        hace = n - 1 - i2
        if hace <= vigencia_ruedas and sub_closes.iloc[i2] < sub_closes.iloc[i1] and sub_ad.iloc[i2] > sub_ad.iloc[i1]:
            return {"tipo": "acumulacion", "hace_ruedas": int(hace)}
    if len(altos) >= 2:
        i1, i2 = altos[-2], altos[-1]
        hace = n - 1 - i2
        if hace <= vigencia_ruedas and sub_closes.iloc[i2] > sub_closes.iloc[i1] and sub_ad.iloc[i2] < sub_ad.iloc[i1]:
            return {"tipo": "distribucion", "hace_ruedas": int(hace)}
    return None


def _media(closes, periodo, tipo):
    return closes.ewm(span=periodo, adjust=False).mean() if tipo == "ema" else closes.rolling(periodo).mean()


def detectar_cruce_medias(closes, corto=50, largo=200, tipo_corto="ema", tipo_largo="sma", vigencia_ruedas=15):
    """Cruce entre dos medias: golden/death cross con EMA50 x SMA200 por
    defecto (mismas medias ya usadas en 'Distancia a medias'), o EMA9 x
    EMA21 para el cruce de corto plazo. Solo reporta si el cruce mas
    reciente paso dentro de 'vigencia_ruedas' — si no, es historia vieja,
    no una señal actual."""
    if len(closes) < largo + vigencia_ruedas + 1:
        return None
    media_corta = _media(closes, corto, tipo_corto)
    media_larga = _media(closes, largo, tipo_largo)
    diff = (media_corta - media_larga).dropna()
    if len(diff) < vigencia_ruedas + 2:
        return None
    signo = np.sign(diff)
    diffs_signo = signo.diff().to_numpy()
    cambios = np.where(diffs_signo[1:] != 0)[0] + 1  # [1:] descarta el NaN inicial de .diff()
    if len(cambios) == 0:
        return None
    ultimo = cambios[-1]
    hace = len(diff) - 1 - ultimo
    if hace > vigencia_ruedas:
        return None
    tipo = "golden" if signo.iloc[ultimo] > 0 else "death"
    return {"tipo": tipo, "hace_ruedas": int(hace)}


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
# Warren Score: screener tecnico/cuantitativo (0-100), NO fundamental. Ver
# spec completa en la conversacion — 4 pilares (Tendencia/25, Fuerza
# relativa/30, Momentum/30, Volatilidad/15). Reusa el 'closes'/'bench_closes'
# ya descargado para beta/sharpe, no pide nada nuevo a yfinance. La Fuerza
# Relativa necesita el percentil dentro de TODO el universo, asi que se
# calcula en dos pasadas (igual patron que promedios_por_industria): primera
# pasada guarda el retorno relativo crudo de cada ticker, segunda pasada (ya
# con el universo completo) lo convierte a percentil + puntos.
# ---------------------------------------------------------------------------
WS_LOOKBACK_PENDIENTE = 20  # ruedas atras para "pendiente positiva" de una media
WS_VENTANA_RS = 126  # ~6 meses de ruedas para el retorno relativo vs SPY
WS_VENTANA_BREAKOUT = 20  # ruedas para "hizo un nuevo maximo de 52 semanas recientemente"
WS_VENTANA_VOL_HIST = 252  # ~1 anio de volatilidades moviles de 20 ruedas, para la mediana


def _pendiente_positiva(serie, lookback=WS_LOOKBACK_PENDIENTE):
    """Compara el valor actual de una media contra su valor 'lookback' ruedas
    atras. None (no bool) si no hay historial suficiente — nunca se inventa
    un True/False sin dato real detras."""
    if len(serie) < lookback + 1:
        return None
    actual, anterior = serie.iloc[-1], serie.iloc[-1 - lookback]
    if pd.isna(actual) or pd.isna(anterior):
        return None
    return bool(actual > anterior)


def ws_calcular_trend(closes):
    """Pilar A (25 pts): estructura de SMA50/EMA200. OJO: son las medias que
    pide la spec del Warren Score, DISTINTAS de las que ya usa el resto de la
    app para 'Distancia a medias'/golden-death cross (que usan EMA50/SMA200,
    exactamente al reves) — no son intercambiables, se calculan aparte."""
    minimo = 200 + WS_LOOKBACK_PENDIENTE
    if len(closes) < minimo:
        return None
    sma50 = closes.rolling(50).mean()
    ema200 = closes.ewm(span=200, adjust=False).mean()
    precio, sma50_v, ema200_v = closes.iloc[-1], sma50.iloc[-1], ema200.iloc[-1]
    if pd.isna(sma50_v) or pd.isna(ema200_v):
        return None

    price_above_ema200 = bool(precio > ema200_v)
    price_above_sma50 = bool(precio > sma50_v)
    sma50_above_ema200 = bool(sma50_v > ema200_v)
    sma50_rising = _pendiente_positiva(sma50)
    ema200_rising = _pendiente_positiva(ema200)

    score = (
        (7 if price_above_ema200 else 0)
        + (5 if price_above_sma50 else 0)
        + (5 if sma50_above_ema200 else 0)
        + (4 if sma50_rising else 0)
        + (4 if ema200_rising else 0)
    )
    return {
        "score": num(score, 1),
        "max_score": 25,
        "price_above_ema200": price_above_ema200,
        "price_above_sma50": price_above_sma50,
        "sma50_above_ema200": sma50_above_ema200,
        "sma50_rising": sma50_rising,
        "ema200_rising": ema200_rising,
        "sma50": num(sma50_v, 2),
        "ema200": num(ema200_v, 2),
    }


def ws_calcular_relative_return(closes, bench_closes, ventana=WS_VENTANA_RS):
    """Retorno relativo vs. SPY sobre ~6 meses (por posicion, "ruedas atras"
    en cada serie — asi lo pide la spec, no por fecha). Valor crudo: el
    percentil dentro del universo se calcula despues, en la segunda pasada."""
    if len(closes) < ventana + 1 or bench_closes is None or len(bench_closes) < ventana + 1:
        return None
    precio_actual, precio_prev = closes.iloc[-1], closes.iloc[-1 - ventana]
    spy_actual, spy_prev = bench_closes.iloc[-1], bench_closes.iloc[-1 - ventana]
    if pd.isna(precio_actual) or pd.isna(precio_prev) or not precio_prev:
        return None
    if pd.isna(spy_actual) or pd.isna(spy_prev) or not spy_prev:
        return None
    stock_return = precio_actual / precio_prev - 1
    spy_return = spy_actual / spy_prev - 1
    denominador = 1 + spy_return
    if denominador == 0:
        return None
    return ((1 + stock_return) / denominador) - 1


def ws_rs_score_desde_percentil(rs_percentil):
    """Puntos del pilar B a partir del percentil (0-100) de fuerza relativa,
    segun la tabla de la spec. Por debajo de 50, proporcional (sin saltos)."""
    if rs_percentil is None:
        return None
    if rs_percentil >= 95:
        return 30.0
    if rs_percentil >= 90:
        return 27.0
    if rs_percentil >= 80:
        return 24.0
    if rs_percentil >= 70:
        return 18.0
    if rs_percentil >= 60:
        return 14.0
    if rs_percentil >= 50:
        return 10.0
    return round((rs_percentil / 50) * 9, 1)


def ws_calcular_momentum(closes, high_52w, low_52w, precio):
    """Pilar C (30 pts): cercania al maximo de 52w (15) + distancia sobre el
    minimo de 52w (10) + breakout reciente (5). Reusa high_52w/low_52w que
    el pipeline ya calcula para listado.json."""
    if high_52w is None or low_52w is None or high_52w <= 0 or len(closes) < 30:
        return None
    dist_high = (precio / high_52w - 1) * 100  # <= 0 (o ~0 si es el maximo)
    pct_above_low = (precio / low_52w - 1) * 100 if low_52w > 0 else None

    d = abs(dist_high)
    if d <= 3:
        p_high = 15
    elif d <= 5:
        p_high = 14
    elif d <= 10:
        p_high = 12
    elif d <= 15:
        p_high = 9
    elif d <= 20:
        p_high = 6
    elif d <= 25:
        p_high = 3
    else:
        p_high = 0

    if pct_above_low is None:
        p_low = 0
    elif pct_above_low >= 50:
        p_low = 10
    elif pct_above_low >= 40:
        p_low = 8
    elif pct_above_low >= 30:
        p_low = 7
    elif pct_above_low >= 25:
        p_low = 6
    elif pct_above_low >= 15:
        p_low = 3
    else:
        p_low = 0

    # Nuevo maximo de 52 semanas en las ultimas 20 ruedas: el cierre de ese
    # dia estuvo (con 0.1% de tolerancia) en su propio maximo movil de 252
    # ruedas hasta esa fecha — sobre la serie completa, no un slice, para que
    # el "maximo movil" sea el trailing real y no un maximo truncado.
    rolling_max_252 = closes.rolling(252, min_periods=1).max()
    recientes_close = closes.tail(WS_VENTANA_BREAKOUT)
    recientes_max = rolling_max_252.tail(WS_VENTANA_BREAKOUT)
    nuevo_maximo_reciente = bool((recientes_close >= recientes_max * 0.999).any())
    p_breakout = 5 if nuevo_maximo_reciente else 0

    return {
        "score": num(p_high + p_low + p_breakout, 1),
        "max_score": 30,
        "distance_from_52w_high": num(dist_high, 2),
        "percentage_above_52w_low": num(pct_above_low, 2),
        "recent_52w_high": nuevo_maximo_reciente,
    }


def ws_calcular_volatility(closes):
    """Pilar D (15 pts): volatilidad realizada actual (20 ruedas, anualizada)
    vs. la mediana de esa misma metrica en el ultimo anio — no es "mucha o
    poca" volatilidad en absoluto, es relativa a la propia historia reciente
    del activo."""
    ret = closes.pct_change().dropna()
    if len(ret) < WS_VENTANA_VOL_HIST + 20:
        return None
    vol_movil_20 = ret.rolling(20).std() * math.sqrt(252) * 100
    current_volatility = vol_movil_20.iloc[-1]
    historical_volatility = vol_movil_20.tail(WS_VENTANA_VOL_HIST).median()
    if pd.isna(current_volatility) or pd.isna(historical_volatility) or not historical_volatility:
        return None
    ratio = current_volatility / historical_volatility

    if ratio <= 0.60:
        score = 15
    elif ratio <= 0.70:
        score = 14
    elif ratio <= 0.80:
        score = 12
    elif ratio <= 0.90:
        score = 9
    elif ratio <= 1.00:
        score = 6
    elif ratio <= 1.20:
        score = 3
    else:
        score = 0

    return {
        "score": num(score, 1),
        "max_score": 15,
        "current_volatility": num(current_volatility, 1),
        "historical_volatility": num(historical_volatility, 1),
        "volatility_ratio": num(ratio, 2),
    }


def ws_calcular_gates(trend, rs, momentum, volatility):
    """Criterios rapidos independientes del score — no suman puntos, son
    filtros. 'count' y los 4 principales (rs80/ema200/sma50/above25_from_low)
    quedan expuestos para los filtros de la UI."""
    gates = {
        "rs80": bool(rs is not None and rs >= 80),
        "ema200": bool(trend and trend["price_above_ema200"]),
        "sma50": bool(trend and trend["price_above_sma50"]),
        "above25_from_low": bool(
            momentum and momentum["percentage_above_52w_low"] is not None and momentum["percentage_above_52w_low"] >= 25
        ),
        "vol_below_08": bool(volatility and volatility["volatility_ratio"] is not None and volatility["volatility_ratio"] < 0.80),
        "sma50_rising": bool(trend and trend["sma50_rising"]),
        "ema200_rising": bool(trend and trend["ema200_rising"]),
    }
    gates["count"] = sum(1 for k, v in gates.items() if v)
    principales = ("rs80", "ema200", "sma50", "above25_from_low")
    gates["all_main_gates_passed"] = all(gates[g] for g in principales)
    return gates


def calcular_warren_score(warren_datos):
    """Segunda pasada: convierte el retorno relativo crudo de cada ticker en
    percentil (0-100) dentro del universo completo, arma el score total
    (A+B+C+D, siempre exacto) y los gates. Si falta cualquier pilar, el total
    queda en None (no se inventa un 0) y 'datos_suficientes' en False."""
    validos_rr = [w["relative_return"] for w in warren_datos if w["relative_return"] is not None]
    salida = []
    for w in warren_datos:
        rr = w["relative_return"]
        rs = None
        rs_score = None
        if rr is not None and validos_rr:
            rs = round((sum(1 for v in validos_rr if v <= rr) / len(validos_rr)) * 100, 1)
            rs_score = ws_rs_score_desde_percentil(rs)

        trend, momentum, volatility = w["trend"], w["momentum"], w["volatility"]
        partes = [trend["score"] if trend else None, rs_score, momentum["score"] if momentum else None, volatility["score"] if volatility else None]
        datos_suficientes = all(p is not None for p in partes)
        total = num(min(100.0, max(0.0, sum(partes))), 1) if datos_suficientes else None

        relative_strength = (
            {
                "score": rs_score,
                "max_score": 30,
                "rs": rs,
                "relative_performance": num(rr * 100, 2),
            }
            if rr is not None
            else None
        )

        salida.append(
            {
                "ticker": w["ticker"],
                "nombre": w["nombre"],
                "total_score": total,
                "datos_suficientes": datos_suficientes,
                "trend": trend,
                "relative_strength": relative_strength,
                "momentum": momentum,
                "volatility": volatility,
                "gates": ws_calcular_gates(trend, rs, momentum, volatility),
            }
        )
    return salida


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

    print("Descargando benchmark (SPY) para beta/correlacion realizados...")
    _, _, _, bench_closes = resolver_ticker("SPY")
    if bench_closes is None or bench_closes.empty:
        print("  ! No se pudo descargar SPY: beta/correlacion van a quedar en None.")

    listado, medias, fundamentales, screener, invalidos = [], [], [], [], []
    historico_mensual = []
    warren_datos = []

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

        # Volumen de hoy vs. promedio de los ultimos 20 dias (sin contar hoy):
        # detecta picos de volumen inusual, no cuesta nada extra (mismo hist
        # ya descargado). Igual logica que vol_ratio del Crypto Screener.
        volumen = hist["Volume"].dropna() if "Volume" in hist.columns else pd.Series(dtype=float)
        vol_hoy = float(volumen.iloc[-1]) if len(volumen) >= 1 else None
        vol_prom20 = float(volumen.iloc[-21:-1].mean()) if len(volumen) >= 21 else None
        vol_ratio = (vol_hoy / vol_prom20) if vol_hoy and vol_prom20 else None

        # Gap de apertura: hueco entre el cierre de ayer y la apertura de
        # hoy (mismo hist ya descargado, columna Open). Un gap grande suele
        # anticipar mas volatilidad ese dia.
        apertura_hoy = float(hist["Open"].iloc[-1]) if "Open" in hist.columns and len(hist) else None
        gap_pct = ((apertura_hoy / anterior) - 1) * 100 if apertura_hoy and anterior else None

        listado.append(
            {
                **base,
                "var_pct": num(var_pct, 2),
                "rsi": num(rsi, 2),
                "spark": spark,
                "high_52w": num(high_52w, 2),
                "low_52w": num(low_52w, 2),
                "vol_hoy": int(vol_hoy) if vol_hoy else None,
                "vol_prom20": int(vol_prom20) if vol_prom20 else None,
                "vol_ratio": num(vol_ratio, 2),
                "gap_pct": num(gap_pct, 2),
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
        stats_mercado = calcular_beta_sharpe(closes, bench_closes)
        precios_mensuales, estacionalidad = calcular_estacionalidad_y_mensual(closes)
        historico_mensual.append({"ticker": sym, "precios": precios_mensuales})
        proximo_earnings = extraer_proximo_earnings(info)
        dividendos = extraer_dividendos(hist)
        pre_post_market = extraer_pre_post_market(info)
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
                **stats_mercado,
                "estacionalidad": estacionalidad,
                "proximo_earnings": proximo_earnings,
                "dividendos": dividendos,
                "pre_post_market": pre_post_market,
            }
        )

        screener.append({**base, **calcular_screener(hist)})

        # Warren Score: pilares A/C/D son por-ticker, se calculan aca; el
        # pilar B (Fuerza Relativa) necesita el percentil de TODO el
        # universo, asi que solo se guarda el retorno relativo crudo y se
        # convierte a score despues del loop (calcular_warren_score).
        warren_datos.append(
            {
                "ticker": sym,
                "nombre": nombre,
                "trend": ws_calcular_trend(closes),
                "relative_return": ws_calcular_relative_return(closes, bench_closes),
                "momentum": ws_calcular_momentum(closes, high_52w, low_52w, precio),
                "volatility": ws_calcular_volatility(closes),
            }
        )

        print(f"  ok {sym} ({nombre})")

    print("\nCalculando Warren Score (percentil de fuerza relativa sobre el universo)...")
    warren_score = calcular_warren_score(warren_datos)

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

    print("Actualizando historial de Oportunidades...")
    calificados_hoy = calcular_oportunidades_hoy(fundamentales, comparables, screener)
    historial_oportunidades = actualizar_historial_oportunidades(calificados_hoy, ahora)
    print(f"  {len(calificados_hoy)} ticker(s) cumplen hoy valor+señal.")

    print("\nEscribiendo JSON:")
    escribir("listado.json", {"acciones": listado, "promedios_por_industria": promedios})
    escribir("medias.json", medias)
    escribir("fundamentales.json", fundamentales)
    escribir("comparables.json", comparables)
    escribir("screener.json", screener)
    escribir("screener_historial.json", historial)
    escribir("oportunidades_historial.json", historial_oportunidades)
    escribir("historico_mensual.json", historico_mensual)
    escribir("warren_score.json", {"actualizado": ahora_iso, "tickers": warren_score})
    escribir("meta.json", meta)

    print(f"\nListo. {n_frescos} frescos, {n_arrastrados} arrastrados, {len(invalidos)} invalidos.")
    if invalidos:
        print(f"Invalidos: {invalidos}")


if __name__ == "__main__":
    main()
