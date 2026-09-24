"""Fundamentales por ticker a partir de tk.info y del historico ya
descargado: ratios, dividendos y dividend yield, moneda (ratios de moneda
mixta, market cap en USD, CCL implicito), insiders, holdings de ETFs,
proximo earnings y pre/post-market."""

import math
from datetime import datetime

import numpy as np
import pandas as pd

from comun import TZ, moneda_por_sufijo, num


# CCL implicito: los CEDEAR cuyo CCL se aleja mas que esto de la mediana
# casi siempre son ratio mal cargado o precio viejo en BYMA -> se anulan.
TOL_CCL = 0.15
# Dividend yield por encima de esto es casi seguro un error de moneda/dato.
DIVIDEND_YIELD_MAX = 25.0

# Ratios que mezclan precio (moneda de cotizacion) con datos contables
# (financialCurrency). Si las dos monedas difieren, Yahoo divide market cap
# en USD por ventas/patrimonio en la moneda local sin convertir: P/S y P/B
# salen basura (TM P/S 0.00, TSM P/B 91, TXR.BA P/S 1053) -> None siempre.
RATIOS_MONEDA_MIXTA = ["ev_sales", "pb", "ps"]
# El PER si lo convierte bien cuando la cotizacion es en USD (ADRs: TSM 33,
# BABA 25, SAP 28, coherentes), pero no cuando la especie cotiza en otra
# moneda (CEDEARs en pesos: BBV.BA PER 308, NOKA.BA 478, PKS.BA 0.06) ->
# None solo en ese caso.
RATIOS_MONEDA_MIXTA_NO_USD = ["per_trailing", "per_forward", "peg"]


def extraer_proximo_earnings(info):
    """Fecha del proximo reporte de resultados. Viene gratis dentro de
    tk.info (earningsTimestamp*), no es un request nuevo. isEarningsDateEstimate
    indica si Yahoo todavia no tiene la fecha confirmada por la empresa."""
    ts_inicio = info.get("earningsTimestampStart") or info.get("earningsTimestamp")
    if not ts_inicio:
        return None
    ts_fin = info.get("earningsTimestampEnd")
    try:
        fecha = datetime.fromtimestamp(ts_inicio, tz=TZ).strftime("%Y-%m-%d")
        fecha_fin = (
            datetime.fromtimestamp(ts_fin, tz=TZ).strftime("%Y-%m-%d")
            if ts_fin and ts_fin != ts_inicio
            else None
        )
    except (TypeError, ValueError, OSError):
        return None
    return {"fecha": fecha, "fecha_fin": fecha_fin, "estimado": bool(info.get("isEarningsDateEstimate", False))}


def extraer_dividendos(hist):
    """Historial de dividendos de los ultimos ~5 anios, de la columna
    'Dividends' que ya viene en el hist descargado (no es un request nuevo
    — tk.dividends por separado si lo seria, y trae todo el historico desde
    el IPO, mucho mas de lo que hace falta para ver una tendencia)."""
    if "Dividends" not in hist.columns:
        return None
    pagos = hist["Dividends"]
    pagos = pagos[pagos > 0]
    if pagos.empty:
        return None

    lista = [{"fecha": f.strftime("%Y-%m-%d"), "monto": num(float(v), 4)} for f, v in pagos.items()]

    # Cuantos pagos entran en ~1 anio, inferido del espaciado tipico entre
    # pagos (trimestral/semestral/anual) — mas robusto que una ventana fija
    # de 365 dias: las fechas de pago se corren unos dias de un anio a otro,
    # asi que una ventana de dias puede agarrar 5 pagos de un lado y 3 del
    # otro e inventar un crecimiento que no existe (visto con AAPL: daba
    # +75% cuando en realidad crecio ~4% ese anio).
    valores = pagos.to_numpy()
    ultimos_12m = crecimiento_yoy = None
    if len(pagos) >= 3:
        dias = np.diff(pagos.index.values).astype("timedelta64[D]").astype(int)
        espaciado = float(np.median(dias)) if len(dias) else 365.0
        por_anio = max(1, round(365 / espaciado)) if espaciado > 0 else 4
        if len(valores) >= por_anio:
            ultimos_12m = float(valores[-por_anio:].sum())
            if len(valores) >= por_anio * 2:
                anio_anterior = float(valores[-por_anio * 2 : -por_anio].sum())
                crecimiento_yoy = ((ultimos_12m / anio_anterior) - 1) * 100 if anio_anterior > 0 else None

    return {
        "pagos": lista[-20:],
        "total_ultimos_12m": num(ultimos_12m, 4),
        "crecimiento_yoy": num(crecimiento_yoy, 2),
    }


