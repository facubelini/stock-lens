import { useMemo } from 'react'
import { fmtPct, fmtNum, estiloValor } from '../lib/formato'
import { compararValores } from '../lib/ordenar'
import TickerLink from './TickerLink'
import ComoSeCalcula, { Formula } from './ComoSeCalcula'
import { Vacio } from './Estados'

// Episodic Pivots (guía Warren Bife): un ticker "pivotea" hoy si sube fuerte
// Y con volumen fuera de lo normal en la misma rueda — la combinación
// importa, no cada dato por separado. `filas` ya viene filtrada de stale /
// sin volumen (mismo criterio que la Cartelera del día).
const VAR_MIN = 4
const VOL_MIN = 2

export function calcularEpisodicPivots(filas) {
  return (filas ?? [])
    .filter((f) => f.var_pct != null && f.var_pct >= VAR_MIN && f.vol_ratio != null && f.vol_ratio >= VOL_MIN)
    .sort((a, b) => compararValores(a.var_pct, b.var_pct, 'desc') || a.ticker.localeCompare(b.ticker))
}

export default function EpisodicPivots({ filas }) {
  const pivots = useMemo(() => calcularEpisodicPivots(filas), [filas])

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-terminal-border">
      <div className="flex items-center justify-between gap-2 border-b border-terminal-border bg-terminal-panel2 px-2.5 py-1.5">
        <span className="text-xs font-semibold text-terminal-text">⚡ Episodic Pivots</span>
        <span className="text-[11px] text-terminal-dim tabular">{pivots.length}</span>
      </div>
      {pivots.length === 0 ? (
        <Vacio texto={`Ningún ticker con var % ≥ +${VAR_MIN}% y volumen ≥ ${VOL_MIN}× hoy.`} />
      ) : (
        <table className="w-full border-collapse text-sm">
          <tbody>
            {pivots.map((f) => (
              <tr key={f.ticker} className="border-t border-terminal-border first:border-t-0">
                <td className="max-w-0 px-2 py-1">
                  <div className="flex items-center gap-1.5">
                    <TickerLink ticker={f.ticker} className="font-semibold" />
                    <span
                      className="inline-block rounded bg-terminal-info/15 px-1 py-0.5 text-[9px] font-bold leading-none text-terminal-info"
                      title="Episodic Pivot: var. % ≥ +4% con volumen ≥ 2× el promedio"
                    >
                      EP
                    </span>
                  </div>
                  <div className="truncate text-[10px] text-terminal-dim">
                    {f.nombre} {f.industria ? `· ${f.industria}` : ''}
                  </div>
                </td>
                <td className="whitespace-nowrap px-2 py-1 text-right tabular" style={estiloValor(f.var_pct, 6)}>
                  {fmtPct(f.var_pct, { signo: true })}
                </td>
                <td
                  className="whitespace-nowrap px-2 py-1 text-right tabular text-terminal-info"
                  title={`Volumen de hoy: ${fmtNum(f.vol_ratio, 2)}× el promedio de 20 ruedas`}
                >
                  +{Math.round((f.vol_ratio - 1) * 100)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ComoSeCalcula className="m-2 mt-1.5">
        <p>
          Un ticker es <b className="text-terminal-text">Episodic Pivot</b> hoy si{' '}
          <Formula>var % ≥ +{VAR_MIN}%</Formula> Y <Formula>vol_ratio ≥ {VOL_MIN}×</Formula> (volumen de
          hoy vs el promedio de 20 ruedas, de <Formula>listado.json</Formula>) en la misma rueda — el salto
          de precio solo, o el volumen solo, no alcanzan. Orden: mayor var % primero. La columna de la
          derecha muestra <Formula>vol_ratio</Formula> como exceso sobre el promedio (×2,8 se muestra
          "+180%").
        </p>
        <p>
          Un Episodic Pivot <b>no siempre es señal de compra inmediata</b> — el precio puede estar
          extendido. Agregalo a favoritos, esperá una consolidación de 2-4 semanas y buscá un pullback
          ordenado antes de entrar.
        </p>
      </ComoSeCalcula>
    </div>
  )
}
