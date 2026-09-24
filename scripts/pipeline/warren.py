"""Warren Score (0-100): pilares Tendencia / Fuerza relativa /
Contraccion / Gatillo, penalizaciones, stage de Weinstein y percentiles de
fuerza relativa sobre el universo USD."""

from bisect import bisect_left, bisect_right

import numpy as np
import pandas as pd

from comun import atr_serie, es_valido, lineal, num, rsi_serie, rsi_wilder, tri

from .tecnico import _pivots
from .vcp import ws_ciclo_vcp


# ---------------------------------------------------------------------------
# Warren Score: screener tecnico/cuantitativo (0-100), NO fundamental.
# Modelo tipo "Warren Bife Dashboard" (pesos de su guia publica, guia.html):
#   score = clamp(A + B + C + D + penalizaciones, 0, 100) y despues caps.
#   A Tendencia /25 · B Fuerza relativa /30 · C Contraccion /30 · D Gatillo /15.
# (Version anterior, propia: 20/25/35/20 -- si hace falta volver a esos
# pesos, son los que salian de leer el JS real del dashboard en vivo en vez
# de su guia; la guia y el codigo del sitio no coinciden entre si).
# Todo sale del 'hist' OHLCV ya descargado (no pide nada nuevo a yfinance).
# La Fuerza Relativa necesita el percentil dentro de TODO el universo USD,
# asi que se arma en dos pasadas (mismo patron que promedios_por_industria):
# la primera (ws_calcular_ticker) guarda el rendimiento relativo crudo hoy,
# hace 5 y hace 21 ruedas; la segunda (calcular_warren_score) lo convierte
# en percentil y cierra el total. Si se toca un umbral aca, tocarlo tambien
# en src/pages/WarrenScore.jsx y en ExplicacionWarrenScore (Explicaciones.jsx).
# ---------------------------------------------------------------------------
WS_RUEDAS_PENDIENTE = 20  # pendiente EMA200 = variacion diaria promedio (%) en 20 ruedas
WS_PESOS_RS = ((63, 0.4), (126, 0.2), (189, 0.2), (252, 0.2))  # tipo IBD: el ultimo trimestre pesa doble
WS_DESFASES_RS = (0, 5, 21)  # RS hoy / hace una semana / hace un mes
# Para la pagina Señales hace falta el RS "a la fecha del contacto": se
# calcula el percentil del universo en cada rueda de las ultimas 10 y en
# cada semana (5 ruedas) de los ultimos ~6 meses; se toma el mas cercano.
WS_DESFASES_RS_EXT = tuple(sorted(set(WS_DESFASES_RS) | set(range(11)) | {5 * k for k in range(27)}))
WS_VENTANA_VOL = 20  # volatilidad realizada de 20 ruedas
WS_VENTANA_VOL_HIST = 252  # mediana de esa volatilidad en el ultimo anio
WS_MEMORIA_CONTRACCION = 7  # minimo del ratio en las ultimas 7 ruedas


WS_VENTANA_BASE = 275  # ~55 semanas para el pivote de la base
WS_CAP_GATE = 40
WS_CAP_RECHAZO = 70
WS_TOPE_AGOTAMIENTO = -14
WS_MIN_RUEDAS = 200 + WS_RUEDAS_PENDIENTE  # EMA200 + su pendiente


def _alinear_con_bench(closes, bench_closes):
    """Join POR FECHA (ruedas en comun) del ticker contra SPY. Antes era por
    posicion en cada serie y, con feriados distintos (BYMA/B3 vs NYSE) o
    huecos de datos, comparaba fechas distintas."""
    if bench_closes is None or bench_closes.empty:
        return None
    a, b = closes.copy(), bench_closes.copy()
    for s_ in (a, b):
        if s_.index.tz is not None:
            s_.index = s_.index.tz_localize(None)
        s_.index = s_.index.normalize()
    conjunto = pd.concat([a.rename("t"), b.rename("b")], axis=1, join="inner").dropna()
    conjunto = conjunto[~conjunto.index.duplicated(keep="last")]
    return conjunto if len(conjunto) else None


