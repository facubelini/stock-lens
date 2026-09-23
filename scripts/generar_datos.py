"""Pipeline de datos de Stock Lens.

Lee data/tickers.xlsx, descarga datos diarios con yfinance, calcula los
indicadores y escribe los JSON estaticos que consume el frontend en
public/data/. No requiere API keys.

Uso:
    python scripts/generar_datos.py
    # prueba chica, sin tocar public/data ni data/:
    python scripts/generar_datos.py --tickers AAPL,KEP,GGAL.BA --out /tmp/sl --estado /tmp/sl-estado
"""

import argparse
import json
import math
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yfinance as yf

from comparables_universo import INDUSTRIA_COMPARABLES
from comun import (  # noqa: F401  (num/rsi_wilder/RAIZ/TZ se re-exportan: los importan backtests y mock)
    CLAVES_BENCH,
    DIR_DATOS_PUBLICOS,
    DIR_ESTADO,
    RAIZ,
    TZ,
    base_ticker,
    borrar_huerfanos,
    escribir_json,
    leer_json,
    mediana_de,
    moneda_por_sufijo,
    normalizar_industria,
    num,
    rsi_serie,
    rsi_wilder,
    sig,
)

# --- Rutas y constantes ---
ARCHIVO_TICKERS = RAIZ / "data" / "tickers.xlsx"
ARCHIVO_RATIOS_MANUAL = RAIZ / "data" / "ratios_cedear_manual.json"
# Carpetas de salida/estado: se pueden redirigir con --out/--estado (ver
# main) para probar contra un universo chico sin pisar los datos reales.
DIR_SALIDA = DIR_DATOS_PUBLICOS

# Encabezados aceptados para la columna de tickers (se normalizan sin acentos).
NOMBRES_TICKER = ["ticker", "codigo", "symbol", "simbolo", "code", "tickers"]
# 5y (no cuesta requests extra, es el mismo history() con mas filas): hace
# falta para que semanal (SMA52 ~ 1 ano) y mensual (SMA36 ~ 3 anos) del
# screener tengan velas suficientes. 2y ya alcanzaba para SMA200/EMA150 diario.
PERIODO_HISTORICO = "5y"
# Si el ticker "pelado" no trae datos, se reintenta con estos sufijos:
# .SA = B3 (Brasil), .BA = BYMA (Argentina). Solo para tickers que NUNCA
# resolvieron: si ya resolvieron alguna vez, se usa siempre el mismo simbolo
# (ver resolver_universo) para no saltar de plaza por un fallo transitorio
# (paso con BK: un 404 puntual de Yahoo lo dejo resuelto como BK.BA, el
# CEDEAR en pesos, en vez de la accion de NYSE).
SUFIJOS = ["", ".SA", ".BA"]
DIAS_HISTORIAL = 90
# Los mismos 3 ratios que src/lib/valuacion.js (calcularDescuento) — si se
# toca uno, tocar el otro para que no se desincronicen.
RATIOS_VALOR_OPORTUNIDADES = ["per_trailing", "ev_sales", "ps"]

# Descarga en lote (yf.download) en vez de un history() por ticker: la
# corrida pasa de ~10 min a unos pocos. Los simbolos que fallan se
# reintentan con espera creciente antes de darlos por perdidos.
TAM_LOTE_DESCARGA = 80
ESPERAS_REINTENTO = [5, 20]  # segundos antes de cada reintento
WORKERS_INFO = 4  # tk.info/insiders en paralelo (I/O); mas alto arriesga rate-limit

# Arrastre de datos viejos: si un ticker falla, se publica el ultimo dato
# bueno marcado stale, pero no para siempre (SNP.BA quedo arrastrado desde
# julio): pasados estos dias se descarta.
DIAS_MAX_ARRASTRE = 7
# Tickers que no resolvieron en ninguna plaza: no se reintentan en cada
# corrida (eran ~50 x 3 sufijos) hasta que pase este TTL.
TTL_INVALIDOS_DIAS = 7
# Salvaguarda anti rate-limit: si los frescos quedan por debajo de esta
# fraccion de los tickers intentados, se aborta sin escribir (exit 1).
UMBRAL_ABORTO = 0.5
# CCL implicito: los CEDEAR cuyo CCL se aleja mas que esto de la mediana
# casi siempre son ratio mal cargado o precio viejo en BYMA -> se anulan.
TOL_CCL = 0.15
# Dividend yield por encima de esto es casi seguro un error de moneda/dato.
DIVIDEND_YIELD_MAX = 25.0

# Filtro de "basura" del Excel (se aplica por regla, el Excel no se toca):
# filas que no son tickers (DIVIDENDOS, EFECTIVO...) y bonos soberanos
# argentinos (AL29, GD30...), que Yahoo no tiene.
# OJO: nada de siglas cortas tipo "CCL"/"USD": son tickers reales (Carnival,
# ProShares Ultra Semiconductors).
PALABRAS_NO_TICKER = {
    "DIVIDENDOS", "DIVIDENDO", "EFECTIVO", "CAUCION", "CAUCIONES", "SALDO", "PESOS", "DOLARES",
}
RE_BONO_AR = re.compile(r"^(AL|GD|AE|TX|TZX|TV)\d{2}[DC]?$")
RE_TICKER_VALIDO = re.compile(r"^[A-Z0-9][A-Z0-9.\-^=]*$")

# Campos que se publican por par en comparables.json: solo lo que leen
# Comparables.jsx / TickerDetalle.jsx (tabla de ratios + pool de peers
# manuales) — el resto de la fila de fundamentales (estacionalidad,
# dividendos, insiders...) ya esta en fundamentales.json y duplicarlo aca
# inflaba el archivo a ~700KB.
CAMPOS_PARES = [
    "ticker", "nombre", "industria", "sector", "en_portfolio", "moneda",
    "market_cap", "market_cap_usd",
    "per_trailing", "per_forward", "peg", "ev_sales", "pb", "ps", "eps",
    "profit_margin", "roe", "dividend_yield", "beta", "debt_to_equity", "current_ratio",
    "target_mean_price", "upside_pct", "recommendation_key", "n_analistas",
]
# Ratios que mezclan precio (moneda de cotizacion) con datos contables
# (financialCurrency). Si las dos monedas difieren, Yahoo divide market cap
# en USD por ventas/patrimonio en la moneda local sin convertir: P/S y P/B
# salen basura (TM P/S 0.00, TSM P/B 91, TXR.BA P/S 1053) -> None siempre.
RATIOS_MONEDA_MIXTA = ["ev_sales", "pb", "ps"]
# El PER si lo convierte bien cuando la cotizacion es en USD (ADRs: TSM 33,
# BABA 25, SAP 28, coherentes), pero no cuando la especie cotiza en otra
# moneda (CEDEARs en pesos: BBV.BA PER 308, NOKA.BA 478, PKS.BA 0.06) ->
# None solo en ese caso.
RATIOS_MONEDA_MIXTA_NO_USD = ["per_trailing", "per_forward", "peg"]


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


def es_ticker_basura(t):
    """True si la fila del Excel no es un ticker cotizable en Yahoo: palabras
    sueltas (DIVIDENDOS, EFECTIVO), bonos soberanos AR (AL30, GD29) o texto
    con caracteres que ningun simbolo usa. Los deslistados no se detectan
    aca: los filtra el cache de invalidos con TTL."""
    t = str(t).upper()
    base = base_ticker(t)
    if base in PALABRAS_NO_TICKER or RE_BONO_AR.match(base):
        return True
    if not RE_TICKER_VALIDO.match(t):
        return True
    # Ningun ticker real es una palabra de 7+ letras (US <=5, B3 4+digitos).
    return base.isalpha() and len(base) >= 7


