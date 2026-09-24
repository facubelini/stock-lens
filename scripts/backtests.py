"""Corre los tres backtests (Screener, Score y Señales) con UNA sola descarga
de 5y del universo USD. Antes cada script bajaba su propio historico de los
~440 tickers (varias veces el mismo request pesado en el mismo job).

Uso:
    python scripts/backtests.py [--out CARPETA]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import backtest_score  # noqa: E402
import backtest_screener  # noqa: E402
import backtest_senales  # noqa: E402
from comun import DIR_DATOS_PUBLICOS  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description="Backtests del Screener, el Score y las Señales (una sola descarga)")
    ap.add_argument("--out", type=Path, default=DIR_DATOS_PUBLICOS)
    args = ap.parse_args(argv)
    # universo_usd necesita SPY (benchmark de backtest_senales): siempre esta
    # en el universo (ETF en USD), asi que viene incluido sin pedirlo aparte.
    historicos = backtest_screener.descargar_para_backtest(backtest_screener.universo_usd(args.out))
    if not historicos:
        print("::error::No se pudo descargar ningun historico para los backtests.")
        sys.exit(1)
    backtest_screener.main(["--out", str(args.out)], historicos=historicos)
    backtest_score.main(["--out", str(args.out)], historicos=historicos)
    backtest_senales.main(["--out", str(args.out)], historicos=historicos)


if __name__ == "__main__":
    main()
