"""Log de seguimiento EN VIVO de las señales (data/senales_log.json, estado;
public/data/senales_seguimiento.json, publicado): cada corrida agrega las
señales de HOY (dedupe por ticker/señal/racha) y cierra los horizontes
vencidos de las entradas viejas a medida que llegan precios nuevos.

Complementa el backtest historico (scripts/backtest_senales.py, sobre 5
años, mensual): esto es el resultado REAL de las señales que fue mostrando
la app desde que existe este log, actualizado en cada corrida del pipeline
(no hay que esperar a que se cumpla el horizonte para ver la señal: se
publica "abierta" y se completa sola)."""

from datetime import datetime, timedelta

from comun import num

HORIZONTES = (5, 10, 20)  # mismas ruedas que Backtest.jsx / backtest_senales.py (temporalidad diaria)
DIAS_MAX_LOG = 730  # ~2 años: entradas cerradas mas viejas se recortan (el resumen ya las tiene contadas)
MAX_RECIENTES = 20
CAP_RETORNOS_RESUMEN = 500  # retornos recientes que guarda cada señal/horizonte para la mediana (no crece sin limite)


def _entradas_hoy(senales, precios_hoy):
    """[(ticker, señal, fecha, precio)] de las señales de HOY. 'fecha' es la
    del contacto (identidad de la racha); para VCP, que no trae una fecha de
    evento propia, se usa el pivote (una base = un pivote: mientras no
    cambie es "la misma" base, aunque su estado evolucione)."""
    salida = []
    for tf in ("diario", "semanal"):
        for tipo, lista in senales["ema200"][tf].items():
            for f in lista:
                precio = precios_hoy.get(f["ticker"])
                if precio is not None:
                    salida.append((f["ticker"], f"ema_{tf}_{tipo}", f["fecha"], precio))
    for f in senales["vcp"]:
        precio = precios_hoy.get(f["ticker"])
        if precio is not None and f.get("pivote") is not None:
            salida.append((f["ticker"], "vcp", f"pivote-{f['pivote']}", precio))
    for tipo, lista in senales["rsi_semanal"].items():
        for f in lista:
            precio = precios_hoy.get(f["ticker"])
            if precio is not None:
                salida.append((f["ticker"], f"rsi_semanal_{tipo}", f["fecha"], precio))
    return salida


def _id(ticker, señal, fecha):
    return f"{ticker}|{señal}|{fecha}"


