"""VCP (Volatility Contraction Pattern): ZigZag adaptativo, deteccion de
la base y su ciclo de vida (armado / rompio / fallo). Lo usan el pilar C del
Warren Score y la pagina Señales (Bases VCP)."""

from comun import es_valido, lineal, num


WS_VENTANA_VCP = 120  # ruedas donde se busca el VCP


def ws_zigzag(high, low, umbral_pct):
    """Swings de un ZigZag sobre maximos/minimos: un giro se confirma cuando
    el precio se aleja 'umbral_pct' % del extremo vigente. Devuelve la lista
    [(posicion, 'H'|'L', precio)] con el ultimo extremo (todavia sin
    confirmar) al final."""
    u = umbral_pct / 100
    swings = []
    tendencia = None
    i_max = i_min = 0
    for i in range(len(high)):
        if tendencia is None:
            if high[i] > high[i_max]:
                i_max = i
            if low[i] < low[i_min]:
                i_min = i
            if high[i] >= low[i_min] * (1 + u) and i_min < i:
                swings.append((i_min, "L", low[i_min]))
                tendencia, i_ext = "sube", i
            elif low[i] <= high[i_max] * (1 - u) and i_max < i:
                swings.append((i_max, "H", high[i_max]))
                tendencia, i_ext = "baja", i
            continue
        if tendencia == "sube":
            if high[i] >= high[i_ext]:
                i_ext = i
            elif low[i] <= high[i_ext] * (1 - u):
                swings.append((i_ext, "H", high[i_ext]))
                tendencia, i_ext = "baja", i
        else:
            if low[i] <= low[i_ext]:
                i_ext = i
            elif high[i] >= low[i_ext] * (1 + u):
                swings.append((i_ext, "L", low[i_ext]))
                tendencia, i_ext = "sube", i
    if tendencia == "sube":
        swings.append((i_ext, "H", high[i_ext]))
    elif tendencia == "baja":
        swings.append((i_ext, "L", low[i_ext]))
    return swings


def ws_detectar_vcp(df, atr_pct):
    """VCP (Volatility Contraction Pattern), deteccion propia: ZigZag con
    umbral adaptativo max(3%, 1.5 × ATR14%) sobre las ultimas ~120 ruedas.
    La base arranca en el swing high mas alto; cada tramo maximo -> minimo
    siguiente es una contraccion (profundidad % desde el maximo). Hay VCP si
    las ultimas >= 2 contracciones son cada una menos profunda que la
    anterior (10% de tolerancia), la ultima mide <= 12% y el precio esta
    entre 10% abajo y 2% arriba del pivote (maximo de la base)."""
    vacio = {"detectado": False, "score": 0, "contracciones": 0, "dist_pivote_pct": None, "pivote": None,
             "vol_decreciente": False, "profundidades": []}
    sub = df.tail(WS_VENTANA_VCP)
    if len(sub) < 40:
        return vacio
    high, low = sub["High"].values, sub["Low"].values
    vol = sub["Volume"].fillna(0).values
    umbral = max(3.0, 1.5 * atr_pct) if es_valido(atr_pct) else 3.0
    swings = ws_zigzag(high, low, umbral)
    maximos = [s for s in swings if s[1] == "H"]
    if not maximos:
        return vacio
    tope = max(maximos, key=lambda s: s[2])
    base = [s for s in swings if s[0] >= tope[0]]
    contracciones = []  # (profundidad %, pos. maximo, pos. minimo)
    for s1, s2 in zip(base, base[1:]):
        if s1[1] == "H" and s2[1] == "L" and s1[2]:
            contracciones.append(((s1[2] - s2[2]) / s1[2] * 100, s1[0], s2[0], s2[2]))
    pivote = float(tope[2])
    precio = float(sub["Close"].iloc[-1])
    dist = (precio / pivote - 1) * 100
    # Cadena final de contracciones decrecientes (desde la ultima para atras).
    n = 1 if contracciones else 0
    for k in range(len(contracciones) - 1, 0, -1):
        if contracciones[k][0] <= contracciones[k - 1][0] * 1.1:
            n += 1
        else:
            break
    vol_decreciente = False
    if len(contracciones) >= 2:
        _, h1, l1, _ = contracciones[-1]
        _, h0, l0, _ = contracciones[-2]
        v_ult, v_prev = vol[h1 : l1 + 1].mean(), vol[h0 : l0 + 1].mean()
        vol_decreciente = bool(v_prev > 0 and v_ult < v_prev)
    ultima = contracciones[-1][0] if contracciones else None
    detectado = bool(n >= 2 and ultima is not None and ultima <= 12 and -10 <= dist <= 2)
    score = 0.0
    if detectado:
        score = {2: 50, 3: 70}.get(n, 85)
        score += lineal(ultima, 12, 3, 0, 10)  # mas apretada, mas puntos
        score += lineal(dist, -10, -2, 0, 5)  # mas cerca del pivote, mas puntos
        score += 5 if vol_decreciente else 0
        score = min(100.0, score)
    return {
        "detectado": detectado,
        "score": num(score, 1),
        "contracciones": int(n),
        "dist_pivote_pct": num(dist, 2),
        "pivote": num(pivote, 2),
        "vol_decreciente": vol_decreciente,
        "profundidades": [num(c[0], 1) for c in contracciones[-4:]],
        # minimo de la ultima contraccion: si un cierre lo perfora antes de
        # romper el pivote, la base fallo (ver ws_ciclo_vcp)
        "min_ultima": num(contracciones[-1][3], 2) if contracciones else None,
        # el minimo de la ultima contraccion ya giro (hubo rebote >= umbral
        # desde ahi); si es el ultimo extremo del ZigZag todavia se esta formando
        "ultima_confirmada": bool(contracciones and swings[-1][0] != contracciones[-1][2]),
    }


