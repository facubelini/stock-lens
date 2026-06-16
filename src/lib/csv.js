// Exporta filas a CSV y dispara la descarga en el navegador.
// columnas: [{ key, label, valor(row)?, valorCSV(row)? }]
export function exportarCSV(nombreArchivo, columnas, filas) {
  const cols = columnas.filter((c) => c.csv !== false)

  const escapar = (v) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  const valorDe = (col, row) => {
    if (col.valorCSV) return col.valorCSV(row)
    if (col.valor) return col.valor(row)
    return row[col.key]
  }

  const header = cols.map((c) => escapar(c.label)).join(',')
  const lineas = filas.map((row) => cols.map((c) => escapar(valorDe(c, row))).join(','))
  const csv = [header, ...lineas].join('\n')

  // BOM para que Excel detecte UTF-8.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombreArchivo
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
