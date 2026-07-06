"""Backtest de la logica del Screener (temporalidad diaria): mide, sobre 5
anios de historial, que tan bien predice cada veredicto (COMPRA/CERCA/VENTA/
EXTENDIDO) un retorno favorable en los dias siguientes, comparado contra el
retorno "base" (cualquier dia, sin filtrar por veredicto).

Reutiliza las MISMAS constantes y funciones que generar_datos.py (PERFIL_DIARIO,
_calcular_asl/_calcular_macd/_calcular_smi, etc.) para que el backtest evalue
exactamente la misma logica que corre en produccion, no una reimplementacion
aparte que se pueda desincronizar.

Alcance a proposito: solo temporalidad DIARIA (no semanal/mensual) y stats
GLOBALES (no por ticker) — un backtest por ticker individual tendria muy
pocas señales en 5 anios para ser estadisticamente significativo; agregando
todos los tickers juntos el tamaño de muestra es mucho mas confiable.

Uso:
    python scripts/backtest_screener.py
"""

import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generar_datos import (  # noqa: E402
    ASL_LEN,
    MACD_SLOW,
    NEAR_FACTOR,
    PERFIL_DIARIO,
    RSI_BEAR,
    RSI_BULL,
    SMI_LEN,
    TOL_ASL,
    TOL_CLAVE,
    TOL_EXTENSION,
    TZ,
    RAIZ,
    _calcular_asl,
    _calcular_macd,
    _calcular_smi,
    leer_tickers,
    num,
    resolver_ticker,
)

DIR_SALIDA = RAIZ / "public" / "data"
HORIZONTES = [5, 10, 20]  # ruedas habiles (~1 semana, ~2 semanas, ~1 mes)
MINIMO_VELAS = 300


def _rsi_serie(closes, periodo=14):
    """RSI de Wilder vectorizado (serie completa, no solo el ultimo valor).
    Aproximacion estandar via EWM — converge al mismo resultado en regimen
    estable que el calculo manual punto a punto usado en vivo; para un
    backtest agregado esto es suficiente, no hace falta bit-a-bit identico."""
    delta = closes.diff()
    ganancia = delta.clip(lower=0)
    perdida = -delta.clip(upper=0)
    avg_g = ganancia.ewm(alpha=1 / periodo, adjust=False, min_periods=periodo).mean()
    avg_p = perdida.ewm(alpha=1 / periodo, adjust=False, min_periods=periodo).mean()
    rs = avg_g / avg_p
    rsi = 100 - 100 / (1 + rs)
    rsi[avg_p == 0] = 100
    return rsi


def evaluar_serie_diaria(ohlc):
    """Version vectorizada de perfil_setup(PERFIL_DIARIO): un veredicto por
    cada vela historica (no solo la ultima), sin look-ahead — cada punto usa
    unicamente datos hasta esa fecha inclusive (medias/RSI/MACD/SMI/ASL son
    todas funciones de ventana hacia atras)."""
    closes = ohlc["Close"]
    highs = ohlc["High"]
    lows = ohlc["Low"]
    medias = PERFIL_DIARIO["medias"]
    clave = PERFIL_DIARIO["clave"]
    slope_lookback = PERFIL_DIARIO["slope_lookback"]

    series = {}
    for nombre, tipo, periodo in medias:
        series[nombre] = (
            closes.ewm(span=periodo, adjust=False).mean()
            if tipo == "ema"
            else closes.rolling(periodo).mean()
        )
    ma_clave = series[medias[clave][0]]
    ma_clave_prev = ma_clave.shift(slope_lookback)

    rsi = _rsi_serie(closes, 14)
    asl = _calcular_asl(closes)
    macd, macd_sig = _calcular_macd(closes)
    smi, smi_sig = _calcular_smi(highs, lows, closes)

    macd_bull = macd > macd_sig
    smi_bull = smi > smi_sig
    smi_bear = smi < smi_sig

    trend_up = ma_clave > ma_clave_prev
    trend_dn = ma_clave < ma_clave_prev
    tendencia_alcista = (closes >= ma_clave) & trend_up
    tendencia_bajista = (closes < ma_clave) & trend_dn

    dist_clave = (closes / ma_clave - 1) * 100
    dist_asl = (closes / asl - 1) * 100

    en_zona = (dist_clave.abs() <= TOL_CLAVE) | (dist_asl.abs() <= TOL_ASL)
    cerca_zona = (dist_clave.abs() <= TOL_CLAVE * NEAR_FACTOR) | (dist_asl.abs() <= TOL_ASL * NEAR_FACTOR)
    extendido = (dist_clave.abs() >= TOL_EXTENSION) & (dist_asl.abs() >= TOL_EXTENSION)

    confluencia_alcista = tendencia_alcista & macd_bull & smi_bull & (rsi >= RSI_BULL)
    confluencia_bajista = tendencia_bajista & (~macd_bull) & smi_bear & (rsi <= RSI_BEAR)

    veredicto = pd.Series("NEUTRAL", index=closes.index)
    veredicto[tendencia_alcista & extendido] = "EXTENDIDO"
    veredicto[confluencia_bajista] = "VENTA"
    veredicto[confluencia_alcista & cerca_zona] = "CERCA"
    veredicto[confluencia_alcista & en_zona] = "COMPRA"

    # Invalido mientras cualquiera de los insumos todavia este en warmup. Las
    # EMA (a diferencia de las SMA) nunca dan NaN en pandas — se "calientan"
    # en silencio con pocos datos — asi que ademas del .notna() hace falta
    # replicar el mismo piso que perfil_setup exige explicitamente
    # (`minimo` = periodo mas largo + slope_lookback), si no los primeros
    # ~150 dias quedarian evaluados con una EMA150 que en realidad no es tal.
    periodo_max = max(p[2] for p in medias)
    minimo = max(periodo_max + slope_lookback, ASL_LEN, MACD_SLOW, SMI_LEN) + 1
    valido = (
        ma_clave.notna()
        & ma_clave_prev.notna()
        & rsi.notna()
        & asl.notna()
        & macd_sig.notna()
        & smi_sig.notna()
    )
    veredicto[~valido] = np.nan
    veredicto.iloc[:minimo] = np.nan
    return veredicto