# ---------------------------------------------------------------------------
# Indicadores (num/rsi_wilder/rsi_serie viven en comun.py)
# ---------------------------------------------------------------------------
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
    """WMA con pesos lineales crecientes (1,2,3...), igual que el analizador v8.
    Vectorizada con np.convolve (antes rolling().apply() con una lambda por
    vela: era lo mas lento del pipeline). Mismo resultado que la version
    anterior, incluido el arranque con ventana parcial (min_periods=1)."""
    x = serie.to_numpy(dtype="float64")
    n = len(x)
    out = np.full(n, np.nan)
    pesos = np.arange(1, periodo + 1, dtype="float64")
    if n >= periodo:
        # convolve invierte el kernel: pesos[::-1] deja el peso mayor sobre la vela mas reciente.
        out[periodo - 1 :] = np.convolve(x, pesos[::-1], mode="valid") / pesos.sum()
    for i in range(min(periodo - 1, n)):
        w = pesos[: i + 1]
        out[i] = np.dot(x[: i + 1], w) / w.sum()
    return pd.Series(out, index=serie.index)


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

    # dist_clave/dist_asl/ma_clave ya no se publican (el front no los usaba;
    # quedan dentro del texto de "motivo").
    return {
        "verdict": verdict,
        "estado": estado,
        "rsi": num(rsi, 1),
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


# ---------------------------------------------------------------------------
# Scanner de setups CORTO/LARGO (puerto del "analizador v8" de escritorio del
# usuario). Perfil CORTO evaluado en velas diarias y LARGO en semanales — en
# el script de escritorio original eran 30m/1h y 1d/1wk, pero esto es un
# sitio estatico que se actualiza unas pocas veces al dia (no cada 15 min
# como el script corriendo en la maquina del usuario): pedir intradia real
# no aportaria nada, la señal quedaria igual de "vieja" entre corridas.
# Reusa las mismas formulas de ASL/MACD/SMI ya portadas arriba para el
# Screener multi-temporalidad (_calcular_asl/_calcular_macd/_calcular_smi),
# pero con la logica de veredicto propia del scanner: exige la zona de
# pullback (ASL Y SMA30 a la vez, no OR) + confluencia de tendencia completa
# (precio sobre EMA200, MACD y SMI alcistas, RSI>50) para SETUP_LONG.
# ---------------------------------------------------------------------------
SCANNER_SMA_LEN = 30
SCANNER_EMA_SLOW_LEN = 200
SCANNER_NEAR_FACTOR = 1.5

SCANNER_PERFILES = {
    "corto": {"tf": "Diario", "tol_asl": 1.5, "tol_sma": 2.5},
    "largo": {"tf": "Semanal", "tol_asl": 3.0, "tol_sma": 5.0},
}


def _scanner_score_y_motivo(d_asl, d_sma, close_over_ema, macd_bull, smi_bull, rsi_bull):
    checks = [
        (d_asl is not None, "distancia al ASL"),
        (d_sma is not None, "distancia a la SMA30"),
        (close_over_ema, "precio bajo la EMA200"),
        (macd_bull, "MACD bajista"),
        (smi_bull, "SMI bajista"),
        (rsi_bull, "RSI bajo 50"),
    ]
    score = sum(1 for ok, _ in checks if ok)
    faltantes = [motivo for ok, motivo in checks if not ok]
    motivo = "Falta: " + " · ".join(faltantes) if faltantes else "OK"
    return score, motivo


def _setup_perfil(df, tf_label, tol_asl, tol_sma):
    """Evalua un perfil (CORTO=diario, LARGO=semanal) del scanner. SETUP_LONG
    solo si la zona de pullback (ASL y SMA30 a la vez) y la confluencia de
    tendencia (EMA200 + MACD + SMI + RSI) se cumplen juntas; NEAR_SETUP si la
    zona de precio esta cerca (tolerancia x1.5) con la tendencia ya
    confirmada. Score/Motivo solo se calculan para esos dos casos, igual que
    en el scanner original."""
    closes = df["Close"]
    minimo = max(SCANNER_EMA_SLOW_LEN, SCANNER_SMA_LEN, ASL_LEN, MACD_SLOW, SMI_LEN) + 1
    vacio = {"tf": tf_label, "status": "NO_DATA", "rsi": None, "score": None, "motivo": "", "close": None}
    if len(closes) < minimo:
        return vacio

    close = float(closes.iloc[-1])
    rsi = rsi_wilder(closes.values, 14)
    if rsi is None:
        return vacio

    asl = _calcular_asl(closes).iloc[-1]
    sma = closes.rolling(SCANNER_SMA_LEN).mean().iloc[-1]
    ema_slow = closes.ewm(span=SCANNER_EMA_SLOW_LEN, adjust=False).mean().iloc[-1]
    macd, macd_sig = _calcular_macd(closes)
    smi, smi_sig = _calcular_smi(df["High"], df["Low"], closes)

    macd_bull = bool(macd.iloc[-1] > macd_sig.iloc[-1])
    smi_val, smi_sig_val = smi.iloc[-1], smi_sig.iloc[-1]
    smi_bull = bool(not pd.isna(smi_val) and not pd.isna(smi_sig_val) and smi_val > smi_sig_val)
    rsi_bull = rsi > 50

    d_asl = dist_pct(close, asl) if not pd.isna(asl) else None
    d_sma = dist_pct(close, sma) if not pd.isna(sma) else None
    close_over_ema = bool(not pd.isna(ema_slow) and close >= ema_slow)

    en_zona = d_asl is not None and abs(d_asl) <= tol_asl and d_sma is not None and abs(d_sma) <= tol_sma
    cerca_zona = (
        d_asl is not None
        and abs(d_asl) <= tol_asl * SCANNER_NEAR_FACTOR
        and d_sma is not None
        and abs(d_sma) <= tol_sma * SCANNER_NEAR_FACTOR
    )
    tendencia_ok = close_over_ema and macd_bull and smi_bull and rsi_bull

    if en_zona and tendencia_ok:
        status = "SETUP_LONG"
    elif cerca_zona and tendencia_ok:
        status = "NEAR_SETUP"
    else:
        status = "OK"

    score = None
    motivo = ""
    if status in ("SETUP_LONG", "NEAR_SETUP"):
        score, motivo = _scanner_score_y_motivo(d_asl, d_sma, close_over_ema, macd_bull, smi_bull, rsi_bull)

    return {
        "tf": tf_label,
        "status": status,
        "rsi": num(rsi, 1),
        "score": score,
        "motivo": motivo,
        "close": num(close, 2),
    }


def calcular_setup_scanner(hist):
    """Perfil CORTO (diario) + LARGO (semanal, resampleado del mismo
    historico diario ya descargado) + Status_GLOBAL combinando ambos."""
    ohlc = hist[["High", "Low", "Close"]].dropna()
    semanales = ohlc.resample("W-FRI").agg({"High": "max", "Low": "min", "Close": "last"}).dropna()

    p_corto = SCANNER_PERFILES["corto"]
    p_largo = SCANNER_PERFILES["largo"]
    corto = _setup_perfil(ohlc, p_corto["tf"], p_corto["tol_asl"], p_corto["tol_sma"])
    largo = _setup_perfil(semanales, p_largo["tf"], p_largo["tol_asl"], p_largo["tol_sma"])

    buy_c = corto["status"] == "SETUP_LONG"
    buy_l = largo["status"] == "SETUP_LONG"
    near_c = corto["status"] == "NEAR_SETUP"
    near_l = largo["status"] == "NEAR_SETUP"

    if buy_c and buy_l:
        status_global = "BUY_BOTH"
    elif buy_c:
        status_global = "BUY_CORTO"
    elif buy_l:
        status_global = "BUY_LARGO"
    elif near_c and near_l:
        status_global = "NEAR_BOTH"
    elif near_c:
        status_global = "NEAR_CORTO"
    elif near_l:
        status_global = "NEAR_LARGO"
    else:
        status_global = "OK"

    return {"corto": corto, "largo": largo, "status_global": status_global}


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


def _ts_a_iso(ts):
    try:
        return datetime.fromtimestamp(int(ts), tz=TZ).isoformat() if ts else None
    except (TypeError, ValueError, OSError):
        return None


def extraer_pre_post_market(info, previo=None, ahora_iso=None):
    """Precio de pre/post-market, gratis dentro de tk.info. Yahoo solo lo
    llena bien mientras el mercado esta en esa sesion (marketState PRE /
    POST o POSTPOST), y GitHub arranca los crons con horas de atraso, asi
    que muchas corridas caen fuera de esas ventanas. Por eso NUNCA se pisa un
    valor capturado con None: se conserva el ultimo capturado junto con su
    propio timestamp (pre_actualizado/post_actualizado, el preMarketTime/
    postMarketTime de Yahoo) para que la UI sepa que tan viejo es."""
    previo = previo or {}
    estado = info.get("marketState") or previo.get("estado")
    salida = {
        "estado": estado,
        "pre_precio": previo.get("pre_precio"),
        "pre_cambio_pct": previo.get("pre_cambio_pct"),
        "pre_actualizado": previo.get("pre_actualizado"),
        "post_precio": previo.get("post_precio"),
        "post_cambio_pct": previo.get("post_cambio_pct"),
        "post_actualizado": previo.get("post_actualizado"),
    }
    if estado == "PRE" and num(info.get("preMarketPrice")) is not None:
        salida["pre_precio"] = num(info.get("preMarketPrice"), 2)
        salida["pre_cambio_pct"] = num(info.get("preMarketChangePercent"), 2)
        salida["pre_actualizado"] = _ts_a_iso(info.get("preMarketTime")) or ahora_iso
    if estado in ("POST", "POSTPOST") and num(info.get("postMarketPrice")) is not None:
        salida["post_precio"] = num(info.get("postMarketPrice"), 2)
        salida["post_cambio_pct"] = num(info.get("postMarketChangePercent"), 2)
        salida["post_actualizado"] = _ts_a_iso(info.get("postMarketTime")) or ahora_iso
    return salida


def _normalizar_moneda(m):
    """'GBp' (peniques) y similares se comparan contra su moneda mayor."""
    if not m:
        return None
    return {"GBP": "GBP", "GBX": "GBP", "ILA": "ILS", "ZAC": "ZAR"}.get(str(m).upper(), str(m).upper())


def moneda_mixta(moneda, moneda_financiera):
    """True si el precio cotiza en una moneda y los estados contables estan
    en otra (ADRs de KEP/KB/MUFG/HMC, CEDEARs .BA): los ratios precio/
    contable que arma Yahoo quedan mezclados y no sirven."""
    a, b = _normalizar_moneda(moneda), _normalizar_moneda(moneda_financiera)
    return bool(a and b and a != b)


def calcular_dividend_yield(dividendos, precio, info):
    """Dividend yield en %. Primero desde los pagos reales de los ultimos 12
    meses (columna Dividends del historico, misma moneda que el precio, asi
    que nunca mezcla monedas) sobre el precio actual. Si no hay pagos
    suficientes para estimarlo, cae a 'dividendYield' de Yahoo, que YA viene
    en % (antes se usaba trailingAnnualDividendYield, que en ADRs divide el
    dividendo en KRW/JPY por el precio en USD: KEP daba 13646%). Valores por
    encima de DIVIDEND_YIELD_MAX se descartan."""
    dy = None
    if dividendos and precio:
        pagos = dividendos.get("pagos") or []
        ultimo = pagos[-1]["fecha"] if pagos else None
        total = dividendos.get("total_ultimos_12m")
        # Si el ultimo pago tiene mas de ~13 meses, o dejo de pagar o Yahoo
        # tiene un hueco en el historial (pasa con varios ADRs: KB/MUFG/HMC
        # sin pagos cargados desde 2025) -> no se estima desde pagos.
        reciente = bool(ultimo) and (datetime.now() - datetime.fromisoformat(ultimo)).days <= 400
        if reciente and total:
            dy = total / precio * 100
    if dy is None:
        v = info.get("dividendYield")
        dy = float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    if dy is None or not math.isfinite(dy) or dy < 0 or dy > DIVIDEND_YIELD_MAX:
        return None
    return dy


def extraer_fundamentales(info):
    """Extrae los fundamentales de yf.Ticker(t).info, tolerando faltantes.
    Margenes/ROE se devuelven ya en formato porcentual. El dividend yield se
    calcula aparte (calcular_dividend_yield) porque necesita el historico."""

    def g(k):
        v = info.get(k)
        if isinstance(v, bool):  # algunos campos vienen como bool por error
            return None
        if isinstance(v, (int, float)) and not (isinstance(v, float) and math.isnan(v)):
            return float(v)
        return None

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
        "dividend_yield": None,  # se completa con calcular_dividend_yield()
        "beta": g("beta"),
        "debt_to_equity": g("debtToEquity"),
        "current_ratio": g("currentRatio"),
        # Consenso de analistas (gratis via yfinance, sin key). recommendation_key
        # es texto ("buy"/"hold"/etc.), se maneja aparte de los campos numericos.
        "target_mean_price": g("targetMeanPrice"),
        "n_analistas": g("numberOfAnalystOpinions"),
        "recommendation_key": info.get("recommendationKey") or None,
        # book_value/fcf_por_accion se sacaron: ningun componente los leia.
    }


