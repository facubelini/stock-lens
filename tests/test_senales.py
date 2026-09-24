"""Señales: rebote / cruce sobre la EMA200 y cruce del RSI semanal con su
SMA14, sobre series sinteticas."""

import pandas as pd

from conftest import ohlcv, tramos
from pipeline.senales import SEN_EMA, construir_senales, sen_contactos_ema, sen_rsi_semanal, velas_semanales

DIARIO = SEN_EMA["diario"]


def test_rebote_sobre_la_ema200():
    # plano en 100 (EMA ~100), sube a 110, vuelve a tocar la EMA y rebota
    df = ohlcv(tramos(100, (250, 100), (30, 110), (6, 101.2), (3, 104)), rango_pct=0.3)
    r = sen_contactos_ema(df, DIARIO, adjust=False)
    assert r["cruce"] is None
    reb = r["rebote"]
    assert reb is not None and reb["hace"] == 1
    assert df["Low"].iloc[reb["pos"]] <= reb["ema"] * 1.01 < df["Close"].iloc[reb["pos"]] * 1.01
    assert reb["dist_ema_pct"] > 0
    assert reb["ultima_vez_dias"] is None  # no hubo un contacto anterior


def test_cruce_al_alza_de_la_ema200():
    # plano, cae abajo de la EMA un buen tramo y la cruza al alza
    df = ohlcv(tramos(100, (230, 100), (30, 90), (5, 89), (1, 103), (2, 104)), rango_pct=0.3)
    r = sen_contactos_ema(df, DIARIO, adjust=False)
    assert r["rebote"] is None
    assert r["cruce"]["hace"] == 2
    assert r["cruce"]["fecha"] == df.index[-3].strftime("%Y-%m-%d")


def test_sin_senal_si_hoy_cierra_abajo_de_la_ema():
    df = ohlcv(tramos(100, (230, 100), (30, 90), (5, 89), (1, 103), (2, 104)) + [95.0], rango_pct=0.3)
    assert sen_contactos_ema(df, DIARIO, adjust=False) == {"rebote": None, "cruce": None}


def test_pocas_velas():
    assert sen_contactos_ema(ohlcv(tramos(100, (100, 120))), DIARIO, adjust=False) is None


def _semanal(cierres):
    return pd.DataFrame({"Close": cierres}, index=pd.date_range("2024-01-05", periods=len(cierres), freq="W-FRI"))


LATERAL = [100 + (2 if i % 2 else 0) for i in range(33)]  # RSI ~50


class TestRSISemanal:
    def test_cruce_alcista_esta_semana(self):
        r = sen_rsi_semanal(_semanal(LATERAL + [101, 100, 99, 98, 97, 96, 105]))
        assert r["tipo"] == "alcista" and r["hace"] == 0
        assert r["rsi"] > r["sma14"]

    def test_cruce_alcista_la_semana_pasada(self):
        r = sen_rsi_semanal(_semanal(LATERAL + [101, 100, 99, 98, 97, 96, 105, 106]))
        assert r["tipo"] == "alcista" and r["hace"] == 1

    def test_cruce_de_hace_4_semanas_ya_no_cuenta(self):
        assert sen_rsi_semanal(_semanal(LATERAL + [101, 100, 99, 98, 97, 96, 105, 106, 107, 108])) is None

    def test_cruce_bajista(self):
        r = sen_rsi_semanal(_semanal(LATERAL + [101, 102, 103, 104, 105, 106, 97]))
        assert r["tipo"] == "bajista" and r["hace"] == 0 and r["rsi"] < r["sma14"]

    def test_pocas_semanas(self):
        assert sen_rsi_semanal(_semanal(LATERAL[:25])) is None


def test_velas_semanales_cierran_el_viernes():
    df = ohlcv([10, 11, 12, 13, 14, 15, 16], inicio="2026-09-14")  # lun 14 .. mar 22
    sem = velas_semanales(df)
    assert list(sem.index.strftime("%Y-%m-%d")) == ["2026-09-18", "2026-09-25"]
    assert list(sem["Close"]) == [14, 16]  # la ultima es la semana en curso (parcial)
    assert sem["Open"].iloc[0] == 10 and sem["Volume"].iloc[0] == 5_000_000


def test_construir_senales_ordena_por_rs_y_no_publica_la_posicion():
    x = {"pos": 10, "hace": 1, "fecha": "2026-09-22", "ema": 1.0}
    datos = [
        {"ticker": "B", "nombre": "B", "senales": {"ema_diario": {"rebote": dict(x), "cruce": None}}},
        {"ticker": "A", "nombre": "A", "senales": {"ema_diario": {"rebote": dict(x), "cruce": None}}},
        {"ticker": "C", "nombre": "C", "senales": None},
    ]
    s = construir_senales(datos, {"A": {0: 50.0, 1: 40.0}, "B": {0: 90.0, 1: 80.0}}, "2026-09-23T10:00:00-03:00")
    rebotes = s["ema200"]["diario"]["rebote"]
    assert [f["ticker"] for f in rebotes] == ["B", "A"]
    assert rebotes[0]["rs_hoy"] == 90.0 and rebotes[0]["rs_contacto"] == 80.0  # RS a la fecha del contacto (hace 1)
    assert "pos" not in rebotes[0]
