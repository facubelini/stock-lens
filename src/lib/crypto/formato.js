// Formato de precio/color compartido entre Crypto Screener y el detalle de
// símbolo (los pares USDT tienen escalas muy distintas: BTC vs. una memecoin).
export function fmtPrice(p) {
  if (p == null) return '—'
  if (p >= 1000) return '$' + p.toLocaleString('es-AR', { maximumFractionDigits: 2 })
  if (p >= 1) return '$' + p.toFixed(4)
  if (p >= 0.001) return '$' + p.toFixed(6)
  return '$' + p.toFixed(8)
}

export function colorRSI(v) {
  if (v >= 70) return '#ef4444'
  if (v >= 55) return '#f97316'
  if (v <= 30) return '#22c55e'
  if (v <= 45) return '#84cc16'
  return '#6b7280'
}
