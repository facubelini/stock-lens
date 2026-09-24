"""Indicadores tecnicos sobre el historico diario: distancia a medias,
screener multi-temporalidad (veredictos diario/semanal/mensual), scanner de
setups CORTO/LARGO, divergencias, cruces de medias, beta/Sharpe,
estacionalidad, volumen de la ultima rueda cerrada y promedios por
industria."""

import math
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from comun import num, rsi_serie, rsi_wilder


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


def promedios_por_industria(listado):
    """RSI y variacion % promedio por industria (tabla del Listado)."""
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
    return promedios
