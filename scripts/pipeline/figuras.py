"""Figuras chartistas: Doble Techo, Doble Piso, Hombro-Cabeza-Hombro (HCH) y
HCH invertido, detectadas sobre la MISMA secuencia de swings de ws_zigzag
(scripts/pipeline/vcp.py) que usa el VCP. Es una feature INDEPENDIENTE del
Warren Score (no entra a ningun pilar): vive en su propia pagina
(FigurasChartistas.jsx) y su propio JSON (public/data/figuras.json).

Mismo umbral adaptativo del ZigZag que el VCP: max(3%, 1,5 x ATR14%)
(FG_UMBRAL_MIN / FG_UMBRAL_ATR, mismos valores que vcp.py para que las dos
detecciones "vean" la misma estructura de swings). Ventana de busqueda mas
ancha que la del VCP (FG_VENTANA=150 vs 120 ruedas): un Hombro-Cabeza-Hombro
necesita 5 swings (2 hombros + cabeza + los 2 puntos de la neckline) y tarda
mas en formarse que una base VCP (3-4 swings).

Ciclo de vida (misma idea que ws_ciclo_vcp: cortar el historial en cada una
de las ultimas ~15 ruedas para ver si la figura YA rompio o fallo, porque la
ruptura crea un swing nuevo y la deteccion de HOY ya no ve la figura vieja):
  Formándose            estructura completa (los extremos + la neckline ya
                         estan), todavia sin romper la neckline
  Recién rompió          rompio la neckline en las ultimas 3 ruedas
  Rompió y confirmó      rompio hace 3-15 ruedas y hubo seguimiento (se alejo
                         >=3% del otro lado de la neckline o 2 cierres
                         seguidos a favor)
  Rompió sin confirmar   rompio hace 3-15 ruedas, no volvio a cruzar la
                         neckline pero tampoco hubo seguimiento
  Falló antes de romper  el precio invalido la figura (superó/perforó sus
                         propios extremos) antes de llegar a romper la
                         neckline
  Rompió y falló         rompio la neckline y despues volvio >=3% para el
                         otro lado (ruptura falsa / trampa)

Doble Techo y Doble Piso son bajista/alcista respectivamente (ruptura hacia
ABAJO / hacia ARRIBA de la neckline); H-C-H es bajista, H-C-H invertido es
alcista. Por eso 'bajista' (bool) parametriza toda la logica compartida.
"""

import numpy as np

from comun import atr_serie, es_valido, lineal, num

from .vcp import ws_zigzag
from .warren import ohlcv_limpio

FG_VENTANA = 150  # ruedas de la ventana de busqueda (mas ancha que la del VCP: el HCH necesita 5 swings)
FG_MIN_RUEDAS = 90  # minimo de historia para intentar (tiene que caber al menos un HCH + margen)
FG_UMBRAL_MIN = 3.0  # % minimo del umbral adaptativo del ZigZag (mismo valor que vcp.py)
FG_UMBRAL_ATR = 1.5  # multiplicador de ATR14% del umbral (mismo valor que vcp.py)

FG_TOL_SIMETRIA_DOBLE = 3.0  # % de tolerancia entre los dos techos/pisos del doble techo/piso
FG_MIN_VALLE_DOBLE = 5.0  # % minimo que el valle/pico intermedio tiene que estar mas alla de los dos extremos
FG_TOL_HOMBROS = 5.0  # % de tolerancia entre los dos hombros del HCH
FG_MIN_CABEZA = 3.0  # % minimo que la cabeza tiene que sobresalir del promedio de los hombros
FG_TOL_NECKLINE_HCH = 8.0  # % maximo de diferencia entre los dos puntos de la neckline del HCH (si no, es un canal, no un cuello)
FG_MAX_ANTIGUEDAD = 40  # ruedas: el extremo que cierra la figura (2do techo/piso o hombro derecho) no puede ser mas viejo que esto

FG_RUEDAS_CICLO = 15  # ruedas hacia atras donde se busca la ruptura (o la falla) de la figura (mismo criterio que VCP_RUEDAS_CICLO)
FG_RUEDAS_RECIEN = 3  # "Recién rompió": ruptura en las ultimas 3 ruedas
FG_TOL_FALLA = 3.0  # % del otro lado de la neckline que, despues de romper, cuenta como ruptura fallida
FG_SEGUIMIENTO = 3.0  # % a favor de la ruptura que confirma seguimiento (o 2 cierres seguidos a favor)
FG_SCORE_MIN = 55  # score minimo para publicar la figura (mas bajo que el del VCP: son patrones mas raros, si no la pagina queda vacia casi siempre)

