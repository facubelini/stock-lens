"""scripts/validar_datos.py: la salida real del pipeline (golden, esc1) pasa
y cada tipo de dato roto se detecta con un mensaje claro."""

import json
from pathlib import Path

import pytest

import grabacion
import validar_datos


@pytest.fixture(scope="module")
def salida_golden():
    return grabacion.cargar_salida()


@pytest.fixture
def carpeta(tmp_path, salida_golden):
    """public/data de la corrida golden esc1 escrita en disco."""
    for k, texto in salida_golden.items():
        if k.startswith("esc1/out/"):
            ruta = tmp_path / k[len("esc1/out/"):]
            ruta.parent.mkdir(parents=True, exist_ok=True)
            ruta.write_text(texto, encoding="utf-8")
    return tmp_path


def _editar(carpeta, nombre, fn):
    ruta = Path(carpeta) / nombre
    d = json.loads(ruta.read_text(encoding="utf-8"))
    fn(d)  # edita en el lugar
    ruta.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")


def _errores(carpeta, **kw):
    return validar_datos.validar(carpeta, **kw).errores


def test_salida_real_pasa(carpeta):
    v = validar_datos.validar(carpeta, meta_previo={"n_frescos": 18})
    assert v.errores == []


def test_nan_en_cualquier_json(carpeta):
    (carpeta / "historial" / "AAPL.json").write_text('[{"fecha": "2026-09-23", "diario": NaN}]', encoding="utf-8")
    [e] = _errores(carpeta)
    assert "historial/AAPL.json" in e and "NaN" in e


def test_rsi_fuera_de_rango(carpeta):
    _editar(carpeta, "listado.json", lambda d: d["acciones"][0].update(rsi=130.5))
    [e] = _errores(carpeta)
    assert "rsi = 130.5 fuera de rango [0, 100]" in e and "(NVDA)" in e


def test_campo_obligatorio_faltante(carpeta):
    _editar(carpeta, "medias.json", lambda d: d[1].pop("dist_sma200"))
    [e] = _errores(carpeta)
    assert "medias.json[1] (AAPL): faltan campos ['dist_sma200']" in e


def test_pilar_sobre_su_maximo_y_total_score(carpeta):
    def romper(d):
        d["tickers"][0]["pilares"]["contraccion"]["pts"] = 36.0
        d["tickers"][1]["total_score"] = 101.0

    _editar(carpeta, "warren_score.json", romper)
    errores = _errores(carpeta)
    assert any("pilares.contraccion.pts = 36.0 fuera de rango [0, 35]" in e for e in errores)
    assert any("total_score = 101.0" in e for e in errores)


@pytest.mark.parametrize("campo, valor, texto", [
    ("dividend_yield", 30.0, "dividend_yield = 30.0 fuera de rango [0, 25.0]"),
    ("market_cap_usd", -5, "market_cap_usd = -5"),
])
def test_rangos_de_fundamentales(carpeta, campo, valor, texto):
    _editar(carpeta, "fundamentales.json", lambda d: d[0].update({campo: valor}))
    assert any(texto in e for e in _errores(carpeta))


def test_var_pct_absurdo_es_solo_aviso(carpeta):
    # |var_pct| > 60 es real (splits, noticias fuertes): no bloquea el commit.
    _editar(carpeta, "listado.json", lambda d: d["acciones"][2].update(var_pct=-75.0))
    v = validar_datos.validar(carpeta)
    assert v.errores == []
    assert any("var_pct = -75.0" in a and "fuera del rango habitual" in a for a in v.avisos)


def test_var_pct_no_numerico_sigue_siendo_error(carpeta):
    _editar(carpeta, "listado.json", lambda d: d["acciones"][2].update(var_pct="no-es-numero"))
    assert any("var_pct = 'no-es-numero' no es un numero valido" in e for e in _errores(carpeta))


def test_veredicto_desconocido(carpeta):
    _editar(carpeta, "screener.json", lambda d: d[0]["diario"].update(verdict="COMPRAR"))
    assert any("verdict = 'COMPRAR'" in e for e in _errores(carpeta))


def test_falta_archivo_por_ticker(carpeta):
    (carpeta / "mensual" / "KO.json").unlink()
    [e] = _errores(carpeta)
    assert e.startswith("mensual/: falta el archivo de 1 ticker(s)") and "KO" in e


def test_huerfano_es_solo_aviso(carpeta):
    (carpeta / "historial" / "VIEJO.json").write_text("[]", encoding="utf-8")
    v = validar_datos.validar(carpeta)
    assert v.errores == [] and any("VIEJO" in a for a in v.avisos)


def test_caida_de_frescos_contra_la_corrida_anterior(carpeta):
    assert _errores(carpeta, meta_previo={"n_frescos": 25}) == []  # 18 vs 25: cae 28%
    [e] = _errores(carpeta, meta_previo={"n_frescos": 26})  # 18 vs 26: cae 31%
    assert "n_frescos cayo de 26 a 18" in e


def test_meta_incoherente_con_el_listado(carpeta):
    _editar(carpeta, "meta.json", lambda d: d.update(n_tickers=99))
    assert any("n_tickers = 99 pero listado tiene 18" in e for e in _errores(carpeta))


def test_fila_stale_sin_timestamp(carpeta):
    _editar(carpeta, "listado.json", lambda d: d["acciones"][0].update(stale=True))
    errores = _errores(carpeta)
    assert any("fila stale sin 'actualizado'" in e for e in errores)


def test_falta_archivo_obligatorio(carpeta):
    (carpeta / "senales.json").unlink()
    assert "senales.json: falta el archivo" in _errores(carpeta)


def test_solo_valida_lo_pedido(carpeta):
    _editar(carpeta, "listado.json", lambda d: d["acciones"][0].update(rsi=500))
    assert _errores(carpeta, solo=["senales", "warren_score"]) == []
    assert "backtest_score.json: falta el archivo" in _errores(carpeta, solo=["backtest_score"])


def test_cli_exit_code(carpeta, capsys):
    assert validar_datos.main([str(carpeta), "--sin-previo"]) == 0
    _editar(carpeta, "listado.json", lambda d: d["acciones"][0].update(rsi=-1))
    assert validar_datos.main([str(carpeta), "--sin-previo"]) == 1
    assert "::error::" in capsys.readouterr().out


def test_carpeta_fundamental(carpeta):
    assert "fundamental/: falta la carpeta" in _errores(carpeta, solo=["fundamental"])
    assert _errores(carpeta) == []  # sin --solo la carpeta es opcional
    (carpeta / "fundamental").mkdir()
    (carpeta / "fundamental" / "AAPL.json").write_text('{"serie": [1, 2]}', encoding="utf-8")
    assert "fundamental/indice.json: falta o no parsea" in _errores(carpeta, solo=["fundamental"])
    (carpeta / "fundamental" / "indice.json").write_text(
        '{"actualizado": "2026-09-23", "tickers": [{"ticker": "AAPL", "disponible": true}]}', encoding="utf-8")
    assert _errores(carpeta, solo=["fundamental"]) == []
    (carpeta / "fundamental" / "AAPL.json").write_text('{"serie": [Infinity]}', encoding="utf-8")
    [e] = _errores(carpeta, solo=["fundamental"])
    assert "fundamental/AAPL.json" in e
