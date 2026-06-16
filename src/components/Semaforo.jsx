import { nivelScore } from '../lib/score'

// Punto de color + score 0-100 con desglose en el tooltip.
export default function Semaforo({ resultado, mostrarNumero = true }) {
  if (!resultado) return <span className="text-terminal-border">·</span>
  const { score, partes } = resultado
  const n = nivelScore(score)
  const detalle = partes.map((p) => `${p.k} ${p.v}`).join(' · ')
  return (
    <span
      className="inline-flex items-center gap-1"
      title={`Score ${score}/100 (${n.txt}) — ${detalle}. Orientativo, no es recomendación.`}
    >
      <span
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: n.color }}
      />
      {mostrarNumero && (
        <span className="tabular text-xs" style={{ color: n.color }}>
          {score}
        </span>
      )}
    </span>
  )
}
