import { filtrarPorVentana } from '../lib/historicoDerivados'

// Overlay de un mismo ratio para varios tickers (comparar evolucion relativa).
// A diferencia de GraficoRatio (que asume una sola serie con espaciado
// semanal uniforme), aca cada ticker puede tener distinta cantidad/rango de
// puntos, asi que el eje X se ubica por fecha real, no por indice.
const ANCHO = 900
const ALTO = 200
const PALETA = ['#a855f7', '#f97316', '#22c55e', '#38bdf8', '#facc15', '#f472b6', '#94a3b8', '#ef4444']

export default function GraficoComparativo({ series, campo, etiqueta, formatoValor, ventanaMeses }) {
  const grupos = series
    .map((s, i) => ({
      ticker: s.ticker,
      color: PALETA[i % PALETA.length],
      puntos: filtrarPorVentana((s.serie ?? []).filter((p) => p[campo] != null), ventanaMeses),
    }))
    .filter((g) => g.puntos.length >= 2)

  const header = (
    <div className="flex flex-wrap items-center gap-3 border-l-4 border-terminal-accent bg-terminal-panel2 px-3 py-2">
      <span className="text-sm font-semibold text-terminal-text">{etiqueta}</span>
      <div className="ml-auto flex flex-wrap items-center gap-2.5">
        {grupos.map((g) => (
          <span key={g.ticker} className="flex items-center gap-1 text-xs" style={{ color: g.color }}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: g.color }} />
            {g.ticker} {formatoValor(g.puntos[g.puntos.length - 1][campo])}
          </span>
        ))}
      </div>
    </div>
  )

  if (grupos.length === 0) {
    return (
      <div className="overflow-hidden rounded-lg border border-terminal-border bg-terminal-panel">
        {header}
        <div className="px-3 py-6 text-center text-xs text-terminal-dim">
          Ninguno de los tickers elegidos tiene datos de este ratio en la ventana seleccionada.
        </div>
      </div>
    )
  }

  const todasFechas = grupos.flatMap((g) => g.puntos.map((p) => new Date(p.fecha).getTime()))
  const minF = Math.min(...todasFechas)
  const maxF = Math.max(...todasFechas)
  const rangoF = maxF - minF || 1

  const todosValores = grupos.flatMap((g) => g.puntos.map((p) => p[campo]))
  const min = Math.min(...todosValores)
  const max = Math.max(...todosValores)
  const rango = max - min || 1

  const xDe = (fechaIso) => ((new Date(fechaIso).getTime() - minF) / rangoF) * ANCHO
  const yDe = (v) => ALTO - 6 - ((v - min) / rango) * (ALTO - 12)

  const marcasAnio = []
  let ultimoAnio = null
  const ordenPorFecha = [...new Set(grupos.flatMap((g) => g.puntos.map((p) => p.fecha)))].sort()
  ordenPorFecha.forEach((fecha) => {
    const anio = fecha.slice(0, 4)
    if (anio !== ultimoAnio) {
      marcasAnio.push({ x: xDe(fecha), anio })
      ultimoAnio = anio
    }
  })

  return (
    <div className="overflow-hidden rounded-lg border border-terminal-border bg-terminal-panel">
      {header}
      <svg
        viewBox={`0 0 ${ANCHO} ${ALTO + 18}`}
        className="block w-full text-terminal-dim"
        preserveAspectRatio="none"
      >
        {grupos.map((g) => (
          <polyline
            key={g.ticker}
            points={g.puntos.map((p) => `${xDe(p.fecha).toFixed(1)},${yDe(p[campo]).toFixed(1)}`).join(' ')}
            fill="none"
            stroke={g.color}
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        ))}
        {marcasAnio.map((m) => (
          <text key={m.anio} x={Math.min(m.x, ANCHO - 24)} y={ALTO + 14} fontSize="11" fill="currentColor">
            {m.anio}
          </text>
        ))}
      </svg>
    </div>
  )
}
