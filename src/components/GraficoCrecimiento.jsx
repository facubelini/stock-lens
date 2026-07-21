import { rangoYPercentil } from '../lib/historicoDerivados'

// Grafico "estilo TrendSpider": precio semanal en escala logaritmica con una
// cinta de crecimiento interanual de Revenue (TTM) por trimestre debajo, y
// un panel de P/E con la linea de promedio historico + circulos en los
// minimos locales por debajo de ese promedio (zonas relativamente baratas).
// No es un clon pixel a pixel — mismos datos de EDGAR que el resto de
// Historico Fundamental, sin velas ni el texto diagonal de "Revenue Growth".
const ANCHO = 900
const ALTO_PRECIO = 200
const ALTO_RIBBON = 26
const ALTO_PE = 90
const GAP = 14

function agruparPorTrimestre(puntos) {
  const grupos = []
  let actual = null
  puntos.forEach((p, i) => {
    const d = new Date(p.fecha)
    const q = Math.floor(d.getUTCMonth() / 3) + 1
    const clave = `${d.getUTCFullYear()}Q${q}`
    if (!actual || actual.clave !== clave) {
      actual = { clave, inicio: i, fin: i }
      grupos.push(actual)
    } else {
      actual.fin = i
    }
  })
  return grupos
}

// Minimos locales de `campo` por debajo de `promedio` — puntos donde el
// multiplo estuvo relativamente barato contra su propia historia.
function detectarValles(puntos, campo, promedio, ventana = 4) {
  if (promedio == null) return []
  const marcas = []
  for (let i = ventana; i < puntos.length - ventana; i++) {
    const v = puntos[i][campo]
    if (v == null || v > promedio) continue
    const vecinos = puntos
      .slice(i - ventana, i + ventana + 1)
      .map((p) => p[campo])
      .filter((x) => x != null)
    if (vecinos.length && v === Math.min(...vecinos)) marcas.push(i)
  }
  // Evita marcar el mismo valle varias veces seguidas.
  return marcas.filter((idx, j) => j === 0 || idx - marcas[j - 1] > ventana)
}

