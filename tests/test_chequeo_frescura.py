"""Tests de scripts/monitoreo/chequeo_frescura.py: mismo criterio que
tests/js/frescura.test.js (26h semana / 74h fin de semana), del lado Python."""

import json
from datetime import datetime
from zoneinfo import ZoneInfo

import time_machine

from monitoreo import chequeo_frescura as cf

TZ = ZoneInfo("America/Argentina/Buenos_Aires")


def _meta(tmp_path, iso):
    ruta = tmp_path / "meta.json"
    ruta.write_text(json.dumps({"ultima_actualizacion": iso}), encoding="utf-8")
    return ruta


def test_fresco_en_semana(tmp_path):
    with time_machine.travel(datetime(2026, 9, 22, 12, 0, tzinfo=TZ)):  # martes
        ruta = _meta(tmp_path, datetime(2026, 9, 22, 0, 0, tzinfo=TZ).isoformat())  # 12h antes
        assert cf.main([str(ruta)]) == 0


def test_desactualizado_en_semana_27h(tmp_path):
    with time_machine.travel(datetime(2026, 9, 22, 12, 0, tzinfo=TZ)):  # martes
        ruta = _meta(tmp_path, datetime(2026, 9, 21, 9, 0, tzinfo=TZ).isoformat())  # 27h antes
        assert cf.main([str(ruta)]) == 1


def test_fresco_fin_de_semana_30h(tmp_path):
    with time_machine.travel(datetime(2026, 9, 20, 12, 0, tzinfo=TZ)):  # domingo
        ruta = _meta(tmp_path, datetime(2026, 9, 19, 6, 0, tzinfo=TZ).isoformat())  # 30h antes
        assert cf.main([str(ruta)]) == 0


def test_desactualizado_fin_de_semana_75h(tmp_path):
    with time_machine.travel(datetime(2026, 9, 20, 12, 0, tzinfo=TZ)):  # domingo
        ruta = _meta(tmp_path, datetime(2026, 9, 17, 9, 0, tzinfo=TZ).isoformat())  # 75h antes
        assert cf.main([str(ruta)]) == 1


def test_archivo_faltante_es_error(tmp_path):
    assert cf.main([str(tmp_path / "no-existe.json")]) == 1


def test_sin_ultima_actualizacion_es_error(tmp_path):
    ruta = tmp_path / "meta.json"
    ruta.write_text("{}", encoding="utf-8")
    assert cf.main([str(ruta)]) == 1
