import { Fragment } from 'react'
import { useJson } from '../lib/useJson'
import { fmtFecha } from '../lib/formato'

const ORDEN = ['FAVORABLE', 'NEUTRAL', 'FLOJO', 'BASELINE']
const LABEL = {
  FAVORABLE: 'Favorable (≥66)',
  NEUTRAL: 'Neutral (40-65)',
  FLOJO: 'Flojo (<40)',
  BASELINE: 'Cualquier día (base)',
}
const COLOR = {
  FAVORABLE: '#7ee2a8',
  NEUTRAL: '#fbbf62',
  FLOJO: '#ff9d9d',
  BASELINE: '#c9d4e0',
}

// Backtest del Score de Listado (solo Tendencia+Momentum — Valuacion no
// tiene serie historica) sobre 5 años, armado con scripts/backtest_score.py
// (corre mensual via GitHub Actions). Si todavía no corrió, se omite en
// silencio — es un extra, no algo crítico.
export default function BacktestScore() {
  const { data, cargando, error } = useJson('backtest_score.json')
  if (cargando || error || !data?.stats || !Object.keys(data.stats).length) return null

  const { stats, horizontes_dias: horizontes, n_tickers_evaluados, actualizado } = data
  const filas = ORDEN.filter((v) => stats[v])

  return (
    <details className="mt-6 rounded-lg border border-terminal-border bg-terminal-panel">
      <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-semibold text-terminal-text">
        📊 ¿Funciona el Score? Backtest histórico ({n_tickers_evaluados} tickers, 5 años)
      </summary>
      <div className="border-t border-terminal-border p-3">
        <p className="mb-3 text-xs text-terminal-dim">
          Aproximación técnica del Score (solo Tendencia + Momentum — Valuación no tiene serie
          histórica de PER/PEG para backtestear, mismo mecanismo que ya usa el Score real cuando le
          falta ese dato). Hit-rate = % de veces que el retorno fue positivo en los N días hábiles
          siguientes, sobre todo el historial disponible, sin look-ahead.{' '}
          <b>"Cualquier día"</b> es la base de comparación: si un nivel de score no supera
          claramente esa línea, no está aportando ventaja real. Actualizado:{' '}
          {actualizado ? fmtFecha(actualizado) : '—'} · corre una vez por mes.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                <th className="px-2 py-2 font-semibold">Nivel de score</th>
                {horizontes.map((h) => (
                  <th key={h} className="px-2 py-2 text-right font-semibold" colSpan={2}>
                    {h}d hábiles
                  </th>
                ))}
              </tr>
              <tr className="bg-terminal-panel2 text-left text-[10px] uppercase text-terminal-dim">
                <th></th>
                {horizontes.map((h) => (
                  <Fragment key={h}>
                    <th className="px-2 py-1 text-right font-normal">Hit-rate</th>
                    <th className="px-2 py-1 text-right font-normal">Retorno prom.</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {filas.map((v) => (
                <tr key={v} className="border-t border-terminal-border">
                  <td className="px-2 py-1.5 font-semibold" style={{ color: COLOR[v] }}>
                    {LABEL[v]}
                  </td>
                  {horizontes.map((h) => {
                    const s = stats[v][String(h)]
                    return (
                      <Fragment key={h}>
                        <td className="px-2 py-1.5 text-right tabular">{s ? `${s.hit_rate}%` : '—'}</td>
                        <td className="px-2 py-1.5 text-right tabular">
                          {s ? `${s.retorno_prom >= 0 ? '+' : ''}${s.retorno_prom}%` : '—'}
                        </td>
                      </Fragment>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-terminal-dim">
          n por nivel (a {horizontes[0]}d):{' '}
          {filas.map((v) => `${LABEL[v]} ${stats[v][String(horizontes[0])]?.n ?? 0}`).join(' · ')}
        </p>
      </div>
    </details>
  )
}
