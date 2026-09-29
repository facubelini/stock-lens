// Datos compartidos de la pagina Figuras Chartistas (pages/FigurasChartistas.jsx).
// Los calculos viven en scripts/pipeline/figuras.py (fg_ciclo / figuras_ticker /
// construir_figuras); aca solo se formatean/etiquetan para la UI.

export const TIPOS_FIGURAS = [
  { tipo: 'doble_techo', nombre: 'Doble Techo', emoji: '⛰️', bajista: true },
  { tipo: 'doble_piso', nombre: 'Doble Piso', emoji: '🏔️', bajista: false },
  { tipo: 'hch', nombre: 'Hombro-Cabeza-Hombro', emoji: '👤', bajista: true },
  { tipo: 'hch_invertido', nombre: 'HCH Invertido', emoji: '🙃', bajista: false },
]
export const NOMBRE_TIPO = Object.fromEntries(TIPOS_FIGURAS.map((t) => [t.tipo, t.nombre]))
export const BAJISTA_TIPO = Object.fromEntries(TIPOS_FIGURAS.map((t) => [t.tipo, t.bajista]))

// Estados del ciclo de vida (fg_ciclo), en orden de "madurez", con su color
// (misma paleta que ESTADOS_VCP de src/lib/senales.js).
export const ESTADOS_FIGURAS = [
  { estado: 'Formándose', color: '#7d8b9c' },
  { estado: 'Recién rompió', color: '#4ade80' },
  { estado: 'Rompió y confirmó', color: '#16a34a' },
  { estado: 'Rompió sin confirmar', color: '#fbbf24' },
  { estado: 'Falló antes de romper', color: '#f97316' },
  { estado: 'Rompió y falló', color: '#ef4444' },
]
export const COLOR_ESTADO_FIGURA = Object.fromEntries(ESTADOS_FIGURAS.map((e) => [e.estado, e.color]))

function plural(n, uno, varios) {
  return `${n} ${n === 1 ? uno : varios}`
}

// Ruedas desde un swing/ruptura: 0 = hoy.
export function fmtHace(hace) {
  if (hace == null) return '—'
  return hace === 0 ? 'hoy' : plural(hace, 'rueda', 'ruedas')
}
