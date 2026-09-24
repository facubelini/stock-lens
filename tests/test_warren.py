"""Warren Score sobre series sinteticas: stage, gate EMA200 (cap 40), caps,
topes de cada pilar, percentiles de RS y ranking."""

import numpy as np
import pytest

from conftest import ohlcv, tramos
from pipeline.warren import (
    WS_CAP_GATE,
    WS_CAP_RECHAZO,
    WS_DESFASES_RS_EXT,
    WS_MIN_RUEDAS,
    calcular_warren_score,
    rs_percentiles,
    ws_calcular_ticker,
    ws_pilar_fuerza,
)

MAXIMOS = {"tendencia": 20, "fuerza": 25, "contraccion": 35, "gatillo": 20}


def _bench(n=600, semilla=0):
    rng = np.random.default_rng(semilla)
    return ohlcv(100 * np.exp(np.cumsum(rng.normal(0.0003, 0.01, n))))["Close"]


def _universo(n_tickers=15, n=600, semilla=1):
    rng = np.random.default_rng(semilla)
    bench = _bench(n)
    datos = []
    for k in range(n_tickers):
        c = 100 * np.exp(np.cumsum(rng.normal(rng.uniform(-0.002, 0.003), 0.02, n)))
        h = ohlcv(c, volumen=rng.uniform(5e5, 2e6, n))
        calc = ws_calcular_ticker(h, bench, True, -1, 30.0)
        datos.append({"ticker": f"T{k:02d}", "nombre": f"T{k}", "sector": "X", "en_usd": True, "calc": calc})
    return datos


def test_stage_y_precio_sobre_ema200():
    bench = _bench()
    sube = ws_calcular_ticker(ohlcv(tramos(50, (400, 150))), bench, True, -1, 20.0)
    baja = ws_calcular_ticker(ohlcv(tramos(150, (400, 50))), bench, True, -1, 20.0)
    assert sube["precio_sobre_ema200"] and sube["stage"]["n"] == 2
    assert not baja["precio_sobre_ema200"] and baja["stage"]["n"] == 4
    assert baja["tendencia"]["pts"] == 0.0


def test_historia_insuficiente_no_inventa_score():
    corto = ohlcv(tramos(50, (WS_MIN_RUEDAS - 2, 60)))
    assert ws_calcular_ticker(corto, _bench(), True, -1, 20.0) is None
    [fila] = calcular_warren_score([{"ticker": "X", "nombre": "X", "sector": "s", "en_usd": True, "calc": None}], {})
    assert fila["total_score"] is None and fila["datos_suficientes"] is False


def test_pilares_nunca_superan_su_maximo_y_total_en_rango():
    datos = _universo()
    salida = calcular_warren_score(datos, rs_percentiles(datos))
    assert len(salida) == 15
    for f in salida:
        for nombre, maximo in MAXIMOS.items():
            p = f["pilares"][nombre]
            assert p["max"] == maximo
            assert 0 <= p["pts"] <= maximo, (f["ticker"], nombre, p["pts"])
        assert 0 <= f["total_score"] <= 100
        assert f["penalizacion"]["pts"] <= 0
        if not f["gates"]["ok"]:
            assert f["total_score"] <= WS_CAP_GATE


def test_ranking_y_percentiles():
    datos = _universo()
    rs = rs_percentiles(datos)
    for t, porc in rs.items():
        assert set(porc) <= set(WS_DESFASES_RS_EXT)
        assert all(0 < v <= 100 for v in porc.values())
    # el mejor RS de hoy es el percentil 100
    assert max(p[0] for p in rs.values()) == 100.0
    salida = calcular_warren_score(datos, rs)
    orden = sorted(salida, key=lambda f: f["rank"])
    assert orden[0]["rank"] == 1 and all(f["total"] == 15 for f in salida)
    assert [f["total_score"] for f in orden] == sorted((f["total_score"] for f in salida), reverse=True)


def _calc_sintetico(**extra):
    """calc con pilares llenos (20+35+20 = 75 + fuerza) para probar caps."""
    calc = {
        "precio": 100.0, "dist_max52_pct": -1.0, "precio_sobre_ema200": True, "sin_52w": False,
        "rechazo_confirmado": False, "stage": {"n": 2}, "tendencia": {"pts": 20.0}, "contraccion": {"pts": 35.0},
        "gatillo": {"pts": 20.0}, "penalizacion": {"pts": 0.0, "flags": []}, "rs_crudo": [0.5, 0.4, 0.3],
        "fr_sobre_sma50": True,
    }
    calc.update(extra)
    return {"ticker": "X", "nombre": "X", "sector": "s", "en_usd": True, "calc": calc}


RS_ALTO = {"X": {0: 95.0, 5: 90.0, 21: 80.0}}


@pytest.mark.parametrize(
    "extra, total, caps",
    [
        ({}, 100.0, []),
        ({"precio_sobre_ema200": False}, float(WS_CAP_GATE), ["gate_ema200"]),
        ({"sin_52w": True}, float(WS_CAP_GATE), ["sin_52w"]),
        ({"rechazo_confirmado": True}, float(WS_CAP_RECHAZO), ["rechazo_confirmado"]),
        ({"penalizacion": {"pts": -30.0, "flags": []}}, 70.0, []),
        ({"precio_sobre_ema200": False, "penalizacion": {"pts": -70.0, "flags": []}}, 30.0, []),  # ya abajo del cap
    ],
)
def test_caps(extra, total, caps):
    [f] = calcular_warren_score([_calc_sintetico(**extra)], RS_ALTO)
    assert f["total_score"] == total
    assert f["caps"] == caps
    assert f["gates"]["ok"] == extra.get("precio_sobre_ema200", True)


def test_no_usd_queda_sin_total():
    fila = _calc_sintetico()
    fila["en_usd"] = False
    [f] = calcular_warren_score([fila], RS_ALTO)
    assert f["total_score"] is None and f["pilares"]["fuerza"] is None
    assert "USD" in f["motivo"]


class TestPilarFuerza:
    def test_via_nivel_y_tope(self):
        assert ws_pilar_fuerza(75, 70, 60, False)["pts"] == 20.0
        assert ws_pilar_fuerza(95, 90, 80, True)["pts"] == 25.0  # 20 + 5, tope 25
        assert ws_pilar_fuerza(45, 45, 45, False)["pts"] == 0.0

    def test_via_delta_premia_la_mejora(self):
        # RS 60 (nivel = 10) pero subio 20 puntos en el mes -> delta = 20
        b = ws_pilar_fuerza(60, 58, 40, False)
        assert b["via_nivel"] == 10.0 and b["via_delta"] == 20.0 and b["pts"] == 20.0
        # si cayo mas de 5 en la semana, la via delta no cuenta
        assert ws_pilar_fuerza(60, 70, 40, False)["via_delta"] == 0.0

    def test_sin_rs_reescala_la_linea_de_fr(self):
        assert ws_pilar_fuerza(None, None, None, True)["pts"] == 25.0
        assert ws_pilar_fuerza(None, None, None, False)["pts"] == 0.0
