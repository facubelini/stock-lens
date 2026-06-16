// SheetJS se carga de forma diferida (dynamic import) para no engordar el
// bundle inicial: sólo se descarga cuando el usuario carga o baja un Excel.

// Lee un Excel/CSV de tickers en el navegador y devuelve filas normalizadas.
// Columnas esperadas (primera fila, case-insensitive): Ticker, Industria, Pais, Nombre.
export async function parsearExcelTickers(file) {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const hoja = wb.Sheets[wb.SheetNames[0]]
  if (!hoja) return { filas: [], errores: ['El archivo no tiene hojas.'] }

  const crudas = XLSX.utils.sheet_to_json(hoja, { defval: '' })
  const vistos = new Set()
  const filas = []

  for (const f of crudas) {
    const lower = {}
    for (const k of Object.keys(f)) lower[String(k).trim().toLowerCase()] = f[k]
    const ticker = String(lower['ticker'] ?? '').trim().toUpperCase()
    if (!ticker || ticker === 'NAN') continue
    if (vistos.has(ticker)) continue
    vistos.add(ticker)
    filas.push({
      ticker,
      industria: String(lower['industria'] ?? '').trim() || 'Sin clasificar',
      pais: String(lower['pais'] ?? lower['país'] ?? '').trim() || '—',
      nombre: String(lower['nombre'] ?? '').trim(),
    })
  }

  const errores = []
  if (!filas.length) {
    errores.push(
      'No se encontraron tickers. Revisá que la primera fila tenga encabezados Ticker / Industria / Pais.',
    )
  }
  return { filas, errores }
}

// Genera y descarga un tickers.xlsx con el formato que espera el pipeline.
export async function descargarTickersXlsx(watchlist, nombreArchivo = 'tickers.xlsx') {
  const XLSX = await import('xlsx')
  const datos = (watchlist ?? []).map((w) => ({
    Ticker: w.ticker,
    Industria: w.industria,
    Pais: w.pais,
    Nombre: w.nombre || '',
  }))
  const ws = XLSX.utils.json_to_sheet(datos, {
    header: ['Ticker', 'Industria', 'Pais', 'Nombre'],
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'tickers')
  XLSX.writeFile(wb, nombreArchivo)
}