FG_RADIO_VOL = 2  # ruedas a cada lado de un swing donde se promedia el volumen (para comparar hombro/techo vs. el otro)
FG_CLIMAX_VOL = 1.5  # volumen >= 1,5x el promedio de 20 ruedas cuenta como "clímax" en la ruptura

TIPOS = ("doble_techo", "doble_piso", "hch", "hch_invertido")
NOMBRE_TIPO = {
    "doble_techo": "Doble Techo",
    "doble_piso": "Doble Piso",
    "hch": "Hombro-Cabeza-Hombro",
    "hch_invertido": "HCH Invertido",
}
BAJISTA = {"doble_techo": True, "doble_piso": False, "hch": True, "hch_invertido": False}


def _umbral(atr_pct):
    return max(FG_UMBRAL_MIN, FG_UMBRAL_ATR * atr_pct) if es_valido(atr_pct) else FG_UMBRAL_MIN


def _swings_ventana(df, atr_pct):
    sub = df.tail(FG_VENTANA)
    high, low = sub["High"].values, sub["Low"].values
    return sub, ws_zigzag(high, low, _umbral(atr_pct))


def _nivel_recta(p1, precio1, p2, precio2):
    """Recta entre dos puntos (posicion, precio); si son el mismo punto (los
    dobles techo/piso tienen una neckline de un solo punto) devuelve un nivel
    constante. Se evalua en cualquier posicion (incluso futuras: es como se
    interpola/extrapola la neckline con pendiente para saber si un cierre
    posterior la rompio)."""
    if p2 == p1:
        return lambda i: precio1
    pend = (precio2 - precio1) / (p2 - p1)
    return lambda i: precio1 + pend * (i - p1)


def _vol_prom(vol, pos, radio=FG_RADIO_VOL):
    a, b = max(0, pos - radio), min(len(vol) - 1, pos + radio)
    return float(vol[a : b + 1].mean())


def _spike_ruptura(close, vol, nivel_fn, pos_fin, bajista):
    """Si la figura YA rompio su neckline dentro de esta misma ventana
    (despues de 'pos_fin', el swing que la cierra), devuelve si esa ruptura
    tuvo clímax de volumen (>= 1,5x el promedio de las 20 ruedas previas).
    None/False si todavia no rompio en esta ventana (el score de volumen de
    ruptura queda en 0: aplica solo cuando ya se puede evaluar)."""
    n = len(close)
    for i in range(pos_fin + 1, n):
        nivel = nivel_fn(i)
        cruzo = close[i] < nivel if bajista else close[i] > nivel
        if cruzo:
            prom20 = vol[max(0, i - 20) : i].mean()
            return bool(prom20 > 0 and vol[i] / prom20 >= FG_CLIMAX_VOL)
    return False


