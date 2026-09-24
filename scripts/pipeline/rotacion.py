"""Rotacion (RRG): historial semanal del RS Score de cada ticker del
universo USD (Fuerza Relativa vs SPY, mismo percentil que pipeline/warren.py)
y el ranking de "cuadrante" (liderando/debilitando/recuperando/rezagando)
que consume la pagina Rotacion.

El historial (data/rotacion_historial.json, NO se publica) es la pieza
clave: sin el no hay forma de dibujar el movimiento semana a semana ni de
detectar "recien entro a liderando" o "aceleracion inusual" — hay que
ACUMULARLO corrida a corrida, no se puede recalcular desde cero. Se guarda
un snapshot por semana ISO (año-Www): si el pipeline corre varias veces en
la misma semana se PISA la entrada de esa semana con los numeros mas
recientes (no se duplica), y se recorta a las ultimas ROT_MAX_SEMANAS.

Publicado en public/data/rotacion.json (ver rot_construir).
"""

from comun import num

ROT_UMBRAL_RS = 60  # "alto" = mitad (o mas) de los puntos del via_nivel de warren.py
# (via_nivel = lineal(rs, 45, 75, 0, 20): en rs=60 -el punto medio del tramo-
# ya da 10/20, la mitad del pilar Fuerza por ese lado. Cuadrante:
#   liderando   = rs >= 60 y delta semanal >= 0
#   debilitando = rs >= 60 y delta semanal < 0
#   recuperando = rs <  60 y delta semanal >= 0
#   rezagando   = rs <  60 y delta semanal < 0
ROT_MAX_SEMANAS_HISTORIAL = 30  # cuanto se guarda en data/rotacion_historial.json
ROT_SEMANAS_PUBLICADAS = 16  # cuanto se publica en public/data/rotacion.json
ROT_VENTANA_ACELERACION = 6  # semanas "estancado" que se piden antes del salto
ROT_MIN_ESTANCADAS = 4  # de esas 6, cuantas tienen que ser recuperando/rezagando
ROT_SALTO_MIN = 15  # suba minima de RS Score en las ultimas 2 semanas
ROT_PREVIO_LLANO_MAX = 5  # cambio neto maximo en las 4 semanas antes del salto (llano/bajando)
ROT_VENTANA_CRUCE_FR = 2  # semanas hacia atras donde se busca el cruce de FR > SMA50


def semana_iso(fecha):
    """Clave de semana ISO (año-Www, ej. "2026-W39"). Ordena
    cronologicamente con orden alfabetico normal (por eso sirve como clave
    de dict y para recortar/ordenar el historial con sorted())."""
    iso = fecha.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def rot_filas_semana(warren_datos, rs_mapa, fundamentales):
    """Snapshot de HOY para cada ticker USD con RS Score (percentil de
    Fuerza Relativa hoy, desfase 0 de rs_percentiles): {ticker: {nombre,
    sector, es_etf, market_cap_usd, rs_score, fr_sobre_sma50}}.
    'sector' es el de warren.py (con el fallback "ETF" para fondos, ver
    pipeline/procesar.py), asi es_etf sale de ahi sin pedir nada nuevo.
    'fr_sobre_sma50' (linea de Fuerza Relativa vs. su SMA50, calculada en
    pipeline/warren.py ws_calcular_ticker) se guarda semana a semana para
    poder detectar despues un cruce reciente sin tener que rehacer el
    calculo diario."""
    fund_por_t = {f["ticker"]: f for f in fundamentales if f.get("ticker")}
    filas = {}
    for w in warren_datos:
        if not w.get("en_usd"):
            continue
        rs = (rs_mapa.get(w["ticker"]) or {}).get(0)
        if rs is None:
            continue
        calc = w.get("calc") or {}
        fund = fund_por_t.get(w["ticker"]) or {}
        fr = calc.get("fr_sobre_sma50")
        filas[w["ticker"]] = {
            "nombre": w.get("nombre"),
            "sector": w.get("sector"),
            "es_etf": w.get("sector") == "ETF",
            "market_cap_usd": fund.get("market_cap_usd"),
            "rs_score": num(rs, 1),
            "fr_sobre_sma50": bool(fr) if fr is not None else None,
        }
    return filas


def rot_actualizar_historial(historial, filas_semana, semana, max_semanas=ROT_MAX_SEMANAS_HISTORIAL):
    """Pisa (u agrega) la entrada de 'semana' con 'filas_semana' y recorta a
    las 'max_semanas' mas recientes (orden cronologico = orden alfabetico de
    la clave año-Www)."""
    historial = dict(historial) if isinstance(historial, dict) else {}
    historial[semana] = filas_semana
    claves = sorted(historial)[-max_semanas:]
    return {k: historial[k] for k in claves}


def _cuadrante(rs, delta, umbral=ROT_UMBRAL_RS):
    """None si no hay RS esa semana. Sin semana anterior (delta None) se
    trata como sin cambio (delta=0): el cuadrante queda definido solo por
    el nivel (liderando/rezagando segun este >= o < del umbral)."""
    if rs is None:
        return None
    delta = delta if delta is not None else 0.0
    if rs >= umbral:
        return "liderando" if delta >= 0 else "debilitando"
    return "recuperando" if delta >= 0 else "rezagando"


