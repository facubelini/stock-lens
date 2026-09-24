"""Indicadores de mercado y macro (no dependen de la lista de tickers).

VIX y yield curve via yfinance, Fear & Greed cripto via alternative.me
(API oficial y gratuita), Fear & Greed de acciones via el endpoint interno
de CNN (no oficial, sin API documentada — tolerante a fallos), e
indicadores de EEUU (CPI/desempleo/tasa de la Fed) via el endpoint publico
de descarga de graficos de FRED (CSV, no requiere API key).

Si una fuente falla en una corrida, se conserva el ultimo valor bueno de
la corrida anterior (campo por campo) en vez de publicar null.

Uso:
    python scripts/mercado_macro.py [--out CARPETA]
"""

import argparse
from datetime import datetime
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

from comun import (
    DIR_DATOS_PUBLICOS,
    TZ,
    adx_dmi_serie,
    atr_serie,
    dias_distribucion,
    escribir_json,
    leer_json,
    lineal,
    num,
    tri,
)


def obtener_vix():
    try:
        cierres = yf.Ticker("^VIX").history(period="5d")["Close"].dropna()
        if cierres.empty:
            return None
        actual = float(cierres.iloc[-1])
        previo = float(cierres.iloc[-2]) if len(cierres) > 1 else None
        cambio_pct = ((actual / previo) - 1) * 100 if previo else None
        return {"valor": num(actual, 2), "cambio_pct": num(cambio_pct, 2)}
    except Exception:  # noqa: BLE001
        return None


def obtener_yield_curve():
    """Spread 10 años - 3 meses: cuando es negativo (invertida), es uno de
    los indicadores de recesion mas seguidos historicamente."""
    try:
        diez = yf.Ticker("^TNX").history(period="5d")["Close"].dropna()
        tres_m = yf.Ticker("^IRX").history(period="5d")["Close"].dropna()
        if diez.empty or tres_m.empty:
            return None
        v10 = float(diez.iloc[-1])
        v3m = float(tres_m.iloc[-1])
        spread = v10 - v3m
        return {
            "diez_anios": num(v10, 2),
            "tres_meses": num(v3m, 2),
            "spread": num(spread, 2),
            "invertida": spread < 0,
        }
    except Exception:  # noqa: BLE001
        return None


def obtener_fear_greed_cripto():
    try:
        r = requests.get("https://api.alternative.me/fng/?limit=1", timeout=10)
        r.raise_for_status()
        dato = r.json()["data"][0]
        return {"valor": int(dato["value"]), "clasificacion": dato["value_classification"]}
    except Exception:  # noqa: BLE001
        return None


def obtener_fear_greed_acciones():
    """No oficial: CNN no publica una API documentada para su indice, este
    es el endpoint que usa internamente su propio grafico. Puede dejar de
    funcionar sin aviso si lo cambian de lugar o le agregan mas proteccion
    anti-bot; por eso va separado y tolerante a fallos del resto."""
    try:
        r = requests.get(
            "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://www.cnn.com/markets/fear-and-greed",
            },
            timeout=10,
        )
        r.raise_for_status()
        fg = r.json()["fear_and_greed"]
        return {
            "valor": num(fg["score"], 1),
            "clasificacion": fg["rating"],
            "prev_cierre": num(fg["previous_close"], 1),
            "prev_semana": num(fg["previous_1_week"], 1),
            "prev_mes": num(fg["previous_1_month"], 1),
            "prev_anio": num(fg["previous_1_year"], 1),
        }
    except Exception:  # noqa: BLE001
        return None


def _fred_serie(serie_id):
    """Serie de FRED via el endpoint publico de descarga de graficos (CSV),
    el mismo que usa el boton "Download" de cualquier grafico en
    fred.stlouisfed.org — no requiere API key. Devuelve lista de
    (fecha, valor) ordenada de mas vieja a mas nueva."""
    try:
        r = requests.get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={serie_id}", timeout=10)
        r.raise_for_status()
        lineas = r.text.strip().splitlines()[1:]  # salteo encabezado
        out = []
        for linea in lineas:
            fecha, _, valor = linea.partition(",")
            if valor and valor != ".":
                out.append((fecha, float(valor)))
        return out
    except Exception:  # noqa: BLE001
        return []


