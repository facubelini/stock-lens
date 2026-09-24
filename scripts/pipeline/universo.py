"""Universo de tickers: lectura del Excel, filtro de basura por regla,
cache de invalidos con TTL y resolucion de cada ticker a su simbolo de
Yahoo (pelado / .SA / .BA) sin cambiar de plaza por un fallo transitorio."""

import re
import unicodedata
from datetime import datetime

import pandas as pd
import yfinance as yf

from comun import RAIZ, base_ticker, leer_json

from .descarga import descargar_historicos


ARCHIVO_TICKERS = RAIZ / "data" / "tickers.xlsx"

# Encabezados aceptados para la columna de tickers (se normalizan sin acentos).
NOMBRES_TICKER = ["ticker", "codigo", "symbol", "simbolo", "code", "tickers"]

# Si el ticker "pelado" no trae datos, se reintenta con estos sufijos:
# .SA = B3 (Brasil), .BA = BYMA (Argentina). Solo para tickers que NUNCA
# resolvieron: si ya resolvieron alguna vez, se usa siempre el mismo simbolo
# (ver resolver_universo) para no saltar de plaza por un fallo transitorio
# (paso con BK: un 404 puntual de Yahoo lo dejo resuelto como BK.BA, el
# CEDEAR en pesos, en vez de la accion de NYSE).
SUFIJOS = ["", ".SA", ".BA"]

# Tickers que no resolvieron en ninguna plaza: no se reintentan en cada
# corrida (eran ~50 x 3 sufijos) hasta que pase este TTL.
TTL_INVALIDOS_DIAS = 7

# Filtro de "basura" del Excel (se aplica por regla, el Excel no se toca):
# filas que no son tickers (DIVIDENDOS, EFECTIVO...) y bonos soberanos
# argentinos (AL29, GD30...), que Yahoo no tiene.
# OJO: nada de siglas cortas tipo "CCL"/"USD": son tickers reales (Carnival,
# ProShares Ultra Semiconductors).
PALABRAS_NO_TICKER = {
    "DIVIDENDOS", "DIVIDENDO", "EFECTIVO", "CAUCION", "CAUCIONES", "SALDO", "PESOS", "DOLARES",
}
RE_BONO_AR = re.compile(r"^(AL|GD|AE|TX|TZX|TV)\d{2}[DC]?$")
RE_TICKER_VALIDO = re.compile(r"^[A-Z0-9][A-Z0-9.\-^=]*$")


# ---------------------------------------------------------------------------
# Lectura del Excel de entrada
# ---------------------------------------------------------------------------
def _norm(s):
    """Normaliza un encabezado: sin acentos, minúsculas, sin espacios extra."""
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode("ascii")
    return s.strip().lower()


def leer_tickers():
    """Lee data/tickers.xlsx. Sólo la columna de tickers es obligatoria
    (acepta encabezados Ticker, Codigo, Symbol, etc.). Industria, Pais y
    Nombre son opcionales: si faltan, se derivan de yfinance (sector/country/
    nombre) en el procesamiento. Devuelve un DataFrame Ticker/Industria/Pais/Nombre."""
    if not ARCHIVO_TICKERS.exists():
        raise SystemExit(
            f"No se encontro {ARCHIVO_TICKERS}.\n"
            "Subi tu Excel de tickers (ver columnas en el README)."
        )

    df = pd.read_excel(ARCHIVO_TICKERS, engine="openpyxl")
    df.columns = [str(c).strip() for c in df.columns]
    norm_map = {_norm(c): c for c in df.columns}

    col_ticker = next((norm_map[n] for n in NOMBRES_TICKER if n in norm_map), None)
    if col_ticker is None:
        if len(df.columns) == 1:
            col_ticker = df.columns[0]  # una sola columna => es la de tickers
        else:
            raise SystemExit(
                "No encontre la columna de tickers. Usa un encabezado como "
                f"'Ticker' o 'Codigo'. Columnas: {list(df.columns)}"
            )

    def opcional(nombre):
        c = norm_map.get(nombre)
        return df[c].astype(str).str.strip() if c is not None else ""

    out = pd.DataFrame(
        {"Ticker": df[col_ticker].astype(str).str.upper().str.replace(r"\s+", "", regex=True)}
    )
    out["Industria"] = opcional("industria")
    out["Pais"] = opcional("pais")
    out["Nombre"] = opcional("nombre")
    for c in ("Industria", "Pais", "Nombre"):
        out[c] = out[c].replace({"nan": "", "NAN": "", "None": ""})

    out = out[out["Ticker"].str.len() > 0]
    out = out[~out["Ticker"].str.lower().isin(["nan", "none"])]
    out = out.drop_duplicates(subset="Ticker")
    return out.reset_index(drop=True)


