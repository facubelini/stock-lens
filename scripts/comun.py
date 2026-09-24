"""Utilidades compartidas entre los scripts del pipeline (generar_datos,
mercado_macro, historico_fundamental, backtests, mock).

Antes cada script tenia su propia copia de TZ/RAIZ/num/_normalizar_industria
y habia TRES implementaciones distintas de RSI (dos con EWM sin semilla, una
con semilla de media simple) que daban numeros levemente distintos entre la
vista en vivo y el backtest. Ahora hay una sola (rsi_serie) y todos la usan.
"""

import json
import math
import os
import re
import tempfile
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

RAIZ = Path(__file__).resolve().parent.parent
DIR_DATOS_PUBLICOS = RAIZ / "public" / "data"  # lo que se publica en Pages
DIR_ESTADO = RAIZ / "data"  # estado/caches del pipeline (se commitea, no se publica)
TZ = ZoneInfo("America/Argentina/Buenos_Aires")

# Claves de ratios usadas tanto para la mediana de industria en Fundamentales
# como para la mediana del universo de comparables.
CLAVES_BENCH = [
    "per_trailing", "per_forward", "peg", "ev_sales", "pb", "ps", "market_cap",
    "eps", "profit_margin", "roe", "dividend_yield", "beta", "debt_to_equity", "current_ratio",
]


# ---------------------------------------------------------------------------
# Numeros
# ---------------------------------------------------------------------------
def num(v, dec=2):
    """Redondea a 'dec' decimales; None si no es un numero finito."""
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, dec)


def sig(v, digitos=4):
    """Redondea a 'digitos' cifras significativas (para el sparkline: con 4
    alcanza para dibujarlo y el JSON pesa bastante menos que con 2 decimales
    fijos en precios de 4-5 cifras)."""
    f = num(v, 12)
    if f is None:
        return None
    return float(f"{f:.{digitos}g}")


def mediana_de(filas, clave):
    vals = sorted(f[clave] for f in filas if f.get(clave) is not None)
    if not vals:
        return None
    n = len(vals)
    m = n // 2
    return vals[m] if n % 2 else (vals[m - 1] + vals[m]) / 2


# ---------------------------------------------------------------------------
# Indicadores compartidos
# ---------------------------------------------------------------------------
def rsi_serie(closes, periodo=14):
    """RSI de Wilder sobre la serie completa (pd.Series). Semilla = media
    simple de las primeras 'periodo' variaciones y despues el suavizado
    recursivo de Wilder (avg = (avg*(n-1) + x) / n), que es exactamente un
    EWM con alpha=1/n arrancando desde la semilla. NaN mientras no hay
    'periodo' variaciones. Es la UNICA implementacion del repo: la usan la
    vista en vivo (ultimo valor), las divergencias y los backtests."""
    closes = pd.Series(closes, dtype="float64") if not isinstance(closes, pd.Series) else closes.astype("float64")
    n = len(closes)
    if n < periodo + 1:
        return pd.Series(np.nan, index=closes.index)
    delta = closes.diff()
    ganancia = delta.clip(lower=0)
    perdida = -delta.clip(upper=0)

    def _wilder(x):
        x = x.copy()
        semilla = x.iloc[1 : periodo + 1].mean()
        x.iloc[:periodo] = np.nan
        x.iloc[periodo] = semilla
        # adjust=False + NaN iniciales: el EWM arranca en la semilla.
        return x.ewm(alpha=1 / periodo, adjust=False).mean()

    avg_g = _wilder(ganancia)
    avg_p = _wilder(perdida)
    with np.errstate(divide="ignore", invalid="ignore"):
        rsi = 100 - 100 / (1 + avg_g / avg_p)
    rsi[(avg_p == 0) & avg_g.notna()] = 100.0
    return rsi


def rsi_wilder(closes, period=14):
    """Ultimo valor del RSI de Wilder (float) o None si no hay datos."""
    serie = rsi_serie(pd.Series(np.asarray(closes, dtype="float64")), period)
    if not len(serie) or pd.isna(serie.iloc[-1]):
        return None
    return float(serie.iloc[-1])


