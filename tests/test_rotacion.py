"""Rotacion (RRG): cuadrante, historial acumulado, recien_a_lideres y
aceleracion inusual sobre historiales sinteticos de RS Score."""

from pipeline.rotacion import (
    ROT_UMBRAL_RS,
    _aceleracion_inusual,
    _cruce_fr_reciente,
    _cuadrante,
    _cuadrantes_de,
    rot_actualizar_historial,
    rot_construir,
    semana_iso,
)


class TestCuadrante:
    def test_liderando_y_debilitando(self):
        assert _cuadrante(70, 5) == "liderando"
        assert _cuadrante(70, -0.1) == "debilitando"
        assert _cuadrante(ROT_UMBRAL_RS, 0) == "liderando"  # igual al umbral cuenta como "alto"

    def test_recuperando_y_rezagando(self):
        assert _cuadrante(40, 3) == "recuperando"
        assert _cuadrante(40, -3) == "rezagando"

    def test_sin_semana_anterior_usa_solo_el_nivel(self):
        # sin dato previo, el delta se trata como 0 (>= 0): el nivel solo
        # define liderando (>= umbral) o recuperando (< umbral).
        assert _cuadrante(70, None) == "liderando"
        assert _cuadrante(40, None) == "recuperando"

    def test_sin_rs_da_none(self):
        assert _cuadrante(None, 5) is None

    def test_cuadrantes_de_serie(self):
        # 50 (sin anterior, delta=0 -> recuperando), sube a 65 (delta>0 y
        # ahora >=60 -> liderando), baja a 62 (sigue >=60 pero bajo ->
        # debilitando), None (sin dato -> None).
        assert _cuadrantes_de([50, 65, 62, None]) == ["recuperando", "liderando", "debilitando", None]


def test_semana_iso_formato():
    import datetime

    assert semana_iso(datetime.date(2026, 9, 24)) == "2026-W39"


class TestHistorialAcumulado:
    def test_agrega_semanas_y_pisa_la_misma_semana(self):
        h = rot_actualizar_historial({}, {"AAPL": {"rs_score": 50}}, "2026-W01")
        h = rot_actualizar_historial(h, {"AAPL": {"rs_score": 55}}, "2026-W01")  # 2da corrida, misma semana
        assert list(h) == ["2026-W01"]
        assert h["2026-W01"]["AAPL"]["rs_score"] == 55

    def test_recorta_a_max_semanas(self):
        h = {}
        for i in range(5):
            h = rot_actualizar_historial(h, {"AAPL": {"rs_score": i}}, f"2026-W{i:02d}", max_semanas=3)
        assert list(h) == ["2026-W02", "2026-W03", "2026-W04"]


def _hist_de(rs_por_semana, semanas=None, sector="Technology", es_etf=False, fr=None):
    """Arma un historial {semana: {ticker: {...}}} de un unico ticker T a
    partir de una lista de RS Score (uno por semana, con None donde falte)."""
    n = len(rs_por_semana)
    semanas = semanas or [f"2026-W{i + 1:02d}" for i in range(n)]
    fr = fr or [None] * n
    return {
        s: {"T": {"rs_score": rs, "sector": sector, "es_etf": es_etf, "market_cap_usd": 1e9, "nombre": "Test",
                  "fr_sobre_sma50": f}}
        for s, rs, f in zip(semanas, rs_por_semana, fr)
    }


class TestRotConstruir:
    def test_forma_basica_y_grupo_por_es_etf(self):
        historial = _hist_de([40, 45, 70])
        historial["2026-W03"]["E"] = {"rs_score": 80, "sector": "ETF", "es_etf": True, "market_cap_usd": 5e9,
                                       "nombre": "Un ETF", "fr_sobre_sma50": None}
        r = rot_construir(historial, "2026-09-24T10:00:00-03:00", n_semanas=16)
        assert r["semanas"] == ["2026-W01", "2026-W02", "2026-W03"]
        assert [f["ticker"] for f in r["acciones"]] == ["T"]
        assert [f["ticker"] for f in r["etfs"]] == ["E"]
        fila = r["acciones"][0]
        assert fila["rs_score"] == 70 and fila["rs_score_semana_ant"] == 45
        assert fila["cuadrante"] == "liderando"
        assert fila["historial"] == [40, 45, 70]

    def test_recien_a_lideres(self):
        # semana pasada "recuperando" (45, subiendo), esta semana "liderando" (75).
        historial = _hist_de([40, 45, 75])
        r = rot_construir(historial, "x", n_semanas=16)
        assert "T" in r["recien_a_lideres"]

    def test_ticker_sin_rs_esta_semana_no_se_publica(self):
        historial = _hist_de([70, 72, None])
        r = rot_construir(historial, "x", n_semanas=16)
        assert r["acciones"] == [] and r["etfs"] == []

    def test_semanas_se_recorta_a_n_semanas_mas_recientes(self):
        historial = _hist_de(list(range(20)))
        r = rot_construir(historial, "x", n_semanas=16)
        assert len(r["semanas"]) == 16
        assert r["acciones"][0]["historial"] == list(range(4, 20))  # las ultimas 16


class TestAceleracionInusual:
    def test_detecta_salto_tras_semanas_estancado(self):
        # 6 semanas estancado (recuperando/rezagando, rs bajo el umbral,
        # llano en conjunto) + salto de 22 puntos en las ultimas 2 semanas.
        rs = [28, 29, 30, 31, 32, 31, 32, 33, 55]
        cuadrantes = _cuadrantes_de(rs)
        assert _aceleracion_inusual(rs, cuadrantes) is True

    def test_no_dispara_si_no_hubo_salto(self):
        rs = [28, 29, 30, 31, 32, 31, 32, 33, 36]  # mismo estancamiento, sin salto (< 15 puntos)
        cuadrantes = _cuadrantes_de(rs)
        assert _aceleracion_inusual(rs, cuadrantes) is False

    def test_no_dispara_si_ya_venia_subiendo_antes_del_salto(self):
        # tendencia ya ascendente antes de la ventana de "salto" (no estaba llano).
        rs = [10, 20, 30, 40, 50, 55, 58, 60, 80]
        cuadrantes = _cuadrantes_de(rs)
        assert _aceleracion_inusual(rs, cuadrantes) is False

    def test_no_dispara_sin_historia_suficiente(self):
        assert _aceleracion_inusual([30, 55], _cuadrantes_de([30, 55])) is False

    def test_cruce_fr_sobre_sma50_reciente(self):
        assert _cruce_fr_reciente([True, False, True], ventana=2) is True  # cruzo hace 1 semana
        assert _cruce_fr_reciente([True, True, True], ventana=2) is False  # ya estaba arriba, no cruzo
        assert _cruce_fr_reciente([False, False, False], ventana=2) is False  # sigue abajo
