"""Crea un data/tickers.xlsx de ejemplo para probar el pipeline.

Reemplazalo por tu propio Excel con las columnas:
    Ticker | Industria | Pais | Nombre (opcional)

Uso:
    python scripts/crear_tickers_ejemplo.py
"""

from pathlib import Path

import pandas as pd

RAIZ = Path(__file__).resolve().parent.parent
DESTINO = RAIZ / "data" / "tickers.xlsx"

FILAS = [
    # Ticker, Industria, Pais, Nombre
    ("AAPL", "Tech USA", "USA", "Apple"),
    ("MSFT", "Tech USA", "USA", "Microsoft"),
    ("NVDA", "Tech USA", "USA", "NVIDIA"),
    ("GOOGL", "Tech USA", "USA", "Alphabet"),
    ("JPM", "Finanzas", "USA", "JPMorgan Chase"),
    ("BAC", "Finanzas", "USA", "Bank of America"),
    ("XOM", "Energia", "USA", "Exxon Mobil"),
    ("CVX", "Energia", "USA", "Chevron"),
    ("KO", "Consumo", "USA", "Coca-Cola"),
    ("PG", "Consumo", "USA", "Procter & Gamble"),
    ("YPF", "Argentina", "Argentina", "YPF"),
    ("GGAL", "Argentina", "Argentina", "Grupo Galicia"),
    ("PAM", "Argentina", "Argentina", "Pampa Energia"),
    ("BMA", "Argentina", "Argentina", "Banco Macro"),
]


def main():
    DESTINO.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(FILAS, columns=["Ticker", "Industria", "Pais", "Nombre"])
    df.to_excel(DESTINO, index=False, engine="openpyxl")
    print(f"Creado {DESTINO} con {len(df)} tickers de ejemplo.")


if __name__ == "__main__":
    main()
