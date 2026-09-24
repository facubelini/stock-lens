"""Estado de la corrida anterior, historiales (screener / Oportunidades)
y escritura de los JSON publicados (public/data), los archivos por ticker
(historial/ y mensual/), el estado (data/) y meta.json."""

from datetime import timedelta

from comun import borrar_huerfanos, escribir_json, leer_json


DIAS_HISTORIAL = 90


# ---------------------------------------------------------------------------
# Estado de la corrida anterior / historiales
# ---------------------------------------------------------------------------
def cargar_lista_previa(ruta, clave=None):
    """Carga un JSON de la corrida anterior (si existe), indexado por el
    simbolo resuelto (ej. "ALUA.BA"). Sirve para arrastrar el ultimo dato
    bueno de un ticker que falla en la corrida actual (yfinance flaky /
    rate-limit puntual) en vez de que desaparezca del todo hasta la proxima
    corrida exitosa."""
    data = leer_json(ruta)
    if data is None:
        return {}
    lista = data.get(clave) if (clave and isinstance(data, dict)) else data
    if not isinstance(lista, list):
        return {}
    return {f["ticker"]: f for f in lista if f.get("ticker")}


def actualizar_historial_screener(historial, screener_actual, ahora):
    """Agrega (o pisa, si ya se corrio hoy) la entrada de hoy en el historial
    maestro de veredictos del screener, y recorta lo mas viejo que
    DIAS_HISTORIAL. Solo guarda el verdict por temporalidad (no el detalle
    completo). El maestro vive en data/ (no se publica): lo que se publica
    son los archivos por ticker (ver historial_por_ticker)."""
    historial = historial if isinstance(historial, list) else []
    hoy = ahora.strftime("%Y-%m-%d")
    historial = [h for h in historial if h.get("fecha") != hoy]
    tickers_hoy = {
        f["ticker"]: {
            tf: (f.get(tf) or {}).get("verdict")
            for tf in ("diario", "semanal", "mensual")
            if f.get(tf)
        }
        for f in screener_actual
    }
    historial.append({"fecha": hoy, "tickers": tickers_hoy})

    corte = (ahora - timedelta(days=DIAS_HISTORIAL)).strftime("%Y-%m-%d")
    historial = [h for h in historial if h.get("fecha", "") >= corte]
    historial.sort(key=lambda h: h["fecha"])
    return historial


def historial_por_ticker(historial, ticker):
    """[{fecha, diario, semanal, mensual}] del ticker, de mas viejo a mas
    nuevo — lo que publica public/data/historial/<TICKER>.json."""
    return [
        {"fecha": h["fecha"], **h["tickers"][ticker]}
        for h in sorted(historial, key=lambda h: h["fecha"])
        if ticker in (h.get("tickers") or {})
    ]


def actualizar_historial_oportunidades(historial, calificados_hoy, ahora):
    """Mismo patron que actualizar_historial_screener: un snapshot por dia
    (se pisa si ya corrio hoy), recortado a DIAS_HISTORIAL."""
    historial = historial if isinstance(historial, list) else []
    hoy = ahora.strftime("%Y-%m-%d")
    historial = [h for h in historial if h.get("fecha") != hoy]
    historial.append({"fecha": hoy, "tickers": calificados_hoy})

    corte = (ahora - timedelta(days=DIAS_HISTORIAL)).strftime("%Y-%m-%d")
    historial = [h for h in historial if h.get("fecha", "") >= corte]
    historial.sort(key=lambda h: h["fecha"])
    return historial


def cargar_previos(out):
    """Filas de la corrida anterior por archivo (para el arrastre y para no
    cambiar de plaza el simbolo resuelto) + el meta.json anterior."""
    previos = {
        "listado": cargar_lista_previa(out / "listado.json", clave="acciones"),
        "medias": cargar_lista_previa(out / "medias.json"),
        "fundamentales": cargar_lista_previa(out / "fundamentales.json"),
        "screener": cargar_lista_previa(out / "screener.json"),
        "scanner_setups": cargar_lista_previa(out / "scanner_setups.json"),
    }
    return previos, leer_json(out / "meta.json", {}) or {}