def ws_rendimiento_relativo(conjunto, desfase=0):
    """Rendimiento relativo ponderado vs SPY (tipo IBD) al cierre de hace
    'desfase' ruedas: 0.4·r63 + 0.2·r126 + 0.2·r189 + 0.2·r252 con
    rN = (1 + ret ticker N) / (1 + ret SPY N) − 1. Si faltan las ventanas
    largas se re-normalizan los pesos sobre las disponibles (minimo r63).
    Valor crudo: el percentil se calcula en la segunda pasada."""
    if conjunto is None:
        return None
    fin = len(conjunto) - 1 - desfase
    t, b = conjunto["t"].values, conjunto["b"].values
    suma = pesos = 0.0
    for n, peso in WS_PESOS_RS:
        ini = fin - n
        if ini < 0:
            break
        if not t[ini] or not b[ini] or not b[fin]:
            continue
        suma += ((t[fin] / t[ini]) / (b[fin] / b[ini]) - 1) * peso
        pesos += peso
    if pesos < WS_PESOS_RS[0][1]:  # sin r63 no hay RS
        return None
    return suma / pesos


def ws_base_y_pivote(df):
    """Base = consolidacion desde el pivote (maximo mas alto de las ultimas
    ~55 semanas). Si ese maximo es de las ultimas 3 ruedas (esta rompiendo o
    en nuevo maximo) se mide la base que ACABA de terminar: desde el maximo
    previo a esas ruedas hasta la ruptura."""
    sub = df.tail(WS_VENTANA_BASE)
    high, low = sub["High"].values, sub["Low"].values
    n = len(sub)
    if n < 30:
        return None
    j = int(np.argmax(high))
    ruptura = j >= n - 3
    if ruptura:
        j = int(np.argmax(high[: n - 3]))
        fin = n - 1
        # la base termina en la primera rueda que cerro arriba del pivote
        cierres = sub["Close"].values
        for k in range(j + 1, n):
            if cierres[k] > high[j]:
                fin = k
                break
    else:
        fin = n - 1
    pivote = float(high[j])
    minimo = float(low[j : fin + 1].min())
    precio = float(sub["Close"].iloc[-1])
    posicion = (precio - minimo) / (pivote - minimo) * 100 if pivote > minimo else None
    return {
        "pivote": pivote,
        "minimo": minimo,
        "semanas": (fin - j) / 5,
        "posicion_pct": posicion,
        "ruptura": bool(ruptura),
    }


def _obv(close, volume):
    return (np.sign(close.diff().fillna(0)) * volume.fillna(0)).cumsum()


