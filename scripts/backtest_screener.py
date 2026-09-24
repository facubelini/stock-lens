"""Backtest de la logica del Screener (temporalidad diaria): mide, sobre 5
anios de historial, que tan bien predice cada veredicto (COMPRA/CERCA/VENTA/
EXTENDIDO) un retorno favorable en los dias siguientes, comparado contra el
retorno "base" (cualquier dia, sin filtrar por veredicto).

Reutiliza las MISMAS constantes y funciones de pipeline/tecnico.py (PERFIL_DIARIO,
_calcular_asl/_calcular_macd/_calcular_smi, etc.) para que el backtest evalue
exactamente la misma logica que corre en produccion, no una reimplementacion
aparte que se pueda desincronizar.

Alcance a proposito: solo temporalidad DIARIA (no semanal/mensual) y stats
GLOBALES (no por ticker) — un backtest por ticker individual tendria muy
pocas señales en 5 anios para ser estadisticamente significativo; agregando
todos los tickers juntos el tamaño de muestra es mucho mas confiable.

Metodologia (para no inflar los numeros):
- Cada señal cuenta UNA vez: el primer dia de cada racha del mismo
  veredicto (antes contaba cada dia de la racha, con retornos solapados
  que multiplicaban el n sin aportar informacion nueva). La base toma una
  muestra cada N ruedas por la misma razon.
- Entrada a la APERTURA de la rueda siguiente a la señal (la señal se
  conoce con el cierre, no se puede comprar a ese mismo cierre) y salida
  al cierre N ruedas despues.
- Solo tickers que cotizan en USD (un CEDEAR en pesos mezcla devaluacion).
- Sesgo de supervivencia: el universo es la lista ACTUAL; se avisa en
  `advertencias` del JSON para que la UI lo muestre.

Uso:
    python scripts/backtest_screener.py [--out CARPETA]
    python scripts/backtests.py   # los dos backtests con una sola descarga
"""

import argparse
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comun import TZ, DIR_DATOS_PUBLICOS, escribir_json, leer_json, moneda_por_sufijo, num, rsi_serie  # noqa: E402
from pipeline.descarga import descargar_historicos  # noqa: E402
from pipeline.tecnico import (  # noqa: E402
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
    _calcular_asl,
    _calcular_macd,
    _calcular_smi,
)
from pipeline.universo import leer_tickers  # noqa: E402

HORIZONTES = [5, 10, 20]  # ruedas habiles (~1 semana, ~2 semanas, ~1 mes)
MINIMO_VELAS = 300

# Misma implementacion de RSI que la vista en vivo (comun.rsi_serie).
_rsi_serie = rsi_serie

ADVERTENCIAS_COMUNES = [
    "Sesgo de supervivencia: el universo es tu lista ACTUAL de tickers. Las empresas que quebraron o "
    "se deslistaron en estos 5 años no están, así que los retornos tienden a verse mejores de lo que fueron.",
    "Solo tickers que cotizan en USD: los CEDEAR en pesos y las acciones de B3 se excluyen porque su "
    "retorno mezcla la devaluación de la moneda.",
    "Cada señal cuenta una sola vez (el primer día de cada racha) y la base toma una muestra cada N "
    "ruedas, para no contar varias veces el mismo movimiento.",
    "Entrada a la apertura de la rueda siguiente a la señal y salida al cierre N ruedas después. "
    "No incluye comisiones, spreads, impuestos ni slippage.",
    "Rendimientos pasados no garantizan rendimientos futuros.",
]


def universo_usd(out=DIR_DATOS_PUBLICOS):
    """Simbolos ya resueltos por el pipeline (listado.json, no arrastrados)
    que cotizan en USD segun fundamentales.json. Evita volver a resolver
    sufijos y a reintentar los tickers invalidos del Excel. Si no hay
    listado todavia, cae a los tickers del Excel sin sufijo."""
    listado = (leer_json(Path(out) / "listado.json", {}) or {}).get("acciones") or []
    monedas = {f["ticker"]: f.get("moneda") for f in (leer_json(Path(out) / "fundamentales.json", []) or [])}
    if listado:
        return sorted(
            {
                f["ticker"]
                for f in listado
                if not f.get("stale") and (monedas.get(f["ticker"]) or moneda_por_sufijo(f["ticker"])) == "USD"
            }
        )
    return sorted({t for t in leer_tickers()["Ticker"] if "." not in t})