def historial_screener(out, estado, screener, ahora):
    """Historial maestro de veredictos (data/screener_historial.json) con
    la entrada de hoy."""
    print("\nActualizando historial de señales...")
    master = leer_json(estado / "screener_historial.json")
    if master is None:  # migracion: el maestro antes se publicaba en public/data
        master = leer_json(out / "screener_historial.json", []) or []
    return actualizar_historial_screener(master, screener, ahora)


def escribir_publicados(out, datos, historial, ahora_iso):
    """Escribe los JSON publicados en 'out' (atomico, minificado, solo si
    cambio) y los archivos por ticker de mensual/ e historial/. Devuelve la
    cantidad de archivos que cambiaron (para decidir el timestamp de meta)."""
    print("\nEscribiendo JSON:")
    cambios = 0
    cambios += escribir_json(out / "listado.json", {"acciones": datos["listado"], "promedios_por_industria": datos["promedios"]})
    cambios += escribir_json(out / "medias.json", datos["medias"])
    cambios += escribir_json(out / "fundamentales.json", datos["fundamentales"])
    cambios += escribir_json(out / "comparables.json", datos["comparables"])
    cambios += escribir_json(out / "screener.json", datos["screener"])
    cambios += escribir_json(out / "scanner_setups.json", datos["scanner_setups"])
    cambios += escribir_json(out / "oportunidades_historial.json", datos["historial_oportunidades"])
    cambios += escribir_json(
        out / "warren_score.json", {"actualizado": ahora_iso, "tickers": datos["warren_score"]}, ignorar_claves=("actualizado",)
    )
    cambios += escribir_json(out / "senales.json", datos["senales"], ignorar_claves=("actualizado",))

    # Migracion one-off al layout por ticker: el historico mensual pasa de un
    # JSON unico (1.8MB) a mensual/<TICKER>.json (sirve para los arrastrados,
    # que no traen precios nuevos en esta corrida).
    mensuales = datos["mensuales"]
    legado_mensual = out / "historico_mensual.json"
    legado_historial = out / "screener_historial.json"
    if legado_mensual.exists():
        for item in leer_json(legado_mensual, []) or []:
            destino = out / "mensual" / f"{item['ticker']}.json"
            if not destino.exists() and item.get("precios") and item["ticker"] not in mensuales:
                escribir_json(destino, item["precios"], silencioso=True)

    vigentes = {f["ticker"] for f in datos["listado"]}
    n_por_ticker = 0
    for sym, precios in mensuales.items():
        n_por_ticker += escribir_json(out / "mensual" / f"{sym}.json", precios, silencioso=True)
    for sym in sorted(vigentes):
        n_por_ticker += escribir_json(
            out / "historial" / f"{sym}.json", historial_por_ticker(historial, sym), silencioso=True
        )
    print(f"  -> mensual/ e historial/: {n_por_ticker} archivo(s) por ticker escritos")
    huerfanos = borrar_huerfanos(out / "mensual", vigentes) + borrar_huerfanos(out / "historial", vigentes)
    if huerfanos:
        print(f"  borrados {len(huerfanos)} archivo(s) por ticker huerfano(s): {sorted(set(huerfanos))}")
    for legado in (legado_mensual, legado_historial):
        if legado.exists():
            legado.unlink()
            print(f"  borrado {legado.name} (reemplazado por archivos por ticker)")
            cambios += 1
    cambios += n_por_ticker + len(huerfanos)
    return cambios


def escribir_estado(estado, historial, cache_peers, invalidos_vigentes, sin_arrastre, hoy):
    """Estado (data/): no se publica, pero se commitea para la proxima
    corrida. Los sin_arrastre de hoy entran al cache de invalidos."""
    escribir_json(estado / "screener_historial.json", historial)
    escribir_json(estado / "comparables_cache.json", cache_peers)
    nuevos_invalidos = dict(invalidos_vigentes)
    for t in sin_arrastre:
        nuevos_invalidos[t] = hoy
    escribir_json(estado / "invalidos_cache.json", {t: nuevos_invalidos[t] for t in sorted(nuevos_invalidos)})


def escribir_meta(out, meta, cambios):
    """meta.json solo cambia su timestamp si cambio algun dato publicado: una
    corrida sin novedades (fin de semana, feriado) no genera commit."""
    if cambios:
        escribir_json(out / "meta.json", meta)
    else:
        escribir_json(out / "meta.json", meta, ignorar_claves=("ultima_actualizacion",))
        print("  (sin cambios en los datos publicados)")
