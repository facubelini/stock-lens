"""Corre los dos backtests (Screener y Score) con UNA sola descarga de 5y
del universo USD. Antes cada script bajaba su propio historico de los ~440
tickers (dos veces el mismo request pesado en el mismo job).

Uso:
    python scripts/backtests.py [--out CARPETA]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import backtest_score  # noqa: E402
import backtest_screener  # noqa: E402
from comun import DIR_DATOS_PUBLICOS  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description="Backtests del Screener y del Score (una sola descarga)")
    ap.add_argument("--out", type=Path, default=DIR_DATOS_PUBLICOS)
    args = ap.parse_args(argv)
    historicos = backtest_screener.descargar_para_backtest(backtest_screener.universo_usd(args.out))
    if not historicos:
        print("::error::No se pudo descargar ningun historico para los backtests.")
        sys.exit(1)
    backtest_screener.main(["--out", str(args.out)], historicos=historicos)
    backtest_score.main(["--out", str(args.out)], historicos=historicos)


if __name__ == "__main__":
    main()
