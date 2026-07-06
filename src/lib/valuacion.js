// Descuento de valuación vs. la mediana de industria (comparables.json),
// compartido entre Oportunidades y Mi Cartera para no duplicar el cálculo.
export const RATIOS_VALOR = ['per_trailing', 'ev_sales', 'ps']

// Promedio del descuento (%) contra la mediana de industria en los ratios de
// valuación disponibles. Positivo = cotiza mas barato que sus pares.
export function calcularDescuento(fila, mediana) {
  if (!mediana) return null
  const descuentos = RATIOS_VALOR.map((k) => {
    const v = fila[k]
    const m = mediana[k]
    if (v == null || m == null || v <= 0 || m <= 0) return null
    return ((m - v) / m) * 100
  }).filter((d) => d != null)
  if (!descuentos.length) return null
  return descuentos.reduce((a, b) => a + b, 0) / descuentos.length
}
