"""Armado de las filas de un ticker (listado / medias / fundamentales /
screener / scanner / mensual / warren / señales) y el arrastre del ultimo
dato bueno (stale) de los que fallan en la corrida."""

from datetime import datetime

import pandas as pd

from comun import moneda_por_sufijo, num, rsi_wilder, sig

from .fundamentales import (
    anular_ratios_mixtos,
    calcular_dividend_yield,
    extraer_dividendos,
    extraer_fundamentales,
    extraer_pre_post_market,
    extraer_proximo_earnings,
)
from .senales import senales_ticker
from .tecnico import (
    calcular_beta_sharpe,
    calcular_estacionalidad_y_mensual,
    calcular_screener,
    calcular_setup_scanner,
    dist_pct,
    sesion_en_curso,
)
from .warren import ws_calcular_ticker


# Arrastre de datos viejos: si un ticker falla, se publica el ultimo dato
# bueno marcado stale, pero no para siempre (SNP.BA quedo arrastrado desde
# julio): pasados estos dias se descarta.
DIAS_MAX_ARRASTRE = 7

# Campos que existian en versiones anteriores del JSON y ya no se publican:
# se limpian tambien de las filas arrastradas (stale) de corridas viejas.
CAMPOS_ELIMINADOS = {"book_value", "fcf_por_accion"}
CAMPOS_ELIMINADOS_SCREENER = {"dist_clave", "dist_asl", "ma_clave"}


def _limpiar_fila_vieja(fila):
    fila = {k: v for k, v in fila.items() if k not in CAMPOS_ELIMINADOS}
    for tf in ("diario", "semanal", "mensual"):
        if isinstance(fila.get(tf), dict):
            fila[tf] = {k: v for k, v in fila[tf].items() if k not in CAMPOS_ELIMINADOS_SCREENER}
    return fila


def _edad_dias(ts_iso, ahora):
    try:
        return (ahora - datetime.fromisoformat(ts_iso)).total_seconds() / 86400
    except (TypeError, ValueError):
        return None


