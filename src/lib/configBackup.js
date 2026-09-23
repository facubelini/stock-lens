// Backup/restore de la configuración que vive en localStorage (watchlist +
// clasificación manual). A propósito NO incluye el GitHub token: es una
// credencial con permiso de escritura sobre el repo, no algo para meter en un
// archivo que se descarga y puede terminar guardado o compartido.
const VERSION_ACTUAL = 1

export function exportarConfig(watchlist, overrides) {
  const payload = {
    version: VERSION_ACTUAL,
    exportado: new Date().toISOString(),
    watchlist: watchlist ?? null,
    clasificacion: overrides ?? {},
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `stock-lens-config-${payload.exportado.slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Normaliza una entrada de watchlist: descarta las que no tienen ticker y
// fuerza todos los campos a string (un JSON editado a mano puede traer
// numeros, null u objetos).
function normalizarEntrada(w) {
  if (!w || typeof w !== 'object') return null
  const ticker = String(w.ticker ?? '').trim().toUpperCase()
  if (!ticker) return null
  return {
    ticker,
    industria: String(w.industria ?? '').trim(),
    pais: String(w.pais ?? '').trim(),
    nombre: String(w.nombre ?? '').trim(),
  }
}

export function parsearConfig(texto) {
  let data
  try {
    data = JSON.parse(texto)
  } catch {
    throw new Error('El archivo no es un JSON válido.')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('El archivo no tiene el formato esperado.')
  }
  const version = Number(data.version ?? 1)
  if (!Number.isFinite(version) || version > VERSION_ACTUAL) {
    throw new Error(
      `El backup es de una versión más nueva de la app (v${data.version}); actualizá la página antes de restaurarlo.`,
    )
  }

  let watchlist = null
  if (Array.isArray(data.watchlist)) {
    const vistos = new Set()
    watchlist = data.watchlist
      .map(normalizarEntrada)
      .filter((w) => w && !vistos.has(w.ticker) && vistos.add(w.ticker))
  }

  const clasificacion = {}
  if (data.clasificacion && typeof data.clasificacion === 'object' && !Array.isArray(data.clasificacion)) {
    for (const [tk, campos] of Object.entries(data.clasificacion)) {
      if (!tk || !campos || typeof campos !== 'object') continue
      const industria = String(campos.industria ?? '').trim()
      const sector = String(campos.sector ?? '').trim()
      if (industria || sector) clasificacion[tk] = { industria, sector }
    }
  }

  return { watchlist, clasificacion }
}