def anular_ratios_mixtos(fund, moneda, moneda_financiera):
    """Pone en None los ratios que mezclan monedas (ver RATIOS_MONEDA_MIXTA
    y RATIOS_MONEDA_MIXTA_NO_USD)."""
    if moneda_mixta(moneda, moneda_financiera):
        claves = RATIOS_MONEDA_MIXTA + (RATIOS_MONEDA_MIXTA_NO_USD if moneda != "USD" else [])
        for k in claves:
            fund[k] = None
    return fund


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


# Alias con el nombre viejo: la implementacion vive en comun.py.
_normalizar_industria = normalizar_industria
_base_ticker = base_ticker


def fila_par(fila, en_portfolio):
    """Recorta una fila de fundamentales a los campos que se publican por par
    en comparables.json (CAMPOS_PARES)."""
    out = {k: fila.get(k) for k in CAMPOS_PARES if k != "en_portfolio"}
    out["en_portfolio"] = en_portfolio
    return {k: out.get(k) for k in CAMPOS_PARES}


def _fila_peer_desde_info(peer, info):
    """Fila de un peer curado (fuera de tu universo), solo con su .info."""
    nombre = info.get("shortName") or info.get("longName") or peer
    moneda = info.get("currency") or moneda_por_sufijo(peer)
    fund = extraer_fundamentales(info)
    anular_ratios_mixtos(fund, moneda, info.get("financialCurrency"))
    dy = info.get("dividendYield")
    fund["dividend_yield"] = (
        float(dy) if isinstance(dy, (int, float)) and not isinstance(dy, bool) and 0 <= dy <= DIVIDEND_YIELD_MAX else None
    )
    mc = fund.pop("market_cap")
    recommendation_key = fund.pop("recommendation_key")
    precio = num(info.get("currentPrice") or info.get("regularMarketPrice"), 4)
    target = fund.get("target_mean_price")
    upside = ((target / precio - 1) * 100) if target and precio else None
    return {
        "ticker": peer,
        "nombre": nombre,
        "sector": info.get("sector") or None,
        "moneda": moneda,
        **{k: num(v, 2) for k, v in fund.items()},
        "market_cap": int(mc) if mc else None,
        "market_cap_usd": None,  # se completa con el tipo de cambio de la corrida
        "recommendation_key": recommendation_key,
        "upside_pct": num(upside, 2),
    }


def obtener_peers(fundamentales, cache_peers, hoy):
    """Fundamentales (.info) de los peers curados que NO estan en tu
    universo, para las industrias presentes. Cache diario en
    data/comparables_cache.json: el .info de un peer no cambia de forma
    relevante entre las 5 corridas del dia, asi que se pide una sola vez por
    dia en vez de en cada corrida. Devuelve (dict peer -> fila, cache_nuevo)."""
    industrias = {normalizar_industria(f["industria"]) for f in fundamentales}
    propios = {base_ticker(f["ticker"]) for f in fundamentales} | {f["ticker"] for f in fundamentales}
    necesarios = sorted(
        {p for ind in industrias for p in INDUSTRIA_COMPARABLES.get(ind, []) if p not in propios}
    )
    cache_hoy = cache_peers.get("pares", {}) if cache_peers.get("fecha") == hoy else {}
    filas = {p: cache_hoy[p] for p in necesarios if p in cache_hoy}
    faltan = [p for p in necesarios if p not in filas]

    def _pedir(peer):
        try:
            info = yf.Ticker(peer).info or {}
        except Exception:  # noqa: BLE001
            return peer, None
        if not info or not (info.get("shortName") or info.get("longName")):
            return peer, None
        return peer, _fila_peer_desde_info(peer, info)

    if faltan:
        print(f"  {len(faltan)} peers sin cache de hoy, pidiendo .info...")
        with ThreadPoolExecutor(max_workers=WORKERS_INFO) as pool:
            for peer, fila in pool.map(_pedir, faltan):
                if fila:
                    filas[peer] = fila
    # Si Yahoo fallo hoy para un peer, se reusa el ultimo dato cacheado.
    for p in necesarios:
        if p not in filas and p in cache_peers.get("pares", {}):
            filas[p] = cache_peers["pares"][p]
    return filas, {"fecha": hoy, "pares": {p: filas[p] for p in sorted(filas)}}


