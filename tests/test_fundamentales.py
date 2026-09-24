"""Reglas de fundamentales: dividend yield, monedas (ratios mixtos, market
cap en USD, tipos de cambio) y el filtro de CCL implicito."""

from datetime import datetime, timedelta

import pandas as pd
import pytest

from pipeline import descarga
from pipeline.fundamentales import (
    DIVIDEND_YIELD_MAX,
    TOL_CCL,
    anular_ratios_mixtos,
    calcular_dividend_yield,
    completar_market_cap_usd,
    extraer_dividendos,
    extraer_fundamentales,
    filtrar_ccl,
    market_cap_usd,
    moneda_mixta,
)


def _pagos(montos, ultimo_hace_dias, cada_dias=91):
    """dividendos al estilo extraer_dividendos con el ultimo pago hace N dias."""
    hoy = datetime.now()
    fechas = [hoy - timedelta(days=ultimo_hace_dias + cada_dias * k) for k in range(len(montos))][::-1]
    return {
        "pagos": [{"fecha": f.strftime("%Y-%m-%d"), "monto": m} for f, m in zip(fechas, montos)],
        "total_ultimos_12m": sum(montos[-4:]),
    }


class TestDividendYield:
    def test_desde_pagos_reales_en_la_moneda_del_precio(self):
        # 4 pagos de 0.25 en 12 meses sobre precio 20 -> 5%
        assert calcular_dividend_yield(_pagos([0.25] * 4, 30), 20.0, {}) == pytest.approx(5.0)

    def test_adr_tipo_kep_no_usa_el_trailing_en_moneda_local(self):
        # KEP: trailingAnnualDividendYield divide KRW por USD (daba 13646%).
        # Sin pagos cargados se usa dividendYield, que ya viene en %.
        info = {"trailingAnnualDividendYield": 136.46, "dividendYield": 2.1}
        assert calcular_dividend_yield(None, 12.3, info) == pytest.approx(2.1)

    def test_etf_dividend_yield_ya_viene_en_porcentaje(self):
        assert calcular_dividend_yield(None, 500.0, {"dividendYield": 1.23}) == pytest.approx(1.23)

    def test_pagos_viejos_caen_al_dato_de_yahoo(self):
        # ultimo pago hace > 400 dias (hueco de Yahoo o dejo de pagar)
        assert calcular_dividend_yield(_pagos([1.0] * 4, 450), 10.0, {"dividendYield": 3.0}) == pytest.approx(3.0)
        assert calcular_dividend_yield(_pagos([1.0] * 4, 450), 10.0, {}) is None

    @pytest.mark.parametrize("info", [{"dividendYield": 30.0}, {"dividendYield": -1.0}, {"dividendYield": True},
                                      {"dividendYield": float("inf")}, {"dividendYield": "3"}])
    def test_descarta_valores_absurdos(self, info):
        assert calcular_dividend_yield(None, 10.0, info) is None

    def test_mas_de_25_por_ciento_desde_pagos_se_descarta_sin_fallback(self):
        # 40% desde pagos: se descarta (no cae al dato de Yahoo)
        assert calcular_dividend_yield(_pagos([1.0] * 4, 10), 10.0, {"dividendYield": 2.0}) is None
        assert DIVIDEND_YIELD_MAX == 25.0

    def test_extraer_dividendos_infiere_pagos_por_anio(self):
        # trimestral: 8 pagos, los ultimos 4 suman 4.4 y los 4 anteriores 4.0 -> +10%
        idx = pd.date_range("2023-01-15", periods=8, freq="91D")
        hist = pd.DataFrame({"Dividends": [1.0] * 4 + [1.1] * 4}, index=idx)
        d = extraer_dividendos(hist)
        assert d["total_ultimos_12m"] == pytest.approx(4.4)
        assert d["crecimiento_yoy"] == pytest.approx(10.0)
        assert extraer_dividendos(pd.DataFrame({"Dividends": [0.0, 0.0]}, index=idx[:2])) is None