def _ts_a_iso(ts):
    try:
        return datetime.fromtimestamp(int(ts), tz=TZ).isoformat() if ts else None
    except (TypeError, ValueError, OSError):
        return None


def extraer_pre_post_market(info, previo=None, ahora_iso=None):
    """Precio de pre/post-market, gratis dentro de tk.info. Yahoo solo lo
    llena bien mientras el mercado esta en esa sesion (marketState PRE /
    POST o POSTPOST), y GitHub arranca los crons con horas de atraso, asi
    que muchas corridas caen fuera de esas ventanas. Por eso NUNCA se pisa un
    valor capturado con None: se conserva el ultimo capturado junto con su
    propio timestamp (pre_actualizado/post_actualizado, el preMarketTime/
    postMarketTime de Yahoo) para que la UI sepa que tan viejo es."""
    previo = previo or {}
    estado = info.get("marketState") or previo.get("estado")
    salida = {
        "estado": estado,
        "pre_precio": previo.get("pre_precio"),
        "pre_cambio_pct": previo.get("pre_cambio_pct"),
        "pre_actualizado": previo.get("pre_actualizado"),
        "post_precio": previo.get("post_precio"),
        "post_cambio_pct": previo.get("post_cambio_pct"),
        "post_actualizado": previo.get("post_actualizado"),
    }
    if estado == "PRE" and num(info.get("preMarketPrice")) is not None:
        salida["pre_precio"] = num(info.get("preMarketPrice"), 2)
        salida["pre_cambio_pct"] = num(info.get("preMarketChangePercent"), 2)
        salida["pre_actualizado"] = _ts_a_iso(info.get("preMarketTime")) or ahora_iso
    if estado in ("POST", "POSTPOST") and num(info.get("postMarketPrice")) is not None:
        salida["post_precio"] = num(info.get("postMarketPrice"), 2)
        salida["post_cambio_pct"] = num(info.get("postMarketChangePercent"), 2)
        salida["post_actualizado"] = _ts_a_iso(info.get("postMarketTime")) or ahora_iso
    return salida


def _normalizar_moneda(m):
    """'GBp' (peniques) y similares se comparan contra su moneda mayor."""
    if not m:
        return None
    return {"GBP": "GBP", "GBX": "GBP", "ILA": "ILS", "ZAC": "ZAR"}.get(str(m).upper(), str(m).upper())


def moneda_mixta(moneda, moneda_financiera):
    """True si el precio cotiza en una moneda y los estados contables estan
    en otra (ADRs de KEP/KB/MUFG/HMC, CEDEARs .BA): los ratios precio/
    contable que arma Yahoo quedan mezclados y no sirven."""
    a, b = _normalizar_moneda(moneda), _normalizar_moneda(moneda_financiera)
    return bool(a and b and a != b)


