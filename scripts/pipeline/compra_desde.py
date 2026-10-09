"""'Desde cuando cumple' cada señal de compra (public/data/compra_desde.json).

Para poder ver si una recomendacion funciono, cada señal guarda la FECHA en
que empezo la racha actual (cumpliendo el requisito de forma continua) y el
cierre de ese dia. El frontend compara contra el precio de hoy.

Dos fuentes, segun la señal:
  - Con historial propio (screener COMPRA/CERCA por temporalidad, Oportunidades):
    la racha se reconstruye hacia atras desde esos historiales (hasta
    DIAS_HISTORIAL dias). Si llega hasta la primera fecha del historial, la
    entrada sale con aprox=True ("desde al menos").
  - Sin historial (Candidatos en dos escenarios, Warren Score >= 70 / >= 80, bases VCP): un log
    en data/compra_desde_estado.json. Cada corrida deja la fecha de las que ya
    estaban y agrega hoy a las nuevas; la que sale del requisito se borra (si
    vuelve, empieza una racha nueva). Arranca el dia que se agrego el log:
    las que ya cumplian ese dia salen con aprox=True.

Los umbrales del embudo de Candidatos replican FILTROS_DEFAULT de
src/lib/candidatos.js — si se toca uno, tocar el otro."""

import numpy as np

from comun import num

TIMEFRAMES = ("diario", "semanal", "mensual")
VCP_ESTADOS_GATILLO = {"Armado", "Recién rompió", "Rompió y confirmó"}
FLAGS_EXCLUYENTES_BASE = {"distribucion", "breakout_fallido"}
FLAGS_EXCLUYENTES_ESTRICTO = {"sobreextension", "reversion_volumen", "churning", "divergencia_rsi", "divergencia_obv"}
CAPS_GATE = {"gate_ema200", "sin_52w"}
WARREN_UMBRALES = (70.0, 80.0)  # 80 = el mismo umbral que dispara la alerta de Telegram

# Escenarios del embudo de Candidatos cuya racha se registra. Mismas claves y
# valores que FILTROS_DEFAULT / FILTROS_LAXO de src/lib/candidatos.js — si se
# toca uno, tocar el otro (el frontend solo muestra fecha si los parametros
# elegidos coinciden con uno de estos dos).
FILTROS_CANDIDATOS = {
    "candidato": {
        "umbralFuerza": 0.6, "umbralContraccion": 0.5, "cuadrante": "liderando", "ema200DiarioMaxHace": 10,
        "ema200SemanalMaxHace": 4, "minTemporalidadesScreener": 2, "exigirSinVenta": True, "modoEstricto": False,
    },
    "candidato_laxo": {
        "umbralFuerza": 0.3, "umbralContraccion": 0.2, "cuadrante": "liderando_recuperando", "ema200DiarioMaxHace": 20,
        "ema200SemanalMaxHace": 8, "minTemporalidadesScreener": 1, "exigirSinVenta": False, "modoEstricto": False,
    },
}


# ---------------------------------------------------------------------------
# Quien cumple hoy cada requisito
# ---------------------------------------------------------------------------
def _tickers(lista):
    """Set de tickers de una lista de strings o de dicts con 'ticker'."""
    return {(x.get("ticker") if isinstance(x, dict) else x) for x in (lista or [])} - {None, ""}


def _tiene_senal(dato):
    return (dato or {}).get("verdict") in ("COMPRA", "CERCA")


def _gatillos(ticker, senales, vcp_tickers, f):
    if ticker in vcp_tickers:
        return True
    ema = senales.get("ema200") or {}
    for tf, tope in (("diario", f["ema200DiarioMaxHace"]), ("semanal", f["ema200SemanalMaxHace"])):
        for tipo in ("rebote", "cruce"):
            if any(r["ticker"] == ticker and r["hace"] <= tope for r in (ema.get(tf) or {}).get(tipo, [])):
                return True
    return any(r["ticker"] == ticker for r in (senales.get("rsi_semanal") or {}).get("alcista", []))