def construir_comparables(fundamentales, peers):
    """Para cada industria presente en tus tickers que tenga peers curados en
    comparables_universo.INDUSTRIA_COMPARABLES, arma el grupo (tus tickers +
    peers) y la mediana. La mediana usa solo tickers que cotizan en USD: un
    CEDEAR en pesos o una accion de B3 no son comparables en market cap, y
    sus multiplos suelen venir contaminados por mezcla de monedas."""
    por_industria = {}
    for f in fundamentales:
        por_industria.setdefault(f["industria"], []).append(f)

    tickers_propios = {f["ticker"] for f in fundamentales}
    resultado, sin_mapeo = [], []

    for industria, propios in sorted(por_industria.items()):
        peers_curados = INDUSTRIA_COMPARABLES.get(normalizar_industria(industria))
        if not peers_curados:
            sin_mapeo.append(industria)
            continue

        pares = [fila_par(p, True) for p in propios]
        vistos = set(tickers_propios)
        for peer in peers_curados:
            if peer in vistos or peer not in peers:
                continue
            vistos.add(peer)
            pares.append(fila_par({**peers[peer], "industria": industria}, False))

        en_usd = [p for p in pares if p.get("moneda") == "USD"]
        resultado.append(
            {
                "industria": industria,
                "pares": pares,
                "mediana": {k: num(mediana_de(en_usd, k), 2) for k in CLAVES_BENCH},
            }
        )

    if sin_mapeo:
        print(f"\n(Sin comparables curados para: {', '.join(sin_mapeo)})")

    return resultado


# ---------------------------------------------------------------------------
# Estado de la corrida anterior / historiales
# ---------------------------------------------------------------------------
def cargar_lista_previa(ruta, clave=None):
    """Carga un JSON de la corrida anterior (si existe), indexado por el
    simbolo resuelto (ej. "ALUA.BA"). Sirve para arrastrar el ultimo dato
    bueno de un ticker que falla en la corrida actual (yfinance flaky /
    rate-limit puntual) en vez de que desaparezca del todo hasta la proxima
    corrida exitosa."""
    data = leer_json(ruta)
    if data is None:
        return {}
    lista = data.get(clave) if (clave and isinstance(data, dict)) else data
    if not isinstance(lista, list):
        return {}
    return {f["ticker"]: f for f in lista if f.get("ticker")}


def mapear_previos(tickers_excel, prev_listado):
    """ticker del Excel -> simbolo con el que resolvio la corrida anterior.
    Primero el match exacto; si no, el mismo ticker con sufijo .SA/.BA,
    salvo que ese simbolo con sufijo este TAMBIEN en el Excel como fila
    propia (el Excel tiene "SEMI" y "SEMI.BA", "AGRO" y "AGRO.BA": indexar
    por ticker pelado los mezclaba y los dos terminaban como .BA)."""
    reservados = set(tickers_excel)
    mapa = {}
    for t in tickers_excel:
        if t in prev_listado:
            mapa[t] = t
            continue
        for suf in SUFIJOS[1:]:
            if f"{t}{suf}" in prev_listado and f"{t}{suf}" not in reservados:
                mapa[t] = f"{t}{suf}"
                break
    return mapa


def actualizar_historial_screener(historial, screener_actual, ahora):
    """Agrega (o pisa, si ya se corrio hoy) la entrada de hoy en el historial
    maestro de veredictos del screener, y recorta lo mas viejo que
    DIAS_HISTORIAL. Solo guarda el verdict por temporalidad (no el detalle
    completo). El maestro vive en data/ (no se publica): lo que se publica
    son los archivos por ticker (ver historial_por_ticker)."""
    historial = historial if isinstance(historial, list) else []
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


def historial_por_ticker(historial, ticker):
    """[{fecha, diario, semanal, mensual}] del ticker, de mas viejo a mas
    nuevo — lo que publica public/data/historial/<TICKER>.json."""
    return [
        {"fecha": h["fecha"], **h["tickers"][ticker]}
        for h in sorted(historial, key=lambda h: h["fecha"])
        if ticker in (h.get("tickers") or {})
    ]


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


def actualizar_historial_oportunidades(historial, calificados_hoy, ahora):
    """Mismo patron que actualizar_historial_screener: un snapshot por dia
    (se pisa si ya corrio hoy), recortado a DIAS_HISTORIAL."""
    historial = historial if isinstance(historial, list) else []
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


def calcular_beta_sharpe(closes, bench_closes, ventana=252, en_usd=True):
    """Beta realizado y correlacion contra el benchmark (SPY) + Sharpe y
    volatilidad anualizada del propio ticker, todo sobre el ultimo anio de
    ruedas. Reusa el historico de 5y ya descargado (closes), no pide nada
    nuevo salvo el benchmark (una sola vez por corrida, no por ticker).
    Beta/correlacion solo para tickers que cotizan en USD: un CEDEAR en
    pesos contra SPY en dolares mide sobre todo el movimiento del CCL, no
    el del activo. Sharpe/volatilidad se dejan (son del propio ticker, en
    su moneda)."""
    if not en_usd:
        bench_closes = None
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


# Serie completa de RSI (para divergencias): misma implementacion unica de
# comun.py que usa rsi_wilder() y los backtests.
_rsi_serie = rsi_serie


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


def _detectar_divergencia(closes, indicador, etiqueta_alcista, etiqueta_bajista, ventana_pivot, vigencia_ruedas, tramo):
    """Nucleo compartido entre detectar_divergencia_rsi y
    detectar_divergencia_ad (antes duplicado casi textual entre las dos,
    solo cambiaban las etiquetas): busca en los ultimos pivots de precio si
    `indicador` (RSI o A/D Line) se movio en contra — alcista/acumulacion si
    el precio hace un minimo mas bajo pero el indicador no, bajista/
    distribucion si el precio hace un maximo mas alto pero el indicador no.
    Heuristica basada en pivots locales, no una señal infalible."""
    sub_closes = closes.tail(tramo).reset_index(drop=True)
    sub_ind = indicador.tail(tramo).reset_index(drop=True)

    bajos, altos = _pivots(sub_closes, ventana_pivot)
    n = len(sub_closes)

    if len(bajos) >= 2:
        i1, i2 = bajos[-2], bajos[-1]
        hace = n - 1 - i2
        if hace <= vigencia_ruedas and sub_closes.iloc[i2] < sub_closes.iloc[i1] and sub_ind.iloc[i2] > sub_ind.iloc[i1]:
            return {"tipo": etiqueta_alcista, "hace_ruedas": int(hace)}
    if len(altos) >= 2:
        i1, i2 = altos[-2], altos[-1]
        hace = n - 1 - i2
        if hace <= vigencia_ruedas and sub_closes.iloc[i2] > sub_closes.iloc[i1] and sub_ind.iloc[i2] < sub_ind.iloc[i1]:
            return {"tipo": etiqueta_bajista, "hace_ruedas": int(hace)}
    return None


