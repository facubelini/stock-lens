// Mediana (más robusta que el promedio para múltiplos con outliers).
export function mediana(valores) {
  const v = valores
    .filter((x) => x !== null && x !== undefined && !Number.isNaN(x))
    .sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

export function medianaDe(filas, fn) {
  return mediana((filas ?? []).map(fn))
}
