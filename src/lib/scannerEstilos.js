// Estilos/prioridad compartidos por la pestaña Scanner. Mismo patron que
// screenerEstilos.js, pero para los veredictos propios del scanner
// CORTO/LARGO (SETUP_LONG/NEAR_SETUP/OK), no las 3 temporalidades del
// indicador Pine.
export const ESTILO_STATUS = {
  SETUP_LONG: { bg: 'rgba(245, 165, 36, 0.24)', color: '#fbbf62', label: 'SETUP' },
  NEAR_SETUP: { bg: 'rgba(56, 189, 248, 0.18)', color: '#7dd3fc', label: 'CERCA' },
  OK: { bg: 'rgba(148, 163, 184, 0.12)', color: '#9aa7b5', label: 'OK' },
  NO_DATA: { bg: 'rgba(148, 163, 184, 0.08)', color: '#6b7684', label: 'N/D' },
}

export const ESTILO_GLOBAL = {
  BUY_BOTH: { bg: 'rgba(245, 165, 36, 0.3)', color: '#fbbf62', label: 'SETUP AMBOS' },
  BUY_CORTO: { bg: 'rgba(34, 197, 94, 0.22)', color: '#7ee2a8', label: 'SETUP CORTO' },
  BUY_LARGO: { bg: 'rgba(34, 197, 94, 0.22)', color: '#7ee2a8', label: 'SETUP LARGO' },
  NEAR_BOTH: { bg: 'rgba(56, 189, 248, 0.24)', color: '#7dd3fc', label: 'CERCA AMBOS' },
  NEAR_CORTO: { bg: 'rgba(56, 189, 248, 0.16)', color: '#7dd3fc', label: 'CERCA CORTO' },
  NEAR_LARGO: { bg: 'rgba(56, 189, 248, 0.16)', color: '#7dd3fc', label: 'CERCA LARGO' },
  OK: { bg: 'rgba(148, 163, 184, 0.12)', color: '#9aa7b5', label: 'OK' },
}

const PESO_GLOBAL = {
  BUY_BOTH: 5,
  BUY_CORTO: 3,
  BUY_LARGO: 3,
  NEAR_BOTH: 2,
  NEAR_CORTO: 1,
  NEAR_LARGO: 1,
  OK: 0,
}

export function tieneSetup(fila) {
  return PESO_GLOBAL[fila?.status_global] > 0
}

export function esSetupConfirmado(fila) {
  const g = fila?.status_global
  return g === 'BUY_BOTH' || g === 'BUY_CORTO' || g === 'BUY_LARGO'
}

export function esCerca(fila) {
  const g = fila?.status_global
  return g === 'NEAR_BOTH' || g === 'NEAR_CORTO' || g === 'NEAR_LARGO'
}

export function prioridadScanner(fila) {
  return PESO_GLOBAL[fila?.status_global] ?? 0
}
