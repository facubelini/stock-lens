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