# Ciclo de vida de la base VCP (pagina Señales · Bases VCP). Si se toca un
# umbral aca, tocarlo tambien en la explicacion de src/pages/Senales.jsx.
VCP_RUEDAS_CICLO = 15  # ruedas hacia atras donde se busca la ruptura (o la falla) de la base
VCP_RUEDAS_RECIEN = 3  # "Recién rompió": primer cierre sobre el pivote en las ultimas 3 ruedas (hace 0-2)
VCP_TOL_FALLA = 3.0  # % bajo el pivote que, despues de romper, cuenta como ruptura fallida
VCP_SEGUIMIENTO = 3.0  # % sobre el pivote que confirma la ruptura (o 2 cierres mas altos que el de la ruptura)
VCP_ULTIMA_ARMADO = 8.0  # la ultima contraccion tiene que medir <= 8% para "Armado"
VCP_DIST_ARMADO = -5.0  # ... y el precio estar a <= 5% abajo del pivote


def ws_ciclo_vcp(df, atr_pct_s, cache=None):
    """VCP de hoy (el mismo de ws_detectar_vcp, que puntua el pilar C) mas
    el ESTADO de la base en su ciclo de vida. Para saber si una base ya
    rompio o fallo hay que mirarla como estaba ANTES: la ruptura crea un
    maximo nuevo y ws_detectar_vcp de hoy ya no la ve. Se re-detecta el VCP
    con los datos cortados en cada una de las ultimas ~15 ruedas:
      1. Ruptura en la rueda b = el VCP detectado al cierre de b-1 tiene
         pivote P, cierre(b-1) <= P < cierre(b). Desde b: algun cierre
         < P x 0,97 -> "Rompió y falló"; si no, b en las ultimas 3 ruedas ->
         "Recién rompió"; si no, todos los cierres >= P y seguimiento
         (maximo cierre >= P x 1,03 o 2 cierres mas altos que el de b) ->
         "Rompió y confirmó"; si no -> "Rompió sin confirmar".
      2. Sin ruptura y VCP detectado hoy: ultima contraccion <= 8% y precio
         entre -5% y 0% del pivote -> "Armado"; si no -> "Formándose".
      3. Sin VCP hoy pero con uno detectado en las ultimas 15 ruedas cuya
         ultima contraccion ya habia girado (minimo confirmado por el
         ZigZag), y un cierre posterior abajo de ese minimo ->
         "Falló antes de romper".
    Devuelve (vcp_hoy + "estado", ciclo) con ciclo = la base de referencia
    (o None si no hay base).

    'cache' (opcional): dict posicion -> VCP detectado con los datos hasta
    esa rueda. El backtest (scripts/backtest_senales.py) evalua el ciclo con
    df cortado en cada rueda del historial y comparte el cache entre cortes
    del MISMO df (la deteccion en la rueda i solo depende de df[:i+1])."""
    n = len(df)
    closes = df["Close"].values
    cache = {} if cache is None else cache

    def det(i):  # VCP con los datos hasta la rueda i inclusive
        if i not in cache:
            a = float(atr_pct_s.iloc[i])
            cache[i] = ws_detectar_vcp(df.iloc[: i + 1], a if es_valido(a) else None)
        return cache[i]

    hoy = det(n - 1)
    precio = float(closes[-1])

    def fila(base, estado, **extra):
        piv = base["pivote"]
        return {
            "estado": estado,
            "score": base["score"],
            "contracciones": base["contracciones"],
            "profundidades": base["profundidades"],
            "pivote": piv,
            "dist_pivote_pct": num((precio / piv - 1) * 100, 2) if piv else None,
            "vol_decreciente": base["vol_decreciente"],
            **extra,
        }

    # 1. Ruptura en las ultimas VCP_RUEDAS_CICLO ruedas (la mas reciente).
    for hace in range(0, VCP_RUEDAS_CICLO + 1):
        b = n - 1 - hace
        if b < 41:
            break
        if closes[b] <= closes[b - 1]:  # una ruptura siempre cierra arriba de la rueda anterior
            continue
        base = det(b - 1)
        piv = base["pivote"]
        if not base["detectado"] or not piv or not (closes[b - 1] <= piv < closes[b]):
            continue
        tramo = closes[b:]
        if tramo.min() < piv * (1 - VCP_TOL_FALLA / 100):
            estado = "Rompió y falló"
        elif hace < VCP_RUEDAS_RECIEN:
            estado = "Recién rompió"
        else:
            seguimiento = tramo.max() >= piv * (1 + VCP_SEGUIMIENTO / 100) or int((tramo[1:] > tramo[0]).sum()) >= 2
            estado = "Rompió y confirmó" if tramo.min() >= piv and seguimiento else "Rompió sin confirmar"
        return {**hoy, "estado": estado}, fila(base, estado, hace_ruptura=hace)

    # 2. Base viva hoy.
    if hoy["detectado"]:
        ultima = hoy["profundidades"][-1] if hoy["profundidades"] else None
        dist = hoy["dist_pivote_pct"]
        armado = ultima is not None and ultima <= VCP_ULTIMA_ARMADO and dist is not None and VCP_DIST_ARMADO <= dist <= 0
        estado = "Armado" if armado else "Formándose"
        return {**hoy, "estado": estado}, fila(hoy, estado)

    # 3. Base que se deshizo perforando su ultima contraccion.
    for hace in range(1, VCP_RUEDAS_CICLO + 1):
        i = n - 1 - hace
        if i < 40:
            break
        base = det(i)
        if base["detectado"]:
            # Solo cuenta perforar un minimo YA confirmado: si la ultima
            # contraccion seguia abierta, un cierre mas bajo solo la hace
            # mas profunda (no es una falla de la base).
            if base["ultima_confirmada"] and base["min_ultima"] and closes[i + 1 :].min() < base["min_ultima"]:
                return {**hoy, "estado": "Falló antes de romper"}, fila(base, "Falló antes de romper", hace_base=hace)
            break
    return {**hoy, "estado": None}, None
