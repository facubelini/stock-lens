"""Chequeo de "staleness": hace cuanto corrio el pipeline por ultima vez
(meta.json de la rama `datos`) vs. el umbral segun el dia (26h entre semana,
74h el fin de semana — el mercado no opera, asi que un viernes a la tarde sin
corridas hasta el lunes es normal). Mismo criterio que
src/lib/frescura.js (banner de la app); se evalua en hora de Argentina.

Uso: python scripts/monitoreo/chequeo_frescura.py [ruta/a/meta.json]
Sale 0 si esta fresco, 1 si esta desactualizado (para que el workflow decida
si abre un issue / manda Telegram)."""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Argentina/Buenos_Aires")
UMBRAL_HORAS_SEMANA = 26
UMBRAL_HORAS_FIN_DE_SEMANA = 74


def es_fin_de_semana(ahora):
    return ahora.astimezone(TZ).weekday() >= 5  # 5=sabado, 6=domingo


def umbral_horas(ahora):
    return UMBRAL_HORAS_FIN_DE_SEMANA if es_fin_de_semana(ahora) else UMBRAL_HORAS_SEMANA


def horas_desde(iso, ahora):
    return (ahora - datetime.fromisoformat(iso)).total_seconds() / 3600


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("meta", nargs="?", default="public/data/meta.json", type=Path)
    args = ap.parse_args(argv)

    if not args.meta.exists():
        print(f"::error::{args.meta}: no existe (¿todavía no se migró a la rama datos?).")
        return 1

    meta = json.loads(args.meta.read_text(encoding="utf-8"))
    ts = meta.get("ultima_actualizacion")
    if not ts:
        print("::error::meta.json no tiene 'ultima_actualizacion'.")
        return 1

    ahora = datetime.now(TZ)
    horas = horas_desde(ts, ahora)
    umbral = umbral_horas(ahora)

    if horas > umbral:
        print(f"DESACTUALIZADO: última corrida hace {horas:.1f}h (umbral {umbral}h, "
              f"{'fin de semana' if es_fin_de_semana(ahora) else 'día hábil'}).")
        return 1
    print(f"OK: última corrida hace {horas:.1f}h (umbral {umbral}h).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
