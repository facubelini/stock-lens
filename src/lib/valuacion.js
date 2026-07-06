// Descuento de valuación vs. la mediana de industria (comparables.json),
// compartido entre Oportunidades y Mi Cartera para no duplicar el cálculo.
// Ojo: scripts/generar_datos.py tiene una version Python de esto mismo
// (_descuento_valor) para el historial de Oportunidades — si se toca un
// lado, tocar el otro.
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

// "Barato" no es solo múltiplo bajo: una empresa cara-por-mala-razón (ROE y
// margen por debajo de sus pares) no es la misma oportunidad que una barata
// Y rentable. No cambia el filtro de Oportunidades, es una dimensión extra
// para mostrar al lado del descuento.
export function evaluarCalidad(fila, mediana) {
  if (!mediana) return null
  const roeOk = fila.roe != null && mediana.roe != null && fila.roe > mediana.roe
  const margenOk =
    fila.profit_margin != null && mediana.profit_margin != null && fila.profit_margin > mediana.profit_margin
  return { roeOk, margenOk }
}

// Señales de alerta de "trampa de valor": barato + señal técnica no
// significa que el negocio esté sano. Se fija en rentabilidad negativa e
// insiders vendiendo sin ninguna compra en los últimos 6 meses (ver
// resumen_insider en generar_datos.py). No excluye al ticker de la lista,
// solo lo marca para que el usuario lo mire con más cuidado.
export function señalesTrampaValor(fila) {
  const señales = []
  if (fila.roe != null && fila.roe < 0) señales.push('ROE negativo')
  if (fila.profit_margin != null && fila.profit_margin < 0) señales.push('Margen negativo')
  const ins = fila.insider
  if (ins && ins.n_ventas > 0 && ins.n_compras === 0 && ins.valor_ventas > 0) {
    señales.push('Insiders solo vendiendo (6m)')
  }
  return señales
}
