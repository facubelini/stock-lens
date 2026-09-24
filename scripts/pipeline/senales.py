"""Señales (public/data/senales.json): rebote y cruce sobre la EMA200
(diaria y semanal), bases VCP y cruce del RSI semanal con su SMA14."""

import numpy as np
import pandas as pd

from comun import atr_serie, es_valido, num, rsi_serie

from .vcp import ws_ciclo_vcp
from .warren import WS_DESFASES_RS_EXT, ohlcv_limpio


# ---------------------------------------------------------------------------
# Señales (public/data/senales.json): EMA200 rebote / cruce (diaria y
# semanal), bases VCP y cruce del RSI semanal con su SMA14. Todo sale del
# mismo 'hist' diario de 5 años; las velas semanales se arman UNA vez por
# ticker (W-FRI). El RS a la fecha del contacto sale de rs_percentiles. Si se
# toca un umbral aca, tocarlo tambien en src/pages/Senales.jsx.
# ---------------------------------------------------------------------------
SEN_TOQUE = 1.01  # la rueda "toca" la EMA si su minimo <= EMA x 1,01
SEN_FRAC_TRAMO = 0.8  # "tramo sostenido" = >= 80% de los cierres del tramo del mismo lado de la EMA
SEN_EMA = {
    # tramo: velas previas que tienen que estar (mayormente) del mismo lado;
    # reciente: solo contactos en las ultimas N velas; desde: velas de
    # calentamiento de la EMA antes de buscar contactos (para "Última vez").
    "diario": {"tramo": 20, "reciente": 10, "desde": 200, "min_velas": 250},
    "semanal": {"tramo": 10, "reciente": 4, "desde": 150, "min_velas": 150},
}
SEN_CLIMAX_RADIO = 2  # velas a cada lado del contacto donde se busca el climax de volumen
SEN_CLIMAX_VOL = 1.5  # 🌊: volumen >= 1,5x el promedio de 20 velas...
SEN_CLIMAX_POS = 0.6  # ... y cierre en el 40% superior del rango (posicion >= 60%)
SEN_RSI_SEMANAS = 3  # cruces del RSI semanal en las ultimas 3 semanas (0 = la semana en curso)
SEN_VCP_MIN = 60  # score VCP minimo para listar la base


def velas_semanales(df):
    """Velas semanales (cierre del viernes) desde las diarias. La ultima es la
    semana EN CURSO (parcial) si la corrida cae de lunes a jueves."""
    sem = df.resample("W-FRI").agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"})
    return sem[sem["Close"].notna()]


def _desfase_mas_cercano(ruedas):
    return min(WS_DESFASES_RS_EXT, key=lambda d: (abs(d - ruedas), d))


def sen_eventos_ema(velas, cfg, adjust):
    """Series vela a vela (sin look-ahead: cada vela usa solo datos hasta
    ella) de la EMA200, 'arriba' (cierre > EMA) y los eventos de rebote y
    cruce al alza (ver sen_contactos_ema). Las velas de calentamiento
    ('desde') quedan en False. La usan la señal en vivo y el backtest
    (scripts/backtest_senales.py)."""
    n = len(velas)
    c, l = velas["Close"], velas["Low"]
    ema = c.ewm(span=200, adjust=adjust).mean()
    arriba = c > ema
    frac_arriba = arriba.astype(float).rolling(cfg["tramo"]).mean().shift(1)
    rebote = (l <= ema * SEN_TOQUE) & arriba & (frac_arriba >= SEN_FRAC_TRAMO)
    cruce = arriba & ~arriba.shift(1, fill_value=True) & ((1 - frac_arriba) >= SEN_FRAC_TRAMO)
    desde = min(cfg["desde"], n - 1)
    rebote.iloc[:desde] = False
    cruce.iloc[:desde] = False
    return ema, arriba, rebote, cruce


