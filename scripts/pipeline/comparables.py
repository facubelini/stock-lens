"""Comparables por industria (tus tickers + peers curados de
comparables_universo) y la seleccion de Oportunidades (barato vs. industria
+ señal tecnica)."""

from concurrent.futures import ThreadPoolExecutor

import yfinance as yf

from comparables_universo import INDUSTRIA_COMPARABLES
from comun import CLAVES_BENCH, base_ticker, mediana_de, moneda_por_sufijo, normalizar_industria, num

from .descarga import WORKERS_INFO
from .fundamentales import DIVIDEND_YIELD_MAX, anular_ratios_mixtos, extraer_fundamentales


# Los mismos 3 ratios que src/lib/valuacion.js (calcularDescuento) — si se
# toca uno, tocar el otro para que no se desincronicen.
RATIOS_VALOR_OPORTUNIDADES = ["per_trailing", "ev_sales", "ps"]

# Campos que se publican por par en comparables.json: solo lo que leen
# Comparables.jsx / TickerDetalle.jsx (tabla de ratios + pool de peers
# manuales) — el resto de la fila de fundamentales (estacionalidad,
# dividendos, insiders...) ya esta en fundamentales.json y duplicarlo aca
# inflaba el archivo a ~700KB.
CAMPOS_PARES = [
    "ticker", "nombre", "industria", "sector", "en_portfolio", "moneda",
    "market_cap", "market_cap_usd",
    "per_trailing", "per_forward", "peg", "ev_sales", "pb", "ps", "eps",
    "profit_margin", "roe", "dividend_yield", "beta", "debt_to_equity", "current_ratio",
    "target_mean_price", "upside_pct", "recommendation_key", "n_analistas",
]


def fila_par(fila, en_portfolio):
    """Recorta una fila de fundamentales a los campos que se publican por par
    en comparables.json (CAMPOS_PARES)."""
    out = {k: fila.get(k) for k in CAMPOS_PARES if k != "en_portfolio"}
    out["en_portfolio"] = en_portfolio
    return {k: out.get(k) for k in CAMPOS_PARES}


def _fila_peer_desde_info(peer, info):
    """Fila de un peer curado (fuera de tu universo), solo con su .info."""
    nombre = info.get("shortName") or info.get("longName") or peer
    moneda = info.get("currency") or moneda_por_sufijo(peer)
    fund = extraer_fundamentales(info)
    anular_ratios_mixtos(fund, moneda, info.get("financialCurrency"))
    dy = info.get("dividendYield")
    fund["dividend_yield"] = (
        float(dy) if isinstance(dy, (int, float)) and not isinstance(dy, bool) and 0 <= dy <= DIVIDEND_YIELD_MAX else None
    )
    mc = fund.pop("market_cap")
    recommendation_key = fund.pop("recommendation_key")
    precio = num(info.get("currentPrice") or info.get("regularMarketPrice"), 4)
    target = fund.get("target_mean_price")
    upside = ((target / precio - 1) * 100) if target and precio else None
    return {
        "ticker": peer,
        "nombre": nombre,
        "sector": info.get("sector") or None,
        "moneda": moneda,
        **{k: num(v, 2) for k, v in fund.items()},
        "market_cap": int(mc) if mc else None,
        "market_cap_usd": None,  # se completa con el tipo de cambio de la corrida
        "recommendation_key": recommendation_key,
        "upside_pct": num(upside, 2),
    }


