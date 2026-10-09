"""Warren Score 2 (public/data/warren_score2.json): variante del Warren Score
que premia al LIDER QUE RETROCEDIO en vez de al que ya esta en maximos.

El Warren Score original (pipeline/warren.py) NO se toca: WS2 corre al lado, se
calcula a partir de la MISMA fila que ya produjo calcular_warren_score (no
pide nada nuevo ni recalcula indicadores), asi el backtest puede aplicarlo
exactamente igual que el pipeline (scripts/backtest_senales.py).

Por que existe (backtest 5 anios, 351 tickers, muestras cada 15 ruedas, exceso
vs. SPY a 20 ruedas): el score original casi no se correlaciona con el retorno
posterior (IC ≈ 0) y sus bandas altas rinden igual o peor que las medias. Lo
que si se repite en las dos mitades del periodo:
  - lideres (RS ≥ 70) que retrocedieron (≥10% bajo el maximo de 52 semanas, o
    RSI < 50) rinden mas que los que estan en maximos;
  - lideres con base VCP ≥ 60 rinden PEOR que los que no la tienen;
  - el sub-universo en maximos de 52s es el peor tramo.
WS2 reordena los pesos en consecuencia. Ojo: esos hallazgos salen del mismo
periodo con el que se diseño (en muestra) y el universo tiene sesgo de
supervivencia — es una hipotesis para confirmar con el seguimiento en vivo
(compra_desde.json) y con scripts/backtest_senales.py (warren2_bucket).

  score = clamp(Liderazgo /44 + Tendencia /17 + Timing /39 + penalizaciones, 0, 100)
  Liderazgo /44: RS (percentil vs el universo USD) 50→95 da 0→33, + aceleracion
    del RS vs hace un mes 0→20 da 0→11.
  Tendencia /17: pendiente de la EMA200 0→0,15 %/dia da 0→17.
  Timing /39: profundidad bajo el maximo 52s (plateau entre −25% y −8%) /22 +
    RSI14 (plateau 35-55) /11 + extension sobre la SMA50 en ATR (plateau
    −2..1,5) /6.
  Penalizaciones: las del original menos la de sobreextension (ya la
    cubre el Timing), con piso en −22.
  Topes: precio ≤ EMA200 o sin 52s → 44; extension > 8 ATR o RSI > 80 → 66.
    (Sin liderazgo, RS < 50, el techo natural ya es 56 = 17 + 39: no hace falta
    un tope aparte.)
Si se toca un umbral aca, tocarlo tambien en src/pages/WarrenScore2.jsx."""

from bisect import bisect_left

from comun import lineal, num, tri

WS2_PESOS = {"liderazgo": 44, "tendencia": 17, "timing": 39}
WS2_PTS_RS, WS2_PTS_ACEL = 33, 11
WS2_PTS_PROF, WS2_PTS_RSI, WS2_PTS_EXT = 22, 11, 6
WS2_RS_MIN, WS2_RS_MAX = 50, 95
WS2_DELTA_MAX = 20  # puntos de RS ganados en un mes que dan el maximo de aceleracion
WS2_PEND_MAX = 0.15
WS2_TIMING = {"prof": (-40, -25, -8, -3), "rsi": (25, 35, 55, 68), "ext": (-5, -2, 1.5, 5)}
WS2_PISO_PENALIZACION = -22
WS2_CAP_GATE = 44
WS2_CAP_EXTENDIDO = 66
WS2_EXT_ATR_CAP = 8
WS2_RSI_CAP = 80


