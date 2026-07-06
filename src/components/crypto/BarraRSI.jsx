import { colorRSI } from '../../lib/crypto/formato'

export default function BarraRSI({ valor }) {
  return (
    <span className="ml-1 inline-block h-1 w-8 overflow-hidden rounded-full bg-terminal-border align-middle">
      <span className="block h-full rounded-full" style={{ width: `${valor}%`, backgroundColor: colorRSI(valor) }} />
    </span>
  )
}
