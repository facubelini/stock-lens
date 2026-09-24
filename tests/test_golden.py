"""Regresion golden del pipeline completo: reproduce offline (red grabada en
tests/fixtures/golden_red.pkl.gz, reloj congelado) y compara byte a byte
TODOS los archivos que escribe (public/data + estado, dos escenarios)
contra tests/fixtures/golden_salida.json.gz.

Si un cambio de comportamiento es A PROPOSITO, regenerar la salida esperada:
    python tests/golden/grabacion.py actualizar
y revisar el diff antes de commitear. Para volver a grabar la red (otro
universo, yfinance nuevo): python tests/golden/grabacion.py grabar
"""

import sys
from datetime import datetime

import pytest

import grabacion


def _tz_local_compatible():
    # En Linux time-machine fija TZ=America/Argentina/Buenos_Aires al viajar;
    # en Windows no puede, y el pipeline usa datetime.now() naive (hora
    # local) en dos lugares: la maquina tiene que estar en UTC-3.
    if sys.platform != "win32":
        return True
    return datetime.now().astimezone().utcoffset().total_seconds() == -3 * 3600


@pytest.mark.skipif(not _tz_local_compatible(), reason="Windows fuera de UTC-3: el golden depende de la hora local")
def test_reproduccion_identica_byte_a_byte(tmp_path):
    red = grabacion.cargar_red()
    esperado = grabacion.cargar_salida()
    obtenido, faltantes = grabacion.reproducir(red, tmp_path)
    # esc1 es exactamente la corrida grabada: no puede pedir nada que no este.
    assert faltantes["esc1"] == [], f"el pipeline pidio datos no grabados: {faltantes['esc1'][:5]}"
    difs = grabacion.diferencias(esperado, obtenido)
    assert not difs, "La salida del pipeline cambio:\n" + "\n".join(difs)


def test_codec_de_dataframes_ida_y_vuelta():
    import numpy as np
    import pandas as pd

    idx = pd.date_range("2024-01-01", periods=4, freq="D", tz="America/New_York")
    cols = pd.MultiIndex.from_tuples([("AAA", "Close"), ("AAA", "Volume"), ("BBB", "Close")], names=["Ticker", "Price"])
    df = pd.DataFrame([[1.5, 10, np.nan], [2.0, 11, 3.0], [np.nan, 12, 4.0], [2.5, 13, 5.0]], index=idx, columns=cols)
    df[("AAA", "Volume")] = df[("AAA", "Volume")].astype("int64")
    tipo, cod = grabacion.codificar(df)
    pd.testing.assert_frame_equal(grabacion.decodificar((tipo, cod)), df, check_freq=False)

    texto = pd.DataFrame({"Text": ["Sale at price 1", None], "Value": [1.0, np.nan],
                          "Start Date": pd.to_datetime(["2024-01-02", "2024-02-03"])})
    pd.testing.assert_frame_equal(grabacion.decodificar(grabacion.codificar(texto)), texto)
