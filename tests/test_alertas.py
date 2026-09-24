"""Tests de scripts/alertas.py: eventos nuevos vs. estado anterior, dedupe, y
que nunca lanza si faltan credenciales de Telegram (main() tiene que devolver
0 siempre, es un job de CI que no puede fallar por esto)."""

import json

import pytest

import alertas


def _senales(vcp=None, ema200_semanal=None, ema200_diario_cruce=None, rsi_alcista=None):
    return {
        "actualizado": "2026-09-24T10:00:00-03:00",
        "ema200": {
            "diario": {"rebote": [], "cruce": ema200_diario_cruce or []},
            "semanal": {"rebote": (ema200_semanal or {}).get("rebote", []), "cruce": (ema200_semanal or {}).get("cruce", [])},
        },
        "vcp": vcp or [],
        "rsi_semanal": {"alcista": rsi_alcista or [], "bajista": []},
    }


def _warren(*filas):
    return {"actualizado": "2026-09-24T10:00:00-03:00", "tickers": list(filas)}


def _ticker_warren(t, score, **extra):
    return {"ticker": t, "nombre": t, "total_score": score, "datos_suficientes": True, **extra}


def _listado(*filas):
    return {"actualizado": "2026-09-24T10:00:00-03:00", "acciones": list(filas)}


@pytest.fixture
def datos_base():
    return {
        "senales": _senales(),
        "warren": _warren(),
        "listado": _listado(),
        "medias": [],
    }


def _estado_vacio():
    return {k: (dict(v) if isinstance(v, dict) else list(v)) for k, v in alertas.ESTADO_VACIO.items()}


class TestVCP:
    def test_base_recien_rompio_es_evento_nuevo(self, datos_base):
        datos_base["senales"]["vcp"] = [{"ticker": "AAPL", "estado": "Recién rompió", "score": 90, "contracciones": 3, "pivote": 100}]
        eventos, estado = alertas.calcular_eventos(datos_base, _estado_vacio(), {"tickers": []})
        assert len(eventos) == 1 and eventos[0]["ticker"] == "AAPL" and eventos[0]["tipo"] == "VCP"
        assert estado["vcp"] == {"AAPL": "Recién rompió"}

    def test_mismo_estado_no_se_repite(self, datos_base):
        datos_base["senales"]["vcp"] = [{"ticker": "AAPL", "estado": "Armado", "score": 90, "contracciones": 3, "pivote": 100}]
        prev = _estado_vacio()
        prev["vcp"] = {"AAPL": "Armado"}
        eventos, _ = alertas.calcular_eventos(datos_base, prev, {"tickers": []})
        assert eventos == []

    def test_estado_no_avisable_no_genera_evento(self, datos_base):
        datos_base["senales"]["vcp"] = [{"ticker": "AAPL", "estado": "Formándose", "score": 50, "contracciones": 1, "pivote": 100}]
        eventos, _ = alertas.calcular_eventos(datos_base, _estado_vacio(), {"tickers": []})
        assert eventos == []


class TestWarren:
    def test_entra_al_podio(self, datos_base):
        datos_base["warren"] = _warren(_ticker_warren("A", 90), _ticker_warren("B", 80), _ticker_warren("C", 70))
        eventos, estado = alertas.calcular_eventos(datos_base, _estado_vacio(), {"tickers": []})
        tickers = {e["ticker"] for e in eventos if e["tipo"] == "Warren Score"}
        assert {"A", "B", "C"} <= tickers
        assert estado["warren_podium"] == ["A", "B", "C"]

    def test_ya_en_podio_no_se_repite(self, datos_base):
        datos_base["warren"] = _warren(_ticker_warren("A", 90), _ticker_warren("B", 80))
        prev = _estado_vacio()
        prev["warren_podium"] = ["A", "B"]
        eventos, _ = alertas.calcular_eventos(datos_base, prev, {"tickers": []})
        assert eventos == []

    def test_cruza_80_sin_estar_en_podio(self, datos_base):
        datos_base["warren"] = _warren(
            _ticker_warren("A", 95), _ticker_warren("B", 90), _ticker_warren("C", 85), _ticker_warren("D", 81),
        )
        prev = _estado_vacio()
        prev["warren_podium"] = ["A", "B", "C"]
        eventos, estado = alertas.calcular_eventos(datos_base, prev, {"tickers": []})
        assert any(e["ticker"] == "D" for e in eventos)
        assert estado["warren_alto"] == ["A", "B", "C", "D"]

    def test_debajo_de_80_no_genera_evento(self, datos_base):
        # 4 tickers para que "A" no entre trivialmente al podio (top 3).
        datos_base["warren"] = _warren(
            _ticker_warren("X", 60), _ticker_warren("Y", 55), _ticker_warren("Z", 50), _ticker_warren("A", 45),
        )
        prev = _estado_vacio()
        prev["warren_podium"] = ["X", "Y", "Z"]
        eventos, _ = alertas.calcular_eventos(datos_base, prev, {"tickers": []})
        assert eventos == []