def obtener_indicadores_usa():
    cpi = _fred_serie("CPIAUCSL")
    desempleo = _fred_serie("UNRATE")
    fed_funds = _fred_serie("FEDFUNDS")

    cpi_yoy = None
    if len(cpi) >= 13:
        cpi_yoy = num(((cpi[-1][1] / cpi[-13][1]) - 1) * 100, 2)

    return {
        "cpi_yoy": cpi_yoy,
        "cpi_actualizado": cpi[-1][0] if cpi else None,
        "desempleo": num(desempleo[-1][1], 1) if desempleo else None,
        "desempleo_actualizado": desempleo[-1][0] if desempleo else None,
        "fed_funds": num(fed_funds[-1][1], 2) if fed_funds else None,
        "fed_funds_actualizado": fed_funds[-1][0] if fed_funds else None,
    }


def obtener_put_call():
    """Proxy de la ratio put/call (CBOE). Probado en la practica: yfinance
    no tiene ^CPCE (put/call de equities de CBOE) ni ^PCALL (404 "Quote not
    found" en ambos), y la pagina de CBOE con el historico total no tiene un
    endpoint publico estable para scrapear sin quebrar en cualquier cambio
    de layout. No hay ninguna fuente gratuita y confiable disponible hoy:
    se devuelve None a proposito (no se fabrica un numero) y el layer de
    sentimiento se arma solo con el VIX (ver `regimen.capas.sentimiento.
    pc_disponible: false` en la salida)."""
    return None


# ---------------------------------------------------------------------------
# Regimen de Mercado (0-100): score unico que resume el estado general del
# mercado para decidir cuanta exposicion tomar, armado con 3 capas
# independientes (cada una se excluye de la suma Y de su maximo si un dia le
# faltan los datos, nunca "diluye" sumando 0 sobre un maximo que sigue
# entero). Formulas y umbrales documentados en el docstring de cada funcion
# de esta seccion (_indice_capa / _amplitud_universo / _sentimiento):
#   - Indices SPY + QQQ (80 = 40 c/u, sumados sin promediar: cada indice ya
#     da su propio /40, y sumar dos "/40 sanos" en vez de promediarlos hace
#     que a un solo indice muy debil (ej. QQQ en una rotacion sectorial) le
#     pese menos que si el otro esta fuerte, en vez de anularlo).
#   - Amplitud del universo USD (30): reusa listado.json/medias.json/
#     fundamentales.json ya publicados por generar_datos.py (que corre ANTES
#     en el workflow, ver .github/workflows/datos.yml) en vez de volver a
#     descargar/calcular todo el universo: mismo universo USD que el pilar
#     Fuerza de pipeline/warren.py (moneda == "USD").
#   - Sentimiento (15): VIX (ya se descarga en este script) + put/call ratio
#     (no disponible hoy, ver obtener_put_call: la capa queda solo con VIX).
# El score y el max finales SIEMPRE se normalizan a base 100 (si un dia
# faltan capas, se renormaliza sobre las que quedan) para que sea un unico
# "0-100"; cada capa expone su propio pts/max (40/80, 30, 15) para el detalle.
# ---------------------------------------------------------------------------
REG_MIN_RUEDAS_INDICE = 220  # EMA200 + su pendiente (20 ruedas), igual que warren.py
REG_VENTANA_DIST = 25  # ruedas para contar dias de distribucion
REG_CAIDA_DISTRIBUCION = 0.2  # % de baja minima de un "dia de distribucion"
REG_TOPE_DIST_DIAS = 6  # a partir de esta cantidad de dias de distribucion, 0 pts
REG_VENTANA_FT = 15  # ruedas donde se busca el follow-through day
REG_FT_VAR_MIN = 1.5  # % suba minima de un follow-through day (estilo IBD)
REG_PENDIENTE_RUEDAS = 20  # mismas 20 ruedas que warren.py para la pendiente de EMA200
REG_MIN_TICKERS_AMPLITUD = 20  # con menos que esto el universo USD publicado no es representativo
REG_VIX_SANO = (5, 13, 20, 32)  # tri(): zona sana 13-20, cae a 0 en <=5 o >=32
REG_VIX_PANICO = 28  # a partir de aca se evalua ablandar la penalizacion
REG_FRAC_FUERTE = 0.70  # "las otras dos capas ya estan fuertes" = >= 70% de su maximo


