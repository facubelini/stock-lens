// Comparador unico para las tablas (Tabla.jsx, Listado, Warren Score): nulos
// / NaN siempre al final (sin importar la direccion), strings con
// localeCompare 'es', numeros por resta. Antes habia 3 copias casi iguales.
function esNulo(v) {
  return v === null || v === undefined || Number.isNaN(v)
}

export function compararValores(va, vb, dir = 'desc') {
  const na = esNulo(va)
  const nb = esNulo(vb)
  if (na && nb) return 0
  if (na) return 1
  if (nb) return -1
  if (typeof va === 'string' || typeof vb === 'string') {
    const r = String(va).localeCompare(String(vb), 'es')
    return dir === 'asc' ? r : -r
  }
  return dir === 'asc' ? va - vb : vb - va
}

// getter(fila) -> valor. Con `pins` (Set de tickers), los favoritos van
// primero antes de aplicar el orden.
export function crearComparador(getter, dir = 'desc', pins = null) {
  return (a, b) => {
    if (pins) {
      const pa = pins.has(a.ticker)
      const pb = pins.has(b.ticker)
      if (pa !== pb) return pa ? -1 : 1
    }
    if (!getter) return 0
    return compararValores(getter(a), getter(b), dir)
  }
}

// aria-sort para un <th> ordenable.
export function ariaSort(activa, dir) {
  if (!activa) return 'none'
  return dir === 'asc' ? 'ascending' : 'descending'
}
