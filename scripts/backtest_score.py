"""Backtest del Score de Listado (src/lib/score.js), aproximado con solo
Tendencia + Momentum: mide, sobre 5 anios de historial, si un score mas alto
realmente antecede retornos mejores en los dias siguientes, comparado
contra el retorno "base" (cualquier dia).

Por que no incluye Valuacion: el Score real combina Tendencia (40%) +
Momentum (30%) + Valuacion (30%, PER/PEG). yfinance solo expone el PER/PEG
ACTUAL via .info, no una serie historica diaria para los ~380 tickers del
universo -- no hay con que backtestear esa parte. Esta aproximacion usa
EXACTAMENTE la misma formula y el mismo mecanismo de "repartir el peso
entre las partes disponibles" que calcularScore() ya usa hoy cuando a un
ticker le falta Valuacion -- no es una heuristica nueva, es la misma
formula aplicada hacia atras en el tiempo.

Misma metodologia que backtest_screener.py: una muestra por racha de cada
bucket (primer dia), entrada a la apertura siguiente, solo tickers en USD,
y advertencias (supervivencia, etc.) en el JSON.

Uso:
    python scripts/backtest_score.py [--out CARPETA]
    python scripts/backtests.py   # los dos backtests con una sola descarga
"""

import argparse
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backtest_screener import (  # noqa: E402
    ADVERTENCIAS_COMUNES,
    HORIZONTES,
    agregar_stats_filas,
    descargar_para_backtest,
    muestras_no_solapadas,
    universo_usd,
)
from comun import DIR_DATOS_PUBLICOS, TZ, escribir_json, rsi_serie  # noqa: E402

MINIMO_VELAS = 300


def _score_tecnico_serie(closes):
    """Mismos pesos y formulas que calcularScore() (score.js) para Tendencia
    (40%) y Momentum (30%), renormalizados a 100% entre las dos (Valuacion
    no tiene serie historica)."""
    ema50 = closes.ewm(span=50, adjust=False).mean()
    sma200 = closes.rolling(200).mean()
    rsi = rsi_serie(closes, 14)

    dist_ema50 = (closes / ema50 - 1) * 100
    dist_sma200 = (closes / sma200 - 1) * 100

    bruto = dist_sma200.clip(-30, 30) + dist_ema50.clip(-20, 20)
    v_tendencia = ((bruto + 50) / 100 * 100).clip(0, 100)
    v_momentum = (100 - (rsi - 55).abs() * 2.2).clip(0, 100)

    w_t, w_m = 0.4, 0.3
    score = (v_tendencia * w_t + v_momentum * w_m) / (w_t + w_m)
    valido = ema50.notna() & sma200.notna() & rsi.notna()
    score[~valido] = np.nan
    return score.round()


def _buckets(score):
    """Serie de etiquetas FAVORABLE/NEUTRAL/FLOJO (NaN sin score)."""
    etiquetas = pd.Series(np.nan, index=score.index, dtype="object")
    etiquetas[score >= 66] = "FAVORABLE"
    etiquetas[(score >= 40) & (score < 66)] = "NEUTRAL"
    etiquetas[score < 40] = "FLOJO"
    return etiquetas


def backtest_ticker(ohlc):
    return muestras_no_solapadas(_buckets(_score_tecnico_serie(ohlc["Close"])), ohlc)


def main(argv=None, historicos=None):
    ap = argparse.ArgumentParser(description="Backtest del Score tecnico de Listado")
    ap.add_argument("--out", type=Path, default=DIR_DATOS_PUBLICOS)
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    if historicos is None:
        historicos = descargar_para_backtest(universo_usd(args.out))
    print(f"Backtest del score (aprox. tecnica, sin Valuacion) sobre {len(historicos)} tickers...")

    todas_filas = []
    ok, fallidos = 0, 0
    for sym, hist in sorted(historicos.items()):
        try:
            ohlc = hist[["Open", "Close"]].dropna()
            if len(ohlc) < MINIMO_VELAS:
                fallidos += 1
                continue
            todas_filas.extend(backtest_ticker(ohlc))
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"  ! {sym}: error {e}")
            fallidos += 1

    print("Agregando estadisticas...")
    stats = agregar_stats_filas(todas_filas)

    salida = {
        "actualizado": datetime.now(TZ).isoformat(),
        "horizontes_dias": HORIZONTES,
        "n_tickers_evaluados": ok,
        "n_tickers_fallidos": fallidos,
        "metodologia": "primer dia de cada racha por bucket; entrada apertura t+1, salida cierre t+h; base muestreada cada h ruedas",
        "advertencias": ADVERTENCIAS_COMUNES
        + ["Score aproximado solo con Tendencia y Momentum: la Valuación (PER/PEG) no tiene serie histórica."],
        "stats": stats,
    }
    escribir_json(args.out / "backtest_score.json", salida, ignorar_claves=("actualizado",))
    print(f"Listo: {ok} tickers evaluados, {fallidos} sin datos suficientes.")


if __name__ == "__main__":
    main()