def candidatos_hoy(warren_rows, senales, screener, rotacion, filtros):
    """Tickers que pasan el embudo de Candidatos con 'filtros' (mismas 5
    etapas que armarCandidatos en src/lib/candidatos.js)."""
    f = {**FILTROS_CANDIDATOS["candidato"], **filtros}
    excluyentes = FLAGS_EXCLUYENTES_BASE | (FLAGS_EXCLUYENTES_ESTRICTO if f["modoEstricto"] else set())
    vcp_tickers = {x["ticker"] for x in senales.get("vcp", []) if x.get("estado") in VCP_ESTADOS_GATILLO}
    rot_por_ticker = {r["ticker"]: r for r in (rotacion.get("acciones") or []) if r.get("ticker")}
    recien = _tickers(rotacion.get("recien_a_lideres")) | _tickers(rotacion.get("aceleracion_inusual"))
    screener_por_ticker = {x["ticker"]: x for x in screener}
    cuadrantes_ok = {"liderando": {"liderando"}, "liderando_recuperando": {"liderando", "recuperando"}}.get(f["cuadrante"])

    salida = set()
    for w in warren_rows:
        if not w.get("datos_suficientes") or w.get("total_score") is None:
            continue
        if CAPS_GATE & set(w.get("caps") or []):
            continue
        fuerza, contr = (w.get("pilares") or {}).get("fuerza"), (w.get("pilares") or {}).get("contraccion")
        if not fuerza or not contr or not fuerza.get("max") or not contr.get("max"):
            continue
        if any(fl.get("clave") in excluyentes for fl in (w.get("penalizacion") or {}).get("flags", [])):
            continue
        if fuerza["pts"] / fuerza["max"] < f["umbralFuerza"] or contr["pts"] / contr["max"] < f["umbralContraccion"]:
            continue
        t = w["ticker"]
        if cuadrantes_ok is not None and t not in recien and (rot_por_ticker.get(t) or {}).get("cuadrante") not in cuadrantes_ok:
            continue
        if not _gatillos(t, senales, vcp_tickers, f):
            continue
        fila = screener_por_ticker.get(t)
        if not fila:
            continue
        con_senal = sum(1 for tf in TIMEFRAMES if _tiene_senal(fila.get(tf)))
        con_venta = any((fila.get(tf) or {}).get("verdict") == "VENTA" for tf in TIMEFRAMES)
        if con_senal >= f["minTemporalidadesScreener"] and not (f["exigirSinVenta"] and con_venta):
            salida.add(t)
    return salida


def activos_hoy(warren_rows, senales, screener, rotacion, warren2_rows=()):
    """{clave: set(tickers)} de las señales que se siguen con el log de estado."""
    con_score = [w for w in warren_rows if w.get("datos_suficientes") and w.get("total_score") is not None]
    activos = {f"warren_{int(u)}": {w["ticker"] for w in con_score if w["total_score"] >= u} for u in WARREN_UMBRALES}
    # Warren Score 2 (pipeline/warren2.py): mismas zonas, para comparar los dos en vivo.
    con_score2 = [w for w in warren2_rows if w.get("total_score") is not None]
    for u in WARREN_UMBRALES:
        activos[f"warren2_{int(u)}"] = {w["ticker"] for w in con_score2 if w["total_score"] >= u}
    activos["vcp"] = {f["ticker"] for f in senales.get("vcp", [])}
    for clave, filtros in FILTROS_CANDIDATOS.items():
        activos[clave] = candidatos_hoy(warren_rows, senales, screener, rotacion, filtros)
    return activos


# ---------------------------------------------------------------------------
# Log de estado (señales sin historial propio)
# ---------------------------------------------------------------------------
def precio_en(closes, fecha):
    """Ultimo cierre de la serie en o antes de 'fecha' (YYYY-MM-DD), o None."""
    if closes is None or not len(closes):
        return None
    fechas = closes.index.strftime("%Y-%m-%d")
    pos = int(np.searchsorted(fechas, fecha, side="right")) - 1
    return float(closes.iloc[pos]) if pos >= 0 else None


