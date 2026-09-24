"""Universo: filtro de basura, cache de invalidos con TTL, mapeo al simbolo
previo y resolucion por sufijo sin cambiar de plaza."""

from datetime import datetime
from types import SimpleNamespace

import pandas as pd

from comun import TZ, escribir_json
from pipeline import universo
from pipeline.universo import es_ticker_basura, filtrar_universo, mapear_previos, universo_desde_args


def _hist():
    return pd.DataFrame({"Close": [1.0, 2.0]})


class DescargaFalsa:
    """Reemplazo de descargar_historicos: solo 'existen' los simbolos dados,
    y anota cada pedido."""

    def __init__(self, existen):
        self.existen = set(existen)
        self.pedidos = []

    def __call__(self, simbolos, periodo=None, esperas=None, auto_adjust=True):
        self.pedidos.append(list(simbolos))
        return {s: _hist() for s in simbolos if s in self.existen}


class TestResolucion:
    def test_ticker_ya_resuelto_no_cambia_de_plaza_si_falla(self, monkeypatch):
        # BK ya resolvio como BK (NYSE). Hoy Yahoo falla: NO se prueba BK.BA
        # (el CEDEAR en pesos), queda para el arrastre.
        falsa = DescargaFalsa(existen={"BK.BA", "BK.SA"})
        monkeypatch.setattr(universo, "descargar_historicos", falsa)
        assert universo.resolver_universo(["BK"], {"BK": "BK"}) == {}
        assert falsa.pedidos == [["BK"]]

    def test_ticker_nuevo_prueba_sa_y_despues_ba(self, monkeypatch):
        falsa = DescargaFalsa(existen={"AAPL", "PETR4.SA", "ALUA.BA"})
        monkeypatch.setattr(universo, "descargar_historicos", falsa)
        r = universo.resolver_universo(["AAPL", "PETR4", "ALUA", "GGAL.BA", "NOEXISTE"], {})
        assert {t: s for t, (s, _) in r.items()} == {"AAPL": "AAPL", "PETR4": "PETR4.SA", "ALUA": "ALUA.BA"}
        assert falsa.pedidos == [
            ["AAPL", "PETR4", "ALUA", "GGAL.BA", "NOEXISTE"],
            ["PETR4.SA", "ALUA.SA", "NOEXISTE.SA"],  # GGAL.BA ya trae sufijo: no se prueba
            ["ALUA.BA", "NOEXISTE.BA"],
        ]

    def test_usa_el_simbolo_previo(self, monkeypatch):
        falsa = DescargaFalsa(existen={"ALUA.BA"})
        monkeypatch.setattr(universo, "descargar_historicos", falsa)
        r = universo.resolver_universo(["ALUA"], {"ALUA": "ALUA.BA"})
        assert r["ALUA"][0] == "ALUA.BA"
        assert falsa.pedidos == [["ALUA.BA"]]

    def test_mapear_previos_no_mezcla_filas_propias_con_sufijo(self):
        prev = {"AAPL": {}, "SEMI.BA": {}, "ALUA.BA": {}}
        # SEMI y SEMI.BA son filas distintas del Excel: SEMI no hereda SEMI.BA.
        mapa = mapear_previos(["AAPL", "SEMI", "SEMI.BA", "ALUA"], prev)
        assert mapa == {"AAPL": "AAPL", "SEMI.BA": "SEMI.BA", "ALUA": "ALUA.BA"}


class TestFiltros:
    def test_basura_por_regla(self):
        for t in ("DIVIDENDOS", "EFECTIVO", "AL30", "GD29D", "TX26", "AL30.BA", "HOLA MUNDO", "ACCIONES", "$$$"):
            assert es_ticker_basura(t), t
        for t in ("AAPL", "CCL", "USD", "GGAL.BA", "PETR4.SA", "BRK-B", "EURUSD=X", "YPFD"):
            assert not es_ticker_basura(t), t

    def test_cache_de_invalidos_con_ttl(self, tmp_path):
        ahora = datetime(2026, 9, 23, 12, 0, tzinfo=TZ)
        ruta = tmp_path / "invalidos_cache.json"
        escribir_json(ruta, {"VIEJO": "2026-09-10", "NUEVO": "2026-09-20", "ROTO": "no-es-fecha"}, silencioso=True)
        df = pd.DataFrame({"Ticker": ["AAPL", "VIEJO", "NUEVO", "ROTO", "AL30"], "Industria": "", "Pais": "", "Nombre": ""})
        tickers, descartados, vigentes, salteados = filtrar_universo(df, ruta, ahora)
        assert descartados == ["AL30"]
        assert vigentes == {"NUEVO": "2026-09-20"}  # 3 dias < TTL 7; VIEJO (13 dias) se reintenta
        assert salteados == ["NUEVO"]
        assert list(tickers["Ticker"]) == ["AAPL", "VIEJO", "ROTO"]

    def test_universo_desde_args(self):
        args = SimpleNamespace(tickers=" aapl, KO ,aapl,,ggal.ba", limite=2)
        df = universo_desde_args(args)
        assert list(df["Ticker"]) == ["AAPL", "KO"]
        assert list(df.columns) == ["Ticker", "Industria", "Pais", "Nombre"]
