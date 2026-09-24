import { useJson } from '../lib/useJson'
import { fmtPct } from '../lib/formato'
import ComoSeCalcula, { Formula } from './ComoSeCalcula'

// Badge de evidencia por panel/tab (Señales y Warren Score): backtest
// histórico de 5 años (scripts/backtest_senales.py, corre mensual) + el
// seguimiento en vivo de esta misma señal (scripts/pipeline/seguimiento.py,
// se actualiza en cada corrida del pipeline). Si falta el archivo o esa
// señal en particular no tiene datos todavía, no renderiza nada (silencioso,
// nunca rompe la página).
export function useBacktestSenales() {
  const { data } = useJson('backtest_senales.json')
  return data
}

export function useSeguimientoSenales() {
  const { data } = useJson('senales_seguimiento.json')
  return data
}

const UMBRAL_COLOR = 0.5 // puntos de exceso vs SPY (mediana) para diferenciarse de la base

function colorPorExceso(diff) {
  if (diff == null) return { fondo: 'rgba(154,167,181,0.15)', texto: '#9aa7b5' }
  if (diff >= UMBRAL_COLOR) return { fondo: 'rgba(126,226,168,0.15)', texto: '#7ee2a8' }
  if (diff <= -UMBRAL_COLOR) return { fondo: 'rgba(255,157,157,0.15)', texto: '#ff9d9d' }
  return { fondo: 'rgba(251,191,98,0.15)', texto: '#fbbf62' }
}

/**
 * Línea de evidencia para un panel/tab: "Backtest 5a: acierto 58% a 10
 * ruedas · mediana +2,1% (exceso +1,2% vs SPY) · n=340 · en vivo: 12
 * cerradas, 7 ganadoras". Colorea segun si supera la base (BASELINE) en el
 * exceso mediano vs. SPY del mismo horizonte.
 *
 * - ruta: [] | ["diario","rebote"] etc. dentro de backtest_senales.json.stats
 *   (ver scripts/backtest_senales.py: ema_diario/ema_semanal/rsi_semanal
 *   ya anidan un nivel mas, vcp_estado/warren_bucket no).
 * - valor: la etiqueta dentro de ese grupo (p.ej. "REBOTE", "Armado", "≥80").
 * - horizonte: dia/semana destacado en la linea compacta (el resto queda en
 *   "¿Cómo se calcula?").
 * - señalVivo: clave de senales_seguimiento.json.stats (p.ej.
 *   "ema_diario_rebote"); si no se pasa, no se muestra la parte "en vivo".
 */
export default function BadgeEvidencia({ ruta = [], valor, horizonte, señalVivo, unidad = 'ruedas', titulo }) {
  const backtest = useBacktestSenales()
  const seguimiento = useSeguimientoSenales()
  if (!backtest?.stats) return null

  const grupo = ruta.reduce((d, k) => d?.[k], backtest.stats)
  const entrada = grupo?.[valor]?.[String(horizonte)]
  const base = grupo?.BASELINE?.[String(horizonte)]
  if (!entrada) return null

  const diff = entrada.exceso_mediana_spy != null && base?.exceso_mediana_spy != null
    ? entrada.exceso_mediana_spy - base.exceso_mediana_spy
    : null
  const { fondo, texto } = colorPorExceso(diff)
  const vivo = señalVivo ? seguimiento?.stats?.[señalVivo]?.[String(horizonte)] : null

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] leading-relaxed">
      <span className="rounded px-1.5 py-0.5 font-semibold" style={{ backgroundColor: fondo, color: texto }}>
        📊 Backtest 5a: acierto {entrada.hit_rate}% a {horizonte} {unidad} · mediana{' '}
        {fmtPct(entrada.retorno_mediana, { signo: true })}
        {entrada.exceso_mediana_spy != null && (
          <> (exceso {fmtPct(entrada.exceso_mediana_spy, { signo: true })} vs SPY)</>
        )}{' '}
        · n={entrada.n}
      </span>
      {vivo && vivo.n > 0 && (
        <span className="text-terminal-dim">
          · en vivo: {vivo.n} cerrada{vivo.n === 1 ? '' : 's'}, {vivo.n_pos} ganadora{vivo.n_pos === 1 ? '' : 's'} (
          {vivo.hit_rate}%)
        </span>
      )}
      <ComoSeCalculaEvidencia backtest={backtest} entrada={entrada} base={base} diff={diff} titulo={titulo} />
    </div>
  )
}

/**
 * Tabla compacta de evidencia para grupos con muchas etiquetas (estados VCP,
 * buckets del Warren Score): una fila por etiqueta con acierto / mediana /
 * exceso vs SPY a un horizonte fijo, más una fila BASELINE. 'señalVivo' es
 * una única clave de senales_seguimiento.json (VCP y Warren no separan el
 * seguimiento en vivo por estado/bucket).
 */