def obtener_peers(fundamentales, cache_peers, hoy):
    """Fundamentales (.info) de los peers curados que NO estan en tu
    universo, para las industrias presentes. Cache diario en
    data/comparables_cache.json: el .info de un peer no cambia de forma
    relevante entre las 5 corridas del dia, asi que se pide una sola vez por
    dia en vez de en cada corrida. Devuelve (dict peer -> fila, cache_nuevo)."""
    industrias = {normalizar_industria(f["industria"]) for f in fundamentales}
    propios = {base_ticker(f["ticker"]) for f in fundamentales} | {f["ticker"] for f in fundamentales}
    necesarios = sorted(
        {p for ind in industrias for p in INDUSTRIA_COMPARABLES.get(ind, []) if p not in propios}
    )
    cache_hoy = cache_peers.get("pares", {}) if cache_peers.get("fecha") == hoy else {}
    filas = {p: cache_hoy[p] for p in necesarios if p in cache_hoy}
    faltan = [p for p in necesarios if p not in filas]

    def _pedir(peer):
        try:
            info = yf.Ticker(peer).info or {}
        except Exception:  # noqa: BLE001
            return peer, None
        if not info or not (info.get("shortName") or info.get("longName")):
            return peer, None
        return peer, _fila_peer_desde_info(peer, info)

    if faltan:
        print(f"  {len(faltan)} peers sin cache de hoy, pidiendo .info...")
        with ThreadPoolExecutor(max_workers=WORKERS_INFO) as pool:
            for peer, fila in pool.map(_pedir, faltan):
                if fila:
                    filas[peer] = fila
    # Si Yahoo fallo hoy para un peer, se reusa el ultimo dato cacheado.
    for p in necesarios:
        if p not in filas and p in cache_peers.get("pares", {}):
            filas[p] = cache_peers["pares"][p]
    return filas, {"fecha": hoy, "pares": {p: filas[p] for p in sorted(filas)}}


def construir_comparables(fundamentales, peers):
    """Para cada industria presente en tus tickers que tenga peers curados en
    comparables_universo.INDUSTRIA_COMPARABLES, arma el grupo (tus tickers +
    peers) y la mediana. La mediana usa solo tickers que cotizan en USD: un
    CEDEAR en pesos o una accion de B3 no son comparables en market cap, y
    sus multiplos suelen venir contaminados por mezcla de monedas."""
    por_industria = {}
    for f in fundamentales:
        por_industria.setdefault(f["industria"], []).append(f)

    tickers_propios = {f["ticker"] for f in fundamentales}
    resultado, sin_mapeo = [], []

    for industria, propios in sorted(por_industria.items()):
        peers_curados = INDUSTRIA_COMPARABLES.get(normalizar_industria(industria))
        if not peers_curados:
            sin_mapeo.append(industria)
            continue

        pares = [fila_par(p, True) for p in propios]
        vistos = set(tickers_propios)
        for peer in peers_curados:
            if peer in vistos or peer not in peers:
                continue
            vistos.add(peer)
            pares.append(fila_par({**peers[peer], "industria": industria}, False))

        en_usd = [p for p in pares if p.get("moneda") == "USD"]
        resultado.append(
            {
                "industria": industria,
                "pares": pares,
                "mediana": {k: num(mediana_de(en_usd, k), 2) for k in CLAVES_BENCH},
            }
        )

    if sin_mapeo:
        print(f"\n(Sin comparables curados para: {', '.join(sin_mapeo)})")

    return resultado


def _descuento_valor(fila, mediana):
    """Version Python de calcularDescuento (src/lib/valuacion.js): promedio
    del descuento % en PER/EV-Sales/P-S contra la mediana de industria. Solo
    se usa para armar el historial de Oportunidades del lado del pipeline —
    la vista en vivo la calcula el frontend con los mismos 3 ratios."""
    if not mediana:
        return None
    descuentos = []
    for k in RATIOS_VALOR_OPORTUNIDADES:
        v = fila.get(k)
        m = mediana.get(k)
        if v is None or m is None or v <= 0 or m <= 0:
            continue
        descuentos.append(((m - v) / m) * 100)
    if not descuentos:
        return None
    return sum(descuentos) / len(descuentos)


def calcular_oportunidades_hoy(fundamentales, comparables, screener):
    """Tickers que hoy cumplen las dos condiciones de la pestaña
    Oportunidades (barato vs. industria + señal tecnica), para poder armar
    un historial de "hace cuantos dias que esta en la lista"."""
    mediana_por_industria = {g["industria"]: g["mediana"] for g in comparables}
    screener_por_ticker = {f["ticker"]: f for f in screener}
    calificados = []
    for f in fundamentales:
        mediana = mediana_por_industria.get(f["industria"])
        descuento = _descuento_valor(f, mediana)
        if descuento is None or descuento <= 0:
            continue
        sf = screener_por_ticker.get(f["ticker"])
        if not sf:
            continue
        tiene_señal = any(
            (sf.get(tf) or {}).get("verdict") in ("COMPRA", "CERCA")
            for tf in ("diario", "semanal", "mensual")
        )
        if tiene_señal:
            calificados.append(f["ticker"])
    return calificados