def _indice_capa(hist):
    """Sub-score /40 de un indice (SPY o QQQ) a partir de su historico
    diario OHLCV (yf.Ticker(...).history). None si no hay suficiente
    historia (< REG_MIN_RUEDAS_INDICE ruedas)."""
    if hist is None or hist.empty:
        return None
    df = hist[["Open", "High", "Low", "Close", "Volume"]].dropna(subset=["Close"])
    c, h, l, v = df["Close"], df["High"], df["Low"], df["Volume"].fillna(0)
    if len(c) < REG_MIN_RUEDAS_INDICE:
        return None
    precio = float(c.iloc[-1])
    ema50 = float(c.ewm(span=50, adjust=False).mean().iloc[-1])
    ema200_s = c.ewm(span=200, adjust=False).mean()
    ema200 = float(ema200_s.iloc[-1])
    atr_ult = atr_serie(h, l, c, 14).iloc[-1]
    atr = float(atr_ult) if pd.notna(atr_ult) else None
    atr_pct = atr / precio * 100 if atr and precio else None
    pendiente = float(ema200_s.pct_change().tail(REG_PENDIENTE_RUEDAS).mean() * 100)

    # --- Tendencia (10 pts): precio vs EMA50/EMA200 medido en ATRs + la
    # pendiente de la EMA200 (mismo "tri()/lineal() sobre distancia en ATRs"
    # que pipeline/warren.py pilar Tendencia, con umbrales propios para un
    # indice en vez de una accion individual).
    if atr_pct:
        d50_atr = (precio / ema50 - 1) * 100 / atr_pct
        d200_atr = (precio / ema200 - 1) * 100 / atr_pct
        pts50 = tri(d50_atr, -3, 0, 5, 9) * 5
        pts200 = tri(d200_atr, -1, 0, 6, 10) * 3
    else:
        d50_atr = d200_atr = None
        pts50 = pts200 = 0.0
    pts_pend = lineal(pendiente, -0.05, 0.15, 0, 2)
    pts_tendencia = min(pts50 + pts200 + pts_pend, 10)

    # --- Dias de distribucion (10 pts): "dia de distribucion" = baja >=
    # 0.2% con volumen mayor al de la rueda anterior (regla clasica
    # IBD/O'Neil), contados en las ultimas 25 ruedas. 0 dias = 10 pts; cada
    # dia adicional resta hasta 0 pts a partir de REG_TOPE_DIST_DIAS dias
    # (lineal).
    n_dist = dias_distribucion(c, v, ventana=REG_VENTANA_DIST, caida_pct=REG_CAIDA_DISTRIBUCION)
    pts_dist = lineal(n_dist, 0, REG_TOPE_DIST_DIAS, 10, 0)

    # --- Follow-through / estado del rally (5 pts): dos señales simples que
    # no se solapan con las anteriores.
    #  (a) estructura de las ultimas 10 ruedas: maximos Y minimos mas altos
    #      en la segunda mitad (ultimas 5) que en la primera -> 3 pts (o 1.5
    #      si se cumple una sola de las dos condiciones, 0 si ninguna).
    #  (b) follow-through day (estilo IBD, simplificado): alguna rueda de
    #      las ultimas 15 subio >= 1.5% con volumen mayor al de la rueda
    #      anterior -> 2 pts.
    var_pct_s = c.pct_change() * 100
    h10, l10, v15 = h.tail(10), l.tail(10), v.tail(REG_VENTANA_FT)
    hh_reciente = len(h10) == 10 and float(h10.tail(5).max()) > float(h10.head(5).max())
    hl_reciente = len(l10) == 10 and float(l10.tail(5).min()) > float(l10.head(5).min())
    pts_estructura = 3.0 if (hh_reciente and hl_reciente) else (1.5 if (hh_reciente or hl_reciente) else 0.0)
    ft_day = bool((
        (var_pct_s.tail(REG_VENTANA_FT) >= REG_FT_VAR_MIN) & (v15 > v15.shift(1))
    ).fillna(False).any())
    pts_estado = min(pts_estructura + (2.0 if ft_day else 0.0), 5)

    # --- ADX/DMI (8 pts): ADX(14) estandar de Wilder + direccion (+DI vs
    # -DI). Tendencia alcista confirmada suma hasta 8 pts (mas cuanto mayor
    # el ADX); tendencia bajista confirmada resta hasta 0 (0 pts con ADX
    # alto y -DI > +DI); sin tendencia clara (ADX bajo, <=10) el resultado
    # queda cerca del medio en cualquier direccion.
    adx_s, plus_di_s, minus_di_s = adx_dmi_serie(h, l, c, 14)
    adx = float(adx_s.iloc[-1]) if pd.notna(adx_s.iloc[-1]) else None
    plus_di = float(plus_di_s.iloc[-1]) if pd.notna(plus_di_s.iloc[-1]) else None
    minus_di = float(minus_di_s.iloc[-1]) if pd.notna(minus_di_s.iloc[-1]) else None
    if adx is not None and plus_di is not None and minus_di is not None:
        pts_adx = lineal(adx, 10, 40, 0, 8) if plus_di > minus_di else lineal(adx, 10, 40, 4, 0)
    else:
        pts_adx = 0.0

    # --- Extension en ATRs (7 pts): distancia del precio a la EMA200 medida
    # en ATRs (misma idea que pipeline/warren.py pilar Tendencia): score
    # maximo en una zona sana por encima de la EMA200, penaliza tanto estar
    # por debajo como estar muy estirado.
    pts_ext = tri(d200_atr, -2, 0, 6, 11) * 7 if d200_atr is not None else 0.0

    pts = round(min(pts_tendencia + pts_dist + pts_estado + pts_adx + pts_ext, 40), 1)
    return {
        "pts": pts,
        "max": 40,
        "detalle": {
            "precio": num(precio, 2),
            "ema50": num(ema50, 2),
            "ema200": num(ema200, 2),
            "dist_ema200_atr": num(d200_atr, 2),
            "pendiente_ema200": num(pendiente, 3),
            "pts_tendencia": num(pts_tendencia, 2),
            "dias_distribucion_25r": n_dist,
            "pts_distribucion": num(pts_dist, 2),
            "estructura_hh_hl_10r": bool(hh_reciente and hl_reciente),
            "follow_through_day_15r": ft_day,
            "pts_estado": num(pts_estado, 2),
            "adx14": num(adx, 1),
            "plus_di": num(plus_di, 1),
            "minus_di": num(minus_di, 1),
            "pts_adx": num(pts_adx, 2),
            "pts_extension": num(pts_ext, 2),
        },
    }


