"""Genera JSON de PRUEBA (datos sinteticos, sin red) a partir de
data/tickers.xlsx. Sirve para desarrollar/ver la UI sin depender de yfinance.

NO usar en produccion: los numeros son ficticios pero deterministas.

Uso:
    python scripts/generar_datos_mock.py
"""

import json
import random
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

RAIZ = Path(__file__).resolve().parent.parent
ARCHIVO_TICKERS = RAIZ / "data" / "tickers.xlsx"
DIR_SALIDA = RAIZ / "public" / "data"
TZ = ZoneInfo("America/Argentina/Buenos_Aires")


def r2(v):
    return round(v, 2)


def main():
    DIR_SALIDA.mkdir(parents=True, exist_ok=True)
    df = pd.read_excel(ARCHIVO_TICKERS, engine="openpyxl")
    df.columns = [str(c).strip() for c in df.columns]

    listado, medias, fundamentales = [], [], []

    for _, fila in df.iterrows():
        t = str(fila["Ticker"]).strip()
        if not t or t.lower() in ("nan", "none"):
            continue
        industria = str(fila["Industria"]).strip()
        pais = str(fila["Pais"]).strip()
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

        medias.append(
            {
                **base,
                "precio": r2(precio),
                "dist_ema21": r2(rng.uniform(-12, 12)),
                "dist_ema50": r2(rng.uniform(-20, 20)),
                "dist_ema150": r2(rng.uniform(-30, 35)),
                "dist_sma200": r2(rng.uniform(-40, 50)),
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

    escribir("listado.json", {"acciones": listado, "promedios_por_industria": promedios})
    escribir("medias.json", medias)
    escribir("fundamentales.json", fundamentales)
    escribir("meta.json", meta)
    print(f"Mock generado: {len(listado)} tickers en {DIR_SALIDA.relative_to(RAIZ)}")


if __name__ == "__main__":
    main()
