"""Backtest historico (5 años, sin look-ahead) de las señales de la pagina
Señales y del Warren Score: EMA200 diaria/semanal (rebote y cruce), RSI
semanal (cruce con su SMA14), estados del ciclo de vida de la base VCP y los
buckets del Warren Score (<40, 40-60, 60-70, 70-80, ≥80).

Reutiliza EXACTAMENTE las mismas funciones que corren en produccion
(pipeline.senales.sen_eventos_ema / sen_cruces_rsi, pipeline.vcp.ws_ciclo_vcp,
pipeline.warren.ws_calcular_ticker / rs_percentiles / calcular_warren_score),
evaluadas con los datos CORTADOS en cada fecha (nunca con datos futuros).

Metodologia (misma idea que backtest_screener.py):
  - Cada señal cuenta una vez: el primer dia (o la primera muestra) de cada
    racha por ticker. La base ("BASELINE") toma una muestra cada N ruedas.
  - Entrada a la apertura de la rueda siguiente a la señal, salida al cierre
    N ruedas despues (N semanas/velas semanales para las señales semanales).
  - Exceso = retorno del ticker - retorno de SPY en la MISMA ventana (mismas
    fechas exactas, ticker y SPY alineados por fecha).
  - El Warren Score y el estado VCP necesitan el universo COMPLETO en cada
    fecha (el percentil de Fuerza Relativa es cross-sectional): se muestrean
    cada STRIDE_PESADO ruedas (no todos los dias, sino no alcanza el tiempo
    de corrida) y se avisa en 'advertencias'.
  - Solo tickers en USD (mismo criterio que backtest_screener.py).
  - Bootstrap (percentil 2.5/97.5 de 200 remuestreos) del exceso mediano vs.
    SPY, como nota de significancia (no reemplaza el n ni la dispersion).

Uso:
    python scripts/backtest_senales.py [--out CARPETA]
    python scripts/backtests.py   # los tres backtests con una sola descarga
"""

import argparse
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backtest_screener import ADVERTENCIAS_COMUNES, descargar_para_backtest, universo_usd  # noqa: E402
from comun import DIR_DATOS_PUBLICOS, TZ, atr_serie, escribir_json, num  # noqa: E402
from pipeline import warren as warren_mod  # noqa: E402
from pipeline.senales import SEN_EMA, sen_cruces_rsi, sen_eventos_ema, velas_semanales  # noqa: E402
from pipeline.tecnico import calcular_beta_sharpe  # noqa: E402
from pipeline.warren import WS_DESFASES_RS, WS_MIN_RUEDAS, calcular_warren_score, rs_percentiles, ws_calcular_ticker  # noqa: E402

# El backtest no necesita el RS "a la fecha del contacto" (desfases extendidos
# de señales.json, ~37 valores): solo hoy/semana/mes (los 3 que usa el pilar
# de Fuerza). Se pisa el modulo ANTES de llamar ws_calcular_ticker/rs_percentiles
# para no calcular ~12x mas percentiles de los que hacen falta. Es un proceso
# aparte de generar_datos.py, asi que no afecta a la corrida real del pipeline.
warren_mod.WS_DESFASES_RS_EXT = WS_DESFASES_RS

HORIZ_D = [5, 10, 20]  # ruedas habiles (señales diarias: EMA200 diaria, VCP, Warren)
HORIZ_S = [4, 8, 13]  # velas semanales (señales semanales: EMA200 semanal, RSI semanal)
STRIDE_PESADO = 30  # ruedas entre muestras de Warren Score / estado VCP (~6 semanas): son cross-sectional y mas caras
MIN_MUESTRA_BOOT = 30
N_BOOT = 200
CAP_BOOT = 4000

BUCKETS_WARREN = ["<40", "40-60", "60-70", "70-80", "≥80"]
ESTADOS_VCP = [
    "Formándose", "Armado", "Recién rompió", "Rompió y confirmó",
    "Rompió sin confirmar", "Falló antes de romper", "Rompió y falló",
]

