"""Arrastre de datos viejos (stale) en procesar_universo."""

from datetime import datetime, timedelta

import pandas as pd

from comun import TZ
from pipeline.procesar import ARCHIVOS_POR_TICKER, DIAS_MAX_ARRASTRE, procesar_universo

AHORA = datetime(2026, 9, 23, 15, 0, tzinfo=TZ)


def _iso(dias_atras):
    return (AHORA - timedelta(days=dias_atras)).isoformat()


def _correr(tickers, previos_listado, resueltos=None, ts_prev=None, extra_previos=None):
    previos = {k: {} for k in ARCHIVOS_POR_TICKER}
    previos["listado"] = previos_listado
    for k, v in (extra_previos or {}).items():
        previos[k] = v
    df = pd.DataFrame({"Ticker": tickers, "Industria": "", "Pais": "", "Nombre": ""})
    ctx = {"prev_fundamentales": previos["fundamentales"], "ratios_cedear": {}, "precios_cedear": {},
           "bench_closes": None, "ahora_iso": AHORA.isoformat(), "ahora_utc": AHORA}
    simbolo_previo = {t: t for t in tickers if t in previos_listado}
    return procesar_universo(df, resueltos or {}, {}, ctx, previos, simbolo_previo, ts_prev or _iso(2), AHORA)


def test_arrastre_maximo_7_dias():
    prev = {
        "FRESCO_AYER": {"ticker": "FRESCO_AYER", "stale": False},  # usa el timestamp de la corrida anterior (2 dias)
        "STALE_6D": {"ticker": "STALE_6D", "stale": True, "actualizado": _iso(6.9)},
        "STALE_7D": {"ticker": "STALE_7D", "stale": True, "actualizado": _iso(DIAS_MAX_ARRASTRE)},
        "STALE_8D": {"ticker": "STALE_8D", "stale": True, "actualizado": _iso(8)},
    }
    res = _correr(list(prev) + ["NUNCA_VISTO"], prev)
    publicados = {f["ticker"]: f for f in res["listado"]}
    assert set(publicados) == {"FRESCO_AYER", "STALE_6D", "STALE_7D"}
    assert all(f["stale"] for f in publicados.values())
    assert publicados["FRESCO_AYER"]["actualizado"] == _iso(2)
    assert publicados["STALE_6D"]["actualizado"] == _iso(6.9)  # conserva SU timestamp, no el de ayer
    assert res["descartados_viejos"] == ["STALE_8D"]
    assert res["sin_arrastre"] == ["STALE_8D", "NUNCA_VISTO"]  # van al cache de invalidos
    assert res["invalidos"] == list(prev) + ["NUNCA_VISTO"]


def test_arrastre_limpia_campos_viejos_en_todos_los_archivos():
    prev_listado = {"KO": {"ticker": "KO", "stale": False, "book_value": 1}}
    extra = {
        "screener": {"KO": {"ticker": "KO", "diario": {"verdict": "COMPRA", "dist_clave": 1.0, "ma_clave": 2}}},
        "medias": {"KO": {"ticker": "KO", "precio": 60}},
    }
    res = _correr(["KO"], prev_listado, extra_previos=extra)
    assert "book_value" not in res["listado"][0]
    assert res["screener"][0]["diario"] == {"verdict": "COMPRA"}
    assert res["medias"][0]["stale"] is True
    assert res["fundamentales"] == [] and res["scanner_setups"] == []  # sin previo en ese archivo: no inventa fila


def test_ticker_que_rompe_al_procesar_va_al_arrastre():
    prev = {"ROTO": {"ticker": "ROTO", "stale": False}}
    hist_roto = pd.DataFrame({"Close": [10.0]}, index=pd.date_range("2026-09-22", periods=1))  # una sola rueda
    res = _correr(["ROTO"], prev, resueltos={"ROTO": ("ROTO", hist_roto)})
    assert res["invalidos"] == ["ROTO"]
    assert res["listado"][0]["stale"] is True
    assert res["sin_arrastre"] == []