def _amplitud_universo(carpeta):
    """Sub-score /30 de amplitud sobre el universo USD ya publicado
    (listado.json + medias.json + fundamentales.json de esta misma corrida:
    generar_datos.py corre antes en el workflow). None si esos archivos no
    estan o el universo USD resultante es demasiado chico para ser
    representativo (< REG_MIN_TICKERS_AMPLITUD).
    NOTA: el pipeline no publica EMA200/SMA50 por ticker (solo para el
    subconjunto con Warren Score); se usan los campos ya publicados por
    ticker en medias.json que miden lo mismo en espiritu (tendencia de largo
    y mediano plazo): dist_sma200 (% sobre la SMA200) y dist_ema50 (% sobre
    la EMA50)."""
    listado = leer_json(carpeta / "listado.json") or {}
    acciones = listado.get("acciones") if isinstance(listado, dict) else None
    medias = leer_json(carpeta / "medias.json") or []
    fundamentales = leer_json(carpeta / "fundamentales.json") or []
    if not isinstance(acciones, list) or not isinstance(medias, list) or not isinstance(fundamentales, list):
        return None
    moneda_por_t = {f["ticker"]: f.get("moneda") for f in fundamentales if isinstance(f, dict) and f.get("ticker")}
    medias_por_t = {m["ticker"]: m for m in medias if isinstance(m, dict) and m.get("ticker")}
    listado_por_t = {a["ticker"]: a for a in acciones if isinstance(a, dict) and a.get("ticker")}
    universo = [
        t for t, mo in moneda_por_t.items()
        if mo == "USD" and t in medias_por_t and t in listado_por_t and not listado_por_t[t].get("stale")
    ]
    if len(universo) < REG_MIN_TICKERS_AMPLITUD:
        return None

    n200 = n200_sobre = n50 = n50_sobre = 0
    nuevos_altos = nuevos_bajos = 0
    vol_alcista = vol_bajista = 0.0
    for t in universo:
        m, a = medias_por_t[t], listado_por_t[t]
        if m.get("dist_sma200") is not None:
            n200 += 1
            n200_sobre += m["dist_sma200"] > 0
        if m.get("dist_ema50") is not None:
            n50 += 1
            n50_sobre += m["dist_ema50"] > 0
        precio, alto, bajo = m.get("precio"), a.get("high_52w"), a.get("low_52w")
        if precio is not None and alto is not None and precio >= alto:
            nuevos_altos += 1
        if precio is not None and bajo is not None and precio <= bajo:
            nuevos_bajos += 1
        vol_hoy, var_pct = a.get("vol_hoy"), a.get("var_pct")
        if vol_hoy and var_pct is not None:
            if var_pct > 0:
                vol_alcista += vol_hoy
            elif var_pct < 0:
                vol_bajista += vol_hoy

    # % de tickers por encima de su SMA200 (8 pts) / EMA50 (7 pts): mapa
    # lineal 0%->0 pts, 50%->mitad, 100%->el maximo.
    pct_200 = (n200_sobre / n200 * 100) if n200 else None
    pct_50 = (n50_sobre / n50 * 100) if n50 else None
    pts_200 = lineal(pct_200, 0, 100, 0, 8) if pct_200 is not None else 0.0
    pts_50 = lineal(pct_50, 0, 100, 0, 7) if pct_50 is not None else 0.0

    # Nuevos maximos vs. minimos de 52 semanas HOY (6 pts): ratio neto
    # (altos - bajos) / (altos + bajos) en [-1, 1] -> lineal a [0, 6].
    total_52 = nuevos_altos + nuevos_bajos
    ratio_52 = (nuevos_altos - nuevos_bajos) / total_52 if total_52 else 0.0
    pts_52 = lineal(ratio_52, -1, 1, 0, 6)

    # Volumen en ruedas alcistas vs. bajistas HOY (4 pts): mismo tipo de
    # ratio neto en [-1, 1] -> lineal a [0, 4].
    total_vol = vol_alcista + vol_bajista
    ratio_vol = (vol_alcista - vol_bajista) / total_vol if total_vol else 0.0
    pts_vol = lineal(ratio_vol, -1, 1, 0, 4)

    pts = round(min(pts_200 + pts_50 + pts_52 + pts_vol, 30), 1)
    return {
        "pts": pts,
        "max": 30,
        "detalle": {
            "n_universo_usd": len(universo),
            "pct_sobre_sma200": num(pct_200, 1),
            "pct_sobre_ema50": num(pct_50, 1),
            "nuevos_altos_52s": nuevos_altos,
            "nuevos_bajos_52s": nuevos_bajos,
            "ratio_neto_52s": num(ratio_52, 3),
            "vol_alcista": num(vol_alcista, 0),
            "vol_bajista": num(vol_bajista, 0),
            "ratio_neto_volumen": num(ratio_vol, 3),
            "pts_sobre_sma200": num(pts_200, 2),
            "pts_sobre_ema50": num(pts_50, 2),
            "pts_altos_bajos_52s": num(pts_52, 2),
            "pts_volumen": num(pts_vol, 2),
        },
    }


