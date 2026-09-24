"""Config comun de pytest: scripts/ en sys.path (asi los tests importan
comun, pipeline.* y generar_datos igual que cuando se corren los scripts
desde la raiz del repo) y helpers de series sinteticas."""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

RAIZ = Path(__file__).resolve().parent.parent
for p in (RAIZ / "scripts", RAIZ / "tests" / "golden"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))


def ohlcv(closes, inicio="2020-01-01", rango_pct=0.5, volumen=1_000_000, freq="B"):
    """DataFrame OHLCV diario sintetico a partir de una lista de cierres:
    Open = cierre anterior, High/Low = cierre +- rango_pct %."""
    c = np.asarray(closes, dtype="float64")
    idx = pd.date_range(inicio, periods=len(c), freq=freq)
    o = np.concatenate([[c[0]], c[:-1]])
    h = np.maximum(o, c) * (1 + rango_pct / 100)
    lo = np.minimum(o, c) * (1 - rango_pct / 100)
    v = np.full(len(c), float(volumen)) if np.isscalar(volumen) else np.asarray(volumen, dtype="float64")
    return pd.DataFrame({"Open": o, "High": h, "Low": lo, "Close": c, "Volume": v}, index=idx)


def tramos(*puntos):
    """Serie lineal por tramos: tramos(100, (10, 120), (5, 110)) = arranca en
    100, sube a 120 en 10 ruedas y baja a 110 en 5."""
    serie = [float(puntos[0])]
    for n, destino in puntos[1:]:
        ini = serie[-1]
        serie += [ini + (destino - ini) * k / n for k in range(1, n + 1)]
    return serie


@pytest.fixture
def hacer_ohlcv():
    return ohlcv


@pytest.fixture
def hacer_tramos():
    return tramos