def ws_penalizaciones(df, ind, fin):
    """Banderas con puntos negativos (y el 💣, positivo sin puntos). 'fin' =
    posicion de la ultima rueda CERRADA (-2 si la corrida cae con el
    mercado abierto), igual que vol_ratio: las reglas de volumen no se miden
    sobre una vela parcial."""
    c, o, h, l, v = (df[k] for k in ("Close", "Open", "High", "Low", "Volume"))
    v = v.fillna(0)
    precio, high_52w, atr, atr_pct, rsi = ind["precio"], ind["high_52w"], ind["atr"], ind["atr_pct"], ind["rsi"]
    cerca_max = lambda tol: bool(high_52w and precio >= high_52w * (1 - tol))  # noqa: E731
    flags = []

    def agregar(emoji, clave, pts, detalle):
        flags.append({"emoji": emoji, "clave": clave, "pts": pts, "detalle": detalle})

    # 🎈 Sobreextension
    d50 = ind["dist_sma50_pct"]
    ext_atr = d50 / atr_pct if es_valido(d50) and es_valido(atr_pct) and atr_pct else None
    sobre = (ext_atr is not None and ext_atr > 7) or (ext_atr is None and es_valido(d50) and d50 > 25)
    if sobre or (es_valido(rsi) and rsi > 80):
        motivo = f"{ext_atr:.1f} ATR sobre la SMA50" if ext_atr is not None else f"{d50:.1f}% sobre la SMA50"
        agregar("🎈", "sobreextension", -6, f"Sobreextendida: {motivo}, RSI {rsi:.0f} (umbral > 7 ATR o RSI > 80)"
                if es_valido(rsi) else f"Sobreextendida: {motivo} (umbral > 7 ATR)")

    # Ventanas terminadas en la ultima rueda cerrada.
    corte = len(df) + fin + 1
    cc, oo, hh, ll, vv = (s.iloc[:corte] for s in (c, o, h, l, v))
    prom20 = float(vv.iloc[-21:-1].mean()) if len(vv) >= 21 else None

    # 🩸 Distribucion activa
    if cerca_max(0.05) and len(cc) >= 8:
        ult_c, ult_o, ult_v = cc.tail(8), oo.tail(8), vv.tail(8)
        rojas = ult_c < ult_o
        vol_rojo, vol_verde = float(ult_v[rojas].sum()), float(ult_v[~rojas].sum())
        if int(rojas.sum()) >= 6 and vol_rojo > 0 and vol_verde < 0.8 * vol_rojo:
            agregar("🩸", "distribucion", -15,
                    f"Distribución: {int(rojas.sum())}/8 velas rojas cerca del máximo 52s, volumen verde "
                    f"{vol_verde / vol_rojo * 100:.0f}% del rojo (umbral ≥6 rojas y < 80%)")

    # 💥 Reversion con volumen
    if len(cc) >= 21 and prom20:
        var = (cc.iloc[-1] / cc.iloc[-2] - 1) * 100
        rv = float(vv.iloc[-1]) / prom20
        if var < -3 and rv > 1.5:
            agregar("💥", "reversion_volumen", -8,
                    f"Reversión con volumen: {var:.1f}% con {rv:.1f}× el volumen promedio de 20 ruedas "
                    f"(umbral < −3% y > 1,5×)")

    # ⛔ Breakout fallido: cerro arriba del maximo previo de 52s hace 6-15
    # ruedas y hoy esta de nuevo abajo de ese nivel.
    max_prev = hh.rolling(252, min_periods=60).max().shift(1)
    for k in range(6, 16):
        if len(cc) < k + 2:
            break
        d = len(cc) - 1 - k
        niv, niv_ant = max_prev.iloc[d], max_prev.iloc[d - 1]
        if es_valido(niv) and es_valido(niv_ant) and cc.iloc[d] > niv and cc.iloc[d - 1] <= niv_ant and precio < niv:
            agregar("⛔", "breakout_fallido", -10,
                    f"Breakout fallido: rompió {niv:.2f} hace {k} ruedas y hoy cierra abajo ({precio:.2f})")
            break

    # Agotamiento (tope −14 entre los tres). Divergencias: los dos ultimos
    # swing highs de cierre (maximo local de ±5 ruedas en las ultimas 90),
    # el mas reciente dentro de las ultimas 20 ruedas, mas alto que el
    # anterior, y con el precio todavia a <= 5% del maximo de 52s.
    agot = []
    if cerca_max(0.05) and len(cc) >= 100:
        tramo = cc.tail(100).reset_index(drop=True)
        rsi_t = rsi_serie(cc, 14).tail(100).reset_index(drop=True)
        obv_t = _obv(cc, vv).tail(100).reset_index(drop=True)
        _, altos = _pivots(tramo, 5)
        if len(altos) >= 2:
            i_p, i_r = altos[-2], altos[-1]
            if len(tramo) - 1 - i_r <= 20 and tramo.iloc[i_r] > tramo.iloc[i_p]:
                r_r, r_p = rsi_t.iloc[i_r], rsi_t.iloc[i_p]
                if es_valido(r_r) and es_valido(r_p) and r_r < r_p - 3:
                    agot.append(("📉", "divergencia_rsi", -8,
                                 f"Divergencia RSI: máximo más alto ({tramo.iloc[i_r]:.2f} > {tramo.iloc[i_p]:.2f}) "
                                 f"con RSI más bajo ({r_r:.0f} vs {r_p:.0f})"))
                if prom20 and obv_t.iloc[i_r] < obv_t.iloc[i_p] - prom20:
                    agot.append(("🪫", "divergencia_obv", -4,
                                 f"Divergencia OBV: máximo más alto de precio con OBV más bajo "
                                 f"({(obv_t.iloc[i_p] - obv_t.iloc[i_r]) / prom20:.1f} días de volumen menos)"))
    if cerca_max(0.03) and len(cc) >= 26 and es_valido(atr) and atr:
        v5 = float(vv.tail(5).mean())
        v_base = float(vv.iloc[-25:-5].mean())
        avance = (cc.iloc[-1] - cc.iloc[-6]) / atr
        if v_base and v5 > 1.5 * v_base and avance < 0.5:
            agot.append(("🐘", "churning", -4,
                         f"Churning en máximos: volumen de 5 ruedas {v5 / v_base:.1f}× el promedio con avance neto "
                         f"de {avance:.2f} ATR (umbral > 1,5× y < 0,5 ATR)"))
    total_agot = sum(a[2] for a in agot)
    for a in agot:
        agregar(*a)

    # ⚠️ Vela de rechazo en maximos (ultimas 10 ruedas): mecha superior
    # >= 2× cuerpo y >= 50% del rango, cerca del maximo 52s, volumen arriba
    # del promedio. Si es la ultima rueda queda "sin confirmar" (aviso, sin
    # cap); si la rueda siguiente cierra roja queda "confirmada" (cap 70)
    # hasta 2 verdes seguidas o un maximo nuevo sobre esa vela.
    rechazo_confirmado = False
    max_movil = cc.rolling(252, min_periods=60).max()
    vol_prom = vv.rolling(20).mean().shift(1)
    for k in range(0, min(10, len(cc) - 21)):
        r = len(cc) - 1 - k
        rango = hh.iloc[r] - ll.iloc[r]
        cuerpo = abs(cc.iloc[r] - oo.iloc[r])
        mecha = hh.iloc[r] - max(cc.iloc[r], oo.iloc[r])
        if not (rango > 0 and mecha >= 2 * cuerpo and mecha >= 0.5 * rango):
            continue
        if not (es_valido(max_movil.iloc[r]) and hh.iloc[r] >= max_movil.iloc[r] * 0.97):
            continue
        if not (es_valido(vol_prom.iloc[r]) and vv.iloc[r] > vol_prom.iloc[r]):
            continue
        estado = "sin confirmar"
        if r + 1 < len(cc) and cc.iloc[r + 1] >= oo.iloc[r + 1]:
            estado = "invalidada"  # la rueda siguiente no cerro roja: no se confirmo
        elif r + 1 < len(cc):
            estado = "confirmada"
            verdes = 0
            for q in range(r + 2, len(cc)):
                verdes = verdes + 1 if cc.iloc[q] > oo.iloc[q] else 0
                if verdes >= 2 or hh.iloc[q] > hh.iloc[r]:
                    estado = "invalidada"
                    break
        if estado != "invalidada":
            rechazo_confirmado = estado == "confirmada"
            agregar("⚠️", "vela_rechazo", 0,
                    f"Vela de rechazo en máximos {'en la última rueda' if k == 0 else f'hace {k} rueda(s)'} ({estado})"
                    + (": score topeado en 70" if rechazo_confirmado else ""))
        break

    # 💣 Bomba: rompio el maximo previo de 52s con volumen >= 1,5× y cierre
    # en el 30% superior del rango del dia.
    if len(cc) >= 21 and prom20:
        rango = hh.iloc[-1] - ll.iloc[-1]
        niv = max_prev.iloc[-1]
        if (es_valido(niv) and cc.iloc[-1] > niv and float(vv.iloc[-1]) >= 1.5 * prom20
                and rango > 0 and (cc.iloc[-1] - ll.iloc[-1]) / rango >= 0.7):
            agregar("💣", "bomba", 0,
                    f"Bomba: rompió el máximo previo {niv:.2f} con {float(vv.iloc[-1]) / prom20:.1f}× volumen y "
                    "cierre en el 30% superior del rango")

    pts = sum(f["pts"] for f in flags) - total_agot + max(WS_TOPE_AGOTAMIENTO, total_agot)
    return {"pts": num(pts, 1), "flags": flags}, rechazo_confirmado


