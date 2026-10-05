"""'Desde cuando cumple': rachas desde historial, log de estado y embudo."""

import pandas as pd

from pipeline.compra_desde import (
    actualizar_estado,
    FILTROS_CANDIDATOS,
    candidatos_hoy,
    construir,
    precio_en,
    rachas_desde_historial,
)


def _scr(**tfs):
    return {tf: {"verdict": v} for tf, v in tfs.items()}


def test_racha_camina_hacia_atras_y_corta_en_el_ultimo_hueco():
    hist = [
        {"fecha": "2026-07-01", "tickers": {"A": {"diario": "COMPRA"}}},
        {"fecha": "2026-07-02", "tickers": {"A": {"diario": "NEUTRAL"}}},
        {"fecha": "2026-07-03", "tickers": {"A": {"diario": "CERCA"}}},
        {"fecha": "2026-07-04", "tickers": {"A": {"diario": "COMPRA"}}},
    ]
    r, inicio = rachas_desde_historial(hist, lambda e, t: e["tickers"][t]["diario"] in ("COMPRA", "CERCA"))
    assert inicio == "2026-07-01"
    assert r["A"] == {"desde": "2026-07-03", "aprox": False}


def test_racha_que_llega_al_inicio_del_historial_es_aproximada():
    hist = [{"fecha": "2026-07-01", "tickers": {"A": 1}}, {"fecha": "2026-07-02", "tickers": {"A": 1}}]
    r, _ = rachas_desde_historial(hist, lambda e, t: t in e["tickers"])
    assert r["A"] == {"desde": "2026-07-01", "aprox": True}


def test_racha_ignora_a_los_que_no_cumplen_en_la_ultima_entrada():
    hist = [{"fecha": "2026-07-01", "tickers": {"A": 1}}, {"fecha": "2026-07-02", "tickers": {}}]
    assert rachas_desde_historial(hist, lambda e, t: t in e["tickers"])[0] == {}


def test_estado_conserva_fecha_agrega_nuevos_y_descarta_los_que_salen():
    prev = {"vcp": {"inicio": "2026-09-01", "tickers": {"A": {"desde": "2026-09-01", "precio": 10.0}, "B": {"desde": "2026-09-02", "precio": 5.0}}}}
    nuevo = actualizar_estado(prev, {"vcp": {"A", "C"}, "warren_80": {"A"}}, {"A": 12.0, "C": 7.0}, "2026-09-10")
    assert nuevo["vcp"]["inicio"] == "2026-09-01"
    assert nuevo["vcp"]["tickers"] == {"A": {"desde": "2026-09-01", "precio": 10.0}, "C": {"desde": "2026-09-10", "precio": 7.0}}
    assert nuevo["warren_80"]["inicio"] == "2026-09-10"  # clave nueva: empieza el registro hoy


def test_si_vuelve_a_cumplir_arranca_una_racha_nueva():
    s1 = actualizar_estado({}, {"vcp": {"A"}}, {"A": 10.0}, "2026-09-01")
    s2 = actualizar_estado(s1, {"vcp": set()}, {}, "2026-09-02")
    s3 = actualizar_estado(s2, {"vcp": {"A"}}, {"A": 11.0}, "2026-09-03")
    assert s3["vcp"]["tickers"]["A"] == {"desde": "2026-09-03", "precio": 11.0}


def test_precio_en_usa_el_ultimo_cierre_en_o_antes_de_la_fecha():
    c = pd.Series([1.0, 2.0, 3.0], index=pd.to_datetime(["2026-09-01", "2026-09-02", "2026-09-04"]))
    assert precio_en(c, "2026-09-03") == 2.0
    assert precio_en(c, "2026-09-04") == 3.0
    assert precio_en(c, "2026-08-01") is None
    assert precio_en(None, "2026-09-04") is None