def sen_contactos_ema(velas, cfg, adjust):
    """Rebote y cruce al alza sobre la EMA200 de 'velas' (diarias o semanales).
      Rebote (vela i): minimo <= EMA x 1,01 y cierre > EMA, con >= 80% de los
        cierres de las 'tramo' velas anteriores arriba de la EMA.
      Cruce al alza (vela i): cierre > EMA y cierre anterior <= EMA, con >= 80%
        de los cierres de las 'tramo' velas anteriores abajo de la EMA.
    Solo cuenta el contacto mas reciente dentro de las ultimas 'reciente'
    velas, y solo si HOY el cierre sigue arriba de la EMA. Devuelve
    {"rebote": {...}|None, "cruce": {...}|None} con la posicion del contacto,
    el climax de volumen alrededor y la fecha del contacto anterior."""
    n = len(velas)
    if n < cfg["min_velas"]:
        return None
    c, h, l, v = (velas[k] for k in ("Close", "High", "Low", "Volume"))
    ema, arriba, rebote, cruce = sen_eventos_ema(velas, cfg, adjust)
    if not bool(arriba.iloc[-1]):
        return {"rebote": None, "cruce": None}

    vv = v.fillna(0).values
    prom20 = v.fillna(0).rolling(20).mean().shift(1).values
    cc, hh, ll = c.values, h.values, l.values
    fechas = velas.index

    def detalle(i, eventos, separacion):
        a, b = max(0, i - SEN_CLIMAX_RADIO), min(n - 1, i + SEN_CLIMAX_RADIO)
        k = a + int(np.argmax(vv[a : b + 1]))
        ratio = vv[k] / prom20[k] if es_valido(float(prom20[k])) and prom20[k] > 0 else None
        rango = hh[k] - ll[k]
        pos = (cc[k] - ll[k]) / rango if rango > 0 else None
        # Contacto anterior (mismo criterio): para el rebote, anterior al tramo
        # sostenido que precedio a este contacto (si no, un toque de ayer
        # contaria como "la vez anterior"); para el cruce, cualquier cruce previo.
        previos = np.flatnonzero(eventos.values[: max(0, i - separacion)])
        anterior = fechas[previos[-1]] if len(previos) else None
        return {
            "pos": i,
            "hace": n - 1 - i,
            "fecha": fechas[i].strftime("%Y-%m-%d"),
            "ema": num(ema.iloc[i], 2),
            "climax_ratio": num(ratio, 2),
            "climax_pos_pct": num(pos * 100, 0) if pos is not None else None,
            "climax_ola": bool(ratio is not None and pos is not None and ratio >= SEN_CLIMAX_VOL and pos >= SEN_CLIMAX_POS),
            "climax_fecha": fechas[k].strftime("%Y-%m-%d"),
            "ultima_vez_dias": int((fechas[i] - anterior).days) if anterior is not None else None,
            "dist_ema_pct": num((cc[-1] / ema.iloc[-1] - 1) * 100, 2),
        }

    salida = {}
    for tipo, eventos, sep in (("rebote", rebote, cfg["tramo"]), ("cruce", cruce, 0)):
        recientes = np.flatnonzero(eventos.values[n - cfg["reciente"] :])
        salida[tipo] = detalle(n - cfg["reciente"] + int(recientes[-1]), eventos, sep) if len(recientes) else None
    return salida


def sen_cruces_rsi(sem):
    """RSI(14) semanal, su SMA14 y la serie de cruces vela a vela: +1 cruce
    alcista (RSI pasa arriba de la SMA), -1 bajista, 0 sin cruce. Sin
    look-ahead (la usan la señal en vivo y el backtest)."""
    rsi = rsi_serie(sem["Close"], 14)
    sma = rsi.rolling(14).mean()
    sobre = rsi > sma
    valido = rsi.notna() & sma.notna()
    cambio = valido & valido.shift(1, fill_value=False) & (sobre != sobre.shift(1, fill_value=False))
    cruces = pd.Series(0, index=sem.index, dtype="int64")
    cruces[cambio & sobre] = 1
    cruces[cambio & ~sobre] = -1
    return rsi, sma, cruces