def procesar_ticker(fila, sym, hist, info_datos, ctx):
    """Calcula todas las filas (listado/medias/fundamentales/screener/
    scanner/warren/mensual) de un ticker ya descargado. Cualquier excepcion
    la maneja el llamador mandandolo al camino de arrastre."""
    t = fila["Ticker"]
    _, info, insider, holdings = info_datos
    pf = ctx["prev_fundamentales"].get(sym) or {}
    closes = hist["Close"].dropna()

    # Si Yahoo no devolvio .info (quoteSummary 404, rate-limit), se reusan
    # los datos "lentos" de la corrida anterior en vez de publicar None /
    # "Sin clasificar": nombre, industria, ratios, analistas, insiders.
    sin_info = not info
    quote_type = info.get("quoteType")
    es_fondo = quote_type in ("ETF", "MUTUALFUND")
    industria_prev = pf.get("industria") if pf.get("industria") not in (None, "", "Sin clasificar") else None

    nombre = fila["Nombre"] or info.get("shortName") or info.get("longName") or pf.get("nombre") or sym
    # "industry" es la clasificacion granular de Yahoo (ej. "Semiconductors"),
    # mas especifica que "sector" (ej. "Technology"). Los ETF no tienen ni
    # una ni otra en Yahoo (eran 49 "Sin clasificar"): se agrupan como "ETF".
    industria = (
        fila["Industria"]
        or info.get("industry")
        or info.get("sector")
        or ("ETF" if es_fondo else None)
        or industria_prev
        or "Sin clasificar"
    )
    pais = fila["Pais"] or info.get("country") or pf.get("pais") or "Sin país"
    moneda = info.get("currency") or pf.get("moneda") or moneda_por_sufijo(sym)
    moneda_financiera = info.get("financialCurrency") or (pf.get("moneda_financiera") if sin_info else None)
    en_usd = moneda == "USD"

    precio = float(closes.iloc[-1])
    anterior = float(closes.iloc[-2])
    var_pct = (precio / anterior - 1) * 100 if anterior else None
    rsi = rsi_wilder(closes.values, 14)

    ema21 = closes.ewm(span=21, adjust=False).mean().iloc[-1]
    ema50 = closes.ewm(span=50, adjust=False).mean().iloc[-1]
    ema150 = closes.ewm(span=150, adjust=False).mean().iloc[-1]
    sma200 = closes.rolling(200).mean().iloc[-1] if len(closes) >= 200 else None

    # Sin "actualizado" por fila: el timestamp global esta en meta.json y
    # solo las filas arrastradas (stale) llevan el suyo. Asi una corrida sin
    # datos nuevos no genera diff.
    base = {"ticker": sym, "nombre": nombre, "industria": industria, "pais": pais, "stale": False}

    # Sparkline: ultimas ~180 ruedas (~8-9 meses) de cierre, a 4 cifras
    # significativas (alcanza para dibujarlo y pesa bastante menos).
    spark = [sig(x, 4) for x in closes.tail(180).tolist()]
    ventana_52w = closes.tail(min(len(closes), 252))
    high_52w = float(ventana_52w.max())
    low_52w = float(ventana_52w.min())

    # Volumen de la ultima rueda CERRADA vs. promedio de las 20 anteriores.
    # Si la corrida cae con el mercado abierto, la ultima vela tiene volumen
    # parcial (a las 11 de la mañana siempre daba "volumen bajo"): en ese
    # caso se usa la rueda anterior. vol_fecha dice que rueda se midio.
    volumen = hist["Volume"].dropna() if "Volume" in hist.columns else pd.Series(dtype=float)
    fin = -1
    if len(volumen) >= 2 and sesion_en_curso(sym, volumen.index[-1], ctx["ahora_utc"]):
        fin = -2
    vol_hoy = vol_prom20 = vol_fecha = None
    if len(volumen) >= -fin:
        vol_hoy = float(volumen.iloc[fin])
        vol_fecha = volumen.index[fin].strftime("%Y-%m-%d")
        previos = volumen.iloc[fin - 20 : fin]
        if len(previos) == 20:
            vol_prom20 = float(previos.mean())
    vol_ratio = (vol_hoy / vol_prom20) if vol_hoy and vol_prom20 else None

    # Gap de apertura: hueco entre el cierre de ayer y la apertura de hoy.
    apertura_hoy = float(hist["Open"].iloc[-1]) if "Open" in hist.columns and len(hist) else None
    gap_pct = ((apertura_hoy / anterior) - 1) * 100 if apertura_hoy and anterior else None

    filas = {}
    filas["listado"] = {
        **base,
        "var_pct": num(var_pct, 2),
        "rsi": num(rsi, 2),
        "spark": spark,
        "high_52w": num(high_52w, 2),
        "low_52w": num(low_52w, 2),
        "vol_hoy": int(vol_hoy) if vol_hoy else None,
        "vol_prom20": int(vol_prom20) if vol_prom20 else None,
        "vol_ratio": num(vol_ratio, 2),
        "vol_fecha": vol_fecha,
        "gap_pct": num(gap_pct, 2),
    }

    # CEDEAR: solo si el dato principal es la especie extranjera en USD (si
    # ya resolvio como .BA, "precio" YA es el del CEDEAR). ratio N:1 = N
    # certificados = 1 accion; CCL implicito = precio_cedear * ratio / precio.
    # Precio del CEDEAR: data912 (fuente primaria) o Yahoo .BA (respaldo) —
    # ver pipeline.descarga.obtener_precios_cedear_combinado. cedear_fuente
    # dice cual de las dos se uso esta corrida.
    cedear_precio = cedear_ratio = ccl_implicito = cedear_fuente = cedear_volumen = None
    if not sym.endswith(".BA") and en_usd and t in ctx["ratios_cedear"]:
        cedear_ratio = ctx["ratios_cedear"][t]
        dato_cedear = ctx["precios_cedear"].get(t)
        if dato_cedear:
            cedear_precio = dato_cedear["precio"]
            cedear_fuente = dato_cedear["fuente"]
            cedear_volumen = dato_cedear.get("volumen")
        if cedear_precio and precio:
            ccl_implicito = (cedear_precio * cedear_ratio) / precio

    filas["medias"] = {
        **base,
        "precio": num(precio, 2),
        "dist_ema21": num(dist_pct(precio, ema21), 2),
        "dist_ema50": num(dist_pct(precio, ema50), 2),
        "dist_ema150": num(dist_pct(precio, ema150), 2),
        "dist_sma200": num(dist_pct(precio, sma200), 2),
        "cedear_ticker": f"{t}.BA" if cedear_precio is not None else None,
        "cedear_fuente": cedear_fuente,
        "cedear_volumen": int(cedear_volumen) if cedear_volumen else None,
        "cedear_precio": num(cedear_precio, 2),
        "cedear_ratio": cedear_ratio,
        "cedear_ccl_implicito": num(ccl_implicito, 2),
    }

    claves_fund = list(extraer_fundamentales({}).keys())
    if sin_info and pf:
        fund = {k: pf.get(k) for k in claves_fund}
        sector = pf.get("sector")
        insider, holdings = pf.get("insider"), pf.get("holdings")
        proximo_earnings = pf.get("proximo_earnings")
    else:
        fund = anular_ratios_mixtos(extraer_fundamentales(info), moneda, moneda_financiera)
        sector = info.get("sector") or None
        proximo_earnings = extraer_proximo_earnings(info)
    mc = fund.pop("market_cap")
    recommendation_key = fund.pop("recommendation_key")  # texto, no pasa por num()
    dividendos = extraer_dividendos(hist)
    dy = calcular_dividend_yield(dividendos, precio, info)
    fund["dividend_yield"] = dy if (dy is not None or not sin_info) else pf.get("dividend_yield")
    target_mean_price = fund.get("target_mean_price")
    upside_pct = ((target_mean_price / precio - 1) * 100) if target_mean_price and precio else None
    stats_mercado = calcular_beta_sharpe(closes, ctx["bench_closes"], en_usd=en_usd)
    precios_mensuales, estacionalidad = calcular_estacionalidad_y_mensual(closes)
    pre_post_market = extraer_pre_post_market(info, pf.get("pre_post_market"), ctx["ahora_iso"])

    filas["fundamentales"] = {
        **base,
        **{k: num(v, 2) for k, v in fund.items()},
        "market_cap": int(mc) if mc else None,
        "market_cap_usd": None,  # se completa despues del loop (necesita el CCL mediano)
        "moneda": moneda,
        "moneda_financiera": moneda_financiera,
        "sector": sector,
        "recommendation_key": recommendation_key,
        "upside_pct": num(upside_pct, 2),
        "insider": insider,
        "holdings": holdings,
        **stats_mercado,
        "estacionalidad": estacionalidad,
        "proximo_earnings": proximo_earnings,
        "dividendos": dividendos,
        "pre_post_market": pre_post_market,
    }
    filas["screener"] = {**base, **calcular_screener(hist)}
    filas["scanner_setups"] = {**base, **calcular_setup_scanner(hist)}
    filas["mensual"] = precios_mensuales

    # Warren Score: pilares A/C/D + penalizaciones por ticker; el B (Fuerza
    # Relativa) necesita el percentil de TODO el universo y se arma despues
    # del loop. Solo tickers en USD entran al percentil de RS vs SPY (un
    # CEDEAR en pesos "le gana" a SPY por la devaluacion, no por fuerza
    # relativa real).
    # Un dato raro en el Warren Score no tiene que mandar el ticker entero
    # al camino de arrastre: queda sin score y el resto se publica igual.
    try:
        calc_ws = ws_calcular_ticker(hist, ctx["bench_closes"], en_usd, fin, stats_mercado.get("volatilidad_1y"))
    except Exception as e:  # noqa: BLE001
        print(f"  ! {sym}: Warren Score sin calcular ({type(e).__name__}: {e})")
        calc_ws = None
    filas["warren"] = {
        "ticker": sym,
        "nombre": nombre,
        "sector": sector or ("ETF" if es_fondo else industria),
        "en_usd": en_usd,
        "calc": calc_ws,
    }
    # Señales (EMA200 / VCP / RSI semanal): mismo criterio, una falla no
    # tumba el ticker.
    try:
        senales = senales_ticker(hist, calc_ws)
    except Exception as e:  # noqa: BLE001
        print(f"  ! {sym}: señales sin calcular ({type(e).__name__}: {e})")
        senales = None
    filas["senales"] = {"ticker": sym, "nombre": nombre, "senales": senales}
    return filas