def test_construir_marca_aprox_en_el_inicio_del_registro_y_trae_precio_de_hoy():
    estado = {"vcp": {"inicio": "2026-09-01", "tickers": {"A": {"desde": "2026-09-01", "precio": 10.0}, "B": {"desde": "2026-09-05", "precio": 4.0}}}}
    hist_scr = [
        {"fecha": "2026-09-01", "tickers": {"A": {"diario": "NEUTRAL"}}},
        {"fecha": "2026-09-02", "tickers": {"A": {"diario": "COMPRA"}}},
    ]
    closes = {"A": pd.Series([9.0, 10.0], index=pd.to_datetime(["2026-09-01", "2026-09-02"]))}
    out = construir(estado, hist_scr, [{"fecha": "2026-09-02", "tickers": ["A"]}], closes, {"A": 12.0, "B": 5.0}, "x")
    vcp = out["claves"]["vcp"]["tickers"]
    assert vcp["A"]["aprox"] is True and vcp["B"]["aprox"] is False and vcp["B"]["precio_hoy"] == 5.0
    d = out["claves"]["screener_diario"]["tickers"]["A"]
    assert d == {"desde": "2026-09-02", "precio": 10.0, "aprox": False, "precio_hoy": 12.0}
    assert out["claves"]["oportunidades"]["tickers"]["A"]["aprox"] is True


def _warren(t, f=20, c=20, flags=(), caps=()):
    return {
        "ticker": t, "datos_suficientes": True, "total_score": 80.0, "caps": list(caps),
        "pilares": {"fuerza": {"pts": f, "max": 30}, "contraccion": {"pts": c, "max": 30}},
        "penalizacion": {"flags": [{"clave": k} for k in flags]},
    }


def test_embudo_por_defecto_pasa_solo_quien_cumple_las_cinco_etapas():
    warren = [_warren("OK"), _warren("DEBIL", f=10), _warren("DIST", flags=["distribucion"]), _warren("GATE", caps=["gate_ema200"]),
              _warren("SINROT"), _warren("SINGAT"), _warren("VENTA")]
    senales = {"vcp": [{"ticker": t, "estado": "Armado"} for t in ("OK", "DEBIL", "DIST", "GATE", "SINROT", "VENTA")], "ema200": {}, "rsi_semanal": {}}
    rotacion = {"acciones": [{"ticker": t, "cuadrante": "liderando"} for t in ("OK", "DEBIL", "DIST", "GATE", "SINGAT", "VENTA")]}
    screener = [{"ticker": t, **_scr(diario="COMPRA", semanal="CERCA", mensual="NEUTRAL")} for t in ("OK", "SINROT", "SINGAT")]
    screener.append({"ticker": "VENTA", **_scr(diario="COMPRA", semanal="CERCA", mensual="VENTA")})
    assert candidatos_hoy(warren, senales, screener, rotacion, FILTROS_CANDIDATOS["candidato"]) == {"OK"}


def test_embudo_acepta_recien_llegado_a_lideres_y_ema200_dentro_de_la_ventana():
    warren = [_warren("A"), _warren("B")]
    senales = {"vcp": [], "ema200": {"diario": {"rebote": [{"ticker": "A", "hace": 10}], "cruce": []}, "semanal": {"rebote": [{"ticker": "B", "hace": 5}], "cruce": []}}, "rsi_semanal": {}}
    rotacion = {"acciones": [], "recien_a_lideres": ["A", "B"]}
    screener = [{"ticker": t, **_scr(diario="COMPRA", semanal="COMPRA")} for t in ("A", "B")]
    assert candidatos_hoy(warren, senales, screener, rotacion, FILTROS_CANDIDATOS["candidato"]) == {"A"}  # B: rebote semanal hace 5 > 4


def test_embudo_laxo_suma_recuperando_y_no_exige_sin_venta():
    warren = [_warren("A", f=10, c=8)]
    senales = {"vcp": [{"ticker": "A", "estado": "Armado"}], "ema200": {}, "rsi_semanal": {}}
    rotacion = {"acciones": [{"ticker": "A", "cuadrante": "recuperando"}]}
    screener = [{"ticker": "A", **_scr(diario="COMPRA", semanal="VENTA")}]
    assert candidatos_hoy(warren, senales, screener, rotacion, FILTROS_CANDIDATOS["candidato"]) == set()
    assert candidatos_hoy(warren, senales, screener, rotacion, FILTROS_CANDIDATOS["candidato_laxo"]) == {"A"}
