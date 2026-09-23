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

import requests
import yfinance as yf

from comun import DIR_DATOS_PUBLICOS, TZ, escribir_json, leer_json, num


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
    nuevos = {
        "vix": obtener_vix(),
        "yield_curve": obtener_yield_curve(),
        "fear_greed_cripto": obtener_fear_greed_cripto(),
        "fear_greed_acciones": obtener_fear_greed_acciones(),
        "indicadores_usa": obtener_indicadores_usa(),
    }
    fallidos = [k for k, v in nuevos.items() if v is None or (isinstance(v, dict) and None in v.values())]
    if fallidos:
        print(f"  ! Sin dato nuevo (se conserva el anterior) en: {', '.join(fallidos)}")
    salida = {"actualizado": ahora.isoformat()}
    for k, v in nuevos.items():
        salida[k] = _combinar(v, previo.get(k))
    # Si solo cambio el timestamp (fin de semana: nada se movio) no se toca
    # el archivo, asi la corrida no genera commit.
    if not escribir_json(ruta, salida, ignorar_claves=("actualizado",)):
        print("mercado_macro.json sin cambios.")


if __name__ == "__main__":
    main()