class TestMonedas:
    def test_moneda_mixta(self):
        assert moneda_mixta("USD", "KRW")
        assert moneda_mixta("ARS", "USD")
        assert not moneda_mixta("USD", "USD")
        assert not moneda_mixta("GBp", "GBP")  # peniques vs libras: misma moneda
        assert not moneda_mixta("USD", None)

    def test_adr_en_usd_anula_solo_precio_contable(self):
        fund = {k: 10.0 for k in ("per_trailing", "per_forward", "peg", "ev_sales", "pb", "ps", "roe")}
        anular_ratios_mixtos(fund, "USD", "TWD")  # TSM
        assert fund["ev_sales"] is None and fund["pb"] is None and fund["ps"] is None
        assert fund["per_trailing"] == 10.0 and fund["peg"] == 10.0 and fund["roe"] == 10.0

    def test_cedear_en_pesos_anula_tambien_el_per(self):
        fund = {k: 10.0 for k in ("per_trailing", "per_forward", "peg", "ev_sales", "pb", "ps")}
        anular_ratios_mixtos(fund, "ARS", "USD")
        assert all(v is None for v in fund.values())

    def test_misma_moneda_no_toca_nada(self):
        fund = {"ps": 3.0, "per_trailing": 20.0}
        assert anular_ratios_mixtos(dict(fund), "USD", "USD") == fund

    def test_market_cap_usd(self):
        fx = {"USD": 1.0, "KRW": 1400.0, "ARS": 1500.0}
        assert market_cap_usd(1.4e12, "KRW", fx) == 1_000_000_000
        assert market_cap_usd(3e12, "USD", fx) == 3_000_000_000_000
        assert market_cap_usd(1e9, "JPY", fx) is None  # sin tipo de cambio
        assert market_cap_usd(None, "USD", fx) is None
        assert market_cap_usd(1e9, "USD", {"USD": 0}) is None

    def test_completar_market_cap_usd_respeta_el_de_los_arrastrados(self):
        fx = {"USD": 1.0, "ARS": 1000.0}
        fundamentales = [
            {"ticker": "GGAL.BA", "moneda": None, "market_cap": 5e12, "stale": False},
            {"ticker": "KO", "moneda": "USD", "market_cap": 3e11, "stale": True, "market_cap_usd": 123},
            {"ticker": "PEP", "moneda": "USD", "market_cap": 2e11, "stale": True, "market_cap_usd": None},
        ]
        peers = {"X": {"moneda": "ARS", "market_cap": 2e12}}
        completar_market_cap_usd(fundamentales, peers, fx)
        assert fundamentales[0]["moneda"] == "ARS" and fundamentales[0]["market_cap_usd"] == 5_000_000_000
        assert fundamentales[1]["market_cap_usd"] == 123  # stale con dato: se conserva
        assert fundamentales[2]["market_cap_usd"] == 200_000_000_000
        assert peers["X"]["market_cap_usd"] == 2_000_000_000

    def test_obtener_fx_monedas_menores_y_ccl(self, monkeypatch):
        pedidos = []

        def falso(simbolos, periodo=None, esperas=None, auto_adjust=True):
            pedidos.append(tuple(simbolos))
            return {"USDGBP=X": pd.DataFrame({"Close": [0.8, 0.79]}), "USDBRL=X": pd.DataFrame({"Close": [5.0, 5.5]})}

        monkeypatch.setattr(descarga, "descargar_historicos", falso)
        fx = descarga.obtener_fx({"USD", "ARS", "GBp", "BRL", None}, ccl=1500.0)
        assert fx["USD"] == 1.0 and fx["ARS"] == 1500.0
        assert fx["BRL"] == 5.5 and fx["GBP"] == 0.79
        assert fx["GBp"] == pytest.approx(79.0)  # peniques = libras x 100
        assert pedidos == [("USDBRL=X", "USDGBP=X")]  # ARS no se pide (sale del CCL), orden estable

    def test_extraer_fundamentales_tolera_faltantes_y_bools(self):
        f = extraer_fundamentales({"trailingPE": 20, "profitMargins": 0.25, "beta": True, "pegRatio": 1.5,
                                   "returnOnEquity": float("nan")})
        assert f["per_trailing"] == 20.0 and f["profit_margin"] == 25.0
        assert f["beta"] is None and f["roe"] is None and f["peg"] == 1.5
        assert f["dividend_yield"] is None


class TestCCL:
    def test_filtra_outliers_contra_la_mediana(self):
        medias = [
            {"ticker": "A", "cedear_ccl_implicito": 1500.0},
            {"ticker": "B", "cedear_ccl_implicito": 1510.0},
            {"ticker": "C", "cedear_ccl_implicito": 1490.0},
            {"ticker": "D", "cedear_ccl_implicito": 1500.0 * (1 + TOL_CCL + 0.05)},  # ratio mal cargado
            {"ticker": "E", "cedear_ccl_implicito": 900.0, "stale": True},  # arrastrado: no cuenta ni se toca
            {"ticker": "F", "cedear_ccl_implicito": None},
        ]
        mediana = filtrar_ccl(medias)
        assert mediana == pytest.approx(1505.0)  # mediana de A, B, C, D (sin el stale)
        assert medias[3]["cedear_ccl_implicito"] is None
        assert [m["cedear_ccl_implicito"] for m in medias[:3]] == [1500.0, 1510.0, 1490.0]
        assert medias[4]["cedear_ccl_implicito"] == 900.0

    def test_sin_cedears(self):
        assert filtrar_ccl([{"ticker": "A", "cedear_ccl_implicito": None}]) is None