def _cuadrantes_de(hist_rs):
    """Cuadrante semana a semana de una serie de RS Score (con None donde
    falte), usando el delta contra la semana inmediata anterior."""
    cuadrantes = []
    for i, rs in enumerate(hist_rs):
        anterior = hist_rs[i - 1] if i > 0 else None
        delta = (rs - anterior) if rs is not None and anterior is not None else None
        cuadrantes.append(_cuadrante(rs, delta))
    return cuadrantes


def _aceleracion_inusual(hist_rs, cuadrantes):
    """True si el ticker estuvo 'estancado' (recuperando/rezagando) en
    ROT_MIN_ESTANCADAS o mas de las ROT_VENTANA_ACELERACION semanas previas
    al salto, ese tramo previo venia llano/bajando (cambio neto <=
    ROT_PREVIO_LLANO_MAX) y despues tuvo un salto de RS Score >=
    ROT_SALTO_MIN puntos en las ultimas 2 semanas (rs de hoy contra el de
    hace 2 semanas). Necesita al menos ROT_VENTANA_ACELERACION + 3 semanas
    de historial (sin ningun hueco en la ventana relevante) para evaluarse;
    si no hay suficiente historial, no se marca (False, no error)."""
    n = len(hist_rs)
    if n < ROT_VENTANA_ACELERACION + 3:
        return False
    ventana = cuadrantes[-(ROT_VENTANA_ACELERACION + 2) : -2]
    if len(ventana) < ROT_VENTANA_ACELERACION or any(c is None for c in ventana):
        return False
    estancadas = sum(1 for c in ventana if c in ("recuperando", "rezagando"))
    if estancadas < ROT_MIN_ESTANCADAS:
        return False
    hoy, hace2 = hist_rs[-1], hist_rs[-3]
    base = hist_rs[-(ROT_VENTANA_ACELERACION + 2)]
    if hoy is None or hace2 is None or base is None:
        return False
    if (hoy - hace2) < ROT_SALTO_MIN:
        return False
    return (hace2 - base) <= ROT_PREVIO_LLANO_MAX


def _cruce_fr_reciente(hist_fr, ventana=ROT_VENTANA_CRUCE_FR):
    """True si la linea de Fuerza Relativa (ticker / SPY) esta HOY arriba de
    su SMA50 y en alguna de las 'ventana' semanas anteriores estuvo abajo
    (o sea, cruzo hacia arriba en esa ventana). Resolucion semanal (el
    historial se guarda una vez por semana): 'ventana=2' es el equivalente
    semanal de "las ultimas ~2 semanas" pedido."""
    if not hist_fr or hist_fr[-1] is not True:
        return False
    anteriores = hist_fr[-(ventana + 1) : -1]
    return any(v is False for v in anteriores)


def rot_construir(historial, ahora_iso, n_semanas=ROT_SEMANAS_PUBLICADAS):
    """public/data/rotacion.json: {actualizado, semanas, acciones, etfs,
    recien_a_lideres, aceleracion_inusual} a partir del historial acumulado.
    Un ticker que no aparece en la semana mas reciente del historial (dejo
    de tener RS, ej. se cayo del universo USD) no se publica."""
    semanas = sorted(historial)[-n_semanas:]
    tickers = sorted({t for s in semanas for t in (historial.get(s) or {})})
    salida = {
        "actualizado": ahora_iso,
        "semanas": semanas,
        "acciones": [],
        "etfs": [],
        "recien_a_lideres": [],
        "aceleracion_inusual": [],
    }
    for t in tickers:
        semana_por_t = [(historial.get(s) or {}).get(t) for s in semanas]
        hist_rs = [f.get("rs_score") if f else None for f in semana_por_t]
        hist_fr = [f.get("fr_sobre_sma50") if f else None for f in semana_por_t]
        if hist_rs[-1] is None:
            continue  # no tiene RS esta semana: no se publica (ya no esta en el universo USD)
        ultimo = next(f for f in reversed(semana_por_t) if f)
        cuadrantes = _cuadrantes_de(hist_rs)
        cuadrante_hoy, cuadrante_prev = cuadrantes[-1], (cuadrantes[-2] if len(cuadrantes) >= 2 else None)
        fila = {
            "ticker": t,
            "nombre": ultimo.get("nombre"),
            "sector": ultimo.get("sector"),
            "market_cap_usd": ultimo.get("market_cap_usd"),
            "rs_score": hist_rs[-1],
            "rs_score_semana_ant": hist_rs[-2] if len(hist_rs) >= 2 else None,
            "cuadrante": cuadrante_hoy,
            "historial": hist_rs,
        }
        salida["etfs" if ultimo.get("es_etf") else "acciones"].append(fila)
        if cuadrante_hoy == "liderando" and cuadrante_prev in ("recuperando", "rezagando"):
            salida["recien_a_lideres"].append(t)
        if _aceleracion_inusual(hist_rs, cuadrantes):
            salida["aceleracion_inusual"].append(
                {"ticker": t, "fr_sobre_sma50_cruce_reciente": _cruce_fr_reciente(hist_fr)}
            )
    for grupo in ("acciones", "etfs"):
        salida[grupo].sort(key=lambda f: (-(f["rs_score"] if f["rs_score"] is not None else -1), f["ticker"]))
    return salida
