"""Helpers compartidos de scripts/comun.py."""

import json

import numpy as np
import pandas as pd
import pytest

from comun import (
    adx_dmi_serie,
    atr_serie,
    borrar_huerfanos,
    dias_distribucion,
    es_valido,
    escribir_json,
    leer_json,
    lineal,
    mediana_de,
    moneda_por_sufijo,
    normalizar_industria,
    num,
    rsi_serie,
    rsi_wilder,
    sanear,
    serializar,
    sig,
    tri,
)

# Ejemplo clasico de Wilder publicado por StockCharts ("RSI" en ChartSchool,
# planilla cs-rsi.xls): 33 cierres y el RSI(14) a partir del cierre 15.
CIERRES_STOCKCHARTS = [
    44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931,
    46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521,
    45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314,
]
RSI_STOCKCHARTS = [
    70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46,
    41.87, 45.46, 37.30, 33.08, 37.77,
]


class TestRSI:
    def test_coincide_con_el_ejemplo_publicado_de_wilder(self):
        r = rsi_serie(CIERRES_STOCKCHARTS)
        assert r.iloc[:14].isna().all()  # sin 14 variaciones no hay RSI
        assert [round(x, 2) for x in r.iloc[14:]] == RSI_STOCKCHARTS

    def test_primer_valor_a_mano(self):
        # Semilla = promedio simple de las 14 primeras ganancias / perdidas.
        d = np.diff(CIERRES_STOCKCHARTS[:15])
        ag, ap = d.clip(min=0).mean(), (-d).clip(min=0).mean()
        assert rsi_serie(CIERRES_STOCKCHARTS).iloc[14] == pytest.approx(100 - 100 / (1 + ag / ap), abs=1e-9)
        # Y el siguiente es el suavizado de Wilder: (avg*13 + x) / 14.
        x = CIERRES_STOCKCHARTS[15] - CIERRES_STOCKCHARTS[14]
        ag2, ap2 = (ag * 13 + max(x, 0)) / 14, (ap * 13 + max(-x, 0)) / 14
        assert rsi_serie(CIERRES_STOCKCHARTS).iloc[15] == pytest.approx(100 - 100 / (1 + ag2 / ap2), abs=1e-9)

    def test_rsi_wilder_devuelve_el_ultimo_valor(self):
        assert rsi_wilder(CIERRES_STOCKCHARTS) == pytest.approx(rsi_serie(CIERRES_STOCKCHARTS).iloc[-1])

    def test_sin_datos_suficientes(self):
        assert rsi_wilder([1, 2, 3]) is None
        assert rsi_serie([1.0] * 10).isna().all()

    def test_solo_subas_da_100_y_rango_0_100(self):
        assert rsi_wilder(list(range(1, 40))) == 100.0
        rng = np.random.default_rng(1)
        r = rsi_serie(100 + rng.normal(0, 1, 500).cumsum()).dropna()
        assert ((r >= 0) & (r <= 100)).all()


class TestTriLineal:
    def test_tri_trapezoidal(self):
        assert tri(0, 1, 2, 3, 4) == 0.0
        assert tri(1.5, 1, 2, 3, 4) == 0.5
        assert tri(2.5, 1, 2, 3, 4) == 1.0
        assert tri(3.5, 1, 2, 3, 4) == 0.5
        assert tri(4, 1, 2, 3, 4) == 0.0
        # lados planos
        assert tri(0, 0, 0, 5, 10) == 1.0
        assert tri(20, 0, 10, 50, 50) == 1.0
        assert tri(50, 0, 10, 50, 50) == 1.0

    def test_tri_dato_faltante_suma_cero(self):
        for x in (None, float("nan"), True):
            assert tri(x, 0, 1, 2, 3) == 0.0

    def test_lineal_recorta_y_acepta_tramo_invertido(self):
        assert lineal(5, 0, 10, 0, 20) == 10.0
        assert lineal(-5, 0, 10, 0, 20) == 0.0
        assert lineal(50, 0, 10, 0, 20) == 20.0
        assert lineal(6, 12, 3, 0, 10) == pytest.approx(10 * 6 / 9)  # x0 > x1: mas chico, mas puntos
        assert lineal(None, 0, 10, 7, 20) == 7.0
        assert lineal(5, 3, 3, 1, 2) == 1.0  # x0 == x1: sin division por cero


