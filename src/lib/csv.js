// Exporta filas a CSV y dispara la descarga en el navegador.
// columnas: [{ key, label, valor(row)?, valorCSV(row)? }]
//
// Formato pensado para Excel en español (es-AR): separador ';' y coma
// decimal (con ',' como separador Excel mete todo en una sola columna, y
// "12.5" lo lee como texto o como fecha). UTF-8 con BOM para los acentos.
const SEP = ';'

// Textos que Excel/Sheets interpretan como formula (inyeccion CSV: un nombre
// de empresa o un motivo que empiece con "=" podria ejecutar algo al abrir
// el archivo). Se les antepone un apostrofo. Solo a textos: un numero
// negativo (-3,5) es un numero, no una formula.
const INICIO_FORMULA = /^[=+\-@\t\r]/

function aTexto(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return ''
    // Sin separador de miles (Excel lo tomaria mal); coma decimal.
    return String(v).replace('.', ',')
  }
  if (typeof v === 'boolean') return v ? 'Sí' : 'No'
  const s = String(v)
  return INICIO_FORMULA.test(s) ? `'${s}` : s
}

function escapar(v) {
  const s = aTexto(v)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function exportarCSV(nombreArchivo, columnas, filas) {
  const cols = columnas.filter((c) => c.csv !== false)

  const valorDe = (col, row) => {
    if (col.valorCSV) return col.valorCSV(row)
    if (col.valor) return col.valor(row)
    return row[col.key]
  }

  const header = cols.map((c) => escapar(c.label)).join(SEP)
  const lineas = filas.map((row) => cols.map((c) => escapar(valorDe(c, row))).join(SEP))
  const csv = [header, ...lineas].join('\r\n')

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