def es_ticker_basura(t):
    """True si la fila del Excel no es un ticker cotizable en Yahoo: palabras
    sueltas (DIVIDENDOS, EFECTIVO), bonos soberanos AR (AL30, GD29) o texto
    con caracteres que ningun simbolo usa. Los deslistados no se detectan
    aca: los filtra el cache de invalidos con TTL."""
    t = str(t).upper()
    base = base_ticker(t)
    if base in PALABRAS_NO_TICKER or RE_BONO_AR.match(base):
        return True
    if not RE_TICKER_VALIDO.match(t):
        return True
    # Ningun ticker real es una palabra de 7+ letras (US <=5, B3 4+digitos).
    return base.isalpha() and len(base) >= 7


def mapear_previos(tickers_excel, prev_listado):
    """ticker del Excel -> simbolo con el que resolvio la corrida anterior.
    Primero el match exacto; si no, el mismo ticker con sufijo .SA/.BA,
    salvo que ese simbolo con sufijo este TAMBIEN en el Excel como fila
    propia (el Excel tiene "SEMI" y "SEMI.BA", "AGRO" y "AGRO.BA": indexar
    por ticker pelado los mezclaba y los dos terminaban como .BA)."""
    reservados = set(tickers_excel)
    mapa = {}
    for t in tickers_excel:
        if t in prev_listado:
            mapa[t] = t
            continue
        for suf in SUFIJOS[1:]:
            if f"{t}{suf}" in prev_listado and f"{t}{suf}" not in reservados:
                mapa[t] = f"{t}{suf}"
                break
    return mapa


def resolver_universo(bases, simbolo_previo):
    """dict ticker_base -> (simbolo_resuelto, hist).
    1) Cada ticker se pide con el simbolo con el que resolvio la corrida
       anterior (o pelado si nunca resolvio), con reintentos.
    2) Solo los que NUNCA resolvieron prueban .SA/.BA. Uno que ya tenia
       simbolo y hoy falla NO cambia de plaza: queda para el arrastre
       (stale) y se reintenta en la proxima corrida con el mismo simbolo."""
    candidato = {t: simbolo_previo.get(t, t) for t in bases}
    hists = descargar_historicos(list(candidato.values()))
    resueltos = {t: (s, hists[s]) for t, s in candidato.items() if s in hists}

    nuevos = [t for t in bases if t not in resueltos and t not in simbolo_previo and "." not in t]
    for suf in SUFIJOS[1:]:
        faltan = [t for t in nuevos if t not in resueltos]
        if not faltan:
            break
        print(f"  probando sufijo {suf} para {len(faltan)} ticker(s) nuevos sin datos...")
        h = descargar_historicos([f"{t}{suf}" for t in faltan], esperas=[])
        for t in faltan:
            if f"{t}{suf}" in h:
                resueltos[t] = (f"{t}{suf}", h[f"{t}{suf}"])
    return resueltos


def resolver_ticker(t):
    """Compatibilidad (un solo ticker): (sym, tk, hist, closes) o 4 None."""
    r = resolver_universo([t], {})
    if t not in r:
        return None, None, None, None
    sym, hist = r[t]
    return sym, yf.Ticker(sym), hist, hist["Close"].dropna()


def universo_desde_args(args):
    """Universo crudo: la lista de --tickers (para pruebas) o el Excel,
    recortado a --limite si viene."""
    if args.tickers:
        lista = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        df = pd.DataFrame({"Ticker": list(dict.fromkeys(lista))})
        for c in ("Industria", "Pais", "Nombre"):
            df[c] = ""
    else:
        df = leer_tickers()
    if args.limite:
        df = df.head(args.limite)
    return df.reset_index(drop=True)


def filtrar_universo(tickers, ruta_invalidos, ahora):
    """Saca del universo la basura por regla (es_ticker_basura) y los
    invalidos cacheados cuyo TTL sigue vigente. Devuelve (tickers,
    descartados, invalidos_vigentes, salteados)."""
    descartados = sorted(t for t in tickers["Ticker"] if es_ticker_basura(t))
    tickers = tickers[~tickers["Ticker"].isin(descartados)].reset_index(drop=True)

    cache_invalidos = leer_json(ruta_invalidos, {}) or {}
    invalidos_vigentes = {}
    for t, fecha in cache_invalidos.items():
        try:
            if (ahora.date() - datetime.fromisoformat(fecha).date()).days < TTL_INVALIDOS_DIAS:
                invalidos_vigentes[t] = fecha
        except (TypeError, ValueError):
            pass
    salteados = sorted(t for t in tickers["Ticker"] if t in invalidos_vigentes)
    tickers = tickers[~tickers["Ticker"].isin(salteados)].reset_index(drop=True)
    return tickers, descartados, invalidos_vigentes, salteados
