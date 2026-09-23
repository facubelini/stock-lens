import { useMeta } from '../lib/useJson'
import { fmtFecha } from '../lib/formato'

// 🕒 para filas arrastradas de una corrida anterior (yfinance fallo hoy para
// ese ticker). La fila trae su propio `actualizado` solo cuando es stale; si
// no viene (datos viejos), se usa la ultima corrida de meta.json.
function Marca({ fila, detalle, className, texto }) {
  const meta = useMeta()
  const ts = fila.actualizado ?? meta?.ultima_actualizacion
  return (
    <span
      className={`text-terminal-warn ${className}`}
      title={`Dato arrastrado de la última corrida exitosa (${ts ? fmtFecha(ts) : '?'})${detalle ? `, ${detalle}` : ''}`}
    >
      🕒{texto ? ` ${texto}` : ''}
    </span>
  )
}

export default function MarcaStale({ fila, detalle, className = '', texto }) {
  if (!fila?.stale) return null
  return <Marca fila={fila} detalle={detalle} className={className} texto={texto} />
}

// Fecha de "actualizado" de una fila: la propia si es stale, si no la de la
// ultima corrida del pipeline.
export function fechaDeFila(fila, meta) {
  return fila?.actualizado ?? meta?.ultima_actualizacion ?? null
}