class TestATR:
    def test_atr_a_mano(self):
        h = pd.Series([12.0, 13.0, 12.5, 14.0])
        lo = pd.Series([10.0, 11.0, 11.0, 12.0])
        c = pd.Series([11.0, 12.5, 11.5, 13.5])
        # TR: [2 (H-L, sin cierre previo), max(2, 2, 0)=2, max(1.5, 0, 1.5)=1.5, max(2, 2.5, 0.5)=2.5]
        # Wilder alpha 1/3 arrancando del primer TR: 2 -> 2 -> 1.8333 -> 2.0556
        atr = atr_serie(h, lo, c, periodo=3)
        assert atr.iloc[:2].isna().all()  # min_periods = periodo
        assert atr.iloc[2] == pytest.approx(2 * 2 / 3 + 1.5 / 3)
        assert atr.iloc[3] == pytest.approx(atr.iloc[2] * 2 / 3 + 2.5 / 3)

    def test_rango_constante(self):
        n = 50
        c = pd.Series([100.0] * n)
        atr = atr_serie(c + 1, c - 1, c, 14)
        assert atr.iloc[-1] == pytest.approx(2.0)


class TestADXDMI:
    def _serie(self, n, paso_pct, rango_pct=1.0, semilla=0):
        rng = np.random.default_rng(semilla)
        c = 100 * np.exp(np.cumsum(np.full(n, paso_pct / 100) + rng.normal(0, 0.0005, n)))
        c = pd.Series(c)
        h = c * (1 + rango_pct / 100)
        lo = c * (1 - rango_pct / 100)
        return h, lo, c

    def test_tendencia_alcista_da_plus_di_mayor_y_adx_alto(self):
        h, lo, c = self._serie(120, paso_pct=0.8)
        adx, plus_di, minus_di = adx_dmi_serie(h, lo, c, 14)
        assert adx.iloc[:14].isna().all()
        assert plus_di.iloc[-1] > minus_di.iloc[-1]
        assert adx.iloc[-1] > 25  # tendencia sostenida: ADX deberia marcar fuerza

    def test_tendencia_bajista_da_minus_di_mayor(self):
        h, lo, c = self._serie(120, paso_pct=-0.8)
        adx, plus_di, minus_di = adx_dmi_serie(h, lo, c, 14)
        assert minus_di.iloc[-1] > plus_di.iloc[-1]
        assert adx.iloc[-1] > 25

    def test_lateral_da_adx_bajo(self):
        rng = np.random.default_rng(2)
        n = 120
        c = pd.Series(100 + rng.normal(0, 0.3, n).cumsum() * 0.05)  # ruido chico sin tendencia
        h, lo = c + 1, c - 1
        adx, _, _ = adx_dmi_serie(h, lo, c, 14)
        assert adx.iloc[-1] < 25


class TestDiasDistribucion:
    def test_cuenta_bajas_con_volumen_mayor_al_dia_anterior(self):
        # 5 ruedas: sube, baja 0.5% con volumen mayor (cuenta), sube,
        # baja 1% con volumen MENOR al dia anterior (no cuenta), sube.
        close = pd.Series([100.0, 101.0, 100.5, 101.5, 100.485, 101.5])
        volumen = pd.Series([1_000_000, 1_000_000, 1_500_000, 1_000_000, 900_000, 1_000_000])
        assert dias_distribucion(close, volumen, ventana=10, caida_pct=0.2) == 1

    def test_baja_chica_no_cuenta(self):
        # baja de solo 0.1% (< 0.2%) con volumen mayor: no es dia de distribucion.
        close = pd.Series([100.0, 101.0, 100.9])
        volumen = pd.Series([1_000_000, 1_000_000, 1_500_000])
        assert dias_distribucion(close, volumen, ventana=10, caida_pct=0.2) == 0

    def test_ventana_recorta_a_las_ultimas_n_ruedas(self):
        # 1 dia de distribucion viejo (fuera de la ventana de 3) + ninguno reciente.
        close = pd.Series([100.0, 101.0, 100.5, 101.0, 101.5, 102.0])
        volumen = pd.Series([1_000_000, 1_000_000, 1_500_000, 1_000_000, 1_000_000, 1_000_000])
        assert dias_distribucion(close, volumen, ventana=3, caida_pct=0.2) == 0


