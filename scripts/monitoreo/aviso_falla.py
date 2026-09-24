"""CLI chiquito para mandar un aviso de Telegram desde un step de workflow
(".github/workflows/_monitoreo-falla.yml"): arma el texto y llama a
enviar_telegram. Si faltan las credenciales, no hace nada y sale 0 (el issue
de GitHub ya se creo/comento en el paso anterior; esto es un canal extra)."""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from monitoreo.telegram import enviar_telegram, hay_credenciales  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--titulo", required=True)
    ap.add_argument("--detalle", default="")
    ap.add_argument("--url", required=True)
    args = ap.parse_args(argv)

    if not hay_credenciales():
        print("aviso_falla: faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, no se manda nada.")
        return 0

    texto = f"<b>{args.titulo}</b>\n{args.detalle}\n<a href=\"{args.url}\">Ver la corrida</a>"
    if enviar_telegram(texto):
        print("aviso_falla: mandado por Telegram.")
    else:
        print("::warning::aviso_falla: fallo el envio por Telegram.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
