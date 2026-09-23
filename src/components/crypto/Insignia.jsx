import { COLOR_SENAL } from '../../lib/crypto/constantes'

export default function Insignia({ cls, children }) {
  const c = COLOR_SENAL[cls] ?? COLOR_SENAL.n
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[11px] font-bold tabular"
      style={{ backgroundColor: c.bg, color: c.text }}
    >
      {children}
    </span>
  )
}

// Tendencia por EMA200 ('ALCISTA' / 'BAJISTA'). null = no hay 200 velas
// cerradas para calcularla: se muestra '—' en vez de inventar un lado.
export function TendenciaEma({ valor }) {
  if (!valor) {
    return (
      <span className="text-terminal-dim" title="Sin velas suficientes para la EMA200 (hacen falta 200 cerradas).">
        —
      </span>
    )
  }
  return (
    <>
      {valor === 'ALCISTA' ? '↑ ' : '↓ '}
      {valor}
    </>
  )
}
