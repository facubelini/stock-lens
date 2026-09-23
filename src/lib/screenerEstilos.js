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
export const PESO_VERDICT = { COMPRA: 4, CERCA: 2.5, EXTENDIDO: 0.5, NEUTRAL: 0, VENTA: -3 }
export const PESO_TF = { diario: 0.8, semanal: 1.1, mensual: 1.1 }

export function prioridadScreener(fila) {
  return TIMEFRAMES.reduce((acc, { key }) => {
    const v = fila[key]?.verdict
    return acc + (v ? (PESO_VERDICT[v] ?? 0) * PESO_TF[key] : 0)
  }, 0)
}

// Mismo calculo que prioridadScreener, pero devolviendo cada termino
// (peso del veredicto × peso de la temporalidad) para mostrarlo en la UI.
export function desgloseConviccion(fila) {
  const terminos = TIMEFRAMES.map(({ key, label }) => {
    const v = fila?.[key]?.verdict ?? null
    const pv = v ? (PESO_VERDICT[v] ?? 0) : 0
    return { key, label, verdict: v, pesoVerdict: pv, pesoTf: PESO_TF[key], aporte: pv * PESO_TF[key] }
  })
  return { terminos, total: terminos.reduce((a, t) => a + t.aporte, 0) }
}

// Hay señal alcista "de verdad" si al menos una temporalidad da COMPRA o
// CERCA (EXTENDIDO solo no alcanza: es alcista pero sin punto de entrada).
export function tieneSenalAlcista(fila) {
  return TIMEFRAMES.some(({ key }) => tieneSenal(fila?.[key]))
}

export function tieneSenalVenta(fila) {
  return TIMEFRAMES.some(({ key }) => fila?.[key]?.verdict === 'VENTA')
}
