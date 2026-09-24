"""Forma de public/data/backtest_senales.json (scripts/backtest_senales.py)
sobre un universo sintetico chico: no mide poder estadistico, solo que el
pipeline de agregacion no rompe y que los campos que consume Backtest.jsx
(via un archivo nuevo) estan con el tipo esperado."""

import json

import numpy as np
import pytest

import backtest_senales as bts
from conftest import ohlcv

N = 900  # > WS_MIN_RUEDAS + varias muestras de STRIDE_PESADO


def _serie(semilla, deriva=0.0003, vol=0.018, n=N):
    rng = np.random.default_rng(semilla)
    precios = 100 * np.exp(np.cumsum(rng.normal(deriva, vol, n)))
    return ohlcv(precios, volumen=rng.uniform(5e5, 2e6, n))


@pytest.fixture(scope="module")
def historicos():
    return {
        "SPY": _serie(0, deriva=0.0002, vol=0.010),
        "AAA": _serie(1),
        "BBB": _serie(2, deriva=-0.0002),
        "CCC": _serie(3, deriva=0.0008, vol=0.03),
        "DDD": _serie(4),
    }


@pytest.fixture(scope="module")
def salida(historicos, tmp_path_factory):
    out = tmp_path_factory.mktemp("backtest_senales")
    bts.main(["--out", str(out)], historicos=historicos)
    return json.loads((out / "backtest_senales.json").read_text(encoding="utf-8"))


CAMPOS_NIVEL_1 = {
    "actualizado", "horizontes_dias", "horizontes_semanas", "n_tickers_evaluados", "n_tickers_fallidos",
    "stride_cross_sectional", "metodologia", "advertencias", "stats",
}
CAMPOS_ENTRADA = {
    "n", "hit_rate", "retorno_mediana", "retorno_prom", "n_exceso",
    "exceso_mediana_spy", "exceso_prom_spy", "ci95_exceso_mediana",
}


def test_campos_de_primer_nivel(salida):
    assert CAMPOS_NIVEL_1 <= set(salida)
    assert salida["horizontes_dias"] == bts.HORIZ_D
    assert salida["horizontes_semanas"] == bts.HORIZ_S
    assert salida["n_tickers_evaluados"] >= 3  # AAA/BBB/CCC/DDD (SPY no se autoevalua)
    assert isinstance(salida["advertencias"], list) and len(salida["advertencias"]) > 3
    assert isinstance(salida["metodologia"], str) and salida["metodologia"]


def test_grupos_de_senales_presentes(salida):
    stats = salida["stats"]
    assert set(stats) == {"ema_diario", "ema_semanal", "rsi_semanal", "vcp_estado", "warren_bucket"}
    assert set(stats["ema_diario"]) == {"rebote", "cruce"}
    assert set(stats["ema_semanal"]) == {"rebote", "cruce"}
    assert set(stats["rsi_semanal"]) == {"alcista", "bajista"}


def _revisar_entradas(por_etiqueta, horizontes):
    assert "BASELINE" in por_etiqueta
    for etiqueta, por_h in por_etiqueta.items():
        assert set(str(h) for h in horizontes) >= set(por_h)
        for h, entrada in por_h.items():
            if entrada is None:
                continue
            assert CAMPOS_ENTRADA <= set(entrada)
            assert entrada["n"] > 0
            assert 0 <= entrada["hit_rate"] <= 100
            assert isinstance(entrada["retorno_mediana"], (int, float))
            if entrada["ci95_exceso_mediana"] is not None:
                lo, hi = entrada["ci95_exceso_mediana"]
                assert lo <= hi


def test_forma_de_cada_grupo(salida):
    stats = salida["stats"]
    _revisar_entradas(stats["ema_diario"]["rebote"], bts.HORIZ_D)
    _revisar_entradas(stats["ema_diario"]["cruce"], bts.HORIZ_D)
    _revisar_entradas(stats["ema_semanal"]["rebote"], bts.HORIZ_S)
    _revisar_entradas(stats["ema_semanal"]["cruce"], bts.HORIZ_S)
    _revisar_entradas(stats["rsi_semanal"]["alcista"], bts.HORIZ_S)
    _revisar_entradas(stats["rsi_semanal"]["bajista"], bts.HORIZ_S)
    if stats["vcp_estado"]:
        _revisar_entradas(stats["vcp_estado"], bts.HORIZ_D)
        for estado in stats["vcp_estado"]:
            assert estado == "BASELINE" or estado in bts.ESTADOS_VCP
    if stats["warren_bucket"]:
        _revisar_entradas(stats["warren_bucket"], bts.HORIZ_D)
        for bucket in stats["warren_bucket"]:
            assert bucket == "BASELINE" or bucket in bts.BUCKETS_WARREN


def test_json_serializable_sin_nan(historicos, tmp_path):
    """escribir_json ya usa sanear()/serializar(), pero un NaN colado (float
    de numpy) rompe el parseo estricto: json.loads con un archivo real es la
    prueba de fuego."""
    out = tmp_path
    bts.main(["--out", str(out)], historicos=historicos)
    texto = (out / "backtest_senales.json").read_text(encoding="utf-8")
    json.loads(texto)  # no debe tirar (NaN/Infinity no son JSON valido)
    assert "NaN" not in texto and "Infinity" not in texto
