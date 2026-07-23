"""Genera JSON de PRUEBA (datos sinteticos, sin red) a partir de
data/tickers.xlsx. Sirve para desarrollar/ver la UI sin depender de yfinance.

NO usar en produccion: los numeros son ficticios pero deterministas.

Uso:
    python scripts/generar_datos_mock.py
"""

import json
import random
import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

from comparables_universo import INDUSTRIA_COMPARABLES
from generar_datos import calcular_screener, calcular_setup_scanner, leer_tickers

RAIZ = Path(__file__).resolve().parent.parent
DIR_SALIDA = RAIZ / "public" / "data"
TZ = ZoneInfo("America/Argentina/Buenos_Aires")

CLAVES_BENCH = [
    "per_trailing", "per_forward", "peg", "ev_sales", "pb", "ps", "market_cap",
    "eps", "profit_margin", "roe", "dividend_yield", "beta", "debt_to_equity", "current_ratio",
]


def r2(v):
    return round(v, 2)


def _normalizar_industria(s):
    if not s:
        return ""
    s = str(s).replace("—", "-").replace("–", "-")
    s = re.sub(r"\s*-\s*", " - ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip().lower()


def _fundamentales_random(rng):
    return {
        "per_trailing": r2(rng.uniform(8, 45)),
        "per_forward": r2(rng.uniform(7, 38)),
        "peg": r2(rng.uniform(0.5, 3.5)),
        "ev_sales": r2(rng.uniform(1, 15)),
        "pb": r2(rng.uniform(0.8, 18)),
        "ps": r2(rng.uniform(1, 14)),
        "market_cap": int(rng.uniform(5e9, 3e12)),
        "eps": r2(rng.uniform(0.5, 25)),
        "profit_margin": r2(rng.uniform(-5, 40)),
        "roe": r2(rng.uniform(-10, 60)),
        "dividend_yield": r2(rng.uniform(0, 5)),
        "beta": r2(rng.uniform(0.4, 2.2)),
        "debt_to_equity": r2(rng.uniform(0, 250)),
        "current_ratio": r2(rng.uniform(0.5, 3.5)),
    }


def _hist_sintetico(rng, precio_final, dias=1260):
    """Camino aleatorio de ~5 anios de habiles terminando 'hoy', calibrado para
    llegar al precio final del resto del mock. Sirve para probar el screener
    (calcular_screener espera un DataFrame con High/Low/Close y DatetimeIndex,
    igual que el que devuelve yf.Ticker().history())."""
    fechas = pd.bdate_range(end=pd.Timestamp.now(tz=TZ).tz_localize(None), periods=dias)
    precios, p = [], precio_final / (1 + rng.uniform(-0.4, 0.6))  # arranque ~5 anios atras
    for _ in range(dias):
        p *= 1 + rng.uniform(-0.025, 0.025)
        precios.append(p)
    # Reescala para que termine justo en precio_final (consistente con el resto del mock).
    factor = precio_final / precios[-1]
    precios = [x * factor for x in precios]
    altos = [p * (1 + rng.uniform(0, 0.012)) for p in precios]
    bajos = [p * (1 - rng.uniform(0, 0.012)) for p in precios]
    volumenes = [rng.uniform(5e4, 5e6) for _ in precios]
    return pd.DataFrame(
        {"High": altos, "Low": bajos, "Close": precios, "Volume": volumenes}, index=fechas
    )


def _mediana_de(filas, clave):
    vals = sorted(f[clave] for f in filas if f.get(clave) is not None)
    if not vals:
        return None
    n = len(vals)
    m = n // 2
    return vals[m] if n % 2 else (vals[m - 1] + vals[m]) / 2


def construir_comparables_mock(fundamentales):
    """Version sin red de construir_comparables(): mismos peers curados, pero
    con ratios sinteticos (deterministas por ticker) en vez de yfinance."""
    por_industria = {}
    for f in fundamentales:
        por_industria.setdefault(f["industria"], []).append(f)

    tickers_propios = {f["ticker"] for f in fundamentales}
    resultado = []

    for industria, propios in sorted(por_industria.items()):
        peers_curados = INDUSTRIA_COMPARABLES.get(_normalizar_industria(industria))
        if not peers_curados:
            continue

        pares = [{**p, "en_portfolio": True} for p in propios]
        vistos = set(tickers_propios)
        for peer in peers_curados:
            if peer in vistos:
                continue
            vistos.add(peer)
            rng = random.Random(peer)
            pares.append(
                {
                    "ticker": peer,
                    "nombre": peer,
                    "industria": industria,
                    "en_portfolio": False,
                    **_fundamentales_random(rng),
                    "sector": industria,
                }
            )

        resultado.append(
            {
                "industria": industria,
                "pares": pares,
                "mediana": {k: r2(v) if (v := _mediana_de(pares, k)) is not None else None for k in CLAVES_BENCH},
            }
        )

    return resultado


def main():
    DIR_SALIDA.mkdir(parents=True, exist_ok=True)
    df = leer_tickers()

    listado, medias, fundamentales, screener, scanner_setups = [], [], [], [], []

    for _, fila in df.iterrows():
        t = str(fila["Ticker"]).strip()
        if not t or t.lower() in ("nan", "none"):
            continue
        industria = str(fila["Industria"]).strip() or "Sin clasificar"
        pais = str(fila["Pais"]).strip() or "Sin país"
        nombre = str(fila.get("Nombre", "")).strip() or t

        # Semilla deterministica por ticker (reproducible entre corridas).
        rng = random.Random(t)
        precio = rng.uniform(15, 600)
        base = {"ticker": t, "nombre": nombre, "industria": industria, "pais": pais}

        # Sparkline mock: pequena caminata aleatoria de 30 puntos.
        spark, p = [], precio
        for _ in range(30):
            p *= 1 + rng.uniform(-0.03, 0.03)
            spark.append(r2(p))

        listado.append(
            {
                **base,
                "var_pct": r2(rng.uniform(-5, 5)),
                "rsi": r2(rng.uniform(20, 85)),
                "spark": spark,
            }
        )

        # ~30% de los tickers simulan tener CEDEAR (no todos lo tienen en la
        # realidad tampoco) — ratio realista + CCL implicito con algo de
        # ruido respecto al CCL "de mercado" simulado. ratio N:1 = N
        # certificados representan 1 accion, entonces precio por certificado
        # = (precio USD * CCL) / N.
        tiene_cedear = rng.random() < 0.3
        cedear_ratio = rng.choice([1, 2, 3, 4, 5, 6, 10, 15, 20, 24, 30]) if tiene_cedear else None
        ccl_mock = rng.uniform(950, 1250)
        cedear_precio = (
            r2(precio * ccl_mock / cedear_ratio * rng.uniform(0.97, 1.03)) if tiene_cedear else None
        )

        medias.append(
            {
                **base,
                "precio": r2(precio),
                "dist_ema21": r2(rng.uniform(-12, 12)),
                "dist_ema50": r2(rng.uniform(-20, 20)),
                "dist_ema150": r2(rng.uniform(-30, 35)),
                "dist_sma200": r2(rng.uniform(-40, 50)),
                "cedear_ticker": f"{t}.BA" if tiene_cedear else None,
                "cedear_precio": cedear_precio,
                "cedear_ratio": cedear_ratio,
                "cedear_ccl_implicito": r2(cedear_precio * cedear_ratio / precio) if tiene_cedear else None,
            }
        )

        fundamentales.append(
            {
                **base,
                "per_trailing": r2(rng.uniform(8, 45)),
                "per_forward": r2(rng.uniform(7, 38)),
                "peg": r2(rng.uniform(0.5, 3.5)),
                "ev_sales": r2(rng.uniform(1, 15)),
                "pb": r2(rng.uniform(0.8, 18)),
                "ps": r2(rng.uniform(1, 14)),
                "market_cap": int(rng.uniform(5e9, 3e12)),
                "eps": r2(rng.uniform(0.5, 25)),
                "profit_margin": r2(rng.uniform(-5, 40)),
                "roe": r2(rng.uniform(-10, 60)),
                "dividend_yield": r2(rng.uniform(0, 5)),
                "beta": r2(rng.uniform(0.4, 2.2)),
                "debt_to_equity": r2(rng.uniform(0, 250)),
                "current_ratio": r2(rng.uniform(0.5, 3.5)),
                "sector": industria,
            }
        )

        hist_sint = _hist_sintetico(rng, precio)
        screener.append({**base, **calcular_screener(hist_sint)})
        scanner_setups.append({**base, **calcular_setup_scanner(hist_sint)})

    promedios = []
    df_l = pd.DataFrame(listado)
    for industria, g in df_l.groupby("industria", sort=True):
        promedios.append(
            {
                "industria": industria,
                "rsi_promedio": r2(g["rsi"].mean()),
                "var_pct_promedio": r2(g["var_pct"].mean()),
                "n": int(len(g)),
            }
        )

    meta = {
        "ultima_actualizacion": datetime.now(TZ).isoformat(),
        "n_tickers": len(listado),
        "tickers_invalidos": [],
        "_nota": "DATOS DE PRUEBA (mock) generados sin conexion.",
    }

    def escribir(nombre, obj):
        with open(DIR_SALIDA / nombre, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)

    comparables = construir_comparables_mock(fundamentales)

    escribir("listado.json", {"acciones": listado, "promedios_por_industria": promedios})
    escribir("medias.json", medias)
    escribir("fundamentales.json", fundamentales)
    escribir("comparables.json", comparables)
    escribir("screener.json", screener)
    escribir("scanner_setups.json", scanner_setups)
    escribir("meta.json", meta)
    print(f"Mock generado: {len(listado)} tickers en {DIR_SALIDA.relative_to(RAIZ)}")


if __name__ == "__main__":
    main()