def detectar_divergencia_rsi(closes, lookback=90, ventana_pivot=5, vigencia_ruedas=20):
    """Divergencia precio/RSI en los ultimos 'lookback' dias — ver
    _detectar_divergencia. Solo reporta si el pivot mas reciente cayo dentro
    de 'vigencia_ruedas' para que no se marque algo viejo como si fuera
    actual."""
    if len(closes) < lookback + ventana_pivot * 2 + 20:
        return None
    rsi = _rsi_serie(closes)
    tramo = lookback + ventana_pivot * 2
    return _detectar_divergencia(closes, rsi, "alcista", "bajista", ventana_pivot, vigencia_ruedas, tramo)


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
    """Divergencia precio vs. A/D Line — ver _detectar_divergencia.
    "acumulacion" si el precio hace un minimo mas bajo pero la A/D Line no
    (no la están vendiendo tanto como cae el precio), "distribucion" si el
    precio hace un maximo mas alto pero la A/D Line no (no la estan
    comprando tanto como sube el precio)."""
    closes = ohlc["Close"]
    if len(closes) < lookback + ventana_pivot * 2 + 20:
        return None
    ad = _calcular_ad_line(ohlc)
    tramo = lookback + ventana_pivot * 2
    return _detectar_divergencia(closes, ad, "acumulacion", "distribucion", ventana_pivot, vigencia_ruedas, tramo)


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


def resolver_universo(bases, simbolo_previo):
    """dict ticker_base -> (simbolo_resuelto, hist).
    1) Cada ticker se pide con el simbolo con el que resolvio la corrida
       anterior (o pelado si nunca resolvio), con reintentos.
    2) Solo los que NUNCA resolvieron prueban .SA/.BA. Uno que ya tenia
       simbolo y hoy falla NO cambia de plaza: queda para el arrastre
       (stale) y se reintenta en la proxima corrida con el mismo simbolo."""
    candidato = {t: simbolo_previo.get(t, t) for t in bases}
    hists = descargar_historicos(list(candidato.values()))
    resueltos = {t: (s, hists[s]) for t, s in candidato.items() if s in hists}

    nuevos = [t for t in bases if t not in resueltos and t not in simbolo_previo and "." not in t]
    for suf in SUFIJOS[1:]:
        faltan = [t for t in nuevos if t not in resueltos]
        if not faltan:
            break
        print(f"  probando sufijo {suf} para {len(faltan)} ticker(s) nuevos sin datos...")
        h = descargar_historicos([f"{t}{suf}" for t in faltan], esperas=[])
        for t in faltan:
            if f"{t}{suf}" in h:
                resueltos[t] = (f"{t}{suf}", h[f"{t}{suf}"])
    return resueltos


def resolver_ticker(t):
    """Compatibilidad (un solo ticker): (sym, tk, hist, closes) o 4 None."""
    r = resolver_universo([t], {})
    if t not in r:
        return None, None, None, None
    sym, hist = r[t]
    return sym, yf.Ticker(sym), hist, hist["Close"].dropna()


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


def market_cap_usd(market_cap, moneda, fx):
    if not market_cap or not moneda or moneda not in fx or not fx[moneda]:
        return None
    return int(market_cap / fx[moneda])


# Horario de la rueda regular por plaza (hora local), para saber si la
# ultima vela del historico es una sesion todavia abierta.
HORARIOS_MERCADO = {
    "": ("America/New_York", (9, 30), (16, 0)),
    ".BA": ("America/Argentina/Buenos_Aires", (11, 0), (17, 0)),
    ".SA": ("America/Sao_Paulo", (10, 0), (17, 0)),
}