ADVERTENCIAS_SENALES = ADVERTENCIAS_COMUNES + [
    "El Warren Score y el estado de la base VCP se muestrean cada "
    f"{STRIDE_PESADO} ruedas (~6 semanas) en vez de todos los dias: recalcular el percentil de "
    "Fuerza Relativa contra TODO el universo en cada fecha es la parte mas cara del backtest.",
    "El exceso vs. SPY se calcula sobre tickers y SPY alineados por fecha (join): un ticker con un "
    "calendario de feriados muy distinto al de Nueva York puede perder algunas ruedas de esa alineación.",
    "El intervalo de confianza (bootstrap, 95%) es de la MEDIANA del exceso vs. SPY, no del hit-rate; "
    "con menos de 30 observaciones no se calcula (se muestra vacío).",
]

METODOLOGIA = (
    "Cada señal se recalcula con los datos CORTADOS en cada fecha (sin look-ahead), usando el mismo "
    "código de producción. Primera muestra de cada racha por ticker; entrada a la apertura de la rueda "
    "siguiente, salida al cierre N ruedas después (N semanas para las señales semanales); exceso vs. SPY "
    "en la misma ventana; base = una muestra cada N ruedas del mismo universo."
)


def _bucket_warren(total):
    if total is None:
        return None
    if total < 40:
        return "<40"
    if total < 60:
        return "40-60"
    if total < 70:
        return "60-70"
    if total < 80:
        return "70-80"
    return "≥80"


def alinear_ohlc_spy(df, spy_df):
    """Join por fecha (ruedas en comun) del ticker (OHLCV) contra SPY
    (Open/Close, para el retorno 'excedente'). Normaliza tz/hora igual que
    warren._alinear_con_bench."""
    a = df[["Open", "High", "Low", "Close", "Volume"]].copy()
    b = spy_df[["Open", "Close"]].rename(columns={"Open": "Open_spy", "Close": "Close_spy"}).copy()
    for s_ in (a, b):
        if s_.index.tz is not None:
            s_.index = s_.index.tz_localize(None)
        s_.index = s_.index.normalize()
    j = a.join(b, how="inner")
    j = j[~j.index.duplicated(keep="last")].sort_index()
    return j


def etiqueta_evento(evento_bool, nombre, index):
    return pd.Series(np.where(evento_bool.to_numpy(), nombre, None), index=index, dtype=object)


def filas_evento(etiquetas, frame, horizontes, etiqueta_base="BASELINE"):
    """[(etiqueta, h, retorno, retorno_spy)]: primera vela de cada racha +
    base muestreada cada h velas. 'frame' trae Open/Close del ticker y
    Open_spy/Close_spy de SPY (misma fecha)."""
    validos = etiquetas.notna()
    inicio_racha = validos & (etiquetas != etiquetas.shift(1))
    filas = []
    for h in horizontes:
        entrada, salida = frame["Open"].shift(-1), frame["Close"].shift(-h)
        ret = (salida / entrada - 1) * 100
        entrada_b, salida_b = frame["Open_spy"].shift(-1), frame["Close_spy"].shift(-h)
        ret_b = (salida_b / entrada_b - 1) * 100
        sel = inicio_racha & ret.notna()
        for et, r, rb in zip(etiquetas[sel], ret[sel], ret_b[sel]):
            filas.append((et, h, float(r), float(rb) if pd.notna(rb) else None))
        pos_base = np.flatnonzero((validos & ret.notna()).to_numpy())[::h]
        for i in pos_base:
            r, rb = ret.iloc[i], ret_b.iloc[i]
            filas.append((etiqueta_base, h, float(r), float(rb) if pd.notna(rb) else None))
    return filas


def _bootstrap_ci_mediana(exceso, rng):
    if len(exceso) < MIN_MUESTRA_BOOT:
        return None
    muestra = exceso.to_numpy()
    if len(muestra) > CAP_BOOT:
        muestra = rng.choice(muestra, size=CAP_BOOT, replace=False)
    idx = rng.integers(0, len(muestra), size=(N_BOOT, len(muestra)))
    medianas = np.median(muestra[idx], axis=1)
    return [num(np.percentile(medianas, 2.5), 2), num(np.percentile(medianas, 97.5), 2)]


