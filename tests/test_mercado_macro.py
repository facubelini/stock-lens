"""Regimen de Mercado (mercado_macro.py): sub-scores de indices SPY/QQQ,
amplitud del universo y sentimiento sobre datos sinteticos."""

import json

import numpy as np
import pytest

from conftest import ohlcv
from comun import escribir_json
from mercado_macro import (
    REG_VIX_PANICO,
    _amplitud_universo,
    _indice_capa,
    _sentimiento,
    calcular_regimen,
    obtener_put_call,
)


def _indice_alcista(n=400, semilla=0):
    rng = np.random.default_rng(semilla)
    c = 100 * np.exp(np.cumsum(rng.normal(0.0018, 0.006, n)))  # tendencia sostenida, ruido chico
    return ohlcv(c, volumen=rng.uniform(8e7, 1.2e8, n))


def _indice_bajista(n=400, semilla=1):
    rng = np.random.default_rng(semilla)
    c = 100 * np.exp(np.cumsum(rng.normal(-0.0018, 0.006, n)))
    return ohlcv(c, volumen=rng.uniform(8e7, 1.2e8, n))


class TestIndiceCapa:
    def test_tendencia_alcista_da_puntaje_alto(self):
        capa = _indice_capa(_indice_alcista())
        assert capa is not None and capa["max"] == 40
        assert capa["pts"] > 22  # arriba de la mitad de 40

    def test_tendencia_bajista_da_puntaje_bajo(self):
        capa = _indice_capa(_indice_bajista())
        assert capa is not None
        assert capa["pts"] < 14  # bien abajo de la mitad de 40

    def test_alcista_puntua_mas_que_bajista(self):
        alto = _indice_capa(_indice_alcista())["pts"]
        bajo = _indice_capa(_indice_bajista())["pts"]
        assert alto > bajo

    def test_sin_historia_suficiente_da_none(self):
        assert _indice_capa(_indice_alcista(n=100)) is None
        assert _indice_capa(None) is None


class TestPutCall:
    def test_no_disponible_hoy_devuelve_none(self):
        # Documentado: yfinance no tiene una fuente confiable (^CPCE/^PCALL
        # 404). Se prueba que la funcion no fabrica un numero.
        assert obtener_put_call() is None


class TestSentimiento:
    def test_zona_sana_da_el_maximo(self):
        s = _sentimiento({"valor": 15.0}, None, None)
        assert s["pts"] == pytest.approx(15.0)
        assert s["pc_disponible"] is False

    def test_extremos_dan_cero(self):
        assert _sentimiento({"valor": 5.0}, None, None)["pts"] == 0.0
        assert _sentimiento({"valor": 32.0}, None, None)["pts"] == 0.0

    def test_sin_vix_da_none(self):
        assert _sentimiento(None, None, None) is None
        assert _sentimiento({"valor": None}, None, None) is None

    def test_panico_se_ablanda_si_las_otras_capas_estan_fuertes(self):
        vix = {"valor": REG_VIX_PANICO + 2}
        fuertes = ({"pts": 38, "max": 40}, {"pts": 28, "max": 30})
        debiles = ({"pts": 5, "max": 40}, {"pts": 5, "max": 30})
        con_fuertes = _sentimiento(vix, *fuertes)
        con_debiles = _sentimiento(vix, *debiles)
        assert con_fuertes["detalle"]["panico_ablandado"] is True
        assert con_debiles["detalle"]["panico_ablandado"] is False
        assert con_fuertes["pts"] > con_debiles["pts"]  # el ablande sube el puntaje


class TestAmplitudUniverso:
    def _escribir_universo(self, carpeta, filas):
        """filas: [(ticker, moneda, dist_sma200, dist_ema50, precio, high_52w,
        low_52w, vol_hoy, var_pct)]."""
        listado = {"acciones": [], "promedios_por_industria": []}
        medias, fundamentales = [], []
        for t, mo, d200, d50, precio, alto, bajo, vol, var in filas:
            listado["acciones"].append({"ticker": t, "nombre": t, "industria": "X", "pais": "USA", "stale": False,
                                         "high_52w": alto, "low_52w": bajo, "vol_hoy": vol, "var_pct": var})
            medias.append({"ticker": t, "precio": precio, "dist_sma200": d200, "dist_ema50": d50})
            fundamentales.append({"ticker": t, "moneda": mo})
        escribir_json(carpeta / "listado.json", listado)
        escribir_json(carpeta / "medias.json", medias)
        escribir_json(carpeta / "fundamentales.json", fundamentales)

    def test_universo_todo_sano_da_puntaje_alto(self, tmp_path):
        filas = [
            (f"T{i}", "USD", 10.0, 5.0, 105.0, 105.0, 90.0, 2_000_000, 1.0) for i in range(25)
        ]
        self._escribir_universo(tmp_path, filas)
        capa = _amplitud_universo(tmp_path)
        assert capa is not None and capa["max"] == 30
        assert capa["pts"] > 24  # casi el maximo: todo arriba de sus medias, nuevos maximos, volumen alcista

    def test_universo_todo_debil_da_puntaje_bajo(self, tmp_path):
        filas = [
            (f"T{i}", "USD", -10.0, -5.0, 90.0, 105.0, 90.0, 2_000_000, -1.0) for i in range(25)
        ]
        self._escribir_universo(tmp_path, filas)
        capa = _amplitud_universo(tmp_path)
        assert capa is not None
        assert capa["pts"] < 6

    def test_ignora_tickers_que_no_son_usd(self, tmp_path):
        filas = [("BA1", "ARS", 10.0, 5.0, 105.0, 105.0, 90.0, 1, 1.0)] * 25
        self._escribir_universo(tmp_path, filas)
        assert _amplitud_universo(tmp_path) is None  # < REG_MIN_TICKERS_AMPLITUD en USD

    def test_sin_archivos_da_none(self, tmp_path):
        assert _amplitud_universo(tmp_path) is None


class TestCalcularRegimen:
    def test_sin_ninguna_capa_disponible_da_none(self, tmp_path, monkeypatch):
        import mercado_macro

        monkeypatch.setattr(mercado_macro.yf, "Ticker", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("sin red")))
        assert calcular_regimen(None, tmp_path) is None

    def test_score_normalizado_a_100_con_solo_una_capa(self, tmp_path, monkeypatch):
        import mercado_macro

        monkeypatch.setattr(mercado_macro.yf, "Ticker", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("sin red")))
        r = calcular_regimen({"valor": 15.0}, tmp_path)  # solo sentimiento disponible (indices/amplitud no)
        assert r is not None
        assert r["max"] == 100
        assert r["score"] == pytest.approx(100.0)  # VIX en zona sana = el maximo de su capa = 100% renormalizado
        assert set(r["capas"]) == {"sentimiento"}
