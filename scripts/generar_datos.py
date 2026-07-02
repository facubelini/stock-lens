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
from datetime import datetime
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

TOL_PULLBACK = 1.2  # % de distancia a la media clave para considerar "en pullback"
TOL_EXTENSION = 6.0  # % de distancia para considerar "extendido"


def _texto_tendencia(estado):
    return {"Bull": "alcista", "Bear": "bajista"}.get(estado, "neutral")


def _construir_motivo(estado, verdict, nombre_clave, dist_clave, rsi):
    partes = [f"Tendencia {_texto_tendencia(estado)}"]
    if dist_clave is not None:
        lado = "sobre" if dist_clave >= 0 else "bajo"
        partes.append(f"precio {lado} {nombre_clave} ({dist_clave:+.1f}%)")
    if rsi is not None:
        partes.append(f"RSI {rsi:.0f}")
    extra = {
        "COMPRA": "en pullback a la media, listo para entrar",
        "CERCA": "acercándose a la zona de pullback",
        "VENTA": "presión vendedora",
        "EXTENDIDO": "muy extendido, esperar un retroceso",
    }.get(verdict)
    if extra:
        partes.append(extra)
    return " · ".join(partes)


def perfil_setup(closes, medias, clave, slope_lookback):
    """Aplica la logica de Estado/Trend/Score/Setup del indicador Pine (ver
    indicator_v6_optimo_v2.pine) a una serie de cierres de CUALQUIER
    temporalidad (diaria/semanal/mensual ya resampleada). Devuelve un dict
    con veredicto (COMPRA/CERCA/VENTA/EXTENDIDO/NEUTRAL) + motivo, o None si
    no hay velas suficientes para esa temporalidad todavia."""
    periodo_max = max(p[2] for p in medias)
    if len(closes) < periodo_max + slope_lookback + 1:
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

    trend_up = ma_clave > ma_clave_prev
    trend_dn = ma_clave < ma_clave_prev

    ma_rapida = series[medias[0][0]].iloc[-1]
    ma_media = series[medias[1][0]].iloc[-1]

    score = 0
    if precio > ma_clave:
        score += 1
    if not pd.isna(ma_rapida) and not pd.isna(ma_media) and ma_rapida > ma_media:
        score += 1
    if rsi is not None and rsi > 50:
        score += 1

    estado = "Bull" if (score >= 2 and trend_up) else ("Bear" if (score <= 1 and trend_dn) else "Neutral")

    dist_clave = dist_pct(precio, ma_clave)
    pullback_ok = dist_clave is not None and abs(dist_clave) <= TOL_PULLBACK
    extendido = dist_clave is not None and abs(dist_clave) >= TOL_EXTENSION
    cerca = dist_clave is not None and abs(dist_clave) <= TOL_PULLBACK * 2

    if estado == "Bull" and pullback_ok and rsi is not None and rsi >= 50:
        verdict = "COMPRA"
    elif estado == "Bull" and not extendido and cerca:
        verdict = "CERCA"
    elif estado == "Bear" and rsi is not None and rsi <= 45:
        verdict = "VENTA"
    elif extendido:
        verdict = "EXTENDIDO"
    else:
        verdict = "NEUTRAL"

    return {
        "verdict": verdict,
        "estado": estado,
        "rsi": num(rsi, 1),
        "dist_clave": num(dist_clave, 2),
        "ma_clave": nombre_clave,
        "motivo": _construir_motivo(estado, verdict, nombre_clave, dist_clave, rsi),
    }


def calcular_screener(hist):
    """Arma el veredicto diario/semanal/mensual a partir del historico diario
    ya descargado (resamplea semanal/mensual, no pide datos nuevos)."""
    diarias = hist["Close"].dropna()
    semanales = hist["Close"].resample("W-FRI").last().dropna()
    mensuales = hist["Close"].resample("ME").last().dropna()
    return {
        "diario": perfil_setup(diarias, **PERFIL_DIARIO),
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
    }


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

    listado, medias, fundamentales, screener, invalidos = [], [], [], [], []

    for _, fila in tickers.iterrows():
        t = fila["Ticker"]

        sym, tk, hist, closes = resolver_ticker(t)
        if sym is None:
            print(f"  ! {t}: sin datos (probe .SA / .BA)")
            invalidos.append(t)
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

        base = {"ticker": sym, "nombre": nombre, "industria": industria, "pais": pais}

        # Sparkline: ultimas ~30 ruedas de cierre para el mini-grafico del frontend.
        spark = [round(float(x), 2) for x in closes.tail(30).tolist()]

        listado.append({**base, "var_pct": num(var_pct, 2), "rsi": num(rsi, 2), "spark": spark})

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
        fundamentales.append(
            {
                **base,
                **{k: num(v, 2) for k, v in fund.items()},
                "market_cap": int(mc) if mc else None,
                "sector": info.get("sector") or None,
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

    # Salvaguarda: si esta corrida recupero MUCHOS menos validos que la ultima
    # (tipico de un rate-limit de Yahoo en CI), no pisar los datos buenos.
    anterior = 0
    meta_prev = DIR_SALIDA / "meta.json"
    if meta_prev.exists():
        try:
            anterior = int(json.loads(meta_prev.read_text(encoding="utf-8")).get("n_tickers", 0))
        except Exception:  # noqa: BLE001
            anterior = 0
    if anterior and len(listado) < anterior * 0.5:
        print(
            f"\nABORTO la escritura: {len(listado)} validos vs {anterior} previos "
            "(posible rate-limit). Se conservan los datos anteriores."
        )
        return

    meta = {
        "ultima_actualizacion": datetime.now(TZ).isoformat(),
        "n_tickers": len(listado),
        "tickers_invalidos": invalidos,
    }

    print("\nArmando comparables por industria...")
    comparables = construir_comparables(fundamentales)

    n_compra = sum(
        1 for f in screener if any((f.get(tf) or {}).get("verdict") == "COMPRA" for tf in ("diario", "semanal", "mensual"))
    )
    print(f"Screener: {n_compra} ticker(s) con señal de COMPRA en alguna temporalidad.")

    print("\nEscribiendo JSON:")
    escribir("listado.json", {"acciones": listado, "promedios_por_industria": promedios})
    escribir("medias.json", medias)
    escribir("fundamentales.json", fundamentales)
    escribir("comparables.json", comparables)
    escribir("screener.json", screener)
    escribir("meta.json", meta)

    print(f"\nListo. {len(listado)} validos, {len(invalidos)} invalidos.")
    if invalidos:
        print(f"Invalidos: {invalidos}")


if __name__ == "__main__":
    main()
