// Constantes compartidas entre la pestaña Screener y la vista de detalle de
// ticker, para que ambas pinten los veredictos exactamente igual.
export const TIMEFRAMES = [
  { key: 'diario', label: 'Diario' },
  { key: 'semanal', label: 'Semanal' },
  { key: 'mensual', label: 'Mensual' },
]

export const ESTILO_VERDICT = {
  COMPRA: { bg: 'rgba(34, 197, 94, 0.22)', color: '#7ee2a8', label: 'COMPRA' },
  CERCA: { bg: 'rgba(56, 189, 248, 0.18)', color: '#7dd3fc', label: 'CERCA' },
  EXTENDIDO: { bg: 'rgba(245, 165, 36, 0.18)', color: '#fbbf62', label: 'EXTENDIDO' },
  NEUTRAL: { bg: 'rgba(148, 163, 184, 0.12)', color: '#9aa7b5', label: 'NEUTRAL' },
  VENTA: { bg: 'rgba(239, 68, 68, 0.2)', color: '#ff9d9d', label: 'VENTA' },
}

export function tieneSenal(dato) {
  const v = dato?.verdict
  return v === 'COMPRA' || v === 'CERCA'
}

// Prioridad para ordenar: favorece COMPRA/CERCA, penaliza VENTA. El diario
// pesa un poco menos que semanal/mensual (una senal de mas largo plazo es
// mas relevante para "esta para comprar" que un rebote de un dia).
const PESO_VERDICT = { COMPRA: 4, CERCA: 2.5, EXTENDIDO: 0.5, NEUTRAL: 0, VENTA: -3 }
const PESO_TF = { diario: 0.8, semanal: 1.1, mensual: 1.1 }

export function prioridadScreener(fila) {
  return TIMEFRAMES.reduce((acc, { key }) => {
    const v = fila[key]?.verdict
    return acc + (v ? (PESO_VERDICT[v] ?? 0) * PESO_TF[key] : 0)
  }, 0)
}
