import { filtrarPorVentana, rangoYPercentil } from '../lib/historicoDerivados'

// Grafico de linea (SVG, sin librerias) para un ratio fundamental a lo largo
// del tiempo. `serie` es el array semanal de historico_fundamental.json;
// `campo` es la clave del ratio dentro de cada punto (ej. "per_ltm").
// `ventanaMeses` recorta lo que se DIBUJA (null/0 = todo); el rango/percentil
// del header siempre se calcula sobre la serie completa.
const ANCHO = 900
const ALTO = 130

export default function GraficoRatio({ ticker, nombre, etiqueta, color, serie, campo, formatoValor, ventanaMeses }) {
  const puntosCompletos = (serie ?? []).filter((p) => p[campo] != null)
  const puntos = filtrarPorVentana(puntosCompletos, ventanaMeses)
  const stats = rangoYPercentil(puntosCompletos, campo)

  const header = (
    <div
      className="flex flex-wrap items-center gap-2 border-l-4 bg-terminal-panel2 px-3 py-2"
      style={{ borderColor: color }}
    >
      <span className="font-semibold text-terminal-text">{ticker}</span>
      <span className="truncate text-sm text-terminal-dim">{nombre}</span>
      <span className="text-sm text-terminal-dim">{etiqueta}</span>
      {stats && (
        <span
          className="text-[11px] text-terminal-dim"
          title="Percentil del valor actual dentro de todo el historico disponible (no de la ventana elegida)"
        >
          rango {stats.anios.toFixed(1)}A: {formatoValor(stats.min)}–{formatoValor(stats.max)} · promedio{' '}
          {formatoValor(stats.promedio)} · percentil {stats.percentil}%
        </span>
      )}
      {puntosCompletos.length > 0 && (
        <span className="ml-auto font-semibold tabular" style={{ color }}>
          {formatoValor(puntosCompletos[puntosCompletos.length - 1][campo])}
        </span>
      )}
    </div>
  )

  if (puntos.length < 2) {
    return (
      <div className="overflow-hidden rounded-lg border border-terminal-border bg-terminal-panel">
        {header}
        <div className="px-3 py-6 text-center text-xs text-terminal-dim">
          Sin datos suficientes para graficar este ratio en la ventana elegida.
        </div>
      </div>
    )
  }

  const valores = puntos.map((p) => p[campo])
  const min = Math.min(...valores)
  const max = Math.max(...valores)
  const rango = max - min || 1
  const paso = ANCHO / (puntos.length - 1)

  const coords = puntos
    .map((p, i) => {
      const x = i * paso
      const y = ALTO - 6 - ((p[campo] - min) / rango) * (ALTO - 12)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  // Una marca de anio en el eje X, en el primer punto de cada anio nuevo.
  const marcasAnio = []
  let ultimoAnio = null
  puntos.forEach((p, i) => {
    const anio = p.fecha.slice(0, 4)
    if (anio !== ultimoAnio) {
      marcasAnio.push({ x: i * paso, anio })
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
        <polyline points={coords} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
        {marcasAnio.map((m) => (
          <text key={m.anio} x={Math.min(m.x, ANCHO - 24)} y={ALTO + 14} fontSize="11" fill="currentColor">
            {m.anio}
          </text>
        ))}
      </svg>
    </div>
  )
}
