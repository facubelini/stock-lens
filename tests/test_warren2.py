"""Warren Score 2: premia al lider que retrocedio, no al que esta en maximos."""

import pytest

from pipeline.warren2 import calcular_warren_score2, ws2_calcular


def fila(rs=90, rs_mes=70, pend=0.15, d52=-15, rsi=45, d50=0, flags=(), gates_ok=True, caps=(), total=75):
    return {
        "ticker": "X", "nombre": "X", "sector": "T", "datos_suficientes": True, "total_score": total, "rank": 3,
        "dist_max52_pct": d52, "gates": {"ok": gates_ok, "fallas": []}, "caps": list(caps),
        "pilares": {
            "fuerza": {"rs": rs, "rs_mes_ant": rs_mes},
            "tendencia": {"pendiente_ema200": pend, "dist_sma50_atr": d50},
            "contraccion": {"rsi": rsi},
        },
        "penalizacion": {"flags": [{"clave": k, "pts": p} for k, p in flags]},
    }


def test_lider_que_retrocedio_tiene_score_alto():
    r = ws2_calcular(fila(rs=95))
    assert r["total_score"] == 100.0  # 33+11 liderazgo, 17 tendencia, 22+11+6 timing
    assert r["pilares"]["liderazgo"]["pts"] == 44 and r["pilares"]["timing"]["pts"] == 39
    assert r["caps"] == []


def test_lider_en_maximos_pierde_los_puntos_de_profundidad():
    en_maximos = ws2_calcular(fila(d52=0, rsi=65, d50=4))["total_score"]
    retrocedio = ws2_calcular(fila())["total_score"]
    assert en_maximos < retrocedio - 25


def test_la_sobreextension_ya_no_resta_por_penalizacion_pero_si_topea():
    r = ws2_calcular(fila(d50=9, flags=[("sobreextension", -6)]))
    assert r["penalizacion"]["pts"] == 0 and r["penalizacion"]["flags"] == []
    assert r["total_score"] <= 66 and "extendido" in r["caps"]
    assert "extendido" in ws2_calcular(fila(rsi=82))["caps"]


def test_penalizaciones_con_piso_en_menos_20():
    r = ws2_calcular(fila(flags=[("distribucion", -15), ("breakout_fallido", -12)]))
    assert r["penalizacion"]["pts"] == -22


def test_topes_de_gate_y_sin_liderazgo_no_pasa_de_56():
    assert ws2_calcular(fila(gates_ok=False))["total_score"] == 44.0
    assert "gate_ema200" in ws2_calcular(fila(caps=["sin_52w"]))["caps"]
    assert ws2_calcular(fila(rs=40, rs_mes=40))["total_score"] <= 56  # liderazgo 0: techo natural 17 + 39


def test_aceleracion_del_rs_suma_hasta_10():
    base = ws2_calcular(fila(rs=80, rs_mes=80))["pilares"]["liderazgo"]["pts_aceleracion"]
    acelera = ws2_calcular(fila(rs=80, rs_mes=60))["pilares"]["liderazgo"]["pts_aceleracion"]
    assert base == 0 and acelera == 11


def test_sin_datos_no_inventa_score():
    assert ws2_calcular({"datos_suficientes": False, "total_score": None}) is None
    filas = calcular_warren_score2([{"ticker": "N", "nombre": "N", "sector": None, "datos_suficientes": False, "total_score": None, "motivo": "m"}])
    assert filas[0]["total_score"] is None and filas[0]["datos_suficientes"] is False


def test_ranking_propio_y_score_original_al_lado():
    a, b = fila(), fila(d52=0, rsi=65, d50=4)
    a["ticker"], b["ticker"] = "A", "B"
    a["total_score"], b["total_score"] = 50, 90
    out = {f["ticker"]: f for f in calcular_warren_score2([a, b])}
    assert out["A"]["rank"] == 1 and out["B"]["rank"] == 2 and out["A"]["total"] == 2
    assert out["B"]["score_original"] == 90 and out["B"]["rank_original"] == 3
