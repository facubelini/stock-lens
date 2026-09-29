"""Deteccion y ciclo de vida de las 4 figuras chartistas (scripts/pipeline/
figuras.py) sobre OHLC sintetico: geometria clara de cada figura + su
transicion de estado al romper la neckline, y que una serie sin figura
(ruido puro) no dispare score alto."""

import numpy as np
import pytest

from comun import atr_serie
from conftest import ohlcv, tramos
from pipeline.figuras import FG_SCORE_MIN, TIPOS, _detectar_doble, _detectar_hch, fg_ciclo

LEAD = tramos(60, (40, 70))[:-1]  # relleno de calentamiento (>= FG_MIN_RUEDAS antes de la figura)


def _ciclo(tipo, cierres, rango_pct=0.3):
    df = ohlcv(cierres, rango_pct=rango_pct)
    atr_pct = atr_serie(df["High"], df["Low"], df["Close"], 14) / df["Close"] * 100
    return fg_ciclo(tipo, df, atr_pct)


# --- Doble Techo: 100 -> 80 -> 99.5 (tops a <1% de diferencia, valle 20% abajo) ---
DOBLE_TECHO = LEAD + tramos(70, (30, 100), (15, 80), (15, 99.5))
DT_COLA = tramos(99.5, (10, 90))[1:]  # se aleja del segundo techo sin romper
DT_ROTURA = tramos(90, (5, 74))[1:]  # rompe la neckline (80)
DT_SEGUIMIENTO = tramos(74, (4, 68))[1:]
DT_FALLA = tramos(74, (4, 84))[1:]  # vuelve >3% arriba de la neckline: ruptura fallida


def test_doble_techo_formandose():
    hoy, ciclo = _ciclo("doble_techo", DOBLE_TECHO)
    assert ciclo["estado"] == "Formándose"
    assert 0 <= ciclo["score"] <= 100
    assert ciclo["detalle"]["neckline_precio"] == pytest.approx(80, abs=1)


def test_doble_techo_recien_rompio():
    hoy, ciclo = _ciclo("doble_techo", DOBLE_TECHO + DT_COLA + tramos(90, (1, 74))[1:])
    assert ciclo["estado"] == "Recién rompió"


def test_doble_techo_rompio_y_confirmo():
    hoy, ciclo = _ciclo("doble_techo", DOBLE_TECHO + DT_COLA + DT_ROTURA + DT_SEGUIMIENTO)
    assert ciclo["estado"] == "Rompió y confirmó"


def test_doble_techo_rompio_y_fallo():
    hoy, ciclo = _ciclo("doble_techo", DOBLE_TECHO + DT_COLA + DT_ROTURA + DT_FALLA)
    assert ciclo["estado"] == "Rompió y falló"


def test_doble_techo_fallo_antes_de_romper():
    # supera el segundo techo (99.5) antes de perforar la neckline (80): la figura se invalida
    supera = tramos(99.5, (6, 106))[1:]
    hoy, ciclo = _ciclo("doble_techo", DOBLE_TECHO + supera)
    assert ciclo["estado"] == "Falló antes de romper"


def test_doble_techo_asimetrico_no_detecta():
    # segundo techo 10% mas alto que el primero: no pasa la tolerancia de simetria (3%)
    asimetrico = LEAD + tramos(70, (30, 100), (15, 80), (15, 111))
    df = ohlcv(asimetrico, rango_pct=0.3)
    atr_pct = atr_serie(df["High"], df["Low"], df["Close"], 14) / df["Close"] * 100
    assert _detectar_doble(df, float(atr_pct.iloc[-1]), True)["detectado"] is False


# --- Doble Piso: espejo (40 -> 60 -> 40.5) ---
DOBLE_PISO = LEAD + tramos(70, (30, 40), (15, 60), (15, 40.5))


def test_doble_piso_formandose_y_rompe():
    hoy, ciclo = _ciclo("doble_piso", DOBLE_PISO)
    assert ciclo["estado"] == "Formándose"
    cola = tramos(40.5, (10, 50))[1:]
    rotura = tramos(50, (5, 64))[1:]
    seguimiento = tramos(64, (4, 70))[1:]
    hoy2, ciclo2 = _ciclo("doble_piso", DOBLE_PISO + cola + rotura + seguimiento)
    assert ciclo2["estado"] == "Rompió y confirmó"


# --- HCH: hombro 90 / cabeza 110 / hombro 91, neckline en 75-76 ---
LEAD_HCH = tramos(60, (40, 75))[:-1]
HCH = LEAD_HCH + tramos(75, (20, 90), (10, 75), (15, 110), (15, 76), (10, 91))