class TestNumSig:
    @pytest.mark.parametrize("v", [None, float("nan"), float("inf"), -float("inf"), True, False, "abc", [1], np.nan])
    def test_num_invalidos(self, v):
        assert num(v) is None

    def test_num_redondea(self):
        assert num(1.23456) == 1.23
        assert num(1.23456, 4) == 1.2346
        assert num(np.float64(2.5)) == 2.5
        assert num(np.int64(7)) == 7.0
        assert num("3.14159") == 3.14  # un string numerico se acepta (float())

    def test_sig(self):
        assert sig(12345.678) == 12350.0
        assert sig(0.000123456) == 0.0001235
        assert sig(float("nan")) is None
        assert sig(None) is None

    def test_es_valido(self):
        assert es_valido(0) and es_valido(1.5) and es_valido(np.float64(3))
        assert not es_valido(None) and not es_valido(float("nan")) and not es_valido(float("inf"))


class TestJSON:
    def test_sanear_reemplaza_nan_inf_y_tipos_numpy(self):
        obj = {"a": float("nan"), "b": [np.float64("inf"), np.int64(3), np.bool_(True)], "c": (1.5, None)}
        assert sanear(obj) == {"a": None, "b": [None, 3, True], "c": [1.5, None]}

    def test_serializar_nunca_emite_nan(self):
        texto = serializar({"x": np.nan, "y": [float("-inf")]})
        assert "NaN" not in texto and "Infinity" not in texto

        def estricto(c):
            raise ValueError(f"constante no JSON: {c}")

        assert json.loads(texto, parse_constant=estricto) == {"x": None, "y": [None]}

    def test_serializar_minificado_y_unicode(self):
        assert serializar({"señal": "Rompió", "n": [1, 2]}) == '{"señal":"Rompió","n":[1,2]}'

    def test_objeto_no_serializable_explota(self):
        with pytest.raises(TypeError):
            serializar({"x": object()})

    def test_escribir_json_atomico_y_solo_si_cambio(self, tmp_path):
        ruta = tmp_path / "sub" / "a.json"
        assert escribir_json(ruta, {"v": 1, "t": "hoy"}, silencioso=True) is True
        assert leer_json(ruta) == {"v": 1, "t": "hoy"}
        assert escribir_json(ruta, {"v": 1, "t": "hoy"}, silencioso=True) is False  # igual: no toca
        # solo cambio una clave ignorada: se conserva el archivo anterior
        assert escribir_json(ruta, {"v": 1, "t": "manana"}, ignorar_claves=("t",), silencioso=True) is False
        assert leer_json(ruta)["t"] == "hoy"
        assert escribir_json(ruta, {"v": 2, "t": "manana"}, ignorar_claves=("t",), silencioso=True) is True
        assert leer_json(ruta) == {"v": 2, "t": "manana"}
        assert not list(ruta.parent.glob("*.tmp"))  # sin temporales colgados

    def test_escribir_json_con_error_no_deja_archivo_a_medias(self, tmp_path):
        ruta = tmp_path / "a.json"
        escribir_json(ruta, {"ok": True}, silencioso=True)
        with pytest.raises(TypeError):
            escribir_json(ruta, {"x": object()}, silencioso=True)
        assert leer_json(ruta) == {"ok": True}

    def test_leer_json_tolerante(self, tmp_path):
        (tmp_path / "roto.json").write_text("{no es json", encoding="utf-8")
        assert leer_json(tmp_path / "roto.json", "def") == "def"
        assert leer_json(tmp_path / "no-existe.json", []) == []

    def test_borrar_huerfanos(self, tmp_path):
        for t in ("AAA", "BBB", "CCC"):
            (tmp_path / f"{t}.json").write_text("[]", encoding="utf-8")
        assert sorted(borrar_huerfanos(tmp_path, {"AAA"})) == ["BBB", "CCC"]
        assert [p.stem for p in tmp_path.glob("*.json")] == ["AAA"]


def test_mediana_de_ignora_nulos():
    filas = [{"x": 3}, {"x": None}, {"x": 1}, {"y": 5}, {"x": 2}, {"x": 10}]
    assert mediana_de(filas, "x") == 2.5
    assert mediana_de([{"x": None}], "x") is None


def test_normalizar_industria_y_monedas():
    assert normalizar_industria("Drug Manufacturers—General") == "drug manufacturers - general"
    assert normalizar_industria("Oil & Gas  E&P") == "oil & gas e&p"
    assert moneda_por_sufijo("GGAL.BA") == "ARS"
    assert moneda_por_sufijo("PETR4.SA") == "BRL"
    assert moneda_por_sufijo("AAPL") == "USD"
