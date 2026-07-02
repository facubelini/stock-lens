"""Universo de comparables por industria.

Para cada industria que aparece en tus tickers, el pipeline agrega estos
peers (aunque no esten en tu tickers.xlsx) solo para calcular una mediana de
industria mas representativa en la pestana "Comparables". No se agregan a tu
watchlist ni afectan el resto de las pestanas.

Las claves estan normalizadas (minusculas, guiones con espacios: "banks - regional")
via `_normalizar_industria()` en generar_datos.py, asi no importa si Yahoo
devuelve el guion como "-", "–" o "—". Si una industria de tus tickers no
aparece aca, simplemente no se genera su seccion de comparables (el pipeline
avisa por consola cuales industrias quedaron sin mapeo).

Para agregar/sacar comparables de una industria, edita las listas de abajo.
"""

INDUSTRIA_COMPARABLES = {
    "semiconductors": ["NVDA", "AMD", "AVGO", "QCOM", "TXN", "MU", "INTC", "TSM"],
    "semiconductor equipment & materials": ["ASML", "AMAT", "LRCX", "KLAC"],
    "software - infrastructure": ["MSFT", "ORCL", "CRM", "NOW", "SNOW"],
    "software - application": ["ADBE", "INTU", "WDAY", "PANW", "CRWD"],
    "internet content & information": ["GOOGL", "META", "PINS", "SNAP"],
    "internet retail": ["AMZN", "MELI", "EBAY", "ETSY"],
    "credit services": ["UPST", "SOFI", "AFRM", "SYF", "COF", "DFS"],
    "banks - regional": ["PNC", "USB", "TFC", "RF", "KEY", "FITB"],
    "banks - diversified": ["JPM", "BAC", "C", "WFC"],
    "biotechnology": ["AMGN", "VRTX", "REGN", "GILD", "BIIB"],
    "drug manufacturers - general": ["PFE", "MRK", "JNJ", "LLY", "ABBV", "BMY"],
    "auto manufacturers": ["TSLA", "GM", "F", "TM", "STLA"],
    "oil & gas e&p": ["XOM", "CVX", "COP", "EOG", "PXD"],
    "specialty retail": ["HD", "LOW", "TJX", "ROST"],
    "asset management": ["BLK", "BX", "KKR", "APO"],
    "insurance - diversified": ["AIG", "PRU", "MET", "ALL"],
    "airlines": ["DAL", "UAL", "AAL", "LUV"],
    "restaurants": ["MCD", "SBUX", "CMG", "YUM"],
    "telecom services": ["T", "VZ", "TMUS"],
    "utilities - regulated electric": ["NEE", "DUK", "SO", "D"],
    "consumer electronics": ["AAPL", "SONY"],
    "steel": ["NUE", "STLD", "X"],
    "gold": ["NEM", "GOLD", "AEM"],
}
