"""Precio de CEDEAR (data912 primero, Yahoo de respaldo) y CCL de data912:
scripts/pipeline/descarga.py. requests.get se mockea (nunca red real en
tests); yfinance se mockea via monkeypatch de descargar_historicos."""

import requests

import pipeline.descarga as descarga


class _RespuestaFalsa:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}")

    def json(self):
        return self.payload


def _mock_get(payload, status_code=200, excepcion=None):
    def get(url, timeout=None):
        if excepcion:
            raise excepcion
        return _RespuestaFalsa(payload, status_code)
    return get


class TestPreciosCedearData912:
    def test_toma_solo_los_tickers_pedidos_con_precio_valido(self, monkeypatch):
        monkeypatch.setattr(
            requests, "get",
            _mock_get([
                {"symbol": "AAPL", "c": 27000.0, "v": 97043.0},
                {"symbol": "NVDA", "c": 15080.0, "v": 302792.0},
                {"symbol": "OTRO", "c": 100.0, "v": 10.0},  # no pedido: se ignora
                {"symbol": "MSFT", "c": 0, "v": 5.0},  # precio invalido (<=0): se ignora
                {"symbol": "KO", "c": None, "v": None},  # sin precio: se ignora
            ]),
        )
        out = descarga.obtener_precios_cedear_data912(["AAPL", "NVDA", "MSFT", "KO"])
        assert set(out) == {"AAPL", "NVDA"}
        assert out["AAPL"] == {"precio": 27000.0, "volumen": 97043.0}
        assert out["NVDA"]["precio"] == 15080.0

    def test_symbol_case_insensitive(self, monkeypatch):
        monkeypatch.setattr(requests, "get", _mock_get([{"symbol": "aapl", "c": 100.0, "v": 1.0}]))
        assert "AAPL" in descarga.obtener_precios_cedear_data912(["AAPL"])

    def test_respuesta_no_es_lista_se_ignora(self, monkeypatch):
        monkeypatch.setattr(requests, "get", _mock_get({"error": "mal formada"}))
        assert descarga.obtener_precios_cedear_data912(["AAPL"]) == {}

    def test_timeout_no_rompe_devuelve_vacio(self, monkeypatch):
        monkeypatch.setattr(requests, "get", _mock_get(None, excepcion=requests.Timeout("timeout")))
        assert descarga.obtener_precios_cedear_data912(["AAPL"]) == {}

    def test_http_error_no_rompe_devuelve_vacio(self, monkeypatch):
        monkeypatch.setattr(requests, "get", _mock_get([{"symbol": "AAPL", "c": 1}], status_code=500))
        assert descarga.obtener_precios_cedear_data912(["AAPL"]) == {}

    def test_json_invalido_no_rompe(self, monkeypatch):
        class _RespuestaRota:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                raise ValueError("no es JSON")

        monkeypatch.setattr(requests, "get", lambda url, timeout=None: _RespuestaRota())
        assert descarga.obtener_precios_cedear_data912(["AAPL"]) == {}


class TestPreciosCedearCombinado:
    def test_data912_primero_yahoo_de_respaldo_para_el_resto(self, monkeypatch):
        monkeypatch.setattr(
            descarga, "obtener_precios_cedear_data912",
            lambda tickers: {"AAPL": {"precio": 27000.0, "volumen": 100.0}},
        )
        monkeypatch.setattr(descarga, "obtener_precios_cedear", lambda tickers: {"NVDA": 15000.0})
        out = descarga.obtener_precios_cedear_combinado(["AAPL", "NVDA", "SIN_DATO"])
        assert out["AAPL"] == {"precio": 27000.0, "fuente": "data912", "volumen": 100.0}
        assert out["NVDA"] == {"precio": 15000.0, "fuente": "yahoo", "volumen": None}
        assert "SIN_DATO" not in out

    def test_solo_pide_a_yahoo_los_que_faltan_en_data912(self, monkeypatch):
        monkeypatch.setattr(
            descarga, "obtener_precios_cedear_data912",
            lambda tickers: {"AAPL": {"precio": 1.0, "volumen": None}, "NVDA": {"precio": 2.0, "volumen": None}},
        )
        pedidos = []

        def yahoo(tickers):
            pedidos.append(list(tickers))
            return {}

        monkeypatch.setattr(descarga, "obtener_precios_cedear", yahoo)
        descarga.obtener_precios_cedear_combinado(["AAPL", "NVDA"])
        assert pedidos == []  # nada le falta a data912: ni se llama a Yahoo

    def test_data912_completamente_caido_cae_todo_a_yahoo(self, monkeypatch):
        monkeypatch.setattr(descarga, "obtener_precios_cedear_data912", lambda tickers: {})
        monkeypatch.setattr(descarga, "obtener_precios_cedear", lambda tickers: {"AAPL": 27000.0})
        out = descarga.obtener_precios_cedear_combinado(["AAPL"])
        assert out == {"AAPL": {"precio": 27000.0, "fuente": "yahoo", "volumen": None}}


class TestCclData912:
    def test_mediana_del_panel_cedear(self, monkeypatch):
        monkeypatch.setattr(
            requests, "get",
            _mock_get([
                {"ticker": "MU", "close": 1608.0, "panel": "cedear"},
                {"ticker": "META", "close": 1600.0, "panel": "cedear"},
                {"ticker": "AE38", "close": 1540.0, "panel": "bonds"},  # otro panel: se ignora
                {"ticker": "GGAL", "close": None, "panel": "cedear"},  # sin close: se ignora
            ]),
        )
        assert descarga.obtener_ccl_data912() == 1604.0  # mediana de [1600, 1608]

    def test_sin_valores_validos_devuelve_none(self, monkeypatch):
        monkeypatch.setattr(requests, "get", _mock_get([{"ticker": "X", "close": None, "panel": "cedear"}]))
        assert descarga.obtener_ccl_data912() is None

    def test_fallo_de_red_devuelve_none(self, monkeypatch):
        monkeypatch.setattr(requests, "get", _mock_get(None, excepcion=requests.ConnectionError("caido")))
        assert descarga.obtener_ccl_data912() is None
