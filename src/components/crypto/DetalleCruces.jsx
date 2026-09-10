import { INDICADORES } from '../../lib/crypto/v3/proximidad'

// Detalle del Screener de Cruces para un símbolo: los cinco indicadores con
// sus dos líneas, la distancia entre ellas y cuánto les falta para cruzarse.
//
// Reemplaza al bloque genérico de "Indicadores" cuando la fila viene de esa
// pestaña, porque esas filas no traen el score del v1 ni sus aportes: su
// información es otra (estado de cruce por indicador) y hay que mostrarla
// como tal en vez de dejar la lista vacía.

const PESO_ESTADO = { confirmado: 2, 'en-curso': 1, cerca: 0.5 }

const COLOR_ESTADO = {
  confirmado: { bg: 'rgba(34,197,94,0.22)', text: '#bbf7d0', icono: '●' },
  'en-curso': { bg: 'rgba(234,179,8,0.20)', text: '#fde68a', icono: '◐' },
  cerca: { bg: 'rgba(96,165,250,0.18)', text: '#bfdbfe', icono: '○' },
  revertido: { bg: 'rgba(148,163,184,0.18)', text: '#cbd5e1', icono: '⟲' },
  lejos: { bg: 'transparent', text: '#6b7280', icono: '·' },
  'sin-datos': { bg: 'transparent', text: '#4b5563', icono: '—' },
}

const ETIQUETA_ESTADO = {
  confirmado: 'Cruzó (confirmado)',
  'en-curso': 'Cruzando ahora',
  cerca: 'Cerca de cruzar',
  revertido: 'Cruzó pero ya volvió (no suma)',
  lejos: 'Lejos',
  'sin-datos': 'Sin datos',
}

// Cómo se llama cada línea en cada indicador, para no mostrar "rápida/lenta".
const LINEAS = {
  macd: ['Histograma', 'cero'],
  rsi: ['RSI', 'media 14'],
  estoc: ['%K', '%D'],
  srsi: ['%K', '%D'],
  smi: ['SMI', 'señal'],
}

// Efecto del filtro de volumen, medido sobre 93.549 cruces (4h, 120 perpetuos,
// 250 días, neto de costos). Se repite acá para que esté donde se decide.
const VOLUMEN = {
  rsi: { signo: 'ayuda', texto: 'con vol ≥1,5× pasa de +0,267% a +0,718%' },
  macd: { signo: 'ayuda', texto: 'con vol ≥1,5× pasa de +0,409% a +0,493% (leve)' },
  estoc: { signo: 'empeora', texto: 'con vol ≥1,5× EMPEORA: de +0,170% a −0,105%' },
  srsi: { signo: 'empeora', texto: 'con vol ≥1,5× EMPEORA: de +0,210% a +0,118%' },
  smi: { signo: 'sin-medir', texto: 'sin medir: se agregó después del backtest' },
}

const num = (v, d = 2) => (v == null || isNaN(v) ? '—' : (+v).toFixed(d))

