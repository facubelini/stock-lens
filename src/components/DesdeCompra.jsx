import { infoDesde } from '../lib/compraDesde'
import { fmtFechaCorta, fmtPct, fmtPrecio } from '../lib/formato'

// "desde 15/09 · 20 d · +4,2%": desde cuándo cumple el requisito de compra,
// cuántos días lleva y cómo le fue al precio desde entonces. `entrada` viene de
// compra_desde.json (o de entradaDeEvento). Sin entrada no renderiza nada
// (o `vacio`, si se pasa).
export default function DesdeCompra({ entrada, vacio = null, className = '' }) {
  const info = infoDesde(entrada)
  if (!info) return vacio
  const color = info.retorno == null ? 'text-terminal-dim' : info.retorno > 0 ? 'text-terminal-up' : info.retorno < 0 ? 'text-terminal-down' : 'text-terminal-dim'
  const detalle = [
    `Cumple el requisito de forma continua desde el ${fmtFechaCorta(info.desde)}${info.aprox ? ' (o antes: es el primer día que hay registro)' : ''}.`,
    info.precio != null ? `Cierre ese día: ${fmtPrecio(info.precio)}.` : 'Sin precio de ese día.',
    info.precioHoy != null ? `Precio hoy: ${fmtPrecio(info.precioHoy)}.` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <span className={`whitespace-nowrap tabular ${className}`} title={detalle}>
      <span className="text-terminal-dim">
        {info.aprox ? '≥ ' : ''}
        {fmtFechaCorta(info.desde).slice(0, 5)} · {info.dias} d
      </span>
      {info.retorno != null && <span className={`ml-1 font-semibold ${color}`}>{fmtPct(info.retorno, { signo: true })}</span>}
    </span>
  )
}