def _detectar_doble(df, atr_pct, bajista):
    """Doble Techo (bajista=True) / Doble Piso (bajista=False): dos swings
    del mismo signo (H-H para el techo, L-L para el piso) de altura/
    profundidad similar (tolerancia +-3%, FG_TOL_SIMETRIA_DOBLE), separados
    por EXACTAMENTE un swing intermedio del signo contrario que este al
    menos 5% (FG_MIN_VALLE_DOBLE) mas alla de los dos extremos. Al ser
    swings CONSECUTIVOS de ws_zigzag (que alterna H/L siempre), cualquier
    par de H (o L) consecutivos en la lista ya cumple "separados por
    exactamente un swing intermedio" sin nada mas que chequear. Se toma la
    ULTIMA terna valida de la ventana (la mas reciente) cuyo segundo extremo
    no tenga mas de FG_MAX_ANTIGUEDAD ruedas. La neckline es ese swing
    intermedio (nivel constante, sin pendiente).

    score (0-100) = simetria (35: lineal(diff%, 3%, 0%, 0, 35), mas
    parecidos = mas puntos) + profundidad del valle/pico en unidades de
    ATR14% (35: lineal(profundidad/ATR%, 1.5, 5, 0, 35), una base angosta
    relativa a la volatilidad de la accion vale menos) + volumen (30: 15 si
    el segundo extremo tuvo MENOS volumen promedio que el primero -regla
    clasica de Edwards & Magee-, +15 si ya rompio la neckline con clímax de
    volumen en esta misma ventana)."""
    vacio = {"detectado": False, "score": 0}
    if len(df) < FG_MIN_RUEDAS:
        return vacio
    sub, swings = _swings_ventana(df, atr_pct)
    tipo_extremo, tipo_medio = ("H", "L") if bajista else ("L", "H")
    n = len(sub)
    close, vol = sub["Close"].values, sub["Volume"].fillna(0).values
    mejor = None
    for i in range(len(swings) - 2):
        s1, s2, s3 = swings[i], swings[i + 1], swings[i + 2]
        if not (s1[1] == tipo_extremo and s2[1] == tipo_medio and s3[1] == tipo_extremo):
            continue
        p1, p2, p3 = s1[2], s2[2], s3[2]
        ref = min(p1, p3) if bajista else max(p1, p3)
        if not ref:
            continue
        simetria_pct = abs(p1 - p3) / ref * 100
        if simetria_pct > FG_TOL_SIMETRIA_DOBLE:
            continue
        profundidad_pct = (ref - p2) / ref * 100 if bajista else (p2 - ref) / ref * 100
        if profundidad_pct < FG_MIN_VALLE_DOBLE:
            continue
        if (n - 1) - s3[0] > FG_MAX_ANTIGUEDAD:
            continue
        mejor = (s1, s2, s3, simetria_pct, profundidad_pct)
    if mejor is None:
        return vacio
    s1, s2, s3, simetria_pct, profundidad_pct = mejor
    p1, p2, p3 = s1[2], s2[2], s3[2]
    nivel_fn = _nivel_recta(s2[0], p2, s2[0], p2)
    breakout_spike = _spike_ruptura(close, vol, nivel_fn, s3[0], bajista)

    pts_simetria = lineal(simetria_pct, FG_TOL_SIMETRIA_DOBLE, 0, 0, 35)
    profundidad_atr = profundidad_pct / atr_pct if es_valido(atr_pct) and atr_pct else profundidad_pct / 3.0
    pts_profundidad = lineal(profundidad_atr, 1.5, 5.0, 0, 35)
    vol1, vol3 = _vol_prom(vol, s1[0]), _vol_prom(vol, s3[0])
    pts_vol = (15 if vol3 < vol1 else 0) + (15 if breakout_spike else 0)
    score = min(100.0, pts_simetria + pts_profundidad + pts_vol)

    # Ver el comentario equivalente en _detectar_hch: 'pos_neckline' tiene
    # que quedar en posiciones ABSOLUTAS de 'df' (aca da lo mismo porque la
    # neckline del doble techo/piso es un solo punto sin pendiente, pero se
    # corrige igual para no depender de ese detalle de implementacion).
    desplazamiento = len(df) - n
    return {
        "detectado": True,
        "score": num(score, 1),
        "pos_neckline": (s2[0] + desplazamiento, p2, s2[0] + desplazamiento, p2),
        "nivel_invalidacion": max(p1, p3) if bajista else min(p1, p3),
        "detalle": {
            "extremo_1": {"hace": int(n - 1 - s1[0]), "precio": num(p1, 2)},
            "extremo_2": {"hace": int(n - 1 - s3[0]), "precio": num(p3, 2)},
            "neckline_precio": num(p2, 2),
            "neckline_hace": int(n - 1 - s2[0]),
            "neckline_pendiente_pct": 0.0,
            "simetria_pct": num(simetria_pct, 2),
            "profundidad_pct": num(profundidad_pct, 2),
            "vol_decreciente": bool(vol3 < vol1),
        },
    }