def _sentimiento(vix, indices, amplitud):
    """Sub-score /15 de sentimiento: VIX en zona sana (13-20, tri() cayendo
    a 0 en <=5 o >=32) + put/call (no disponible hoy: ver obtener_put_call).
    En panico extremo (VIX >= 28) si las otras dos capas YA estan fuertes
    (>= 70% de su maximo cada una), se "ablanda" la penalizacion mezclando
    el puntaje 50/50 con el neutro (mitad del maximo): un VIX disparado en
    un mercado que por lo demas esta sano (ej. un solo shock de un dia)
    pesa menos que uno igual de alto con todo lo demas ya deteriorado."""
    valor = (vix or {}).get("valor")
    if valor is None:
        return None
    base = tri(valor, *REG_VIX_SANO) * 15
    ablandado = False
    if valor >= REG_VIX_PANICO and indices and amplitud:
        frac_ind = indices["pts"] / indices["max"] if indices["max"] else 0
        frac_amp = amplitud["pts"] / amplitud["max"] if amplitud["max"] else 0
        if frac_ind >= REG_FRAC_FUERTE and frac_amp >= REG_FRAC_FUERTE:
            base = base * 0.5 + (15 / 2) * 0.5
            ablandado = True
    pts = round(min(max(base, 0.0), 15), 1)
    return {
        "pts": pts,
        "max": 15,
        "pc_disponible": False,
        "detalle": {"vix": num(valor, 2), "zona_sana": "13-20", "panico_ablandado": ablandado},
    }