def sesion_en_curso(sym, ultima_fecha, ahora_utc):
    """True si la ultima vela es la de HOY y el mercado de ese simbolo esta
    abierto ahora (la vela todavia no cerro: volumen parcial)."""
    suf = ".BA" if sym.endswith(".BA") else (".SA" if sym.endswith(".SA") else "")
    zona, ini, fin = HORARIOS_MERCADO[suf]
    local = ahora_utc.astimezone(ZoneInfo(zona))
    if local.weekday() >= 5 or pd.Timestamp(ultima_fecha).date() != local.date():
        return False
    return ini <= (local.hour, local.minute) < fin


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
    transitoria en corridas largas)."""
    h = descargar_historicos([f"{t}.BA" for t in tickers_base], periodo="5d", esperas=[5])
    out = {}
    for t in tickers_base:
        serie = h.get(f"{t}.BA")
        if serie is not None:
            closes = serie["Close"].dropna()
            if len(closes):
                out[t] = float(closes.iloc[-1])
    return out


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
        "price_above_ema200": price_above_ema200,
        "price_above_sma50": price_above_sma50,
        "sma50_above_ema200": sma50_above_ema200,
        "sma50_rising": sma50_rising,
        "ema200_rising": ema200_rising,
        "sma50": num(sma50_v, 2),
        "ema200": num(ema200_v, 2),
    }


def ws_calcular_relative_return(closes, bench_closes, ventana=WS_VENTANA_RS):
    """Retorno relativo vs. SPY sobre ~6 meses. Las dos series se alinean
    POR FECHA (join de ruedas en comun) antes de contar "ventana ruedas
    atras": antes era por posicion en cada serie y, con feriados distintos
    (BYMA/B3 vs NYSE) o huecos de datos, comparaba fechas distintas. Valor
    crudo: el percentil dentro del universo se calcula despues, en la
    segunda pasada. Solo se llama para tickers en USD (ver main)."""
    if bench_closes is None or len(closes) < ventana + 1 or len(bench_closes) < ventana + 1:
        return None
    a = closes.copy()
    b = bench_closes.copy()
    for s_ in (a, b):
        if s_.index.tz is not None:
            s_.index = s_.index.tz_localize(None)
    a.index = a.index.normalize()
    b.index = b.index.normalize()
    conjunto = pd.concat([a.rename("t"), b.rename("b")], axis=1, join="inner").dropna()
    if len(conjunto) < ventana + 1:
        return None
    precio_actual, precio_prev = conjunto["t"].iloc[-1], conjunto["t"].iloc[-1 - ventana]
    spy_actual, spy_prev = conjunto["b"].iloc[-1], conjunto["b"].iloc[-1 - ventana]
    if not precio_prev or not spy_prev:
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
# Campos que existian en versiones anteriores del JSON y ya no se publican:
# se limpian tambien de las filas arrastradas (stale) de corridas viejas.
CAMPOS_ELIMINADOS = {"book_value", "fcf_por_accion"}
CAMPOS_ELIMINADOS_SCREENER = {"dist_clave", "dist_asl", "ma_clave"}


def _limpiar_fila_vieja(fila):
    fila = {k: v for k, v in fila.items() if k not in CAMPOS_ELIMINADOS}
    for tf in ("diario", "semanal", "mensual"):
        if isinstance(fila.get(tf), dict):
            fila[tf] = {k: v for k, v in fila[tf].items() if k not in CAMPOS_ELIMINADOS_SCREENER}
    return fila


def _parsear_args(argv=None):
    ap = argparse.ArgumentParser(description="Pipeline de datos de Stock Lens (yfinance -> JSON).")
    ap.add_argument("--out", type=Path, default=DIR_DATOS_PUBLICOS, help="carpeta publicada (default: public/data)")
    ap.add_argument("--estado", type=Path, default=DIR_ESTADO, help="carpeta de estado/caches (default: data/)")
    ap.add_argument("--tickers", help="lista separada por comas que reemplaza al Excel (para pruebas)")
    ap.add_argument("--limite", type=int, help="procesa solo los primeros N tickers del Excel (para pruebas)")
    return ap.parse_args(argv)


def _universo(args):
    if args.tickers:
        lista = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        df = pd.DataFrame({"Ticker": list(dict.fromkeys(lista))})
        for c in ("Industria", "Pais", "Nombre"):
            df[c] = ""
    else:
        df = leer_tickers()
    if args.limite:
        df = df.head(args.limite)
    return df.reset_index(drop=True)


def _edad_dias(ts_iso, ahora):
    try:
        return (ahora - datetime.fromisoformat(ts_iso)).total_seconds() / 86400
    except (TypeError, ValueError):
        return None


def procesar_ticker(fila, sym, hist, info_datos, ctx):
    """Calcula todas las filas (listado/medias/fundamentales/screener/
    scanner/warren/mensual) de un ticker ya descargado. Cualquier excepcion
    la maneja el llamador mandandolo al camino de arrastre."""
    t = fila["Ticker"]
    _, info, insider, holdings = info_datos
    pf = ctx["prev_fundamentales"].get(sym) or {}
    closes = hist["Close"].dropna()

    # Si Yahoo no devolvio .info (quoteSummary 404, rate-limit), se reusan
    # los datos "lentos" de la corrida anterior en vez de publicar None /
    # "Sin clasificar": nombre, industria, ratios, analistas, insiders.
    sin_info = not info
    quote_type = info.get("quoteType")
    es_fondo = quote_type in ("ETF", "MUTUALFUND")
    industria_prev = pf.get("industria") if pf.get("industria") not in (None, "", "Sin clasificar") else None

    nombre = fila["Nombre"] or info.get("shortName") or info.get("longName") or pf.get("nombre") or sym
    # "industry" es la clasificacion granular de Yahoo (ej. "Semiconductors"),
    # mas especifica que "sector" (ej. "Technology"). Los ETF no tienen ni
    # una ni otra en Yahoo (eran 49 "Sin clasificar"): se agrupan como "ETF".
    industria = (
        fila["Industria"]
        or info.get("industry")
        or info.get("sector")
        or ("ETF" if es_fondo else None)
        or industria_prev
        or "Sin clasificar"
    )
    pais = fila["Pais"] or info.get("country") or pf.get("pais") or "Sin país"
    moneda = info.get("currency") or pf.get("moneda") or moneda_por_sufijo(sym)
    moneda_financiera = info.get("financialCurrency") or (pf.get("moneda_financiera") if sin_info else None)
    en_usd = moneda == "USD"

    precio = float(closes.iloc[-1])
    anterior = float(closes.iloc[-2])
    var_pct = (precio / anterior - 1) * 100 if anterior else None
    rsi = rsi_wilder(closes.values, 14)

    ema21 = closes.ewm(span=21, adjust=False).mean().iloc[-1]
    ema50 = closes.ewm(span=50, adjust=False).mean().iloc[-1]
    ema150 = closes.ewm(span=150, adjust=False).mean().iloc[-1]
    sma200 = closes.rolling(200).mean().iloc[-1] if len(closes) >= 200 else None

    # Sin "actualizado" por fila: el timestamp global esta en meta.json y
    # solo las filas arrastradas (stale) llevan el suyo. Asi una corrida sin
    # datos nuevos no genera diff.
    base = {"ticker": sym, "nombre": nombre, "industria": industria, "pais": pais, "stale": False}

    # Sparkline: ultimas ~180 ruedas (~8-9 meses) de cierre, a 4 cifras
    # significativas (alcanza para dibujarlo y pesa bastante menos).
    spark = [sig(x, 4) for x in closes.tail(180).tolist()]
    ventana_52w = closes.tail(min(len(closes), 252))
    high_52w = float(ventana_52w.max())
    low_52w = float(ventana_52w.min())

    # Volumen de la ultima rueda CERRADA vs. promedio de las 20 anteriores.
    # Si la corrida cae con el mercado abierto, la ultima vela tiene volumen
    # parcial (a las 11 de la mañana siempre daba "volumen bajo"): en ese
    # caso se usa la rueda anterior. vol_fecha dice que rueda se midio.
    volumen = hist["Volume"].dropna() if "Volume" in hist.columns else pd.Series(dtype=float)
    fin = -1
    if len(volumen) >= 2 and sesion_en_curso(sym, volumen.index[-1], ctx["ahora_utc"]):
        fin = -2
    vol_hoy = vol_prom20 = vol_fecha = None
    if len(volumen) >= -fin:
        vol_hoy = float(volumen.iloc[fin])
        vol_fecha = volumen.index[fin].strftime("%Y-%m-%d")
        previos = volumen.iloc[fin - 20 : fin]
        if len(previos) == 20:
            vol_prom20 = float(previos.mean())
    vol_ratio = (vol_hoy / vol_prom20) if vol_hoy and vol_prom20 else None

    # Gap de apertura: hueco entre el cierre de ayer y la apertura de hoy.
    apertura_hoy = float(hist["Open"].iloc[-1]) if "Open" in hist.columns and len(hist) else None
    gap_pct = ((apertura_hoy / anterior) - 1) * 100 if apertura_hoy and anterior else None

    filas = {}
    filas["listado"] = {
        **base,
        "var_pct": num(var_pct, 2),
        "rsi": num(rsi, 2),
        "spark": spark,
        "high_52w": num(high_52w, 2),
        "low_52w": num(low_52w, 2),
        "vol_hoy": int(vol_hoy) if vol_hoy else None,
        "vol_prom20": int(vol_prom20) if vol_prom20 else None,
        "vol_ratio": num(vol_ratio, 2),
        "vol_fecha": vol_fecha,
        "gap_pct": num(gap_pct, 2),
    }

    # CEDEAR: solo si el dato principal es la especie extranjera en USD (si
    # ya resolvio como .BA, "precio" YA es el del CEDEAR). ratio N:1 = N
    # certificados = 1 accion; CCL implicito = precio_cedear * ratio / precio.
    cedear_precio = cedear_ratio = ccl_implicito = None
    if not sym.endswith(".BA") and en_usd and t in ctx["ratios_cedear"]:
        cedear_ratio = ctx["ratios_cedear"][t]
        cedear_precio = ctx["precios_cedear"].get(t)
        if cedear_precio and precio:
            ccl_implicito = (cedear_precio * cedear_ratio) / precio

    filas["medias"] = {
        **base,
        "precio": num(precio, 2),
        "dist_ema21": num(dist_pct(precio, ema21), 2),
        "dist_ema50": num(dist_pct(precio, ema50), 2),
        "dist_ema150": num(dist_pct(precio, ema150), 2),
        "dist_sma200": num(dist_pct(precio, sma200), 2),
        "cedear_ticker": f"{t}.BA" if cedear_precio is not None else None,
        "cedear_precio": num(cedear_precio, 2),
        "cedear_ratio": cedear_ratio,
        "cedear_ccl_implicito": num(ccl_implicito, 2),
    }

    claves_fund = list(extraer_fundamentales({}).keys())
    if sin_info and pf:
        fund = {k: pf.get(k) for k in claves_fund}
        sector = pf.get("sector")
        insider, holdings = pf.get("insider"), pf.get("holdings")
        proximo_earnings = pf.get("proximo_earnings")
    else:
        fund = anular_ratios_mixtos(extraer_fundamentales(info), moneda, moneda_financiera)
        sector = info.get("sector") or None
        proximo_earnings = extraer_proximo_earnings(info)
    mc = fund.pop("market_cap")
    recommendation_key = fund.pop("recommendation_key")  # texto, no pasa por num()
    dividendos = extraer_dividendos(hist)
    dy = calcular_dividend_yield(dividendos, precio, info)
    fund["dividend_yield"] = dy if (dy is not None or not sin_info) else pf.get("dividend_yield")
    target_mean_price = fund.get("target_mean_price")
    upside_pct = ((target_mean_price / precio - 1) * 100) if target_mean_price and precio else None
    stats_mercado = calcular_beta_sharpe(closes, ctx["bench_closes"], en_usd=en_usd)
    precios_mensuales, estacionalidad = calcular_estacionalidad_y_mensual(closes)
    pre_post_market = extraer_pre_post_market(info, pf.get("pre_post_market"), ctx["ahora_iso"])

    filas["fundamentales"] = {
        **base,
        **{k: num(v, 2) for k, v in fund.items()},
        "market_cap": int(mc) if mc else None,
        "market_cap_usd": None,  # se completa despues del loop (necesita el CCL mediano)
        "moneda": moneda,
        "moneda_financiera": moneda_financiera,
        "sector": sector,
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
    filas["screener"] = {**base, **calcular_screener(hist)}
    filas["scanner_setups"] = {**base, **calcular_setup_scanner(hist)}
    filas["mensual"] = precios_mensuales

    # Warren Score: pilares A/C/D por ticker; el B (Fuerza Relativa) necesita
    # el percentil de TODO el universo y se arma despues del loop. Solo
    # tickers en USD entran al percentil de RS vs SPY (un CEDEAR en pesos
    # "le gana" a SPY por la devaluacion, no por fuerza relativa real).
    filas["warren"] = {
        "ticker": sym,
        "nombre": nombre,
        "trend": ws_calcular_trend(closes),
        "relative_return": ws_calcular_relative_return(closes, ctx["bench_closes"]) if en_usd else None,
        "momentum": ws_calcular_momentum(closes, high_52w, low_52w, precio),
        "volatility": ws_calcular_volatility(closes),
    }
    return filas


def main(argv=None):
    args = _parsear_args(argv)
    out = args.out.resolve()
    estado = args.estado.resolve()
    out.mkdir(parents=True, exist_ok=True)
    estado.mkdir(parents=True, exist_ok=True)

    ahora = datetime.now(TZ)
    ahora_iso = ahora.isoformat()
    ahora_utc = datetime.now(timezone.utc)
    hoy = ahora.strftime("%Y-%m-%d")

    # --- Universo: Excel - basura por regla - invalidos cacheados ---
    tickers = _universo(args)
    descartados = sorted(t for t in tickers["Ticker"] if es_ticker_basura(t))
    tickers = tickers[~tickers["Ticker"].isin(descartados)].reset_index(drop=True)

    ruta_invalidos = estado / "invalidos_cache.json"
    cache_invalidos = leer_json(ruta_invalidos, {}) or {}
    invalidos_vigentes = {}
    for t, fecha in cache_invalidos.items():
        try:
            if (ahora.date() - datetime.fromisoformat(fecha).date()).days < TTL_INVALIDOS_DIAS:
                invalidos_vigentes[t] = fecha
        except (TypeError, ValueError):
            pass
    salteados = sorted(t for t in tickers["Ticker"] if t in invalidos_vigentes)
    tickers = tickers[~tickers["Ticker"].isin(salteados)].reset_index(drop=True)
    print(
        f"Universo: {len(tickers)} tickers a procesar (periodo {PERIODO_HISTORICO}); "
        f"{len(descartados)} descartados por regla, {len(salteados)} invalidos en cache (TTL {TTL_INVALIDOS_DIAS}d).\n"
    )

    # --- Estado de la corrida anterior ---
    # Para arrastrar el ultimo dato bueno de un ticker que falla hoy
    # (yfinance flaky) y para no cambiar de plaza el simbolo resuelto.
    prev_listado = cargar_lista_previa(out / "listado.json", clave="acciones")
    prev_medias = cargar_lista_previa(out / "medias.json")
    prev_fundamentales = cargar_lista_previa(out / "fundamentales.json")
    prev_screener = cargar_lista_previa(out / "screener.json")
    prev_scanner_setups = cargar_lista_previa(out / "scanner_setups.json")
    prev_meta = leer_json(out / "meta.json", {}) or {}
    ts_prev = prev_meta.get("ultima_actualizacion")
    simbolo_previo = mapear_previos(list(tickers["Ticker"]) + salteados, prev_listado)

    print("Descargando ratios de CEDEAR (Comafi)...")
    ratios_comafi = descargar_ratios_cedear()
    ratios_manuales = cargar_ratios_cedear_manuales()
    ratios_cedear = combinar_ratios_cedear(ratios_comafi, ratios_manuales)
    print(
        f"  {len(ratios_cedear)} ratios de CEDEAR cargados "
        f"({len(ratios_comafi)} de Comafi + {len(ratios_cedear) - len(ratios_comafi)} manuales)."
    )

    print("Descargando historicos (en lote)...")
    t0 = time.monotonic()
    resueltos = resolver_universo(list(tickers["Ticker"]), simbolo_previo)
    print(f"  {len(resueltos)}/{len(tickers)} resueltos en {time.monotonic() - t0:.0f}s.")

    # Benchmark: si SPY esta en el universo se reusa (antes se bajaba dos veces).
    bench_closes = None
    for t, (sym, h) in resueltos.items():
        if sym == "SPY":
            bench_closes = h["Close"].dropna()
    if bench_closes is None:
        h = descargar_historicos(["SPY"]).get("SPY")
        bench_closes = h["Close"].dropna() if h is not None else None
    if bench_closes is None or bench_closes.empty:
        print("  ! No se pudo descargar SPY: beta/correlacion/RS van a quedar en None.")

    print(f"Pidiendo .info/insiders de {len(resueltos)} simbolos ({WORKERS_INFO} en paralelo)...")
    t0 = time.monotonic()

    def _pedir_seguro(sym):
        try:
            return pedir_info(sym)
        except Exception:  # noqa: BLE001
            return sym, {}, None, None

    with ThreadPoolExecutor(max_workers=WORKERS_INFO) as pool:
        infos = {r[0]: r for r in pool.map(_pedir_seguro, [s for s, _ in resueltos.values()])}
    print(f"  listo en {time.monotonic() - t0:.0f}s ({sum(1 for r in infos.values() if not r[1])} sin .info).")

    # Si "{t}.BA" es una fila propia del Excel (AGRO.BA = Agrometal, SEMI.BA =
    # Molinos Semino), ese simbolo es una accion local, no el CEDEAR de t.
    excel = set(tickers["Ticker"])
    candidatos_cedear = [
        t for t, (sym, _) in resueltos.items()
        if not sym.endswith(".BA")
        and t in ratios_cedear
        and f"{t}.BA" not in excel
        and (infos[sym][1].get("currency") or "USD") == "USD"
    ]
    print(f"Descargando precio de {len(candidatos_cedear)} CEDEARs (.BA, en lote)...")
    precios_cedear = obtener_precios_cedear(candidatos_cedear)

    ctx = {
        "prev_fundamentales": prev_fundamentales,
        "ratios_cedear": ratios_cedear,
        "precios_cedear": precios_cedear,
        "bench_closes": bench_closes,
        "ahora_iso": ahora_iso,
        "ahora_utc": ahora_utc,
    }

    listado, medias, fundamentales, screener, scanner_setups = [], [], [], [], []
    mensuales, warren_datos = {}, []
    invalidos, sin_arrastre, descartados_viejos = [], [], []
    salidas = {
        "listado": (listado, prev_listado),
        "medias": (medias, prev_medias),
        "fundamentales": (fundamentales, prev_fundamentales),
        "screener": (screener, prev_screener),
        "scanner_setups": (scanner_setups, prev_scanner_setups),
    }

    def arrastrar(t):
        """Publica el ultimo dato bueno del ticker marcado stale (con el
        timestamp de su ultima descarga exitosa). Devuelve False si no hay
        dato previo o si ya tiene mas de DIAS_MAX_ARRASTRE dias."""
        clave = simbolo_previo.get(t)
        previo = prev_listado.get(clave) if clave else None
        if not previo:
            return False
        ts = previo.get("actualizado") if previo.get("stale") else ts_prev
        ts = ts or ts_prev
        edad = _edad_dias(ts, ahora)
        if edad is None or edad > DIAS_MAX_ARRASTRE:
            print(f"  x {t}: dato arrastrado desde {ts} (> {DIAS_MAX_ARRASTRE} dias), se descarta.")
            descartados_viejos.append(t)
            return False
        print(f"  ~ {t}: sin datos ahora, se mantiene el ultimo dato ({ts})")
        for lista, prev in salidas.values():
            if clave in prev:
                lista.append({**_limpiar_fila_vieja(prev[clave]), "stale": True, "actualizado": ts})
        return True

    for _, fila in tickers.iterrows():
        t = fila["Ticker"]
        if t not in resueltos:
            invalidos.append(t)
            if not arrastrar(t):
                sin_arrastre.append(t)
                print(f"  ! {t}: sin datos (probe .SA / .BA)")
            continue
        sym, hist = resueltos[t]
        try:
            filas = procesar_ticker(fila, sym, hist, infos.get(sym) or (sym, {}, None, None), ctx)
        except Exception as e:  # noqa: BLE001
            # Un ticker roto (dato raro de Yahoo, bug en un indicador) no
            # corta la corrida entera: va al mismo camino que un fallo de red.
            print(f"  ! {t} ({sym}): error procesando ({type(e).__name__}: {e}), se intenta arrastre")
            invalidos.append(t)
            if not arrastrar(t):
                sin_arrastre.append(t)
            continue
        for clave, (lista, _) in salidas.items():
            lista.append(filas[clave])
        mensuales[sym] = filas["mensual"]
        warren_datos.append(filas["warren"])
        print(f"  ok {sym} ({filas['listado']['nombre']})")

    # --- Salvaguarda anti rate-limit ---
    # Se compara contra los tickers INTENTADOS en esta corrida (referencia
    # estable, no el conteo de la corrida anterior: ese se podia ir
    # achicando corrida a corrida si Yahoo fallaba de a poco). Aborta con
    # exit 1 (el workflow queda en rojo y no commitea) en vez de exit 0.
    n_intentados = len(tickers)
    n_frescos = sum(1 for f in listado if not f.get("stale"))
    if n_intentados >= 5 and n_frescos < n_intentados * UMBRAL_ABORTO:
        msg = (
            f"ABORTO: solo {n_frescos} tickers frescos de {n_intentados} intentados "
            f"(< {UMBRAL_ABORTO:.0%}, posible rate-limit de Yahoo). No se escribio nada."
        )
        print(f"\n::error::{msg}")
        sys.exit(1)

    # --- CCL implicito: mediana + descarte de outliers ---
    ccls = [m["cedear_ccl_implicito"] for m in medias if not m.get("stale") and m.get("cedear_ccl_implicito")]
    ccl_mediana = float(np.median(ccls)) if ccls else None
    if ccl_mediana:
        fuera = []
        for m in medias:
            v = m.get("cedear_ccl_implicito")
            if v and not m.get("stale") and abs(v / ccl_mediana - 1) > TOL_CCL:
                fuera.append(f"{m['ticker']} ({v:.0f})")
                m["cedear_ccl_implicito"] = None
        print(f"\nCCL implicito mediano: {ccl_mediana:.2f} ({len(ccls)} CEDEARs).")
        if fuera:
            print(f"  CCL descartado por alejarse >{TOL_CCL:.0%} de la mediana: {', '.join(fuera)}")

    print("\nArmando comparables por industria...")
    ruta_cache_peers = estado / "comparables_cache.json"
    peers, cache_peers = obtener_peers(fundamentales, leer_json(ruta_cache_peers, {}) or {}, hoy)

    # --- Market cap en USD ---
    monedas = {f.get("moneda") for f in fundamentales} | {p.get("moneda") for p in peers.values()}
    fx = obtener_fx(monedas, ccl_mediana)
    for f in fundamentales:
        if not f.get("moneda"):
            f["moneda"] = moneda_por_sufijo(f["ticker"])
        if not f.get("stale") or f.get("market_cap_usd") is None:
            f["market_cap_usd"] = market_cap_usd(f.get("market_cap"), f.get("moneda"), fx)
    for p in peers.values():
        p["market_cap_usd"] = market_cap_usd(p.get("market_cap"), p.get("moneda"), fx)

    comparables = construir_comparables(fundamentales, peers)

    print("\nCalculando Warren Score (percentil de fuerza relativa sobre el universo USD)...")
    warren_score = calcular_warren_score(warren_datos)

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

    n_compra = sum(
        1 for f in screener if any((f.get(tf) or {}).get("verdict") == "COMPRA" for tf in ("diario", "semanal", "mensual"))
    )
    print(f"Screener: {n_compra} ticker(s) con señal de COMPRA en alguna temporalidad.")

    print("\nActualizando historial de señales...")
    ruta_master = estado / "screener_historial.json"
    legado_historial = out / "screener_historial.json"
    master = leer_json(ruta_master)
    if master is None:  # migracion: el maestro antes se publicaba en public/data
        master = leer_json(legado_historial, []) or []
    historial = actualizar_historial_screener(master, screener, ahora)

    print("Actualizando historial de Oportunidades...")
    calificados_hoy = calcular_oportunidades_hoy(fundamentales, comparables, screener)
    historial_oportunidades = actualizar_historial_oportunidades(
        leer_json(out / "oportunidades_historial.json", []), calificados_hoy, ahora
    )
    print(f"  {len(calificados_hoy)} ticker(s) cumplen hoy valor+señal.")

    # --- Escritura (atomica, minificada, solo si cambio) ---
    print("\nEscribiendo JSON:")
    cambios = 0
    cambios += escribir_json(out / "listado.json", {"acciones": listado, "promedios_por_industria": promedios})
    cambios += escribir_json(out / "medias.json", medias)
    cambios += escribir_json(out / "fundamentales.json", fundamentales)
    cambios += escribir_json(out / "comparables.json", comparables)
    cambios += escribir_json(out / "screener.json", screener)
    cambios += escribir_json(out / "scanner_setups.json", scanner_setups)
    cambios += escribir_json(out / "oportunidades_historial.json", historial_oportunidades)
    cambios += escribir_json(
        out / "warren_score.json", {"actualizado": ahora_iso, "tickers": warren_score}, ignorar_claves=("actualizado",)
    )

    # Migracion one-off al layout por ticker: el historico mensual pasa de un
    # JSON unico (1.8MB) a mensual/<TICKER>.json (sirve para los arrastrados,
    # que no traen precios nuevos en esta corrida).
    legado_mensual = out / "historico_mensual.json"
    if legado_mensual.exists():
        for item in leer_json(legado_mensual, []) or []:
            destino = out / "mensual" / f"{item['ticker']}.json"
            if not destino.exists() and item.get("precios") and item["ticker"] not in mensuales:
                escribir_json(destino, item["precios"], silencioso=True)

    vigentes = {f["ticker"] for f in listado}
    n_por_ticker = 0
    for sym, precios in mensuales.items():
        n_por_ticker += escribir_json(out / "mensual" / f"{sym}.json", precios, silencioso=True)
    for sym in sorted(vigentes):
        n_por_ticker += escribir_json(
            out / "historial" / f"{sym}.json", historial_por_ticker(historial, sym), silencioso=True
        )
    print(f"  -> mensual/ e historial/: {n_por_ticker} archivo(s) por ticker escritos")
    huerfanos = borrar_huerfanos(out / "mensual", vigentes) + borrar_huerfanos(out / "historial", vigentes)
    if huerfanos:
        print(f"  borrados {len(huerfanos)} archivo(s) por ticker huerfano(s): {sorted(set(huerfanos))}")
    for legado in (legado_mensual, legado_historial):
        if legado.exists():
            legado.unlink()
            print(f"  borrado {legado.name} (reemplazado por archivos por ticker)")
            cambios += 1
    cambios += n_por_ticker + len(huerfanos)

    # Estado (data/): no se publica, pero se commitea para la proxima corrida.
    escribir_json(ruta_master, historial)
    escribir_json(ruta_cache_peers, cache_peers)
    nuevos_invalidos = dict(invalidos_vigentes)
    for t in sin_arrastre:
        nuevos_invalidos[t] = hoy
    escribir_json(ruta_invalidos, {t: nuevos_invalidos[t] for t in sorted(nuevos_invalidos)})

    n_arrastrados = sum(1 for f in listado if f.get("stale"))
    meta = {
        "ultima_actualizacion": ahora_iso,
        "n_tickers": len(listado),
        "n_frescos": n_frescos,
        "n_intentados": n_intentados,
        "ccl_implicito_mediana": num(ccl_mediana, 2),
        "tickers_invalidos": sorted(set(invalidos) | set(salteados)),
        "tickers_descartados": descartados,
    }
    # meta.json solo cambia su timestamp si cambio algun dato publicado: una
    # corrida sin novedades (fin de semana, feriado) no genera commit.
    if cambios:
        escribir_json(out / "meta.json", meta)
    else:
        escribir_json(out / "meta.json", meta, ignorar_claves=("ultima_actualizacion",))
        print("  (sin cambios en los datos publicados)")

    print(
        f"\nListo. {n_frescos} frescos, {n_arrastrados} arrastrados, {len(invalidos)} sin datos hoy, "
        f"{len(salteados)} salteados por cache, {len(descartados)} descartados por regla."
    )
    if invalidos:
        print(f"Sin datos hoy: {invalidos}")


if __name__ == "__main__":
    main()