def _detectar_hch(df, atr_pct, bajista):
    """H-C-H (bajista=True): 5 swings CONSECUTIVOS H-L-H-L-H con la cabeza
    (el H del medio) al menos FG_MIN_CABEZA% mas alta que el promedio de los
    dos hombros (H1 y H5), hombros dentro de +-5% entre si (FG_TOL_HOMBROS).
    La neckline es la recta entre los dos L intermedios (L2 y L4); si estan a
    mas de FG_TOL_NECKLINE_HCH% uno del otro se descarta (seria un canal, no
    un cuello razonablemente horizontal). H-C-H invertido (bajista=False):
    mismo esquema con L-H-L-H-L, cabeza mas BAJA que los hombros. Se toma la
    ULTIMA quintupla valida cuyo hombro derecho no tenga mas de
    FG_MAX_ANTIGUEDAD ruedas.

    score (0-100) = simetria de hombros (30: lineal(diff%, 5%, 0%, 0, 30)) +
    prominencia de la cabeza en unidades de ATR14% (35:
    lineal(prominencia/ATR%, 1, 5, 0, 35)) + volumen (35, regla clasica de
    Edwards & Magee: hasta 20 si el volumen promedio decrece hombro
    izquierdo -> cabeza y/o -> hombro derecho -10 por cada uno de los dos
    que baja-, +15 si ya rompio la neckline con clímax de volumen)."""
    vacio = {"detectado": False, "score": 0}
    if len(df) < FG_MIN_RUEDAS:
        return vacio
    sub, swings = _swings_ventana(df, atr_pct)
    tipo_hombro, tipo_valle = ("H", "L") if bajista else ("L", "H")
    n = len(sub)
    close, vol = sub["Close"].values, sub["Volume"].fillna(0).values
    mejor = None
    for i in range(len(swings) - 4):
        s = swings[i : i + 5]
        if [x[1] for x in s] != [tipo_hombro, tipo_valle, tipo_hombro, tipo_valle, tipo_hombro]:
            continue
        hi, l1, cab, l2, hd = s
        p_hi, p_l1, p_cab, p_l2, p_hd = (x[2] for x in s)
        ref_hombros = (p_hi + p_hd) / 2
        if not ref_hombros or not min(p_hi, p_hd):
            continue
        simetria_pct = abs(p_hi - p_hd) / min(p_hi, p_hd) * 100
        if simetria_pct > FG_TOL_HOMBROS:
            continue
        prominencia_pct = (p_cab - ref_hombros) / ref_hombros * 100 if bajista else (ref_hombros - p_cab) / ref_hombros * 100
        if prominencia_pct < FG_MIN_CABEZA:
            continue
        ref_neck = min(p_l1, p_l2) if bajista else max(p_l1, p_l2)
        if not ref_neck:
            continue
        pend_neck_pct = abs(p_l1 - p_l2) / ref_neck * 100
        if pend_neck_pct > FG_TOL_NECKLINE_HCH:
            continue
        if (n - 1) - hd[0] > FG_MAX_ANTIGUEDAD:
            continue
        mejor = (hi, l1, cab, l2, hd, simetria_pct, prominencia_pct)
    if mejor is None:
        return vacio
    hi, l1, cab, l2, hd, simetria_pct, prominencia_pct = mejor
    p_hi, p_l1, p_cab, p_l2, p_hd = hi[2], l1[2], cab[2], l2[2], hd[2]
    # nivel_fn LOCAL a 'sub' (para el clímax de ruptura DENTRO de esta misma
    # ventana, mas abajo): valido porque tanto la posicion de anclaje como
    # las posiciones donde se evalua son locales, todas en el mismo marco.
    nivel_fn = _nivel_recta(l1[0], p_l1, l2[0], p_l2)
    pendiente_pct = (p_l2 - p_l1) / (l2[0] - l1[0]) / ((p_l1 + p_l2) / 2) * 100 if l2[0] != l1[0] else 0.0
    breakout_spike = _spike_ruptura(close, vol, nivel_fn, hd[0], bajista)

    pts_simetria = lineal(simetria_pct, FG_TOL_HOMBROS, 0, 0, 30)
    prominencia_atr = prominencia_pct / atr_pct if es_valido(atr_pct) and atr_pct else prominencia_pct / 3.0
    pts_prominencia = lineal(prominencia_atr, 1.0, 5.0, 0, 35)
    vi, vc, vd = _vol_prom(vol, hi[0]), _vol_prom(vol, cab[0]), _vol_prom(vol, hd[0])
    pts_vol_decrec = {0: 0, 1: 10, 2: 20}[int(vc < vi) + int(vd < vi)]
    pts_vol = min(35, pts_vol_decrec + (15 if breakout_spike else 0))
    score = min(100.0, pts_simetria + pts_prominencia + pts_vol)

    # 'sub' es la COLA de 'df' (df.tail(FG_VENTANA)): las posiciones de los
    # swings son locales a 'sub'. _ciclo() evalua la neckline en posiciones
    # ABSOLUTAS del 'df' completo (para poder interpolar/extrapolar contra
    # cierres de fechas futuras, incluso mucho despues de esta ventana), asi
    # que hay que correrlas por el desplazamiento entre 'sub' y 'df' antes de
    # guardarlas en 'pos_neckline' (si no, con mas historial que FG_VENTANA
    # la pendiente se extrapola miles de posiciones de mas y el nivel
    # "de hoy" da un numero absurdo).
    desplazamiento = len(df) - n
    return {
        "detectado": True,
        "score": num(score, 1),
        "pos_neckline": (l1[0] + desplazamiento, p_l1, l2[0] + desplazamiento, p_l2),
        "nivel_invalidacion": max(p_hi, p_cab, p_hd) if bajista else min(p_hi, p_cab, p_hd),
        "detalle": {
            "hombro_izquierdo": {"hace": int(n - 1 - hi[0]), "precio": num(p_hi, 2)},
            "cabeza": {"hace": int(n - 1 - cab[0]), "precio": num(p_cab, 2)},
            "hombro_derecho": {"hace": int(n - 1 - hd[0]), "precio": num(p_hd, 2)},
            "neckline_precio": num(p_l2, 2),
            "neckline_hace": int(n - 1 - l2[0]),
            "neckline_pendiente_pct": num(pendiente_pct, 3),
            "simetria_pct": num(simetria_pct, 2),
            "profundidad_pct": num(prominencia_pct, 2),
            "vol_decreciente": bool(int(vc < vi) + int(vd < vi) >= 1),
        },
    }