CRITERIOS_EXPOSICION = (
    (40, "0-39: afuera / cash, esperar mejores condiciones."),
    (60, "40-59: 25-50% de exposicion, posiciones chicas."),
    (80, "60-79: 50-75% de exposicion, solo setups A+."),
    (101, "80-100: exposicion plena."),
)


def calcular_regimen(vix, carpeta_out):
    """Arma el objeto 'regimen' (score 0-100 + detalle por capa) a partir de
    SPY/QQQ (indices), el universo USD ya publicado en 'carpeta_out'
    (amplitud) y el VIX ya descargado (sentimiento). None si ninguna de las
    3 capas tiene datos hoy."""
    detalle_indices, pts_ind, max_ind = {}, 0.0, 0
    for sym in ("SPY", "QQQ"):
        try:
            hist = yf.Ticker(sym).history(period="2y")
        except Exception:  # noqa: BLE001
            hist = None
        capa = _indice_capa(hist)
        if capa:
            detalle_indices[sym] = capa["detalle"]
            pts_ind += capa["pts"]
            max_ind += capa["max"]
    indices = {"pts": round(pts_ind, 1), "max": max_ind, "detalle": detalle_indices} if max_ind else None

    amplitud = _amplitud_universo(carpeta_out)
    sentimiento = _sentimiento(vix, indices, amplitud)

    capas, total_pts, total_max = {}, 0.0, 0
    for clave, capa in (("indices", indices), ("amplitud", amplitud), ("sentimiento", sentimiento)):
        if capa:
            capas[clave] = capa
            total_pts += capa["pts"]
            total_max += capa["max"]
    if total_max == 0:
        return None

    score = round(total_pts / total_max * 100, 1)
    criterio = next(txt for tope, txt in CRITERIOS_EXPOSICION if score < tope)
    return {"score": score, "max": 100, "criterio_exposicion": criterio, "capas": capas}


def _combinar(nuevo, previo):
    """Campo por campo: si el valor nuevo es None (fuente caida), se queda
    el de la corrida anterior. Recursivo para los dicts anidados."""
    if nuevo is None:
        return previo
    if isinstance(nuevo, dict) and isinstance(previo, dict):
        return {k: _combinar(nuevo.get(k), previo.get(k)) for k in dict.fromkeys([*nuevo, *previo])}
    return nuevo


def main(argv=None):
    ap = argparse.ArgumentParser(description="Indicadores de mercado/macro -> mercado_macro.json")
    ap.add_argument("--out", type=Path, default=DIR_DATOS_PUBLICOS)
    args = ap.parse_args(argv)
    ruta = args.out / "mercado_macro.json"
    previo = leer_json(ruta, {}) or {}

    ahora = datetime.now(TZ)
    vix = obtener_vix()
    nuevos = {
        "vix": vix,
        "yield_curve": obtener_yield_curve(),
        "fear_greed_cripto": obtener_fear_greed_cripto(),
        "fear_greed_acciones": obtener_fear_greed_acciones(),
        "indicadores_usa": obtener_indicadores_usa(),
    }
    fallidos = [k for k, v in nuevos.items() if v is None or (isinstance(v, dict) and None in v.values())]
    if fallidos:
        print(f"  ! Sin dato nuevo (se conserva el anterior) en: {', '.join(fallidos)}")
    # Regimen de Mercado: siempre se recalcula de cero con lo disponible HOY
    # (no se arrastra el de la corrida anterior campo por campo como el
    # resto: si a un indice o al VIX de hoy le falta un dato, esa capa se
    # excluye y se renormaliza, no se rellena con un valor viejo).
    regimen = calcular_regimen(vix, args.out)
    if regimen is None:
        print("  ! Regimen de Mercado sin calcular (sin datos de indices/amplitud/sentimiento hoy).")
    else:
        print(
            f"  Regimen de Mercado: {regimen['score']}/100 ({regimen['criterio_exposicion']}) "
            f"[capas: {', '.join(regimen['capas'])}]"
        )
    salida = {"actualizado": ahora.isoformat()}
    for k, v in nuevos.items():
        salida[k] = _combinar(v, previo.get(k))
    salida["regimen"] = regimen
    # Si solo cambio el timestamp (fin de semana: nada se movio) no se toca
    # el archivo, asi la corrida no genera commit.
    if not escribir_json(ruta, salida, ignorar_claves=("actualizado",)):
        print("mercado_macro.json sin cambios.")


if __name__ == "__main__":
    main()
