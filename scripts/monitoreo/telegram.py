"""Envio de mensajes por Telegram (Bot API), compartido por scripts/alertas.py
y por el aviso de falla de scripts/monitoreo/aviso_falla.py.

Nunca rompe el workflow que lo llama: si faltan las credenciales devuelve
False sin lanzar (el caller decide si eso es un "no hay nada configurado,
seguir" o un error). Solo usa `requests` (ya pineado en requirements.txt).
"""

import os

import requests

LARGO_MAX = 4096  # limite duro de Telegram por mensaje


def credenciales(token=None, chat_id=None):
    """(token, chat_id) resueltos desde los argumentos o el entorno. Alguno
    puede venir vacio si no esta configurado."""
    return (
        token if token is not None else os.environ.get("TELEGRAM_BOT_TOKEN", ""),
        chat_id if chat_id is not None else os.environ.get("TELEGRAM_CHAT_ID", ""),
    )


def hay_credenciales(token=None, chat_id=None):
    t, c = credenciales(token, chat_id)
    return bool(t.strip()) and bool(c.strip())


def _partir(texto, largo=LARGO_MAX):
    """Corta `texto` en partes <= largo, respetando saltos de linea cuando se
    puede (no corta una linea al medio si entra entera en la parte siguiente)."""
    if len(texto) <= largo:
        return [texto]
    partes, actual = [], ""
    for linea in texto.split("\n"):
        candidata = f"{actual}\n{linea}" if actual else linea
        if len(candidata) > largo:
            if actual:
                partes.append(actual)
            # la linea sola no entra ni vacia: se trocea a lo bruto
            while len(linea) > largo:
                partes.append(linea[:largo])
                linea = linea[largo:]
            actual = linea
        else:
            actual = candidata
    if actual:
        partes.append(actual)
    return partes


def enviar_telegram(texto, token=None, chat_id=None, timeout=15):
    """Manda `texto` (HTML) a Telegram, partiendo en varios mensajes si hace
    falta. Devuelve True si se mando todo OK, False si faltan credenciales o
    alguna parte fallo (no lanza: un fallo de Telegram no tiene que tirar
    abajo el workflow que llama)."""
    t, c = credenciales(token, chat_id)
    if not (t.strip() and c.strip()):
        return False
    ok = True
    for parte in _partir(texto):
        try:
            r = requests.post(
                f"https://api.telegram.org/bot{t}/sendMessage",
                json={"chat_id": c, "text": parte, "parse_mode": "HTML", "disable_web_page_preview": True},
                timeout=timeout,
            )
            if r.status_code != 200:
                print(f"Telegram: HTTP {r.status_code}: {r.text[:300]}")
                ok = False
        except requests.RequestException as e:
            print(f"Telegram: error de red ({e})")
            ok = False
    return ok
