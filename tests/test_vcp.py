"""Ciclo de vida de la base VCP (ws_ciclo_vcp) sobre OHLC sintetico.

Base comun: sube de 50 a 100 (pivote = maximo 100,5 con el rango de 0,5%) y
hace tres contracciones decrecientes: -20,8% / -11% / -5,5%, cerrando a -3%
del pivote."""

import pytest

from comun import atr_serie
from conftest import ohlcv, tramos
from pipeline.vcp import ws_ciclo_vcp, ws_detectar_vcp, ws_zigzag

BASE = tramos(50, (40, 100), (10, 80), (10, 99), (8, 89), (8, 98.5), (5, 94), (5, 97.5))
ACERCA = tramos(97.5, (2, 99))[1:]  # se acerca al pivote sin tocarlo


def _ciclo(cierres):
    df = ohlcv(cierres, rango_pct=0.5)
    return ws_ciclo_vcp(df, atr_serie(df["High"], df["Low"], df["Close"], 14) / df["Close"] * 100)


def test_deteccion_de_la_base():
    df = ohlcv(BASE, rango_pct=0.5)
    vcp = ws_detectar_vcp(df, 1.0)
    assert vcp["detectado"] and vcp["contracciones"] == 3
    assert vcp["profundidades"] == [20.8, 11.0, 5.5]
    assert vcp["pivote"] == 100.5 and vcp["dist_pivote_pct"] == pytest.approx(-2.99, abs=0.01)
    assert vcp["ultima_confirmada"] and vcp["min_ultima"] == pytest.approx(93.53, abs=0.01)
    assert 70 <= vcp["score"] <= 100


def test_contracciones_crecientes_no_son_vcp():
    df = ohlcv(tramos(50, (40, 100), (8, 95), (8, 99), (10, 85), (10, 97)), rango_pct=0.5)
    assert not ws_detectar_vcp(df, 1.0)["detectado"]


@pytest.mark.parametrize(
    "cola, estado",
    [
        ([], "Armado"),
        (tramos(97.5, (3, 96.5))[1:], "Armado"),
        (ACERCA + [102.0], "Recién rompió"),
        (ACERCA + [102.0, 103.0], "Recién rompió"),
        (ACERCA + [102.0] + tramos(102, (3, 96))[1:], "Rompió y falló"),
        (ACERCA + [102.0] + tramos(102, (4, 106))[1:], "Rompió y confirmó"),
        (ACERCA + [102.0, 101.5, 101.0, 100.8], "Rompió sin confirmar"),
        (tramos(97.5, (1, 92), (1, 90))[1:], "Falló antes de romper"),
    ],
)
def test_estados_del_ciclo(cola, estado):
    hoy, ciclo = _ciclo(BASE + cola)
    assert hoy["estado"] == estado
    assert ciclo["estado"] == estado and ciclo["pivote"] == 100.5
    if estado.startswith("Romp") or estado.startswith("Reci"):
        assert ciclo["hace_ruptura"] == len(cola) - len(ACERCA) - 1


def test_formandose_ultima_contraccion_todavia_profunda():
    # ultima contraccion ~9% (> 8%) y precio a -6,5% del pivote: base viva pero no armada
    hoy, ciclo = _ciclo(tramos(50, (40, 100), (10, 80), (10, 99), (8, 88), (8, 98), (5, 90), (5, 94)))
    assert hoy["detectado"] and hoy["estado"] == "Formándose"


def test_sin_base():
    hoy, ciclo = _ciclo(tramos(50, (120, 150)))
    assert hoy["estado"] is None and ciclo is None


def test_zigzag_swings():
    high = [10, 11, 12, 11, 10, 11, 13, 12]
    low = [9, 10, 11, 10, 9, 10, 12, 11]
    swings = ws_zigzag(high, low, 5)
    # el ultimo extremo (todavia sin confirmar) va al final
    assert [(p, t) for p, t, _ in swings] == [(0, "L"), (2, "H"), (4, "L"), (6, "H"), (7, "L")]