def _ciclo(df, atr_pct_s, detectar_fn, bajista, cache=None):
    """Ciclo de vida generico (Formándose / Recién rompió / Rompió y
    confirmó / Rompió sin confirmar / Falló antes de romper / Rompió y
    falló), igual mecanica que ws_ciclo_vcp: se re-detecta la figura con los
    datos cortados en cada una de las ultimas FG_RUEDAS_CICLO ruedas, porque
    la ruptura crea un swing nuevo y la deteccion de HOY ya no ve la figura
    vieja. Devuelve (hoy + "estado", fila) con fila = la figura de
    referencia (o None si nunca hubo una)."""
    n = len(df)
    closes = df["Close"].values
    cache = {} if cache is None else cache

    def det(i):
        if i not in cache:
            a = float(atr_pct_s.iloc[i])
            cache[i] = detectar_fn(df.iloc[: i + 1], a if es_valido(a) else None)
        return cache[i]

    hoy = det(n - 1)

    def fila(base, estado, **extra):
        nivel_fn = _nivel_recta(*base["pos_neckline"])
        nivel_hoy = nivel_fn(n - 1)
        precio = float(closes[-1])
        return {
            "score": base["score"],
            "detalle": base["detalle"],
            "neckline_precio_hoy": num(nivel_hoy, 2),
            "dist_neckline_pct": num((precio / nivel_hoy - 1) * 100, 2) if nivel_hoy else None,
            "estado": estado,
            **extra,
        }

    # 1. Ruptura en las ultimas FG_RUEDAS_CICLO ruedas (la mas reciente).
    for hace in range(0, FG_RUEDAS_CICLO + 1):
        b = n - 1 - hace
        if b < FG_MIN_RUEDAS:
            break
        # una ruptura bajista siempre cierra mas abajo que la rueda anterior (y al reves la alcista)
        if (closes[b] < closes[b - 1]) != bajista:
            continue
        base = det(b - 1)
        if not base["detectado"]:
            continue
        nivel_fn = _nivel_recta(*base["pos_neckline"])
        nivel_ant, nivel_b = nivel_fn(b - 1), nivel_fn(b)
        cruce = (closes[b - 1] >= nivel_ant and closes[b] < nivel_b) if bajista else (closes[b - 1] <= nivel_ant and closes[b] > nivel_b)
        if not cruce:
            continue
        tramo = closes[b:]
        nivel_tramo = np.array([nivel_fn(b + k) for k in range(len(tramo))])
        dist_tramo = (tramo / nivel_tramo - 1) * 100
        if bajista:
            fallo = bool((dist_tramo > FG_TOL_FALLA).any())
        else:
            fallo = bool((dist_tramo < -FG_TOL_FALLA).any())
        if fallo:
            estado = "Rompió y falló"
        elif hace < FG_RUEDAS_RECIEN:
            estado = "Recién rompió"
        else:
            if bajista:
                seguimiento = dist_tramo.min() <= -FG_SEGUIMIENTO or int((tramo[1:] < tramo[0]).sum()) >= 2
                ok = bool((dist_tramo <= 0).all()) and seguimiento
            else:
                seguimiento = dist_tramo.max() >= FG_SEGUIMIENTO or int((tramo[1:] > tramo[0]).sum()) >= 2
                ok = bool((dist_tramo >= 0).all()) and seguimiento
            estado = "Rompió y confirmó" if ok else "Rompió sin confirmar"
        return {**hoy, "estado": estado}, fila(base, estado, hace_ruptura=hace)

    # 2. Figura completa hoy, sin ruptura todavia.
    if hoy["detectado"]:
        return {**hoy, "estado": "Formándose"}, fila(hoy, "Formándose")

    # 3. Figura que se invalido: el precio supero/perforo sus propios extremos antes de romper la neckline.
    for hace in range(1, FG_RUEDAS_CICLO + 1):
        i = n - 1 - hace
        if i < FG_MIN_RUEDAS:
            break
        base = det(i)
        if base["detectado"]:
            lim = base["nivel_invalidacion"]
            tramo = closes[i + 1 :]
            invalido = bool((tramo > lim).any()) if bajista else bool((tramo < lim).any())
            if invalido:
                return {**hoy, "estado": "Falló antes de romper"}, fila(base, "Falló antes de romper", hace_base=hace)
            break
    return {**hoy, "estado": None}, None


