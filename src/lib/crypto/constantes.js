// Constantes compartidas entre Crypto Screener y la vista de detalle de un
// símbolo, para que ambas usen exactamente los mismos parámetros.
export const INTERVALOS = [
  { valor: '15m', etiqueta: '15 minutos' },
  { valor: '1h', etiqueta: '1 hora' },
  { valor: '4h', etiqueta: '4 horas' },
  { valor: '1d', etiqueta: 'Diario' },
]
export const MULTIPLOS_ATR = [1.5, 2.0, 3.0]
export const APALANCAMIENTOS = [2, 3, 5, 7, 10, 15, 20, 25, 30, 50, 75, 100, 125]
export const CORTO = ['se', 'sf', 'sh', 'sw']
export const LARGO = ['le', 'lf', 'lo', 'lw']

export const COLOR_SENAL = {
  se: { bg: 'rgba(239,68,68,0.32)', text: '#fecaca' },
  sf: { bg: 'rgba(239,68,68,0.26)', text: '#fca5a5' },
  sh: { bg: 'rgba(239,68,68,0.19)', text: '#fca5a5' },
  sw: { bg: 'rgba(239,68,68,0.10)', text: '#f87171' },
  n: { bg: 'rgba(125,139,156,0.12)', text: '#9ca3af' },
  lw: { bg: 'rgba(34,197,94,0.10)', text: '#6ee7b7' },
  lo: { bg: 'rgba(34,197,94,0.19)', text: '#bbf7d0' },
  lf: { bg: 'rgba(34,197,94,0.26)', text: '#86efac' },
  le: { bg: 'rgba(34,197,94,0.32)', text: '#86efac' },
}