def calcular_dividend_yield(dividendos, precio, info):
    """Dividend yield en %. Primero desde los pagos reales de los ultimos 12
    meses (columna Dividends del historico, misma moneda que el precio, asi
    que nunca mezcla monedas) sobre el precio actual. Si no hay pagos
    suficientes para estimarlo, cae a 'dividendYield' de Yahoo, que YA viene
    en % (antes se usaba trailingAnnualDividendYield, que en ADRs divide el
    dividendo en KRW/JPY por el precio en USD: KEP daba 13646%). Valores por
    encima de DIVIDEND_YIELD_MAX se descartan."""
    dy = None
    if dividendos and precio:
        pagos = dividendos.get("pagos") or []
        ultimo = pagos[-1]["fecha"] if pagos else None
        total = dividendos.get("total_ultimos_12m")
        # Si el ultimo pago tiene mas de ~13 meses, o dejo de pagar o Yahoo
        # tiene un hueco en el historial (pasa con varios ADRs: KB/MUFG/HMC
        # sin pagos cargados desde 2025) -> no se estima desde pagos.
        reciente = bool(ultimo) and (datetime.now() - datetime.fromisoformat(ultimo)).days <= 400
        if reciente and total:
            dy = total / precio * 100
    if dy is None:
        v = info.get("dividendYield")
        dy = float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    if dy is None or not math.isfinite(dy) or dy < 0 or dy > DIVIDEND_YIELD_MAX:
        return None
    return dy


def extraer_fundamentales(info):
    """Extrae los fundamentales de yf.Ticker(t).info, tolerando faltantes.
    Margenes/ROE se devuelven ya en formato porcentual. El dividend yield se
    calcula aparte (calcular_dividend_yield) porque necesita el historico."""

    def g(k):
        v = info.get(k)
        if isinstance(v, bool):  # algunos campos vienen como bool por error
            return None
        if isinstance(v, (int, float)) and not (isinstance(v, float) and math.isnan(v)):
            return float(v)
        return None

    pm = g("profitMargins")
    roe = g("returnOnEquity")
    peg = g("trailingPegRatio")
    if peg is None:
        peg = g("pegRatio")

    return {
        "per_trailing": g("trailingPE"),
        "per_forward": g("forwardPE"),
        "peg": peg,
        "ev_sales": g("enterpriseToRevenue"),
        "pb": g("priceToBook"),
        "ps": g("priceToSalesTrailing12Months"),
        "market_cap": g("marketCap"),
        "eps": g("trailingEps"),
        "profit_margin": pm * 100 if pm is not None else None,
        "roe": roe * 100 if roe is not None else None,
        "dividend_yield": None,  # se completa con calcular_dividend_yield()
        "beta": g("beta"),
        "debt_to_equity": g("debtToEquity"),
        "current_ratio": g("currentRatio"),
        # Consenso de analistas (gratis via yfinance, sin key). recommendation_key
        # es texto ("buy"/"hold"/etc.), se maneja aparte de los campos numericos.
        "target_mean_price": g("targetMeanPrice"),
        "n_analistas": g("numberOfAnalystOpinions"),
        "recommendation_key": info.get("recommendationKey") or None,
        # book_value/fcf_por_accion se sacaron: ningun componente los leia.
    }


def anular_ratios_mixtos(fund, moneda, moneda_financiera):
    """Pone en None los ratios que mezclan monedas (ver RATIOS_MONEDA_MIXTA
    y RATIOS_MONEDA_MIXTA_NO_USD)."""
    if moneda_mixta(moneda, moneda_financiera):
        claves = RATIOS_MONEDA_MIXTA + (RATIOS_MONEDA_MIXTA_NO_USD if moneda != "USD" else [])
        for k in claves:
            fund[k] = None
    return fund


def obtener_holdings_etf(tk, quote_type):
    """Top holdings (composicion) de un ETF: que activos tiene adentro y con
    que peso. Solo tiene sentido pedirlo para quoteType == "ETF" (una accion
    comun tira error/vacio). Tolerante a fallos: yfinance a veces no tiene
    este dato para ETFs chicos o de renta fija."""
    if quote_type != "ETF":
        return None
    try:
        top = tk.funds_data.top_holdings
        if top is None or top.empty:
            return None
        out = []
        for simbolo, fila in top.iterrows():
            out.append(
                {
                    "ticker": str(simbolo),
                    "nombre": str(fila.get("Name") or ""),
                    "peso_pct": num(float(fila.get("Holding Percent", 0)) * 100, 2),
                }
            )
        return out or None
    except Exception:  # noqa: BLE001
        return None