def actualizar_estado(estado_prev, activos, precios_hoy, hoy):
    """Racha vigente por clave: conserva la fecha de los que siguen cumpliendo,
    agrega hoy a los nuevos y descarta a los que ya no cumplen.
    estado = {clave: {"inicio": fecha, "tickers": {T: {"desde", "precio"}}}}"""
    estado_prev = estado_prev if isinstance(estado_prev, dict) else {}
    nuevo = {}
    for clave, tickers in activos.items():
        previo = estado_prev.get(clave)
        inicio = previo["inicio"] if isinstance(previo, dict) and previo.get("inicio") else hoy
        vigentes = (previo or {}).get("tickers") or {}
        filas = {}
        for t in sorted(tickers):
            if t in vigentes:
                filas[t] = vigentes[t]
            else:
                filas[t] = {"desde": hoy, "precio": num(precios_hoy.get(t), 4)}
        nuevo[clave] = {"inicio": inicio, "tickers": filas}
    return nuevo


# ---------------------------------------------------------------------------
# Rachas reconstruidas desde un historial (screener / Oportunidades)
# ---------------------------------------------------------------------------
def rachas_desde_historial(historial, activo):
    """historial: [{fecha, tickers}] (cualquier orden). activo(entrada, ticker)
    -> bool. Devuelve {ticker: {"desde": fecha, "aprox": bool}} para los que
    cumplen en la ULTIMA entrada: camina hacia atras mientras siga cumpliendo.
    aprox=True si la racha llega a la primera entrada (empezo antes)."""
    entradas = sorted((h for h in historial if h.get("fecha")), key=lambda h: h["fecha"])
    if not entradas:
        return {}, None
    candidatos = [t for t in (entradas[-1].get("tickers") or {}) if activo(entradas[-1], t)]
    salida = {}
    for t in candidatos:
        i = len(entradas) - 1
        while i > 0 and activo(entradas[i - 1], t):
            i -= 1
        salida[t] = {"desde": entradas[i]["fecha"], "aprox": i == 0}
    return salida, entradas[0]["fecha"]


def _con_precio(rachas, closes_por_ticker):
    return {
        t: {
            "desde": r["desde"],
            "precio": num(precio_en(closes_por_ticker.get(t), r["desde"]), 4),
            "aprox": r["aprox"],
        }
        for t, r in rachas.items()
    }


def construir(estado, historial_screener, historial_oportunidades, closes_por_ticker, precios_hoy, ahora_iso):
    """public/data/compra_desde.json:
    {actualizado, claves: {clave: {inicio, tickers: {T: {desde, precio, precio_hoy, aprox}}}}}"""
    claves = {}
    for clave, datos in estado.items():
        inicio = datos["inicio"]
        claves[clave] = {
            "inicio": inicio,
            "tickers": {t: {**f, "aprox": f["desde"] == inicio} for t, f in datos["tickers"].items()},
        }
    for tf in TIMEFRAMES:
        rachas, inicio = rachas_desde_historial(
            historial_screener, lambda e, t, tf=tf: _tiene_senal({"verdict": ((e.get("tickers") or {}).get(t) or {}).get(tf)})
        )
        claves[f"screener_{tf}"] = {"inicio": inicio, "tickers": _con_precio(rachas, closes_por_ticker)}
    # Oportunidades guarda {fecha, tickers: [lista]}: lo paso a dict para reusar la caminata.
    hist_op = [{"fecha": h["fecha"], "tickers": {t: True for t in (h.get("tickers") or [])}} for h in historial_oportunidades or []]
    rachas, inicio = rachas_desde_historial(hist_op, lambda e, t: t in (e.get("tickers") or {}))
    claves["oportunidades"] = {"inicio": inicio, "tickers": _con_precio(rachas, closes_por_ticker)}

    for datos in claves.values():
        for t, fila in datos["tickers"].items():
            fila["precio_hoy"] = num(precios_hoy.get(t), 4)
    return {"actualizado": ahora_iso, "claves": claves}