def agregar_stats(filas, horizontes, bajistas=(), rng=None):
    """stats[etiqueta][h] = {n, hit_rate, retorno_mediana, retorno_prom,
    exceso_mediana_spy, exceso_prom_spy, ci95_exceso_mediana, n_exceso}."""
    if not filas:
        return {}
    rng = rng or np.random.default_rng(12345)
    df_ = pd.DataFrame(filas, columns=["etiqueta", "h", "ret", "ret_spy"])
    resultado = {}
    orden = ["BASELINE"] + sorted(e for e in df_["etiqueta"].unique() if e != "BASELINE")
    for etiqueta in orden:
        grupo = df_[df_["etiqueta"] == etiqueta]
        por_h = {}
        for h in horizontes:
            sub = grupo[grupo["h"] == h]
            if not len(sub):
                por_h[str(h)] = None
                continue
            ret = sub["ret"]
            exceso = (sub["ret"] - sub["ret_spy"]).dropna()
            acierto = (ret < 0) if etiqueta in bajistas else (ret > 0)
            por_h[str(h)] = {
                "n": int(len(sub)),
                "hit_rate": num(acierto.mean() * 100, 1),
                "retorno_mediana": num(ret.median(), 2),
                "retorno_prom": num(ret.mean(), 2),
                "n_exceso": int(len(exceso)),
                "exceso_mediana_spy": num(exceso.median(), 2) if len(exceso) else None,
                "exceso_prom_spy": num(exceso.mean(), 2) if len(exceso) else None,
                "ci95_exceso_mediana": _bootstrap_ci_mediana(exceso, rng),
            }
        resultado[etiqueta] = por_h
    return resultado


def filas_ema_y_rsi(sym, hist, spy_df):
    """Filas de evento (etiqueta, h, ret, ret_spy) de EMA200 diaria/semanal y
    RSI semanal para un ticker, mas el frame diario alineado (lo reusa
    Warren/VCP)."""
    j = alinear_ohlc_spy(hist, spy_df)
    salida = {"ema_diario_rebote": [], "ema_diario_cruce": [], "ema_semanal_rebote": [],
              "ema_semanal_cruce": [], "rsi_semanal_alcista": [], "rsi_semanal_bajista": []}
    if len(j) < SEN_EMA["diario"]["min_velas"]:
        return salida, j
    _, _, rebote_d, cruce_d = sen_eventos_ema(j, SEN_EMA["diario"], adjust=False)
    salida["ema_diario_rebote"] = filas_evento(etiqueta_evento(rebote_d, "REBOTE", j.index), j, HORIZ_D)
    salida["ema_diario_cruce"] = filas_evento(etiqueta_evento(cruce_d, "CRUCE", j.index), j, HORIZ_D)

    sem = j.resample("W-FRI").agg(
        {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum",
         "Open_spy": "first", "Close_spy": "last"}
    )
    sem = sem[sem["Close"].notna()]
    if len(sem) >= SEN_EMA["semanal"]["min_velas"]:
        _, _, rebote_s, cruce_s = sen_eventos_ema(sem, SEN_EMA["semanal"], adjust=True)
        salida["ema_semanal_rebote"] = filas_evento(etiqueta_evento(rebote_s, "REBOTE", sem.index), sem, HORIZ_S)
        salida["ema_semanal_cruce"] = filas_evento(etiqueta_evento(cruce_s, "CRUCE", sem.index), sem, HORIZ_S)
        _, _, cruces = sen_cruces_rsi(sem)
        et_alc = pd.Series(np.where(cruces.to_numpy() > 0, "ALCISTA", None), index=sem.index, dtype=object)
        et_baj = pd.Series(np.where(cruces.to_numpy() < 0, "BAJISTA", None), index=sem.index, dtype=object)
        salida["rsi_semanal_alcista"] = filas_evento(et_alc, sem, HORIZ_S)
        salida["rsi_semanal_bajista"] = filas_evento(et_baj, sem, HORIZ_S)
    return salida, j


def _racha_por_ticker(muestras):
    """De una lista [(ticker, fecha, t, valor)] (ordenada por fecha dentro de
    cada ticker), deja solo la primera muestra de cada racha del mismo valor
    POR TICKER (mismo criterio que 'primer dia de la racha', a la resolucion
    del muestreo)."""
    por_ticker = {}
    for tk, fecha, t, valor in muestras:
        por_ticker.setdefault(tk, []).append((fecha, t, valor))
    filas = []
    for tk, lista in por_ticker.items():
        lista.sort(key=lambda x: x[0])
        anterior = None
        for fecha, t, valor in lista:
            if valor != anterior:
                filas.append((tk, fecha, t))
            anterior = valor
    return filas


