"""Pipeline de datos de Stock Lens.

Lee data/tickers.xlsx, descarga datos diarios con yfinance, calcula los
indicadores y escribe los JSON estaticos que consume el frontend en
public/data/. No requiere API keys.

Uso:
    python scripts/generar_datos.py
"""

import json
import math
import unicodedata
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yfinance as yf

# --- Rutas y constantes ---
RAIZ = Path(__file__).resolve().parent.parent
ARCHIVO_TICKERS = RAIZ / "data" / "tickers.xlsx"
DIR_SALIDA = RAIZ / "public" / "data"
TZ = ZoneInfo("America/Argentina/Buenos_Aires")

# Encabezados aceptados para la columna de tickers (se normalizan sin acentos).
NOMBRES_TICKER = ["ticker", "codigo", "symbol", "simbolo", "code", "tickers"]
PERIODO_HISTORICO = "2y"  # suficiente para SMA200 / EMA150 bien calentadas
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

    listado, medias, fundamentales, invalidos = [], [], [], []

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
        nombre = fila["Nombre"] or info.get("shortName") or info.get("longName") or sym
        industria = fila["Industria"] or info.get("sector") or "Sin clasificar"
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

    meta = {
        "ultima_actualizacion": datetime.now(TZ).isoformat(),
        "n_tickers": len(listado),
        "tickers_invalidos": invalidos,
    }

    print("\nEscribiendo JSON:")
    escribir("listado.json", {"acciones": listado, "promedios_por_industria": promedios})
    escribir("medias.json", medias)
    escribir("fundamentales.json", fundamentales)
    escribir("meta.json", meta)

    print(f"\nListo. {len(listado)} validos, {len(invalidos)} invalidos.")
    if invalidos:
        print(f"Invalidos: {invalidos}")


if __name__ == "__main__":
    main()