def atr_serie(high, low, close, periodo=14):
    """ATR de Wilder sobre la serie completa: true range = max(H-L, |H-C
    ant.|, |L-C ant.|) suavizado con alpha=1/n (mismo EWM que el RSI). NaN
    mientras no hay 'periodo' ruedas."""
    cierre_ant = close.shift(1)
    tr = pd.concat([high - low, (high - cierre_ant).abs(), (low - cierre_ant).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / periodo, adjust=False, min_periods=periodo).mean()


def adx_dmi_serie(high, low, close, periodo=14):
    """ADX(14) de Wilder con +DI/-DI (usado por el Regimen de Mercado).
    Formula estandar: +DM/-DM por rueda (solo el mayor de los dos si ambos
    son positivos, si no 0), suavizados con el mismo EWM alpha=1/periodo que
    el RSI/ATR; +DI/-DI = 100 * DM_suavizado / ATR(periodo); DX = 100 *
    |+DI - -DI| / (+DI + -DI); ADX = EWM(alpha=1/periodo) de DX. Devuelve
    (adx, plus_di, minus_di), tres pd.Series alineadas al indice de 'close'
    (NaN mientras no hay 'periodo' ruedas)."""
    high = pd.Series(high, dtype="float64") if not isinstance(high, pd.Series) else high.astype("float64")
    low = pd.Series(low, dtype="float64") if not isinstance(low, pd.Series) else low.astype("float64")
    close = pd.Series(close, dtype="float64") if not isinstance(close, pd.Series) else close.astype("float64")
    subida, bajada = high.diff(), -low.diff()
    plus_dm = pd.Series(np.where((subida > bajada) & (subida > 0), subida, 0.0), index=high.index)
    minus_dm = pd.Series(np.where((bajada > subida) & (bajada > 0), bajada, 0.0), index=high.index)
    atr = atr_serie(high, low, close, periodo)
    plus_dm_s = plus_dm.ewm(alpha=1 / periodo, adjust=False, min_periods=periodo).mean()
    minus_dm_s = minus_dm.ewm(alpha=1 / periodo, adjust=False, min_periods=periodo).mean()
    with np.errstate(divide="ignore", invalid="ignore"):
        plus_di = 100 * plus_dm_s / atr
        minus_di = 100 * minus_dm_s / atr
        dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di)
    adx = dx.ewm(alpha=1 / periodo, adjust=False, min_periods=periodo).mean()
    return adx, plus_di, minus_di


def dias_distribucion(close, volume, ventana=25, caida_pct=0.2):
    """Cuenta de 'dias de distribucion' (regla clasica estilo O'Neil/IBD) en
    las ultimas 'ventana' ruedas: una rueda cuenta si el cierre bajo >=
    'caida_pct'% Y el volumen de esa rueda fue mayor al de la rueda anterior.
    Usado por el Regimen de Mercado (indices SPY/QQQ). Devuelve un int."""
    close = pd.Series(close, dtype="float64") if not isinstance(close, pd.Series) else close.astype("float64")
    volume = pd.Series(volume, dtype="float64") if not isinstance(volume, pd.Series) else volume.astype("float64")
    var_pct = close.pct_change() * 100
    es_distribucion = (var_pct <= -caida_pct) & (volume > volume.shift(1))
    return int(es_distribucion.tail(ventana).fillna(False).sum())


def _es_num(x):
    return x is not None and not isinstance(x, bool) and not (isinstance(x, float) and math.isnan(x))


def es_valido(x):
    """True si x no es None ni un float NaN/inf (los ints/np.float64 pasan)."""
    return x is not None and not (isinstance(x, float) and (math.isnan(x) or math.isinf(x)))


def tri(x, a, b, c, d):
    """Pertenencia trapezoidal: 0 hasta 'a', sube lineal hasta 1 en 'b',
    vale 1 entre 'b' y 'c', baja lineal hasta 0 en 'd'. Con a == b el lado
    izquierdo es plano (1 desde 'a'); con c == d, el derecho (1 hasta 'c').
    Dato faltante = 0 (no suma)."""
    if not _es_num(x):
        return 0.0
    if x < a:
        return 0.0
    if x < b:
        return (x - a) / (b - a)
    if x <= c:
        return 1.0
    if x < d:
        return (d - x) / (d - c)
    return 0.0


def lineal(x, x0, x1, y0, y1):
    """Mapa lineal x0->y0, x1->y1, recortado al tramo [y0, y1] (sirve
    tambien con x0 > x1). Dato faltante = y0."""
    if not _es_num(x) or x1 == x0:
        return float(y0)
    t = min(1.0, max(0.0, (x - x0) / (x1 - x0)))
    return y0 + t * (y1 - y0)