def ws2_calcular(fila):
    """WS2 de una fila de warren_score.json (con score). Devuelve
    {total_score, pilares, penalizacion, caps} o None si la fila no tiene
    datos suficientes (no cotiza en USD / historia corta)."""
    if not fila.get("datos_suficientes") or fila.get("total_score") is None:
        return None
    p = fila["pilares"]
    fuerza, tend, contr = p["fuerza"], p["tendencia"], p["contraccion"]
    rs, rs_mes = fuerza.get("rs"), fuerza.get("rs_mes_ant")

    pts_rs = lineal(rs, WS2_RS_MIN, WS2_RS_MAX, 0, WS2_PTS_RS) if rs is not None else 0.0
    pts_acel = lineal(rs - max(rs_mes, 40), 0, WS2_DELTA_MAX, 0, WS2_PTS_ACEL) if rs is not None and rs_mes is not None else 0.0
    liderazgo = pts_rs + pts_acel

    pendiente = tend.get("pendiente_ema200") or 0.0
    pts_tend = lineal(pendiente, 0, WS2_PEND_MAX, 0, WS2_PESOS["tendencia"])

    d52, rsi, d50 = fila.get("dist_max52_pct"), contr.get("rsi"), tend.get("dist_sma50_atr")
    pts_prof = tri(d52, *WS2_TIMING["prof"]) * WS2_PTS_PROF if d52 is not None else 0.0
    pts_rsi = tri(rsi, *WS2_TIMING["rsi"]) * WS2_PTS_RSI if rsi is not None else 0.0
    pts_ext = tri(d50, *WS2_TIMING["ext"]) * WS2_PTS_EXT if d50 is not None else 0.0
    timing = pts_prof + pts_rsi + pts_ext

    flags = [fl for fl in fila["penalizacion"]["flags"] if fl["clave"] != "sobreextension"]
    pen = max(sum(fl["pts"] for fl in flags), WS2_PISO_PENALIZACION)

    total = round(max(0.0, min(100.0, liderazgo + pts_tend + timing + pen)), 1)
    caps = []
    if (not fila["gates"]["ok"] or "sin_52w" in fila.get("caps", [])) and total > WS2_CAP_GATE:
        caps.append("gate_ema200")
        total = float(WS2_CAP_GATE)
    if ((d50 is not None and d50 > WS2_EXT_ATR_CAP) or (rsi is not None and rsi > WS2_RSI_CAP)) and total > WS2_CAP_EXTENDIDO:
        caps.append("extendido")
        total = float(WS2_CAP_EXTENDIDO)

    return {
        "total_score": total,
        "pilares": {
            "liderazgo": {"pts": num(liderazgo, 1), "max": WS2_PESOS["liderazgo"], "rs": rs, "rs_mes_ant": rs_mes,
                          "pts_rs": num(pts_rs, 2), "pts_aceleracion": num(pts_acel, 2)},
            "tendencia": {"pts": num(pts_tend, 1), "max": WS2_PESOS["tendencia"], "pendiente_ema200": num(pendiente, 3)},
            "timing": {"pts": num(timing, 1), "max": WS2_PESOS["timing"], "dist_max52_pct": d52, "rsi": rsi,
                       "dist_sma50_atr": d50, "pts_profundidad": num(pts_prof, 2), "pts_rsi": num(pts_rsi, 2),
                       "pts_extension": num(pts_ext, 2)},
        },
        "penalizacion": {"pts": num(pen, 0), "flags": flags},
        "caps": caps,
    }


def calcular_warren_score2(warren_rows):
    """Filas de warren_score2.json: mismas claves de identidad que el original
    + total_score propio, 'score_original' (para compararlos lado a lado) y
    puesto en el ranking de WS2 (empates comparten puesto)."""
    salida = []
    for f in warren_rows:
        r = ws2_calcular(f)
        base = {"ticker": f["ticker"], "nombre": f.get("nombre"), "sector": f.get("sector")}
        if r is None:
            salida.append({**base, "total_score": None, "datos_suficientes": False, "motivo": f.get("motivo")})
            continue
        salida.append(
            {
                **base,
                "precio": f.get("precio"),
                "dist_max52_pct": f.get("dist_max52_pct"),
                "rs_score": f["pilares"]["fuerza"].get("rs"),
                "stage": f.get("stage"),
                "score_original": f["total_score"],
                "rank_original": f.get("rank"),
                "datos_suficientes": True,
                "motivo": None,
                **r,
            }
        )
    puntajes = sorted((f["total_score"] for f in salida if f.get("total_score") is not None), reverse=True)
    for f in salida:
        if f.get("total_score") is not None:
            f["rank"] = 1 + bisect_left([-v for v in puntajes], -f["total_score"])
            f["total"] = len(puntajes)
    return salida