export function TablaEvidenciaMultiple({ ruta, etiquetas, horizonte, unidad = 'ruedas', señalVivo, titulo }) {
  const backtest = useBacktestSenales()
  const seguimiento = useSeguimientoSenales()
  if (!backtest?.stats) return null
  const grupo = ruta.reduce((d, k) => d?.[k], backtest.stats)
  if (!grupo) return null
  const base = grupo.BASELINE?.[String(horizonte)]
  const filas = etiquetas.filter((et) => grupo[et]?.[String(horizonte)])
  if (!filas.length) return null
  const vivo = señalVivo ? seguimiento?.stats?.[señalVivo]?.[String(horizonte)] : null

  return (
    <details className="mb-2 rounded-lg border border-terminal-border bg-terminal-panel">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-terminal-text">
        📊 Backtest 5a por {titulo} (a {horizonte} {unidad})
        {vivo && vivo.n > 0 && (
          <span className="ml-2 font-normal text-terminal-dim">
            · en vivo: {vivo.n} cerrada{vivo.n === 1 ? '' : 's'}, {vivo.n_pos} ganadora{vivo.n_pos === 1 ? '' : 's'} (
            {vivo.hit_rate}%)
          </span>
        )}
      </summary>
      <div className="border-t border-terminal-border p-2.5">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-left uppercase tracking-wide text-terminal-dim">
              <th className="px-1.5 py-1 font-semibold">{titulo}</th>
              <th className="px-1.5 py-1 text-right font-semibold">Acierto</th>
              <th className="px-1.5 py-1 text-right font-semibold">Mediana</th>
              <th className="px-1.5 py-1 text-right font-semibold">Exceso vs SPY</th>
              <th className="px-1.5 py-1 text-right font-semibold">n</th>
            </tr>
          </thead>
          <tbody>
            {base && (
              <tr className="border-t border-terminal-border text-terminal-dim">
                <td className="px-1.5 py-1">Cualquier día (base)</td>
                <td className="px-1.5 py-1 text-right tabular">{base.hit_rate}%</td>
                <td className="px-1.5 py-1 text-right tabular">{fmtPct(base.retorno_mediana, { signo: true })}</td>
                <td className="px-1.5 py-1 text-right tabular">{fmtPct(base.exceso_mediana_spy, { signo: true })}</td>
                <td className="px-1.5 py-1 text-right tabular">{base.n}</td>
              </tr>
            )}
            {filas.map((et) => {
              const e = grupo[et][String(horizonte)]
              const diff = e.exceso_mediana_spy != null && base?.exceso_mediana_spy != null
                ? e.exceso_mediana_spy - base.exceso_mediana_spy
                : null
              const { texto } = colorPorExceso(diff)
              return (
                <tr key={et} className="border-t border-terminal-border">
                  <td className="px-1.5 py-1 font-semibold" style={{ color: texto }}>{et}</td>
                  <td className="px-1.5 py-1 text-right tabular">{e.hit_rate}%</td>
                  <td className="px-1.5 py-1 text-right tabular">{fmtPct(e.retorno_mediana, { signo: true })}</td>
                  <td className="px-1.5 py-1 text-right tabular" style={{ color: texto }}>
                    {fmtPct(e.exceso_mediana_spy, { signo: true })}
                  </td>
                  <td className="px-1.5 py-1 text-right tabular">{e.n}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="mt-2 text-terminal-dim">{backtest.metodologia}</p>
        <ul className="mt-1 list-disc pl-4 text-terminal-dim">
          {(backtest.advertencias || []).map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </div>
    </details>
  )
}

function ComoSeCalculaEvidencia({ backtest, entrada, base, diff, titulo }) {
  return (
    <details className="w-full basis-full">
      <summary className="cursor-pointer select-none text-terminal-dim hover:text-terminal-accent">
        🧮 ¿Cómo se calcula esta evidencia?
      </summary>
      <div className="mt-1 flex flex-col gap-1.5 rounded border border-terminal-border bg-terminal-panel px-2.5 py-2 text-terminal-dim">
        <p>{backtest.metodologia}</p>
        {base && (
          <p>
            Base (<Formula>BASELINE</Formula>, cualquier día del mismo universo, mismo horizonte): acierto{' '}
            {base.hit_rate}%, mediana {fmtPct(base.retorno_mediana, { signo: true })}
            {base.exceso_mediana_spy != null && (
              <> (exceso {fmtPct(base.exceso_mediana_spy, { signo: true })} vs SPY)</>
            )}
            , n={base.n}.{' '}
            {diff != null && (
              <>
                {titulo || 'Esta señal'} le {diff >= UMBRAL_COLOR ? 'gana' : diff <= -UMBRAL_COLOR ? 'pierde' : 'empata'}{' '}
                a la base por {fmtPct(Math.abs(diff), { signo: false })} de exceso mediano vs. SPY.
              </>
            )}
          </p>
        )}
        {entrada.ci95_exceso_mediana && (
          <p>
            Intervalo de confianza (bootstrap, 95%) del exceso mediano vs. SPY:{' '}
            {fmtPct(entrada.ci95_exceso_mediana[0], { signo: true })} a{' '}
            {fmtPct(entrada.ci95_exceso_mediana[1], { signo: true })} (sobre {entrada.n_exceso} observaciones).
          </p>
        )}
        <ul className="list-disc pl-4">
          {(backtest.advertencias || []).map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
        <p className="text-terminal-dim/70">Backtest actualizado: {backtest.actualizado?.slice(0, 10) ?? '—'}.</p>
      </div>
    </details>
  )
}