class TestEMA200Semanal:
    def test_evento_nuevo_por_fecha(self, datos_base):
        datos_base["senales"]["ema200"]["semanal"]["cruce"] = [
            {"ticker": "MSFT", "fecha": "2026-09-18", "dist_ema_pct": 5.0, "rs_hoy": 80.0}
        ]
        eventos, estado = alertas.calcular_eventos(datos_base, _estado_vacio(), {"tickers": []})
        assert len(eventos) == 1 and eventos[0]["ticker"] == "MSFT"
        assert estado["ema200_semanal"] == {"MSFT|cruce": "2026-09-18"}

    def test_mismo_evento_mas_dias_despues_no_se_repite(self, datos_base):
        datos_base["senales"]["ema200"]["semanal"]["cruce"] = [
            {"ticker": "MSFT", "fecha": "2026-09-18", "dist_ema_pct": 8.0, "rs_hoy": 82.0}
        ]
        prev = _estado_vacio()
        prev["ema200_semanal"] = {"MSFT|cruce": "2026-09-18"}
        eventos, _ = alertas.calcular_eventos(datos_base, prev, {"tickers": []})
        assert eventos == []

    def test_nueva_fecha_es_evento_nuevo(self, datos_base):
        datos_base["senales"]["ema200"]["semanal"]["rebote"] = [
            {"ticker": "MSFT", "fecha": "2026-09-25", "dist_ema_pct": 2.0, "rs_hoy": 60.0}
        ]
        prev = _estado_vacio()
        prev["ema200_semanal"] = {"MSFT|rebote": "2026-09-18"}
        eventos, estado = alertas.calcular_eventos(datos_base, prev, {"tickers": []})
        assert len(eventos) == 1
        assert estado["ema200_semanal"] == {"MSFT|rebote": "2026-09-25"}


class TestRSISemanal:
    def test_cruce_alcista_con_rs_alto_es_evento(self, datos_base):
        datos_base["senales"]["rsi_semanal"]["alcista"] = [
            {"ticker": "NVDA", "fecha": "2026-09-25", "rsi": 60.0, "sma14": 55.0, "rs": 90.0}
        ]
        eventos, _ = alertas.calcular_eventos(datos_base, _estado_vacio(), {"tickers": []})
        assert len(eventos) == 1 and eventos[0]["ticker"] == "NVDA"

    def test_rs_bajo_no_genera_evento(self, datos_base):
        datos_base["senales"]["rsi_semanal"]["alcista"] = [
            {"ticker": "NVDA", "fecha": "2026-09-25", "rsi": 60.0, "sma14": 55.0, "rs": 40.0}
        ]
        eventos, _ = alertas.calcular_eventos(datos_base, _estado_vacio(), {"tickers": []})
        assert eventos == []