export default function GraficoCrecimiento({ ticker, nombre, serie }) {
  const puntos = (serie ?? []).filter((p) => p.precio != null)
  if (puntos.length < 8) return null

  const precios = puntos.map((p) => p.precio)
  const minP = Math.max(Math.min(...precios), 0.01)
  const maxP = Math.max(Math.max(...precios), minP * 1.01)
  const logMin = Math.log(minP)
  const logMax = Math.log(maxP)
  const rangoLog = logMax - logMin || 1
  const paso = ANCHO / (puntos.length - 1)
  const yPrecio = (v) => ALTO_PRECIO - 8 - ((Math.log(Math.max(v, minP)) - logMin) / rangoLog) * (ALTO_PRECIO - 16)

  const coordsPrecio = puntos.map((p, i) => `${(i * paso).toFixed(1)},${yPrecio(p.precio).toFixed(1)}`).join(' ')

  const trimestres = agruparPorTrimestre(puntos)

  const statsPE = rangoYPercentil(puntos, 'per_ltm')
  const perValores = puntos.map((p) => p.per_ltm).filter((v) => v != null)
  const minPE = perValores.length ? Math.min(...perValores) : 0
  const maxPE = perValores.length ? Math.max(...perValores) : 1
  const rangoPE = maxPE - minPE || 1
  const yPE = (v) => ALTO_PE - 6 - ((v - minPE) / rangoPE) * (ALTO_PE - 12)
  const coordsPE = puntos
    .map((p, i) => (p.per_ltm != null ? `${(i * paso).toFixed(1)},${yPE(p.per_ltm).toFixed(1)}` : null))
    .filter(Boolean)
    .join(' ')
  const valles = statsPE ? detectarValles(puntos, 'per_ltm', statsPE.promedio) : []

  const altoTotal = ALTO_PRECIO + ALTO_RIBBON + GAP + ALTO_PE + 4

  return (
    <div className="overflow-hidden rounded-lg border border-terminal-border bg-terminal-panel">
      <div className="flex flex-wrap items-center gap-2 border-l-4 border-terminal-accent bg-terminal-panel2 px-3 py-2">
        <span className="font-semibold text-terminal-text">{ticker}</span>
        <span className="truncate text-sm text-terminal-dim">{nombre}</span>
        <span className="text-sm text-terminal-dim">Precio + crecimiento de Revenue por trimestre + P/E</span>
      </div>
      <svg viewBox={`0 0 ${ANCHO} ${altoTotal}`} className="block w-full text-terminal-dim" preserveAspectRatio="none">
        {trimestres.map((t) => (
          <line
            key={t.clave}
            x1={t.inicio * paso}
            y1={0}
            x2={t.inicio * paso}
            y2={ALTO_PRECIO}
            stroke="rgba(148,163,184,0.15)"
            strokeWidth="1"
          />
        ))}
        <polyline points={coordsPrecio} fill="none" stroke="#38bdf8" strokeWidth="1.6" strokeLinejoin="round" />
        <text x={4} y={12} fontSize="10" fill="#38bdf8">
          Precio (escala log)
        </text>

        <g transform={`translate(0, ${ALTO_PRECIO + 4})`}>
          {trimestres.map((t) => {
            const x1 = t.inicio * paso
            const x2 = t.fin * paso + paso
            const crecimiento = puntos[t.fin]?.revenue_ttm_yoy
            if (crecimiento == null) return null
            const positivo = crecimiento >= 0
            return (
              <g key={t.clave}>
                <rect
                  x={x1}
                  y={0}
                  width={Math.max(x2 - x1 - 1, 1)}
                  height={ALTO_RIBBON}
                  fill={positivo ? 'rgba(34,197,94,0.28)' : 'rgba(239,68,68,0.28)'}
                />
                {x2 - x1 > 30 && (
                  <text
                    x={(x1 + x2) / 2}
                    y={ALTO_RIBBON / 2 + 4}
                    fontSize="9"
                    textAnchor="middle"
                    fontWeight="600"
                    fill={positivo ? '#4ade80' : '#f87171'}
                  >
                    {positivo ? '+' : ''}
                    {crecimiento.toFixed(0)}%
                  </text>
                )}
              </g>
            )
          })}
        </g>

        <g transform={`translate(0, ${ALTO_PRECIO + ALTO_RIBBON + GAP})`}>
          {statsPE && (
            <line
              x1={0}
              y1={yPE(statsPE.promedio)}
              x2={ANCHO}
              y2={yPE(statsPE.promedio)}
              stroke="#f5a524"
              strokeWidth="1"
              strokeDasharray="4,3"
            />
          )}
          <polyline points={coordsPE} fill="none" stroke="#a855f7" strokeWidth="1.6" strokeLinejoin="round" />
          {valles.map((idx) => (
            <circle
              key={idx}
              cx={idx * paso}
              cy={yPE(puntos[idx].per_ltm)}
              r="4"
              fill="none"
              stroke="#38bdf8"
              strokeWidth="1.5"
            />
          ))}
          <text x={4} y={12} fontSize="10" fill="#f5a524">
            P/E{statsPE ? ` · promedio ${statsPE.promedio.toFixed(1)}x` : ''}
          </text>
        </g>
      </svg>
      <p className="border-t border-terminal-border px-3 py-2 text-[11px] text-terminal-dim">
        Precio en escala logarítmica, con el crecimiento interanual de Revenue (TTM) por trimestre
        debajo (verde = creció, rojo = cayó vs. el mismo trimestre del año anterior). En el panel de
        P/E, los círculos marcan mínimos locales por debajo del promedio histórico — momentos donde
        el múltiplo estuvo relativamente barato contra su propia historia.
      </p>
    </div>
  )
}