def ohlcv_limpio(hist):
    """OHLCV sin las filas vacias que mete la descarga en lote (fechas en que
    otro simbolo del lote opero y este no) y con O/H/L faltantes = cierre."""
    df = hist[["Open", "High", "Low", "Close", "Volume"]].copy()
    df = df[df["Close"].notna()]
    df[["Open", "High", "Low"]] = df[["Open", "High", "Low"]].apply(lambda s: s.fillna(df["Close"]))
    return df


def ws_calcular_ticker(hist, bench_closes, en_usd, fin_vol, vol_1y, df=None, cache_vcp=None):
    """Primera pasada: pilares A, C y D, penalizaciones, stage y el
    rendimiento relativo crudo para el B. None si no hay historia suficiente
    (EMA200 + su pendiente). 'df' (ya limpio) y 'cache_vcp' son para el
    backtest, que lo evalua cortado en cada fecha (ver ws_ciclo_vcp)."""
    df = ohlcv_limpio(hist) if df is None else df
    c = df["Close"]
    if len(c) < WS_MIN_RUEDAS:
        return None
    precio = float(c.iloc[-1])
    sma50 = float(c.rolling(50).mean().iloc[-1])
    ema200_s = c.ewm(span=200, adjust=False).mean()
    ema200 = float(ema200_s.iloc[-1])
    atr_s = atr_serie(df["High"], df["Low"], c, 14)
    atr = float(atr_s.iloc[-1]) if es_valido(float(atr_s.iloc[-1])) else None
    atr_pct = atr / precio * 100 if atr and precio else None
    rsi = rsi_wilder(c.values, 14)
    ventana_52w = c.tail(252)
    high_52w, low_52w = float(ventana_52w.max()), float(ventana_52w.min())

    dist50 = (precio / sma50 - 1) * 100
    dist200 = (precio / ema200 - 1) * 100
    # Pendiente de la EMA200: variacion diaria promedio (%) en las ultimas
    # 20 ruedas (0,15 ≈ +3% en 20 ruedas).
    pendiente = float(ema200_s.pct_change().tail(WS_RUEDAS_PENDIENTE).mean() * 100)

    # --- Pilar A · Tendencia (25) --- (10/5,8333/4,1667 x 1,25 = 12,5/7,2916/5,2084)
    if atr_pct:
        d50_atr, d200_atr = dist50 / atr_pct, dist200 / atr_pct
        pts50 = tri(d50_atr, -5, -2, 4, 8) * 12.5
        pts200 = tri(d200_atr, 0, 0, 8, 14) * 7.2916
    else:
        d50_atr = d200_atr = None
        exceso = max(0.0, -5 - dist50, dist50 - 20)
        pts50 = max(0.0, 1.25 * (10 - exceso))
        pts200 = tri(dist200, 0, 10, 50, 70) * 7.2916
    pts_pend = lineal(pendiente, 0, 0.15, 0, 5.2084)
    tendencia = {
        "pts": num(min(pts50 + pts200 + pts_pend, 25), 1),
        "max": 25,
        "sma50": num(sma50, 2),
        "ema200": num(ema200, 2),
        "atr_pct": num(atr_pct, 2),
        "dist_sma50_pct": num(dist50, 2),
        "dist_sma50_atr": num(d50_atr, 2),
        "dist_ema200_pct": num(dist200, 2),
        "dist_ema200_atr": num(d200_atr, 2),
        "pendiente_ema200": num(pendiente, 3),
        "pts_sma50": num(pts50, 2),
        "pts_ema200": num(pts200, 2),
        "pts_pendiente": num(pts_pend, 2),
    }

    # --- Stage de Weinstein ---
    if dist200 > 0 and pendiente > 0:
        stage = {"n": 2, "label": "Avance confirmado", "tip": "Precio sobre la EMA200 y EMA200 subiendo"}
    elif dist200 > 0:
        stage = {"n": 3, "label": "Posible techo", "tip": "Precio sobre la EMA200 pero la EMA200 ya no sube"}
    elif pendiente > 0:
        stage = {"n": 1, "label": "Base / acumulación", "tip": "Precio bajo la EMA200 con la EMA200 todavía subiendo"}
    else:
        stage = {"n": 4, "label": "Declive", "tip": "Precio bajo la EMA200 y EMA200 bajando"}

    # --- Pilar B (crudo): rendimiento relativo + linea de FR vs su SMA50 ---
    rs_crudo = [None] * len(WS_DESFASES_RS)
    rs_ext = {}
    fr_sobre_sma50 = None
    if en_usd:
        conjunto = _alinear_con_bench(c, bench_closes)
        rs_ext = {d: ws_rendimiento_relativo(conjunto, d) for d in WS_DESFASES_RS_EXT}
        rs_crudo = [rs_ext[d] for d in WS_DESFASES_RS]
        if conjunto is not None and len(conjunto) >= 50:
            linea = conjunto["t"] / conjunto["b"]
            fr_sobre_sma50 = bool(linea.iloc[-1] > linea.rolling(50).mean().iloc[-1])

    # --- Pilar C · Contraccion (30) --- (15,25/11,25/6,8/1,7/8 x 6/7 =
    # 13,0714/9,6429/5,8286/1,4571/6,8571; la proporcion 35/19,75 del "else"
    # es la misma reescalada, 30/16,9286 = 35/19,75)
    ret = c.pct_change()
    vol20 = ret.rolling(WS_VENTANA_VOL).std()
    ratio_s = vol20 / vol20.rolling(WS_VENTANA_VOL_HIST, min_periods=WS_VENTANA_VOL_HIST).median()
    ratio_min7 = ratio_s.tail(WS_MEMORIA_CONTRACCION).min()
    ratio_min7 = float(ratio_min7) if es_valido(float(ratio_min7)) else None
    neto = (precio - float(c.iloc[-6])) / atr if atr else None
    factor = 1 - 0.5 * min(1.0, max(0.0, (neto - 0.8) / 1.7)) if neto is not None else 1.0
    pts_contr = tri(ratio_min7, 0, 0, 0.70, 1.05) * 13.0714 * factor if ratio_min7 is not None else None
    pts_rsi = tri(rsi, 30, 45, 60, 70) * 9.6429
    vcp, vcp_ciclo = ws_ciclo_vcp(df, atr_s / c * 100, cache=cache_vcp)
    pts_vcp = lineal(vcp["score"], 40, 100, 0, 5.8286) + (1.4571 if vcp["detectado"] and vcp["vol_decreciente"] else 0)
    if pts_contr is not None:
        base_c = min(pts_contr + pts_rsi + pts_vcp, 30)
    else:
        base_c = min((pts_rsi + pts_vcp) * 30 / 16.9286, 30)
    velocidad = ((precio / float(c.tail(15).min()) - 1) * 100) / atr_pct if atr_pct else None
    resta = lineal(velocidad, 5, 11, 0, 6.8571)
    contraccion = {
        "pts": num(max(0.0, base_c - resta), 1),
        "max": 30,
        "ratio_min7": num(ratio_min7, 2),
        "ratio_hoy": num(ratio_s.iloc[-1], 2),
        "avance_neto_atr": num(neto, 2),
        "factor_direccion": num(factor, 3),
        "rsi": num(rsi, 1),
        "pts_contraccion": num(pts_contr, 2),
        "pts_rsi": num(pts_rsi, 2),
        "pts_vcp": num(pts_vcp, 2),
        "velocidad_atr": num(velocidad, 2),
        "resta_verticalidad": num(resta, 2),
        "vcp": vcp,
    }

    # --- Pilar D · Gatillo (15) --- (5/10/5 x 0,75 = 3,75/7,5/3,75; piso a
    # la mitad del max, igual que antes: 15/2 = 7,5)
    dist_low = (precio / low_52w - 1) * 100 if low_52w else None
    ext = dist_low / vol_1y if es_valido(dist_low) and vol_1y else None
    pts_ext = tri(ext, 0.3, 0.5, 1.8, 3.2) * 3.75 if ext is not None else tri(dist_low, 25, 35, 110, 220) * 3.75
    base = ws_base_y_pivote(df)
    pts_sem = tri(base["semanas"], 1, 7, 26, 55) * 7.5 if base else 0.0
    pts_pos = lineal(base["posicion_pct"], 20, 50, 0, 3.75) if base else 0.0
    total_d = min(pts_ext + pts_sem + pts_pos, 15)
    piso = total_d < 7.5
    gatillo = {
        "pts": num(0.0 if piso else total_d, 1),
        "max": 15,
        "dist_min52_pct": num(dist_low, 2),
        "vol_1y": num(vol_1y, 1),
        "ext": num(ext, 2),
        "pivote": num(base["pivote"], 2) if base else None,
        "base_minimo": num(base["minimo"], 2) if base else None,
        "base_semanas": num(base["semanas"], 1) if base else None,
        "base_posicion_pct": num(base["posicion_pct"], 1) if base else None,
        "base_ruptura": base["ruptura"] if base else False,
        "pts_ext": num(pts_ext, 2),
        "pts_semanas": num(pts_sem, 2),
        "pts_posicion": num(pts_pos, 2),
        "suma_bruta": num(total_d, 2),
        "piso_aplicado": piso,
    }

    ind = {"precio": precio, "high_52w": high_52w, "atr": atr, "atr_pct": atr_pct, "rsi": rsi, "dist_sma50_pct": dist50}
    penalizacion, rechazo_confirmado = ws_penalizaciones(df, ind, fin_vol)

    return {
        "precio": num(precio, 2),
        "dist_max52_pct": num((precio / high_52w - 1) * 100, 2) if high_52w else None,
        "precio_sobre_ema200": bool(precio > ema200),
        "sin_52w": not (high_52w and low_52w),
        "rechazo_confirmado": rechazo_confirmado,
        "stage": stage,
        "tendencia": tendencia,
        "contraccion": contraccion,
        "gatillo": gatillo,
        "penalizacion": penalizacion,
        "rs_crudo": rs_crudo,
        "rs_ext": rs_ext,
        "fr_sobre_sma50": fr_sobre_sma50,
        "vcp_ciclo": vcp_ciclo,  # no se publica en warren_score.json: lo usa senales.json
    }