def backtest_warren_y_vcp(joined, spy_df):
    """Pasada cross-sectional (Warren Score) + estado VCP (que sale gratis
    del mismo calc). 'joined' = {ticker: (frame_diario_alineado, atr_pct_s)}.
    Devuelve (filas_vcp_por_estado, filas_warren_por_bucket)."""
    fechas_muestra = spy_df.index[::STRIDE_PESADO]
    pass1 = {}  # fecha_str -> [dict tipo warren_datos]
    posiciones = {}  # (fecha_str, ticker) -> t
    vcp_muestras = []  # (ticker, fecha_str, t, estado)

    for sym, (j, _atr_pct) in joined.items():
        if len(j) < WS_MIN_RUEDAS:
            continue
        idx = j.index
        cache_vcp = {}
        for fecha_m in fechas_muestra:
            pos = int(idx.searchsorted(fecha_m, side="right")) - 1
            if pos < WS_MIN_RUEDAS or pos >= len(j) - 1:
                continue
            sub = j.iloc[: pos + 1]
            try:
                vol_1y = calcular_beta_sharpe(sub["Close"], j["Close_spy"], en_usd=True)["volatilidad_1y"]
                calc = ws_calcular_ticker(sub, j["Close_spy"], True, -1, vol_1y, cache_vcp=cache_vcp)
            except Exception:  # noqa: BLE001
                continue
            if calc is None:
                continue
            fecha_str = idx[pos].strftime("%Y-%m-%d")
            pass1.setdefault(fecha_str, []).append({"ticker": sym, "nombre": sym, "sector": None, "calc": calc, "en_usd": True})
            posiciones[(fecha_str, sym)] = pos
            estado = (calc.get("vcp_ciclo") or {}).get("estado")
            if estado:
                vcp_muestras.append((sym, fecha_str, pos, estado))

    warren_muestras = []
    for fecha_str, lista in pass1.items():
        rs_mapa = rs_percentiles(lista)
        for fila in calcular_warren_score(lista, rs_mapa):
            bucket = _bucket_warren(fila.get("total_score"))
            if bucket:
                warren_muestras.append((fila["ticker"], fecha_str, posiciones[(fecha_str, fila["ticker"])], bucket))

    return vcp_muestras, warren_muestras


def _filas_desde_muestras(muestras, joined, horizontes=HORIZ_D):
    """(ticker, fecha, t, valor) ya deduplicado por racha -> filas (valor, h,
    ret, ret_spy), calculando el retorno directo (sin pasar por
    filas_evento/etiquetas: la muestra YA es el evento)."""
    filas = []
    conteos_base = {}
    for tk, fecha, t in _racha_por_ticker(muestras):
        frame = joined[tk][0]
        n = len(frame)
        for h in horizontes:
            if t + 1 >= n or t + h >= n:
                continue
            entrada, salida = frame["Open"].iloc[t + 1], frame["Close"].iloc[t + h]
            entrada_b, salida_b = frame["Open_spy"].iloc[t + 1], frame["Close_spy"].iloc[t + h]
            if not (entrada and salida):
                continue
            ret = (salida / entrada - 1) * 100
            ret_b = (salida_b / entrada_b - 1) * 100 if entrada_b and salida_b else None
            valor = next(v for (tk2, f2, t2, v) in muestras if tk2 == tk and t2 == t)
            filas.append((valor, h, float(ret), float(ret_b) if ret_b is not None else None))
    # Base: una muestra cada STRIDE_PESADO ruedas por ticker (mismo universo).
    for tk, (frame, _atr) in joined.items():
        n = len(frame)
        for h in horizontes:
            pos_base = np.arange(WS_MIN_RUEDAS, n - h - 1, STRIDE_PESADO)
            for t in pos_base:
                entrada, salida = frame["Open"].iloc[t + 1], frame["Close"].iloc[t + h]
                entrada_b, salida_b = frame["Open_spy"].iloc[t + 1], frame["Close_spy"].iloc[t + h]
                if not (entrada and salida):
                    continue
                ret = (salida / entrada - 1) * 100
                ret_b = (salida_b / entrada_b - 1) * 100 if entrada_b and salida_b else None
                filas.append(("BASELINE", h, float(ret), float(ret_b) if ret_b is not None else None))
    return filas