TAGS_INSIDER_COMPRA = ("purchase", "buy")
TAGS_INSIDER_VENTA = ("sale", "sell")
DIAS_INSIDER = 180


def resumen_insider(tk):
    """Resumen de transacciones de insiders (directivos/directores comprando o
    vendiendo sus propias acciones) de los ultimos ~6 meses. yfinance no
    clasifica la columna "Transaction" de forma confiable: se interpreta el
    texto libre de "Text" (ej. "Sale at price 295.14 per share.",
    "Purchase at price..."). Compra insider fuerte suele ser señal alcista;
    tolerante a fallos porque esta info es menos estable que precio/info."""
    try:
        df = tk.insider_transactions
    except Exception:  # noqa: BLE001
        return None
    if df is None or df.empty or "Start Date" not in df.columns:
        return None
    try:
        corte = pd.Timestamp.now(tz=None) - pd.Timedelta(days=DIAS_INSIDER)
        fechas = pd.to_datetime(df["Start Date"], errors="coerce")
        reciente = df[fechas >= corte].copy()
        if reciente.empty:
            return {"n_compras": 0, "n_ventas": 0, "valor_compras": 0.0, "valor_ventas": 0.0}
        texto = reciente.get("Text", "").astype(str).str.lower()
        es_compra = texto.str.contains("|".join(TAGS_INSIDER_COMPRA), na=False)
        es_venta = texto.str.contains("|".join(TAGS_INSIDER_VENTA), na=False)
        valores = pd.to_numeric(reciente.get("Value"), errors="coerce").fillna(0)
        return {
            "n_compras": int(es_compra.sum()),
            "n_ventas": int(es_venta.sum()),
            "valor_compras": float(valores[es_compra].sum()),
            "valor_ventas": float(valores[es_venta].sum()),
        }
    except Exception:  # noqa: BLE001
        return None


def market_cap_usd(market_cap, moneda, fx):
    if not market_cap or not moneda or moneda not in fx or not fx[moneda]:
        return None
    return int(market_cap / fx[moneda])


def filtrar_ccl(medias):
    """CCL implicito mediano de los CEDEAR frescos de la corrida. Los que se
    alejan mas de TOL_CCL de la mediana (ratio mal cargado o precio viejo en
    BYMA) quedan en None (se modifica 'medias'). Devuelve la mediana o None."""
    ccls = [m["cedear_ccl_implicito"] for m in medias if not m.get("stale") and m.get("cedear_ccl_implicito")]
    ccl_mediana = float(np.median(ccls)) if ccls else None
    if ccl_mediana:
        fuera = []
        for m in medias:
            v = m.get("cedear_ccl_implicito")
            if v and not m.get("stale") and abs(v / ccl_mediana - 1) > TOL_CCL:
                fuera.append(f"{m['ticker']} ({v:.0f})")
                m["cedear_ccl_implicito"] = None
        print(f"\nCCL implicito mediano: {ccl_mediana:.2f} ({len(ccls)} CEDEARs).")
        if fuera:
            print(f"  CCL descartado por alejarse >{TOL_CCL:.0%} de la mediana: {', '.join(fuera)}")
    return ccl_mediana


def completar_market_cap_usd(fundamentales, peers, fx):
    """Completa moneda (por sufijo si falta) y market_cap_usd de las filas
    frescas (las arrastradas conservan el suyo si ya lo tenian) y de los
    peers, con el tipo de cambio de la corrida."""
    for f in fundamentales:
        if not f.get("moneda"):
            f["moneda"] = moneda_por_sufijo(f["ticker"])
        if not f.get("stale") or f.get("market_cap_usd") is None:
            f["market_cap_usd"] = market_cap_usd(f.get("market_cap"), f.get("moneda"), fx)
    for p in peers.values():
        p["market_cap_usd"] = market_cap_usd(p.get("market_cap"), p.get("moneda"), fx)