def ws_pilar_fuerza(rs, rs_sem, rs_mes, fr_sobre_sma50):
    """Pilar B (30): max(via nivel, via delta) + 6 si la linea de FR esta
    sobre su SMA50 (20/5 x 1,2 = 24/6)."""
    fr_pts = 6 if fr_sobre_sma50 else 0
    if rs is None:
        return {"pts": num(min(fr_pts * 5, 30), 1), "via_nivel": None, "via_delta": None, "fr_pts": fr_pts}
    via_nivel = lineal(rs, 45, 75, 0, 24)
    via_delta = 0.0
    if rs_sem is not None and rs_mes is not None and (rs - rs_sem) > -5:
        via_delta = lineal(rs - max(rs_mes, 40), 0, 20, 0, 24)
    return {
        "pts": num(min(max(via_nivel, via_delta) + fr_pts, 30), 1),
        "via_nivel": num(via_nivel, 2),
        "via_delta": num(via_delta, 2),
        "fr_pts": fr_pts,
    }


def rs_percentiles(warren_datos):
    """Percentil de RS (0-100) de cada ticker USD dentro del universo, para
    cada desfase de WS_DESFASES_RS_EXT: {ticker: {desfase: percentil}}. Percentil
    = proporcion del universo con valor <= al del ticker, x 100 (bisect sobre
    el universo ordenado: son ~35 desfases x ~350 tickers)."""
    universos = {
        d: sorted(w["calc"]["rs_ext"][d] for w in warren_datos if w["calc"] and w["calc"]["rs_ext"].get(d) is not None)
        for d in WS_DESFASES_RS_EXT
    }
    mapa = {}
    for w in warren_datos:
        ext = (w["calc"] or {}).get("rs_ext") or {}
        mapa[w["ticker"]] = {
            d: round(bisect_right(universos[d], ext[d]) / len(universos[d]) * 100, 1)
            for d in WS_DESFASES_RS_EXT
            if ext.get(d) is not None and universos[d]
        }
    return mapa