def test_hch_formandose():
    hoy, ciclo = _ciclo("hch", HCH)
    assert ciclo["estado"] == "Formándose"
    assert ciclo["detalle"]["simetria_pct"] < 5


def test_hch_rompe_y_confirma():
    cola = tramos(91, (8, 82))[1:]
    rotura = tramos(82, (5, 68))[1:]
    seguimiento = tramos(68, (4, 60))[1:]
    hoy, ciclo = _ciclo("hch", HCH + cola + rotura + seguimiento)
    assert ciclo["estado"] == "Rompió y confirmó"


def test_hch_hombros_asimetricos_no_detecta():
    asimetrico = LEAD_HCH + tramos(75, (20, 90), (10, 75), (15, 110), (15, 76), (10, 103))
    df = ohlcv(asimetrico, rango_pct=0.3)
    atr_pct = atr_serie(df["High"], df["Low"], df["Close"], 14) / df["Close"] * 100
    assert _detectar_hch(df, float(atr_pct.iloc[-1]), True)["detectado"] is False


# --- HCH invertido: espejo (hombro 95 / cabeza 60 / hombro 94, neckline 119-120) ---
LEAD_HCHI = tramos(60, (40, 110))[:-1]
HCH_INV = LEAD_HCHI + tramos(110, (20, 95), (10, 120), (15, 60), (15, 119), (10, 94))


def test_hch_invertido_formandose():
    hoy, ciclo = _ciclo("hch_invertido", HCH_INV)
    assert ciclo["estado"] == "Formándose"


def test_hch_con_historial_largo_neckline_no_explota():
    # Regresion: 'sub' (la ventana de FG_VENTANA ruedas) es una COLA de 'df'
    # completo; si las posiciones de los swings de la neckline no se
    # convierten a absolutas antes de guardarlas, _ciclo() las extrapola
    # como si el desplazamiento fuera 0 y el nivel "de hoy" explota (con
    # 5 años de historial, un ticker real dio una neckline_precio_hoy
    # negativa). Un relleno largo ANTES de la figura tiene que dar
    # practicamente el mismo resultado que sin relleno.
    relleno_largo = tramos(60, (600, 60))[:-1]  # >> FG_VENTANA, simula 5 años de historia previa (plano en 60)
    con_relleno = relleno_largo + HCH
    hoy, ciclo = _ciclo("hch", con_relleno)
    assert ciclo["estado"] == "Formándose"
    nivel = ciclo["detalle"]["neckline_precio"]
    assert ciclo["neckline_precio_hoy"] == pytest.approx(nivel, rel=0.15)
    assert -50 <= ciclo["dist_neckline_pct"] <= 50


def test_score_en_rango_0_100_para_todos_los_tipos():
    for tipo, serie in (
        ("doble_techo", DOBLE_TECHO), ("doble_piso", DOBLE_PISO),
        ("hch", HCH), ("hch_invertido", HCH_INV),
    ):
        _, ciclo = _ciclo(tipo, serie)
        assert ciclo is not None
        assert 0 <= ciclo["score"] <= 100


def test_ruido_puro_no_supera_el_umbral_de_publicacion():
    """Una caminata aleatoria puede, por azar, dejar que el ZigZag arme una
    secuencia H-L-H o H-L-H-L-H que pase la geometria minima (igual que
    cualquier heuristica de figuras chartistas sobre precios reales) — lo que
    no puede pasar casi nunca es que el SCORE supere el umbral de publicacion
    (FG_SCORE_MIN): eso mediria ademas simetria ajustada, profundidad en
    ATR y volumen a favor, todo alineado por casualidad."""
    con_score_alto = 0
    total = 0
    for semilla in range(20):
        rng = np.random.default_rng(semilla)
        precios = 100 * np.exp(np.cumsum(rng.normal(0, 0.012, 200)))
        vol = rng.uniform(5e5, 2e6, 200)
        df = ohlcv(precios, volumen=vol)
        atr_pct = atr_serie(df["High"], df["Low"], df["Close"], 14) / df["Close"] * 100
        for tipo in TIPOS:
            total += 1
            _, ciclo = fg_ciclo(tipo, df, atr_pct)
            if ciclo and ciclo["estado"] is not None and ciclo["score"] >= FG_SCORE_MIN:
                con_score_alto += 1
    assert con_score_alto / total < 0.15  # menos del 15% de las series de ruido "pasarian" el filtro de publicacion