def descargar_para_backtest(simbolos):
    """Una sola descarga en lote (5y, auto_adjust=True, igual que el
    pipeline) que comparten los dos backtests."""
    print(f"Descargando 5y de {len(simbolos)} simbolos USD (en lote)...")
    return descargar_historicos(simbolos)


def retornos_forward(ohlc, h):
    """Retorno % entrando a la apertura de la rueda siguiente (t+1) y
    saliendo al cierre de t+h. NaN al final de la serie."""
    entrada = ohlc["Open"].shift(-1)
    salida = ohlc["Close"].shift(-h)
    return (salida / entrada - 1) * 100


def muestras_no_solapadas(etiquetas, ohlc, etiqueta_base="BASELINE"):
    """Filas (etiqueta, h, retorno): una por racha de cada etiqueta (primer
    dia) + la base muestreada cada h ruedas."""
    inicio_racha = etiquetas.notna() & (etiquetas != etiquetas.shift(1))
    filas = []
    for h in HORIZONTES:
        ret = retornos_forward(ohlc, h)
        sel = inicio_racha & ret.notna()
        filas.extend((v, h, float(r)) for v, r in zip(etiquetas[sel], ret[sel]))
        validos = np.flatnonzero((etiquetas.notna() & ret.notna()).to_numpy())[::h]
        filas.extend((etiqueta_base, h, float(r)) for r in ret.iloc[validos])
    return filas


def agregar_stats_filas(filas, bajistas=()):
    """stats[etiqueta][h] = {n, retorno_prom, hit_rate}. Para etiquetas
    bajistas (VENTA) el acierto es que el precio baje."""
    if not filas:
        return {}
    df = pd.DataFrame(filas, columns=["etiqueta", "h", "ret"])
    resultado = {}
    orden = ["BASELINE"] + sorted(e for e in df["etiqueta"].unique() if e != "BASELINE")
    for etiqueta in orden:
        grupo = df[df["etiqueta"] == etiqueta]
        por_horizonte = {}
        for h in HORIZONTES:
            validos = grupo.loc[grupo["h"] == h, "ret"]
            if not len(validos):
                por_horizonte[str(h)] = None
                continue
            acierto = (validos < 0) if etiqueta in bajistas else (validos > 0)
            por_horizonte[str(h)] = {
                "n": int(len(validos)),
                "retorno_prom": num(validos.mean(), 2),
                "hit_rate": num(acierto.mean() * 100, 1),
            }
        resultado[etiqueta] = por_horizonte
    return resultado


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
    return muestras_no_solapadas(evaluar_serie_diaria(ohlc), ohlc)


def main(argv=None, historicos=None):
    ap = argparse.ArgumentParser(description="Backtest del Screener (diario)")
    ap.add_argument("--out", type=Path, default=DIR_DATOS_PUBLICOS)
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    if historicos is None:
        historicos = descargar_para_backtest(universo_usd(args.out))
    print(f"Backtest (diario) sobre {len(historicos)} tickers, horizontes {HORIZONTES} ruedas...")

    todas_filas = []
    ok, fallidos = 0, 0
    for sym, hist in sorted(historicos.items()):
        try:
            ohlc = hist[["Open", "High", "Low", "Close"]].dropna()
            if len(ohlc) < MINIMO_VELAS:
                fallidos += 1
                continue
            todas_filas.extend(backtest_ticker(sym, ohlc))
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"  ! {sym}: error {e}")
            fallidos += 1

    print("Agregando estadisticas...")
    stats = agregar_stats_filas(todas_filas, bajistas=("VENTA",))

    salida = {
        "actualizado": datetime.now(TZ).isoformat(),
        "temporalidad": "diario",
        "horizontes_dias": HORIZONTES,
        "n_tickers_evaluados": ok,
        "n_tickers_fallidos": fallidos,
        "metodologia": "primer dia de cada racha; entrada apertura t+1, salida cierre t+h; base muestreada cada h ruedas",
        "advertencias": ADVERTENCIAS_COMUNES,
        "stats": stats,
    }
    escribir_json(args.out / "backtest_screener.json", salida, ignorar_claves=("actualizado",))
    print(f"Listo: {ok} tickers evaluados, {fallidos} sin datos suficientes.")


if __name__ == "__main__":
    main()