export default function DetalleCruces({ fila }) {
  const { est, dir } = fila
  if (!est) return null

  const conSigno = (v) => (v > 0 ? `+${v}` : String(v))

  return (
    <>
      {/* ── Dirección, con la cuenta a la vista ────────────────────────── */}
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
        Dirección · suma de los 5 indicadores
      </div>
      <div className="mb-3 rounded border border-terminal-border bg-terminal-bg p-2.5">
        <div className="mb-2 flex items-baseline gap-2">
          <span
            className="rounded px-2 py-0.5 text-sm font-bold"
            style={{
              backgroundColor:
                dir.lado === 'LONG'
                  ? 'rgba(34,197,94,0.22)'
                  : dir.lado === 'SHORT'
                    ? 'rgba(239,68,68,0.22)'
                    : 'rgba(125,139,156,0.15)',
              color: dir.lado === 'LONG' ? '#bbf7d0' : dir.lado === 'SHORT' ? '#fca5a5' : '#9ca3af',
            }}
          >
            {dir.lado === 'LONG' ? '↑ LONG' : dir.lado === 'SHORT' ? '↓ SHORT' : '= MIXTO'}{' '}
            {conSigno(dir.puntos)}
          </span>
          <span className="text-[11px] text-terminal-dim">
            {dir.alcistas} al alza · {dir.bajistas} a la baja · {5 - dir.conDireccion} sin dirección
          </span>
        </div>
        <div className="text-xs leading-relaxed">
          {INDICADORES.map((ind) => {
            const e = est[ind.id]
            const p = e?.dir && PESO_ESTADO[e.estado] ? PESO_ESTADO[e.estado] * e.dir : 0
            return (
              <div key={ind.id} className="flex gap-1.5">
                <span
                  className={`w-9 shrink-0 text-right font-bold tabular ${
                    p > 0 ? 'text-terminal-up' : p < 0 ? 'text-terminal-down' : 'text-terminal-dim'
                  }`}
                >
                  {p === 0 ? '0' : conSigno(p)}
                </span>
                <span className="text-terminal-text">
                  {ind.nombre} {e?.dir ? (e.dir > 0 ? '↑' : '↓') : ''}{' '}
                  <span className="text-terminal-dim">{(ETIQUETA_ESTADO[e?.estado] ?? '—').toLowerCase()}</span>
                </span>
              </div>
            )
          })}
        </div>
        <p className="mt-2 border-t border-terminal-border pt-1.5 text-[10px] leading-relaxed text-terminal-dim">
          Pesos: confirmado ×2 · en curso ×1 · cerca ×0,5. La escala va de −10 a +10. Es un{' '}
          <b>recuento de los indicadores</b>, no una predicción.
        </p>
      </div>

      {/* ── Las dos líneas de cada indicador ───────────────────────────── */}
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
        Estado de cada indicador
      </div>
      <div className="mb-3 overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-terminal-bg text-[10px] uppercase text-terminal-dim">
              <td className="px-1.5 py-1">Indicador</td>
              <td className="px-1.5 py-1 text-right">Línea</td>
              <td className="px-1.5 py-1 text-right">Señal</td>
              <td className="px-1.5 py-1 text-right" title="Distancia entre las dos líneas, relativa a su separación típica de las últimas 50 velas. 0,10 = está al 10% de lo normal, o sea muy pegado.">
                Dist.
              </td>
              <td className="px-1.5 py-1 text-right" title="Velas estimadas hasta el cruce, extrapolando a qué velocidad se están acercando. Sólo si convergen.">
                Faltan
              </td>
              <td className="px-1.5 py-1">Estado</td>
            </tr>
          </thead>
          <tbody>
            {INDICADORES.map((ind) => {
              const e = est[ind.id]
              const c = COLOR_ESTADO[e?.estado ?? 'sin-datos']
              const [nomRapida, nomLenta] = LINEAS[ind.id] ?? ['rápida', 'lenta']
              const decimales = ind.id === 'macd' ? 6 : 1
              return (
                <tr key={ind.id} className="border-t border-terminal-border">
                  <td className="whitespace-nowrap px-1.5 py-1 text-terminal-text">
                    {ind.nombre}
                    <span className="ml-1 text-[9px] text-terminal-dim">
                      {nomRapida}/{nomLenta}
                    </span>
                  </td>
                  <td className="px-1.5 py-1 text-right tabular text-terminal-text">{num(e?.rapida, decimales)}</td>
                  <td className="px-1.5 py-1 text-right tabular text-terminal-dim">{num(e?.lenta, decimales)}</td>
                  <td className="px-1.5 py-1 text-right tabular text-terminal-dim">{num(e?.gapRel, 2)}</td>
                  <td className="px-1.5 py-1 text-right tabular text-terminal-dim">
                    {e?.velas == null ? (e?.convergiendo === false ? 'se aleja' : '—') : `${num(e.velas, 1)}`}
                  </td>
                  <td className="px-1.5 py-1">
                    <span
                      className="whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-semibold"
                      style={{ backgroundColor: c.bg, color: c.text }}
                      title={ETIQUETA_ESTADO[e?.estado ?? 'sin-datos']}
                    >
                      {c.icono} {e?.dir ? (e.dir > 0 ? '↑' : '↓') : ''}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Contexto ───────────────────────────────────────────────────── */}
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">Contexto</div>
      <div className="mb-3 grid grid-cols-2 gap-1.5 rounded bg-terminal-bg p-3 sm:grid-cols-4">
        {[
          ['RSI', num(fila.rsi, 1), fila.rsi >= 70 ? '#f87171' : fila.rsi <= 30 ? '#4ade80' : null,
            fila.rsi >= 70 ? 'Sobrecompra' : fila.rsi <= 30 ? 'Sobreventa' : 'Zona neutral'],
          ['SMI', num(fila.smi, 1), fila.smi >= 40 ? '#f87171' : fila.smi <= -40 ? '#4ade80' : null,
            fila.smi >= 40 ? 'Sobrecompra' : fila.smi <= -40 ? 'Sobreventa' : 'Zona neutral'],
          ['Vol ×', num(fila.volRatio, 2), fila.volRatio >= 1.5 ? '#fde68a' : null,
            'Volumen de la vela contra el promedio de 20'],
          ['Vela', fila.pctVela == null ? '—' : `${Math.round(fila.pctVela)}%`, null,
            'Cuánto lleva transcurrida la vela en curso'],
        ].map(([et, val, color, ayuda]) => (
          <div key={et} className="text-xs" title={ayuda}>
            <span className="mb-0.5 block text-[10px] uppercase text-terminal-dim">{et}</span>
            <span className="font-bold tabular" style={{ color: color ?? undefined }}>
              {val}
            </span>
          </div>
        ))}
      </div>

      {/* ── Qué dice la medición del volumen para los cruces activos ───── */}
      {(() => {
        const activos = INDICADORES.filter((i) => ['confirmado', 'en-curso'].includes(est[i.id]?.estado))
        if (!activos.length) return null
        return (
          <div className="mb-3 rounded border border-terminal-border bg-terminal-bg p-2.5">
            <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
              ¿El volumen confirma? (medido, 93.549 cruces)
            </div>
            <div className="text-[11px] leading-relaxed">
              {activos.map((ind) => {
                const v = VOLUMEN[ind.id]
                const col =
                  v.signo === 'ayuda' ? 'text-terminal-up' : v.signo === 'empeora' ? 'text-terminal-down' : 'text-terminal-dim'
                return (
                  <div key={ind.id}>
                    <b className="text-terminal-text">{ind.nombre}:</b> <span className={col}>{v.texto}</span>
                  </div>
                )
              })}
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-terminal-dim">
              Esta vela tiene <b>{num(fila.volRatio, 2)}×</b> el volumen promedio.
            </p>
          </div>
        )
      })()}
    </>
  )
}