def fg_ciclo(tipo, df, atr_pct_s, cache=None):
    """ws_ciclo_vcp-like para 'tipo' en TIPOS: detecta + ciclo de vida."""
    bajista = BAJISTA[tipo]
    if tipo in ("doble_techo", "doble_piso"):
        detectar_fn = lambda d, a: _detectar_doble(d, a, bajista)  # noqa: E731
    else:
        detectar_fn = lambda d, a: _detectar_hch(d, a, bajista)  # noqa: E731
    return _ciclo(df, atr_pct_s, detectar_fn, bajista, cache=cache)


def figuras_ticker(hist):
    """Detecta las 4 figuras chartistas de un ticker (independiente del
    Warren Score / VCP: no necesita 200 ruedas ni cotizar en USD). Devuelve
    una lista de 0 a 4 dicts (una por tipo con estado != None y score >=
    FG_SCORE_MIN)."""
    df = ohlcv_limpio(hist)
    if len(df) < FG_MIN_RUEDAS:
        return []
    atr_pct_s = atr_serie(df["High"], df["Low"], df["Close"], 14) / df["Close"] * 100
    salida = []
    for tipo in TIPOS:
        hoy, ciclo = fg_ciclo(tipo, df, atr_pct_s)
        if not ciclo or ciclo["estado"] is None or (ciclo.get("score") or 0) < FG_SCORE_MIN:
            continue
        salida.append({"tipo": tipo, **ciclo})
    return salida


def construir_figuras(figuras_datos, rs_mapa, ahora_iso):
    """Segunda pasada (mismo patron que construir_senales): arma
    figuras.json agregando el RS Score (percentil vs SPY en el universo USD,
    calculado despues del loop principal) a cada figura detectada."""
    salida = {"actualizado": ahora_iso, "figuras": []}
    for d in figuras_datos:
        rs_hoy = (rs_mapa.get(d["ticker"], {}) or {}).get(0)
        for fig in d["figuras"]:
            salida["figuras"].append(
                {
                    "ticker": d["ticker"],
                    "nombre": d["nombre"],
                    "sector": d.get("sector"),
                    "tipo": fig["tipo"],
                    "estado": fig["estado"],
                    "score": fig["score"],
                    "detalle": {
                        **fig["detalle"],
                        "neckline_precio_hoy": fig.get("neckline_precio_hoy"),
                        "dist_neckline_pct": fig.get("dist_neckline_pct"),
                        "hace_ruptura": fig.get("hace_ruptura"),
                        "hace_base": fig.get("hace_base"),
                    },
                    "rs_hoy": rs_hoy,
                }
            )
    salida["figuras"].sort(key=lambda f: (-(f["score"] or 0), f["ticker"]))
    return salida