def actualizar_log(log_previo, senales, precios_hoy, closes_por_ticker, hoy, ahora_iso):
    """Agrega las señales de hoy (si no estaban ya logueadas) y completa los
    horizontes vencidos de las entradas abiertas. 'closes_por_ticker':
    {ticker: pd.Series de cierres (index = fechas, ya resuelto a la plaza
    correcta)} del historico YA descargado en esta corrida (no pide nada
    nuevo). Entrada = cierre del dia de la señal (no la apertura del dia
    siguiente: simplificación del log en vivo frente al backtest histórico,
    que sí usa la apertura siguiente — ver advertencias)."""
    log = log_previo if isinstance(log_previo, dict) else {}
    entradas = {e["id"]: e for e in (log.get("entradas") or []) if e.get("id")}
    resumen = log.get("resumen") or {}

    nuevas = 0
    for ticker, señal, fecha, precio in _entradas_hoy(senales, precios_hoy):
        eid = _id(ticker, señal, fecha)
        if eid in entradas:
            continue
        entradas[eid] = {
            "id": eid,
            "ticker": ticker,
            "señal": señal,
            "fecha": fecha,
            "fecha_entrada": hoy,
            "precio_entrada": precio,
            "resultados": {},
            "cerrado": False,
        }
        nuevas += 1

    cerradas_hoy = 0
    for e in entradas.values():
        if e["cerrado"] or not e.get("precio_entrada"):
            continue
        closes = closes_por_ticker.get(e["ticker"])
        if closes is None or not len(closes):
            continue
        fechas = closes.index.strftime("%Y-%m-%d").tolist()
        try:
            pos_entrada = fechas.index(e["fecha_entrada"])
        except ValueError:
            continue  # la fecha de entrada no esta en este historico (raro: cambio de simbolo/plaza)
        n = len(closes)
        for h in HORIZONTES:
            clave_h = str(h)
            if clave_h in e["resultados"]:
                continue
            pos_h = pos_entrada + h
            if pos_h >= n:
                continue
            precio_h = float(closes.iloc[pos_h])
            retorno = (precio_h / e["precio_entrada"] - 1) * 100
            e["resultados"][clave_h] = {"fecha": fechas[pos_h], "precio": num(precio_h, 2), "retorno": num(retorno, 2)}
            r = resumen.setdefault(e["señal"], {}).setdefault(clave_h, {"n_total": 0, "n_pos_total": 0, "retornos_recientes": []})
            r["n_total"] += 1
            r["n_pos_total"] += 1 if retorno > 0 else 0
            r["retornos_recientes"].append(num(retorno, 2))
            if len(r["retornos_recientes"]) > CAP_RETORNOS_RESUMEN:
                del r["retornos_recientes"][: len(r["retornos_recientes"]) - CAP_RETORNOS_RESUMEN]
            cerradas_hoy += 1
        if all(str(h) in e["resultados"] for h in HORIZONTES):
            e["cerrado"] = True

    # Recorte: entradas YA cerradas (todos los horizontes resueltos) con mas
    # de DIAS_MAX_LOG dias desde la señal. El resumen (arriba) ya las conto,
    # asi que no se pierde estadistica al recortarlas del log crudo.
    try:
        corte = (datetime.fromisoformat(ahora_iso) - timedelta(days=DIAS_MAX_LOG)).strftime("%Y-%m-%d")
        entradas = {k: e for k, e in entradas.items() if not (e["cerrado"] and e["fecha_entrada"] < corte)}
    except (TypeError, ValueError):
        pass

    print(f"  Seguimiento en vivo: {nuevas} señal(es) nueva(s), {cerradas_hoy} resultado(s) cerrado(s) hoy.")
    return {"entradas": list(entradas.values()), "resumen": resumen}


def resumen_publicable(log, ahora_iso):
    """public/data/senales_seguimiento.json: por señal y horizonte, n
    cerradas / hit-rate (exacto, acumulado) / retorno mediano (sobre los
    ultimos hasta {CAP_RETORNOS_RESUMEN} cierres) + las ultimas
    MAX_RECIENTES entradas (abiertas o cerradas), mas nuevas primero."""
    stats = {}
    for señal, por_h in (log.get("resumen") or {}).items():
        stats[señal] = {}
        for h, r in por_h.items():
            retornos = r.get("retornos_recientes") or []
            mediana = None
            if retornos:
                ordenados = sorted(retornos)
                m = len(ordenados) // 2
                mediana = ordenados[m] if len(ordenados) % 2 else (ordenados[m - 1] + ordenados[m]) / 2
            stats[señal][h] = {
                "n": r.get("n_total", 0),
                "n_pos": r.get("n_pos_total", 0),
                "hit_rate": num(r["n_pos_total"] / r["n_total"] * 100, 1) if r.get("n_total") else None,
                "retorno_mediana": num(mediana, 2),
            }
    recientes = sorted(log.get("entradas") or [], key=lambda e: (e["fecha_entrada"], e["ticker"]), reverse=True)
    return {
        "actualizado": ahora_iso,
        "horizontes_dias": list(HORIZONTES),
        "stats": stats,
        "recientes": [
            {k: e[k] for k in ("ticker", "señal", "fecha_entrada", "precio_entrada", "cerrado", "resultados")}
            for e in recientes[:MAX_RECIENTES]
        ],
    }