# ---------------------------------------------------------------------------
# Textos / tickers
# ---------------------------------------------------------------------------
def normalizar_industria(s):
    """Normaliza un nombre de industria para matchear contra
    INDUSTRIA_COMPARABLES sin depender del caracter de guion exacto que
    devuelva Yahoo ("-", "–" o "—")."""
    if not s:
        return ""
    s = str(s).replace("—", "-").replace("–", "-")
    s = re.sub(r"\s*-\s*", " - ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip().lower()


# Alias con el nombre viejo (lo importaba el mock y algun script suelto).
_normalizar_industria = normalizar_industria


def base_ticker(sym):
    """Le saca el sufijo .SA/.BA a un simbolo resuelto, para poder matchear
    contra el ticker "pelado" del Excel."""
    return re.sub(r"\.(SA|BA)$", "", str(sym))


def moneda_por_sufijo(sym):
    """Moneda de cotizacion inferida del sufijo, para cuando Yahoo no
    devuelve .info (ni hay dato previo)."""
    s = str(sym).upper()
    if s.endswith(".BA"):
        return "ARS"
    if s.endswith(".SA"):
        return "BRL"
    return "USD"


# ---------------------------------------------------------------------------
# JSON: lectura tolerante y escritura atomica/minificada
# ---------------------------------------------------------------------------
def sanear(obj):
    """Reemplaza NaN/inf (y tipos numpy) por valores serializables. Con
    allow_nan=False un NaN que se escape rompe la corrida en CI en vez de
    llegar como token invalido al navegador (JSON.parse falla con NaN)."""
    if isinstance(obj, dict):
        return {k: sanear(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanear(v) for v in obj]
    if isinstance(obj, (bool, np.bool_)):
        return bool(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        f = float(obj)
        return None if (math.isnan(f) or math.isinf(f)) else f
    return obj


def serializar(obj):
    return json.dumps(sanear(obj), ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def leer_json(ruta, defecto=None):
    ruta = Path(ruta)
    if not ruta.exists():
        return defecto
    try:
        return json.loads(ruta.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return defecto


def _sin_claves(obj, claves):
    if isinstance(obj, dict) and claves:
        return {k: v for k, v in obj.items() if k not in claves}
    return obj


def escribir_json(ruta, obj, ignorar_claves=(), raiz_log=RAIZ, silencioso=False):
    """Escribe 'obj' minificado en 'ruta' de forma atomica (archivo temporal
    en la misma carpeta + os.replace, asi nunca queda un JSON a medio
    escribir si la corrida se corta). Si el contenido no cambio no toca el
    archivo: una corrida sin datos nuevos no genera diff en git.
    'ignorar_claves': claves de primer nivel (timestamps) que no cuentan como
    cambio — si solo cambio eso, se conserva el archivo anterior tal cual.
    Devuelve True si escribio."""
    ruta = Path(ruta)
    texto = serializar(obj)
    if ruta.exists():
        try:
            actual = ruta.read_text(encoding="utf-8")
        except Exception:  # noqa: BLE001
            actual = None
        if actual == texto:
            return False
        if actual is not None and ignorar_claves:
            try:
                previo = json.loads(actual)
                if _sin_claves(previo, ignorar_claves) == _sin_claves(json.loads(texto), ignorar_claves):
                    return False
            except Exception:  # noqa: BLE001
                pass
    ruta.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{ruta.name}.", suffix=".tmp", dir=ruta.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(texto)
        os.replace(tmp, ruta)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    if not silencioso:
        try:
            etiqueta = ruta.relative_to(raiz_log)
        except ValueError:
            etiqueta = ruta
        print(f"  -> {etiqueta}")
    return True


def borrar_huerfanos(carpeta, vigentes):
    """Borra los <TICKER>.json de 'carpeta' cuyo ticker ya no esta en
    'vigentes' (se saco del Excel o se descarto por invalido/viejo)."""
    carpeta = Path(carpeta)
    if not carpeta.exists():
        return []
    borrados = []
    for archivo in carpeta.glob("*.json"):
        if archivo.stem not in vigentes:
            archivo.unlink()
            borrados.append(archivo.stem)
    return borrados
