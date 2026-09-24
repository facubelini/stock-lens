import { fmtNum } from '../lib/formato'

// Piezas visuales del Warren Score compartidas entre la pestaña
// (pages/WarrenScore.jsx) y la ficha del ticker (pages/TickerDetalle.jsx).
// Topes de cada pilar (mismos que scripts/pipeline/warren.py):
export const PILARES = [
  { key: 'tendencia', corto: 'Tend', nombre: 'Tendencia', max: 25 },
  { key: 'fuerza', corto: 'F.Rel', nombre: 'Fuerza relativa', max: 30 },
  { key: 'contraccion', corto: 'Contr', nombre: 'Contracción', max: 30 },
  { key: 'gatillo', corto: 'Gatillo', nombre: 'Gatillo / setup', max: 15 },
]

export function colorScore(score) {
  if (score == null) return '#7d8b9c'
  if (score >= 80) return '#16a34a'
  if (score >= 70) return '#22c55e'
  if (score >= 55) return '#f5a524'
  if (score >= 40) return '#f97316'
  return '#ef4444'
}

export function Anillo({ score, tam = 64 }) {
  const r = tam / 2 - 5
  const circ = 2 * Math.PI * r
  const frac = Math.max(0, Math.min(100, score ?? 0)) / 100
  const color = colorScore(score)
  return (
    <svg width={tam} height={tam} viewBox={`0 0 ${tam} ${tam}`} role="img" aria-label={`Score ${fmtNum(score, 1)}`}>
      <circle cx={tam / 2} cy={tam / 2} r={r} fill="none" stroke="#1d2733" strokeWidth="5" />
      <circle
        cx={tam / 2}
        cy={tam / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={`${circ * frac} ${circ}`}
        transform={`rotate(-90 ${tam / 2} ${tam / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fill={color} fontSize={tam / 4} fontWeight="700">
        {score != null ? fmtNum(score, 1) : 'N/D'}
      </text>
    </svg>
  )
}

export function MiniBarra({ pts, max, ancho = 'w-14' }) {
  const pct = pts != null ? Math.max(0, Math.min(1, pts / max)) * 100 : 0
  return (
    <div className="flex items-center gap-1.5" title={`${fmtNum(pts, 1)} / ${max}`}>
      <div className={`h-1.5 ${ancho} overflow-hidden rounded-full bg-terminal-border`}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: colorScore(pct) }} />
      </div>
      <span className="tabular text-[11px] text-terminal-dim">{pts != null ? fmtNum(pts, 1) : 'N/D'}</span>
    </div>
  )
}

export function Banderas({ flags }) {
  if (!flags?.length) return <span className="text-terminal-dim">—</span>
  return (
    <span className="inline-flex flex-wrap gap-0.5">
      {flags.map((f) => (
        <span key={f.clave} title={`${f.detalle}${f.pts ? ` (${f.pts} pts)` : ''}`} className="cursor-help">
          {f.emoji}
        </span>
      ))}
    </span>
  )
}