def ws_cerrar_total(calc, pts_fuerza):
    """Total del Warren Score a partir de la primera pasada (calc) y los
    puntos del pilar B: clamp(A + B + C + D + penalizaciones, 0, 100) y los
    caps (gate EMA200 / sin 52 semanas -> 40, rechazo confirmado -> 70).
    Devuelve (total, caps). Lo usan el pipeline y el backtest."""
    bruto = calc["tendencia"]["pts"] + pts_fuerza + calc["contraccion"]["pts"] + calc["gatillo"]["pts"] + calc["penalizacion"]["pts"]
    total = round(min(100.0, max(0.0, bruto)), 1)
    caps = []
    if not calc["precio_sobre_ema200"] and total > WS_CAP_GATE:
        caps.append("gate_ema200")
        total = float(WS_CAP_GATE)
    if calc["sin_52w"] and total > WS_CAP_GATE:
        caps.append("sin_52w")
        total = float(WS_CAP_GATE)
    if calc["rechazo_confirmado"] and total > WS_CAP_RECHAZO:
        caps.append("rechazo_confirmado")
        total = float(WS_CAP_RECHAZO)
    return total, caps


def calcular_warren_score(warren_datos, rs_mapa):
    """Segunda pasada: percentil de RS (hoy, hace 5 y hace 21 ruedas) dentro
    del universo USD (rs_mapa, de rs_percentiles), pilar B, total y caps.
    Tickers no-USD o sin historia suficiente: total None y datos_suficientes
    False (no se inventa un 0). Al final, puesto en el ranking (rank/total)."""
    salida = []
    for w in warren_datos:
        calc = w["calc"]
        fila = {"ticker": w["ticker"], "nombre": w["nombre"], "sector": w["sector"]}
        if not calc:
            salida.append({**fila, "total_score": None, "datos_suficientes": False, "motivo": "historia insuficiente"})
            continue
        fuerza = None
        if w["en_usd"]:
            rs, rs_sem, rs_mes = (rs_mapa.get(w["ticker"], {}).get(d) for d in WS_DESFASES_RS)
            b = ws_pilar_fuerza(rs, rs_sem, rs_mes, calc["fr_sobre_sma50"])
            fuerza = {
                "pts": b["pts"],
                "max": 30,
                "rs": rs,
                "rs_semana_ant": rs_sem,
                "rs_mes_ant": rs_mes,
                "rendimiento_relativo_pct": num(calc["rs_crudo"][0] * 100, 2) if calc["rs_crudo"][0] is not None else None,
                "via_nivel": b["via_nivel"],
                "via_delta": b["via_delta"],
                "fr_sobre_sma50": calc["fr_sobre_sma50"],
                "fr_pts": b["fr_pts"],
            }
        pilares = {"tendencia": calc["tendencia"], "fuerza": fuerza, "contraccion": calc["contraccion"], "gatillo": calc["gatillo"]}
        fallas = [] if calc["precio_sobre_ema200"] else ["Precio ≤ EMA200"]
        total, caps = ws_cerrar_total(calc, fuerza["pts"]) if fuerza is not None else (None, [])
        salida.append(
            {
                **fila,
                "precio": calc["precio"],
                "dist_max52_pct": calc["dist_max52_pct"],
                "total_score": total,
                "rs_score": fuerza["rs"] if fuerza else None,
                "datos_suficientes": total is not None,
                "motivo": None if total is not None else "no cotiza en USD (sin RS vs SPY)",
                "stage": calc["stage"],
                "gates": {"fallas": fallas, "ok": not fallas},
                "pilares": pilares,
                "penalizacion": calc["penalizacion"],
                "caps": caps,
            }
        )
    # Puesto en el ranking entre los que tienen score (empates comparten puesto).
    puntajes = sorted((f["total_score"] for f in salida if f.get("total_score") is not None), reverse=True)
    for f in salida:
        if f.get("total_score") is not None:
            f["rank"] = 1 + bisect_left([-v for v in puntajes], -f["total_score"])
            f["total"] = len(puntajes)
    return salida