def main(argv=None, historicos=None):
    ap = argparse.ArgumentParser(description="Backtest de las señales (EMA200/VCP/RSI semanal/Warren Score)")
    ap.add_argument("--out", type=Path, default=DIR_DATOS_PUBLICOS)
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    if historicos is None:
        historicos = descargar_para_backtest(universo_usd(args.out))
    spy_df = historicos.get("SPY")
    if spy_df is None or len(spy_df) < WS_MIN_RUEDAS:
        print("::error::No se pudo descargar SPY (benchmark), no se puede correr el backtest de señales.")
        return
    print(f"Backtest de señales sobre {len(historicos)} tickers (Warren/VCP muestreados cada {STRIDE_PESADO} ruedas)...")

    filas_por_grupo = {k: [] for k in (
        "ema_diario_rebote", "ema_diario_cruce", "ema_semanal_rebote", "ema_semanal_cruce",
        "rsi_semanal_alcista", "rsi_semanal_bajista",
    )}
    joined = {}
    ok, fallidos = 0, 0
    for sym, hist in sorted(historicos.items()):
        if sym == "SPY":
            continue
        try:
            eventos, j = filas_ema_y_rsi(sym, hist, spy_df)
            if len(j) < SEN_EMA["diario"]["min_velas"]:
                fallidos += 1
                continue
            for k, filas in eventos.items():
                filas_por_grupo[k].extend(filas)
            atr_pct = atr_serie(j["High"], j["Low"], j["Close"], 14) / j["Close"] * 100
            joined[sym] = (j, atr_pct)
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"  ! {sym}: error en EMA/RSI ({type(e).__name__}: {e})")
            fallidos += 1

    print(f"EMA200/RSI semanal: {ok} tickers ok, {fallidos} sin datos suficientes.")
    print(f"Warren Score / VCP: recalculando cross-sectional cada {STRIDE_PESADO} ruedas sobre {len(joined)} tickers...")
    vcp_muestras, warren_muestras = backtest_warren_y_vcp(joined, spy_df)
    print(f"  {len(vcp_muestras)} muestra(s) VCP, {len(warren_muestras)} muestra(s) Warren Score (antes de deduplicar racha).")

    filas_vcp = _filas_desde_muestras(vcp_muestras, joined, HORIZ_D)
    filas_warren = _filas_desde_muestras(warren_muestras, joined, HORIZ_D)

    stats = {
        "ema_diario": {
            "rebote": agregar_stats(filas_por_grupo["ema_diario_rebote"], HORIZ_D),
            "cruce": agregar_stats(filas_por_grupo["ema_diario_cruce"], HORIZ_D),
        },
        "ema_semanal": {
            "rebote": agregar_stats(filas_por_grupo["ema_semanal_rebote"], HORIZ_S),
            "cruce": agregar_stats(filas_por_grupo["ema_semanal_cruce"], HORIZ_S),
        },
        "rsi_semanal": {
            "alcista": agregar_stats(filas_por_grupo["rsi_semanal_alcista"], HORIZ_S),
            "bajista": agregar_stats(filas_por_grupo["rsi_semanal_bajista"], HORIZ_S, bajistas=("BAJISTA",)),
        },
        "vcp_estado": agregar_stats(filas_vcp, HORIZ_D),
        "warren_bucket": agregar_stats(filas_warren, HORIZ_D),
    }

    salida = {
        "actualizado": datetime.now(TZ).isoformat(),
        "horizontes_dias": HORIZ_D,
        "horizontes_semanas": HORIZ_S,
        "n_tickers_evaluados": ok,
        "n_tickers_fallidos": fallidos,
        "stride_cross_sectional": STRIDE_PESADO,
        "metodologia": METODOLOGIA,
        "advertencias": ADVERTENCIAS_SENALES,
        "stats": stats,
    }
    escribir_json(args.out / "backtest_senales.json", salida, ignorar_claves=("actualizado",))
    print(f"Listo: {ok} tickers evaluados, {fallidos} sin datos suficientes.")


if __name__ == "__main__":
    main()