def backtest_ticker(sym, ohlc):
    veredictos = evaluar_serie_diaria(ohlc)
    closes = ohlc["Close"]
    validos = veredictos.notna()
    sub_veredicto = veredictos[validos]
    retornos_h = {h: ((closes.shift(-h) / closes - 1) * 100)[validos] for h in HORIZONTES}

    filas = []
    for i in range(len(sub_veredicto)):
        fila = {"verdict": sub_veredicto.iloc[i]}
        for h in HORIZONTES:
            r = retornos_h[h].iloc[i]
            fila[f"ret_{h}d"] = None if pd.isna(r) else float(r)
        filas.append(fila)
    return filas


def agregar_stats(filas_totales):
    if not filas_totales:
        return {}
    df = pd.DataFrame(filas_totales)
    resultado = {}

    baseline = {}
    for h in HORIZONTES:
        validos = df[f"ret_{h}d"].dropna()
        baseline[str(h)] = (
            {
                "n": int(len(validos)),
                "retorno_prom": num(validos.mean(), 2),
                "hit_rate": num((validos > 0).mean() * 100, 1),
            }
            if len(validos)
            else None
        )
    resultado["BASELINE"] = baseline

    for verdict, grupo in df.groupby("verdict"):
        es_bajista = verdict == "VENTA"
        por_horizonte = {}
        for h in HORIZONTES:
            validos = grupo[f"ret_{h}d"].dropna()
            if not len(validos):
                por_horizonte[str(h)] = None
                continue
            acierto = (validos < 0) if es_bajista else (validos > 0)
            por_horizonte[str(h)] = {
                "n": int(len(validos)),
                "retorno_prom": num(validos.mean(), 2),
                "hit_rate": num(acierto.mean() * 100, 1),
            }
        resultado[verdict] = por_horizonte

    return resultado


def main():
    DIR_SALIDA.mkdir(parents=True, exist_ok=True)
    tickers = leer_tickers()
    print(f"Backtest (diario) sobre {len(tickers)} tickers, horizontes {HORIZONTES} ruedas...\n")

    todas_filas = []
    ok, fallidos = 0, 0
    for _, fila in tickers.iterrows():
        t = fila["Ticker"]
        sym, _tk, hist, _closes = resolver_ticker(t)
        if sym is None:
            fallidos += 1
            continue
        try:
            ohlc = hist[["High", "Low", "Close"]].dropna()
            if len(ohlc) < MINIMO_VELAS:
                fallidos += 1
                continue
            filas = backtest_ticker(sym, ohlc)
            todas_filas.extend(filas)
            ok += 1
            print(f"  ok {sym} ({len(filas)} veredictos evaluables)")
        except Exception as e:  # noqa: BLE001
            print(f"  ! {t}: error {e}")
            fallidos += 1

    print("\nAgregando estadisticas...")
    stats = agregar_stats(todas_filas)

    salida = {
        "actualizado": datetime.now(TZ).isoformat(),
        "temporalidad": "diario",
        "horizontes_dias": HORIZONTES,
        "n_tickers_evaluados": ok,
        "n_tickers_fallidos": fallidos,
        "stats": stats,
    }
    ruta = DIR_SALIDA / "backtest_screener.json"
    with open(ruta, "w", encoding="utf-8") as f:
        json.dump(salida, f, ensure_ascii=False, indent=2)
    print(f"-> {ruta.relative_to(RAIZ)}")
    print(f"\nListo: {ok} tickers evaluados, {fallidos} sin datos suficientes.")


if __name__ == "__main__":
    main()
