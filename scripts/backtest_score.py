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

Uso:
    python scripts/backtest_score.py
"""

import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generar_datos import RAIZ, TZ, leer_tickers, num, resolver_ticker  # noqa: E402
from backtest_screener import HORIZONTES, _rsi_serie  # noqa: E402

DIR_SALIDA = RAIZ / "public" / "data"
MINIMO_VELAS = 300


def _score_tecnico_serie(closes):
    """Mismos pesos y formulas que calcularScore() (score.js) para Tendencia
    (40%) y Momentum (30%), renormalizados a 100% entre las dos (Valuacion
    no tiene serie historica)."""
    ema50 = closes.ewm(span=50, adjust=False).mean()
    sma200 = closes.rolling(200).mean()
    rsi = _rsi_serie(closes, 14)

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


def _bucket(score):
    if pd.isna(score):
        return None
    if score >= 66:
        return "FAVORABLE"
    if score >= 40:
        return "NEUTRAL"
    return "FLOJO"


def backtest_ticker(closes):
    score = _score_tecnico_serie(closes)
    validos = score.notna()
    sub_score = score[validos]
    retornos_h = {h: ((closes.shift(-h) / closes - 1) * 100)[validos] for h in HORIZONTES}

    filas = []
    for i in range(len(sub_score)):
        bucket = _bucket(sub_score.iloc[i])
        if bucket is None:
            continue
        fila = {"bucket": bucket}
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

    for bucket, grupo in df.groupby("bucket"):
        por_horizonte = {}
        for h in HORIZONTES:
            validos = grupo[f"ret_{h}d"].dropna()
            if not len(validos):
                por_horizonte[str(h)] = None
                continue
            por_horizonte[str(h)] = {
                "n": int(len(validos)),
                "retorno_prom": num(validos.mean(), 2),
                "hit_rate": num((validos > 0).mean() * 100, 1),
            }
        resultado[bucket] = por_horizonte

    return resultado


def main():
    DIR_SALIDA.mkdir(parents=True, exist_ok=True)
    tickers = leer_tickers()
    print(f"Backtest del score (aprox. tecnica, sin Valuacion) sobre {len(tickers)} tickers...\n")

    todas_filas = []
    ok, fallidos = 0, 0
    for _, fila in tickers.iterrows():
        t = fila["Ticker"]
        sym, _tk, hist, closes = resolver_ticker(t)
        if sym is None:
            fallidos += 1
            continue
        try:
            if len(closes) < MINIMO_VELAS:
                fallidos += 1
                continue
            filas = backtest_ticker(closes)
            todas_filas.extend(filas)
            ok += 1
            print(f"  ok {sym} ({len(filas)} puntos evaluables)")
        except Exception as e:  # noqa: BLE001
            print(f"  ! {t}: error {e}")
            fallidos += 1

    print("\nAgregando estadisticas...")
    stats = agregar_stats(todas_filas)

    salida = {
        "actualizado": datetime.now(TZ).isoformat(),
        "horizontes_dias": HORIZONTES,
        "n_tickers_evaluados": ok,
        "n_tickers_fallidos": fallidos,
        "stats": stats,
    }
    ruta = DIR_SALIDA / "backtest_score.json"
    with open(ruta, "w", encoding="utf-8") as f:
        json.dump(salida, f, ensure_ascii=False, indent=2)
    print(f"-> {ruta.relative_to(RAIZ)}")
    print(f"\nListo: {ok} tickers evaluados, {fallidos} sin datos suficientes.")


if __name__ == "__main__":
    main()