def sen_rsi_semanal(sem):
    """Cruce del RSI(14) semanal (Wilder, cierres semanales) con su SMA14 en
    las ultimas 3 velas semanales, contando la semana en curso como "esta
    semana" (hace 0). Solo el cruce mas reciente."""
    if len(sem) < 30:
        return None
    rsi, sma, cruces = sen_cruces_rsi(sem)
    n = len(sem)
    for hace in range(SEN_RSI_SEMANAS):
        i = n - 1 - hace
        if not cruces.iloc[i]:
            continue
        return {
            "tipo": "alcista" if cruces.iloc[i] > 0 else "bajista",
            "hace": hace,
            "fecha": sem.index[i].strftime("%Y-%m-%d"),
            "rsi": num(rsi.iloc[-1], 1),
            "sma14": num(sma.iloc[-1], 1),
        }
    return None


def senales_ticker(hist, calc_ws):
    """Primera pasada de senales.json para un ticker (sin RS: el percentil
    del universo se agrega en construir_senales)."""
    df = ohlcv_limpio(hist)
    if len(df) < 60:
        return None
    sem = velas_semanales(df)
    ema_d = sen_contactos_ema(df, SEN_EMA["diario"], adjust=False)
    # Semanal con adjust=True: con 150-260 velas la semilla de un EMA
    # recursivo todavia pesa; asi es el promedio exponencial de lo disponible.
    ema_s = sen_contactos_ema(sem, SEN_EMA["semanal"], adjust=True)
    if ema_s:
        # desfase en RUEDAS de cada contacto semanal (para el RS a esa fecha):
        # ruedas diarias posteriores al ultimo dia de esa semana.
        dias = df.index
        for x in ema_s.values():
            if x:
                ult = int(np.searchsorted(dias, sem.index[x["pos"]], side="right")) - 1
                x["ruedas"] = len(dias) - 1 - ult
    if calc_ws and calc_ws.get("vcp_ciclo") is not None:
        vcp = calc_ws["vcp_ciclo"]
    elif calc_ws:
        vcp = None
    else:
        _, vcp = ws_ciclo_vcp(df, atr_serie(df["High"], df["Low"], df["Close"], 14) / df["Close"] * 100)
    return {"ema_diario": ema_d, "ema_semanal": ema_s, "vcp": vcp, "rsi_semanal": sen_rsi_semanal(sem)}


def construir_senales(senales_datos, rs_mapa, ahora_iso):
    """Segunda pasada: arma senales.json con el RS (percentil del universo
    USD) hoy y a la fecha de cada contacto. Tickers no-USD: RS None."""
    salida = {
        "actualizado": ahora_iso,
        "ema200": {tf: {"rebote": [], "cruce": []} for tf in SEN_EMA},
        "vcp": [],
        "rsi_semanal": {"alcista": [], "bajista": []},
    }
    for d in senales_datos:
        s_ = d["senales"]
        if not s_:
            continue
        rs_t = rs_mapa.get(d["ticker"], {})
        rs_hoy = rs_t.get(0)
        base = {"ticker": d["ticker"], "nombre": d["nombre"]}
        for tf, clave in (("diario", "ema_diario"), ("semanal", "ema_semanal")):
            for tipo, x in (s_.get(clave) or {}).items():
                if not x:
                    continue
                ruedas = x["hace"] if tf == "diario" else x["ruedas"]
                rs_contacto = rs_t.get(_desfase_mas_cercano(ruedas)) if rs_t else None
                fila = {k: v for k, v in x.items() if k not in ("pos", "ruedas")}
                salida["ema200"][tf][tipo].append({**base, **fila, "rs_contacto": rs_contacto, "rs_hoy": rs_hoy})
        vcp = s_.get("vcp")
        if vcp and vcp.get("score") is not None and vcp["score"] >= SEN_VCP_MIN:
            salida["vcp"].append({**base, **vcp, "rs_hoy": rs_hoy})
        r = s_.get("rsi_semanal")
        if r:
            salida["rsi_semanal"][r["tipo"]].append({**base, **{k: v for k, v in r.items() if k != "tipo"}, "rs": rs_hoy})
    for tf in salida["ema200"].values():
        for lista in tf.values():
            lista.sort(key=lambda f: (-(f["rs_hoy"] if f["rs_hoy"] is not None else -1), f["ticker"]))
    salida["vcp"].sort(key=lambda f: (-f["score"], f["ticker"]))
    for lista in salida["rsi_semanal"].values():
        lista.sort(key=lambda f: (f["hace"], -(f["rs"] if f["rs"] is not None else -1), f["ticker"]))
    return salida
