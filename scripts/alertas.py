"""Alertas por Telegram: compara la salida nueva del pipeline (public/data/)
contra el estado de la corrida anterior (data/alertas_estado.json) y manda UN
mensaje con los eventos NUEVOS (nunca repite el mismo evento dos veces).

Se corre como ultimo paso de "Actualizar datos", despues de que el commit a
la rama `datos` ya se hizo (o no: si no hubo cambios en los datos tampoco hay
eventos nuevos, el diff da vacio y no se manda nada). Si faltan las
credenciales (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) imprime un aviso y
termina con codigo 0: nunca hace fallar el workflow.

Eventos que dispara (todos "nuevo desde la corrida anterior", con el estado
guardado en data/alertas_estado.json):
  - Una base VCP (senales.json vcp[]) que paso a estado "Recién rompió" o
    "Armado".
  - Un ticker que entro al podio (top 3) del Warren Score, o que cruzo por
    primera vez total_score >= 80.
  - Un evento nuevo de EMA200 SEMANAL (rebote o cruce) en senales.json
    (deduplicado por fecha del evento, no por "hace" dias: eso crece cada
    corrida aunque sea el mismo evento).
  - Un cruce nuevo de RSI semanal alcista con RS >= 70.
  - Solo para los tickers de la watchlist del usuario (data/alertas_config.json,
    ver mas abajo): un cruce de EMA200 diario (mismos datos de senales.json,
    filtrados a esos tickers) o un movimiento diario >= +-5% (listado.json).

Watchlist: hoy "Mi Cartera" vive solo en localStorage del navegador (no hay
forma de que un workflow la lea). Si el usuario quiere alertas para tickers
puntuales, puede versionar data/alertas_config.json en main:
    {"tickers": ["AAPL", "MRNA"]}
Sin ese archivo, las alertas de EMA200 diario / movimiento diario quedan
desactivadas (los otros 4 tipos de eventos son globales y no dependen de la
watchlist).
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from comun import DIR_DATOS_PUBLICOS, DIR_ESTADO, leer_json, escribir_json  # noqa: E402
from monitoreo.telegram import enviar_telegram, hay_credenciales  # noqa: E402

URL_TICKER = "https://facubelini.github.io/stock-lens/#/ticker/{}"
UMBRAL_WARREN_ALTO = 80.0
UMBRAL_RS_RSI_SEMANAL = 70.0
UMBRAL_MOVIMIENTO_DIARIO_PCT = 5.0
ESTADOS_VCP_AVISABLES = {"Recién rompió", "Armado"}

ARCHIVO_ESTADO_DEFAULT = DIR_ESTADO / "alertas_estado.json"
ARCHIVO_CONFIG_DEFAULT = DIR_ESTADO / "alertas_config.json"

ESTADO_VACIO = {
    "vcp": {},              # ticker -> ultimo estado avisado
    "warren_podium": [],    # tickers en el podio en la corrida anterior
    "warren_alto": [],      # tickers con total_score >= 80 en la corrida anterior
    "ema200_semanal": {},   # "ticker|tipo" -> fecha del ultimo evento avisado
    "ema200_diario": {},    # "ticker" -> fecha del ultimo cruce diario avisado (solo watchlist)
    "rsi_semanal": {},      # ticker -> fecha del ultimo cruce avisado
    "watchlist_var": {},    # ticker -> fecha del ultimo movimiento >=5% avisado
}


def _link(ticker):
    return URL_TICKER.format(ticker)


def _cargar_datos(carpeta):
    return {
        "senales": leer_json(carpeta / "senales.json", {}),
        "warren": leer_json(carpeta / "warren_score.json", {}),
        "listado": leer_json(carpeta / "listado.json", {}),
        "medias": leer_json(carpeta / "medias.json", []),
    }


def _estado_previo(ruta):
    d = leer_json(ruta, None)
    if not isinstance(d, dict):
        return {k: (dict(v) if isinstance(v, dict) else list(v)) for k, v in ESTADO_VACIO.items()}
    return {k: d.get(k, (dict(v) if isinstance(v, dict) else list(v))) for k, v in ESTADO_VACIO.items()}


def _config(ruta):
    d = leer_json(ruta, None)
    if not isinstance(d, dict):
        return {"tickers": []}
    tickers = d.get("tickers")
    return {"tickers": [str(t).upper() for t in tickers] if isinstance(tickers, list) else []}


# --- deteccion de eventos ---

def _eventos_vcp(senales, estado_prev, estado_nuevo):
    eventos = []
    prev = estado_prev.get("vcp", {})
    nuevo = {}
    for fila in senales.get("vcp") or []:
        if not isinstance(fila, dict):
            continue
        t, est = fila.get("ticker"), fila.get("estado")
        if not t or est is None:
            continue
        nuevo[t] = est
        if est in ESTADOS_VCP_AVISABLES and prev.get(t) != est:
            eventos.append({
                "tipo": "VCP",
                "ticker": t,
                "texto": f"base VCP pasó a <b>{est}</b> (score {fila.get('score')}, "
                         f"{fila.get('contracciones')} contracciones, pivote {fila.get('pivote')})",
            })
    estado_nuevo["vcp"] = nuevo
    return eventos


def _eventos_warren(warren, estado_prev, estado_nuevo):
    eventos = []
    filas = [f for f in (warren.get("tickers") or []) if isinstance(f, dict) and f.get("total_score") is not None]
    filas.sort(key=lambda f: f["total_score"], reverse=True)
    podio_nuevo = [f["ticker"] for f in filas[:3]]
    altos_nuevo = [f["ticker"] for f in filas if f["total_score"] >= UMBRAL_WARREN_ALTO]

    podio_prev = set(estado_prev.get("warren_podium", []))
    altos_prev = set(estado_prev.get("warren_alto", []))

    for i, t in enumerate(podio_nuevo):
        if t not in podio_prev:
            score = next(f["total_score"] for f in filas if f["ticker"] == t)
            eventos.append({
                "tipo": "Warren Score",
                "ticker": t,
                "texto": f"entró al podio del Warren Score (#{i + 1}, score {score})",
            })
    for t in altos_nuevo:
        if t in [e["ticker"] for e in eventos]:
            continue  # ya avisado por podio en esta misma corrida, no duplicar
        if t not in altos_prev and t not in podio_prev:
            score = next(f["total_score"] for f in filas if f["ticker"] == t)
            eventos.append({
                "tipo": "Warren Score",
                "ticker": t,
                "texto": f"cruzó Warren Score ≥ {UMBRAL_WARREN_ALTO:.0f} (score {score})",
            })
    estado_nuevo["warren_podium"] = podio_nuevo
    estado_nuevo["warren_alto"] = altos_nuevo
    return eventos


def _eventos_ema200_semanal(senales, estado_prev, estado_nuevo):
    eventos = []
    prev = estado_prev.get("ema200_semanal", {})
    nuevo = {}
    ema200 = senales.get("ema200") or {}
    semanal = ema200.get("semanal") or {}
    for tipo, etiqueta in (("rebote", "rebote"), ("cruce", "cruce")):
        for fila in semanal.get(tipo) or []:
            if not isinstance(fila, dict):
                continue
            t, fecha = fila.get("ticker"), fila.get("fecha")
            if not t or not fecha:
                continue
            clave = f"{t}|{tipo}"
            nuevo[clave] = fecha
            if prev.get(clave) != fecha:
                eventos.append({
                    "tipo": "EMA200 semanal",
                    "ticker": t,
                    "texto": f"{etiqueta} de EMA200 semanal el {fecha} (dist. {fila.get('dist_ema_pct')}%, "
                             f"RS {fila.get('rs_hoy')})",
                })
    estado_nuevo["ema200_semanal"] = nuevo
    return eventos


def _eventos_rsi_semanal(senales, estado_prev, estado_nuevo):
    eventos = []
    prev = estado_prev.get("rsi_semanal", {})
    nuevo = {}
    for fila in (senales.get("rsi_semanal") or {}).get("alcista") or []:
        if not isinstance(fila, dict):
            continue
        t, fecha, rs = fila.get("ticker"), fila.get("fecha"), fila.get("rs")
        if not t or not fecha:
            continue
        nuevo[t] = fecha
        if rs is not None and rs >= UMBRAL_RS_RSI_SEMANAL and prev.get(t) != fecha:
            eventos.append({
                "tipo": "RSI semanal",
                "ticker": t,
                "texto": f"cruce alcista de RSI semanal el {fecha} (RSI {fila.get('rsi')}, RS {rs})",
            })
    estado_nuevo["rsi_semanal"] = nuevo
    return eventos


def _eventos_watchlist(senales, listado, watchlist, estado_prev, estado_nuevo):
    eventos = []
    if not watchlist:
        estado_nuevo["ema200_diario"] = estado_prev.get("ema200_diario", {})
        estado_nuevo["watchlist_var"] = estado_prev.get("watchlist_var", {})
        return eventos

    prev_cruce = estado_prev.get("ema200_diario", {})
    nuevo_cruce = {}
    diario = ((senales.get("ema200") or {}).get("diario") or {}).get("cruce") or []
    for fila in diario:
        if not isinstance(fila, dict):
            continue
        t, fecha = fila.get("ticker"), fila.get("fecha")
        if t not in watchlist or not t or not fecha:
            continue
        nuevo_cruce[t] = fecha
        if prev_cruce.get(t) != fecha:
            eventos.append({
                "tipo": "Watchlist",
                "ticker": t,
                "texto": f"cruce de EMA200 diario el {fecha} (dist. {fila.get('dist_ema_pct')}%)",
            })
    # el resto de la watchlist mantiene su ultima fecha avisada (no se pierde
    # si el ticker sale/entra de la lista de cruces de una corrida a otra)
    estado_nuevo["ema200_diario"] = {**prev_cruce, **nuevo_cruce}

    prev_var = estado_prev.get("watchlist_var", {})
    nuevo_var = dict(prev_var)
    fecha_hoy = listado.get("acciones") and (listado.get("actualizado") or "")[:10]
    for fila in listado.get("acciones") or []:
        if not isinstance(fila, dict):
            continue
        t, var = fila.get("ticker"), fila.get("var_pct")
        if t not in watchlist or var is None:
            continue
        if abs(var) >= UMBRAL_MOVIMIENTO_DIARIO_PCT and prev_var.get(t) != fecha_hoy:
            eventos.append({
                "tipo": "Watchlist",
                "ticker": t,
                "texto": f"movimiento diario de {var:+.1f}% (≥ ±{UMBRAL_MOVIMIENTO_DIARIO_PCT:.0f}%)",
            })
            nuevo_var[t] = fecha_hoy
    estado_nuevo["watchlist_var"] = nuevo_var
    return eventos


def calcular_eventos(datos, estado_prev, config):
    """Devuelve (eventos, estado_nuevo). No muta estado_prev."""
    estado_nuevo = {}
    eventos = []
    eventos += _eventos_vcp(datos["senales"], estado_prev, estado_nuevo)
    eventos += _eventos_warren(datos["warren"], estado_prev, estado_nuevo)
    eventos += _eventos_ema200_semanal(datos["senales"], estado_prev, estado_nuevo)
    eventos += _eventos_rsi_semanal(datos["senales"], estado_prev, estado_nuevo)
    eventos += _eventos_watchlist(datos["senales"], datos["listado"], set(config["tickers"]), estado_prev, estado_nuevo)
    return eventos, estado_nuevo


def armar_mensaje(eventos):
    if not eventos:
        return None
    lineas = [f"<b>Stock Lens · {len(eventos)} evento(s) nuevo(s)</b>"]
    for e in eventos:
        lineas.append(
            f"\n• [{e['tipo']}] <b>{e['ticker']}</b>: {e['texto']}\n"
            f'  <a href="{_link(e["ticker"])}">ver ficha</a>'
        )
    return "\n".join(lineas)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Alertas por Telegram de eventos nuevos en public/data/.")
    ap.add_argument("--data", type=Path, default=DIR_DATOS_PUBLICOS)
    ap.add_argument("--estado", type=Path, default=ARCHIVO_ESTADO_DEFAULT)
    ap.add_argument("--config", type=Path, default=ARCHIVO_CONFIG_DEFAULT)
    ap.add_argument("--dry-run", action="store_true", help="imprime el mensaje, no manda nada ni persiste el estado")
    args = ap.parse_args(argv)

    if not args.dry_run and not hay_credenciales():
        print("Alertas: faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, no se manda nada (no es un error).")
        return 0

    datos = _cargar_datos(args.data)
    estado_prev = _estado_previo(args.estado)
    config = _config(args.config)

    eventos, estado_nuevo = calcular_eventos(datos, estado_prev, config)
    mensaje = armar_mensaje(eventos)

    if args.dry_run:
        print(mensaje or "Alertas: sin eventos nuevos.")
        return 0

    if mensaje is None:
        print("Alertas: sin eventos nuevos, no se manda nada.")
        escribir_json(args.estado, estado_nuevo, raiz_log=args.estado.parent)
        return 0

    if enviar_telegram(mensaje):
        escribir_json(args.estado, estado_nuevo, raiz_log=args.estado.parent)
        print(f"Alertas: {len(eventos)} evento(s) mandado(s) por Telegram.")
        return 0
    print("::warning::Alertas: fallo el envio por Telegram, se reintenta en la proxima corrida (estado no persistido).")
    return 0  # nunca falla el workflow por esto


if __name__ == "__main__":
    sys.exit(main())