class TestWatchlist:
    def test_sin_config_no_hay_eventos_de_watchlist(self, datos_base):
        datos_base["senales"]["ema200"]["diario"]["cruce"] = [{"ticker": "TSLA", "fecha": "2026-09-24", "dist_ema_pct": 1.0}]
        datos_base["listado"] = _listado({"ticker": "TSLA", "var_pct": 8.0})
        eventos, _ = alertas.calcular_eventos(datos_base, _estado_vacio(), {"tickers": []})
        assert eventos == []

    def test_cruce_diario_de_ticker_en_watchlist(self, datos_base):
        datos_base["senales"]["ema200"]["diario"]["cruce"] = [
            {"ticker": "TSLA", "fecha": "2026-09-24", "dist_ema_pct": 1.0},
            {"ticker": "OTRO", "fecha": "2026-09-24", "dist_ema_pct": 1.0},
        ]
        eventos, estado = alertas.calcular_eventos(datos_base, _estado_vacio(), {"tickers": ["TSLA"]})
        assert len(eventos) == 1 and eventos[0]["ticker"] == "TSLA"
        assert estado["ema200_diario"] == {"TSLA": "2026-09-24"}

    def test_movimiento_diario_mayor_a_5_en_watchlist(self, datos_base):
        datos_base["listado"] = _listado({"ticker": "TSLA", "var_pct": -6.5}, {"ticker": "OTRO", "var_pct": 9.0})
        eventos, estado = alertas.calcular_eventos(datos_base, _estado_vacio(), {"tickers": ["TSLA"]})
        assert len(eventos) == 1 and eventos[0]["ticker"] == "TSLA" and "-6.5%" in eventos[0]["texto"]
        assert "TSLA" in estado["watchlist_var"]

    def test_mismo_dia_no_se_repite(self, datos_base):
        datos_base["listado"] = _listado({"ticker": "TSLA", "var_pct": -6.5})
        datos_base["listado"]["actualizado"] = "2026-09-24T10:00:00-03:00"
        prev = _estado_vacio()
        prev["watchlist_var"] = {"TSLA": "2026-09-24"}
        eventos, _ = alertas.calcular_eventos(datos_base, prev, {"tickers": ["TSLA"]})
        assert eventos == []

    def test_movimiento_menor_a_5_no_genera_evento(self, datos_base):
        datos_base["listado"] = _listado({"ticker": "TSLA", "var_pct": 2.0})
        eventos, _ = alertas.calcular_eventos(datos_base, _estado_vacio(), {"tickers": ["TSLA"]})
        assert eventos == []


class TestMensaje:
    def test_sin_eventos_da_none(self):
        assert alertas.armar_mensaje([]) is None

    def test_con_eventos_incluye_ticker_y_link(self):
        msg = alertas.armar_mensaje([{"tipo": "VCP", "ticker": "AAPL", "texto": "algo pasó"}])
        assert "AAPL" in msg and "algo pasó" in msg
        assert "https://facubelini.github.io/stock-lens/#/ticker/AAPL" in msg

    def test_respeta_el_limite_de_telegram(self):
        eventos = [{"tipo": "VCP", "ticker": f"T{i}", "texto": "x" * 200} for i in range(50)]
        msg = alertas.armar_mensaje(eventos)
        from monitoreo.telegram import _partir
        partes = _partir(msg)
        assert all(len(p) <= 4096 for p in partes)
        assert len(partes) > 1


class TestCLI:
    def test_dry_run_no_requiere_credenciales(self, tmp_path, capsys, monkeypatch):
        monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
        monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
        carpeta = tmp_path / "public_data"
        carpeta.mkdir()
        (carpeta / "senales.json").write_text(json.dumps(_senales(vcp=[
            {"ticker": "AAPL", "estado": "Armado", "score": 90, "contracciones": 2, "pivote": 100}
        ])), encoding="utf-8")
        (carpeta / "warren_score.json").write_text(json.dumps(_warren()), encoding="utf-8")
        (carpeta / "listado.json").write_text(json.dumps(_listado()), encoding="utf-8")
        (carpeta / "medias.json").write_text("[]", encoding="utf-8")
        codigo = alertas.main([
            "--data", str(carpeta), "--estado", str(tmp_path / "estado.json"),
            "--config", str(tmp_path / "config.json"), "--dry-run",
        ])
        assert codigo == 0
        assert "AAPL" in capsys.readouterr().out
        assert not (tmp_path / "estado.json").exists()  # dry-run no persiste

    def test_sin_credenciales_sale_0_y_no_manda_nada(self, tmp_path, capsys, monkeypatch):
        monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
        monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
        codigo = alertas.main(["--data", str(tmp_path), "--estado", str(tmp_path / "estado.json")])
        assert codigo == 0
        assert "no se manda nada" in capsys.readouterr().out.lower() or "faltan" in capsys.readouterr().out.lower()

    def test_con_credenciales_pero_sin_eventos_persiste_estado_y_sale_0(self, tmp_path, monkeypatch):
        monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "x")
        monkeypatch.setenv("TELEGRAM_CHAT_ID", "y")
        carpeta = tmp_path / "public_data"
        carpeta.mkdir()
        for nombre, contenido in (
            ("senales.json", _senales()), ("warren_score.json", _warren()),
            ("listado.json", _listado()), ("medias.json", []),
        ):
            (carpeta / nombre).write_text(json.dumps(contenido), encoding="utf-8")
        codigo = alertas.main(["--data", str(carpeta), "--estado", str(tmp_path / "estado.json")])
        assert codigo == 0
        assert json.loads((tmp_path / "estado.json").read_text(encoding="utf-8"))