# Archivos con una fila por ticker (y su dato previo para el arrastre).
ARCHIVOS_POR_TICKER = ("listado", "medias", "fundamentales", "screener", "scanner_setups")


def procesar_universo(tickers, resueltos, infos, ctx, previos, simbolo_previo, ts_prev, ahora):
    """Loop principal: procesar_ticker para cada ticker del universo. Los
    que no resolvieron (o fallan al procesarse) van al arrastre: se publica
    su ultimo dato bueno marcado stale, o, si no hay dato previo vigente,
    quedan en sin_arrastre (van al cache de invalidos). Devuelve un dict con
    las listas de ARCHIVOS_POR_TICKER + mensuales, warren_datos,
    senales_datos, invalidos, sin_arrastre y descartados_viejos."""
    res = {clave: [] for clave in ARCHIVOS_POR_TICKER}
    res.update(mensuales={}, warren_datos=[], senales_datos=[], invalidos=[], sin_arrastre=[], descartados_viejos=[])
    prev_listado = previos["listado"]

    def arrastrar(t):
        """Publica el ultimo dato bueno del ticker marcado stale (con el
        timestamp de su ultima descarga exitosa). Devuelve False si no hay
        dato previo o si ya tiene mas de DIAS_MAX_ARRASTRE dias."""
        clave = simbolo_previo.get(t)
        previo = prev_listado.get(clave) if clave else None
        if not previo:
            return False
        ts = previo.get("actualizado") if previo.get("stale") else ts_prev
        ts = ts or ts_prev
        edad = _edad_dias(ts, ahora)
        if edad is None or edad > DIAS_MAX_ARRASTRE:
            print(f"  x {t}: dato arrastrado desde {ts} (> {DIAS_MAX_ARRASTRE} dias), se descarta.")
            res["descartados_viejos"].append(t)
            return False
        print(f"  ~ {t}: sin datos ahora, se mantiene el ultimo dato ({ts})")
        for archivo in ARCHIVOS_POR_TICKER:
            prev = previos[archivo]
            if clave in prev:
                res[archivo].append({**_limpiar_fila_vieja(prev[clave]), "stale": True, "actualizado": ts})
        return True

    for _, fila in tickers.iterrows():
        t = fila["Ticker"]
        if t not in resueltos:
            res["invalidos"].append(t)
            if not arrastrar(t):
                res["sin_arrastre"].append(t)
                print(f"  ! {t}: sin datos (probe .SA / .BA)")
            continue
        sym, hist = resueltos[t]
        try:
            filas = procesar_ticker(fila, sym, hist, infos.get(sym) or (sym, {}, None, None), ctx)
        except Exception as e:  # noqa: BLE001
            # Un ticker roto (dato raro de Yahoo, bug en un indicador) no
            # corta la corrida entera: va al mismo camino que un fallo de red.
            print(f"  ! {t} ({sym}): error procesando ({type(e).__name__}: {e}), se intenta arrastre")
            res["invalidos"].append(t)
            if not arrastrar(t):
                res["sin_arrastre"].append(t)
            continue
        for archivo in ARCHIVOS_POR_TICKER:
            res[archivo].append(filas[archivo])
        res["mensuales"][sym] = filas["mensual"]
        res["warren_datos"].append(filas["warren"])
        res["senales_datos"].append(filas["senales"])
        print(f"  ok {sym} ({filas['listado']['nombre']})")
    return res
