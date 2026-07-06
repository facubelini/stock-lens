import { fmtPct, fmtNum, estiloValor, estiloRSI, promedio } from '../lib/formato'
import { nivelScore } from '../lib/score'
import BotonPin from './BotonPin'
import EditorClasificacion from './EditorClasificacion'
import Semaforo from './Semaforo'
import Sparkline from './Sparkline'
import TickerLink from './TickerLink'

// Recuadro de una industria: encabezado con promedios (Var%, RSI, score) +
// lista de tickers con favorito, score, sparkline, Var% y RSI.
export default function TarjetaIndustria({
  industria,
  filas,
  isPinned,
  toggle,
  destacada = false,
  industrias = [],
  sectores = [],
}) {
  const varProm = promedio(filas, (f) => f.var_pct)
  const rsiProm = promedio(filas, (f) => f.rsi)
  const scoreProm = promedio(filas, (f) => f._score?.score)
  const nivel = nivelScore(scoreProm == null ? null : Math.round(scoreProm))

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-lg border bg-terminal-panel ${
        destacada ? 'border-terminal-accent/60' : 'border-terminal-border'
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-terminal-border bg-terminal-panel2 px-3 py-2">
        <div className="truncate font-semibold text-terminal-accent">
          {industria} <span className="font-normal text-terminal-dim">· {filas.length}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs">
          <span className="rounded px-1.5 py-0.5 tabular" style={estiloValor(varProm, 6)}>
            {fmtPct(varProm, { signo: true })}
          </span>
          <span className="rounded px-1.5 py-0.5 tabular" style={estiloRSI(rsiProm)}>
            RSI {fmtNum(rsiProm, 0)}
          </span>
          {scoreProm != null && (
            <span
              className="flex items-center gap-1 tabular"
              style={{ color: nivel.color }}
              title="Score promedio del grupo (orientativo)"
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: nivel.color }}
              />
              {Math.round(scoreProm)}
            </span>
          )}
        </div>
      </div>

      <table className="w-full text-sm">
        <tbody>
          {filas.map((r) => (
            <tr
              key={r.ticker}
              className="border-t border-terminal-border/50 transition-colors hover:bg-terminal-panel2/40"
            >
              <td className="w-6 py-1 pl-2 pr-0 text-center align-middle">
                <BotonPin ticker={r.ticker} isPinned={isPinned} toggle={toggle} />
              </td>
              <td className="py-1 pl-1 pr-1 align-middle">
                <span className="flex items-center gap-1.5">
                  <Semaforo resultado={r._score} mostrarNumero={false} />
                  <TickerLink ticker={r.ticker} className="font-semibold" title={r.nombre} />
                  {r.stale && (
                    <span
                      className="text-terminal-warn"
                      title={`Dato arrastrado de la última corrida exitosa (${r.actualizado ?? '?'})`}
                    >
                      🕒
                    </span>
                  )}
                  <EditorClasificacion
                    ticker={r.ticker}
                    industria={r.industria}
                    sector={r.sector}
                    industrias={industrias}
                    sectores={sectores}
                  />
                </span>
              </td>
              <td className="py-1 px-1 align-middle">
                <Sparkline datos={r.spark} />
              </td>
              <td
                className="py-1 px-2 text-right align-middle tabular"
                style={estiloValor(r.var_pct, 6)}
              >
                {fmtPct(r.var_pct, { signo: true })}
              </td>
              <td
                className="w-12 py-1 px-2 text-right align-middle tabular"
                style={estiloRSI(r.rsi)}
              >
                {fmtNum(r.rsi, 1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
