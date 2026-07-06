// Backup/restore de la configuración que vive en localStorage (watchlist +
// clasificación manual). A propósito NO incluye el GitHub token: es una
// credencial con permiso de escritura sobre el repo, no algo para meter en un
// archivo que se descarga y puede terminar guardado o compartido.
export function exportarConfig(watchlist, overrides) {
  const payload = {
    version: 1,
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

export function parsearConfig(texto) {
  let data
  try {
    data = JSON.parse(texto)
  } catch {
    throw new Error('El archivo no es un JSON válido.')
  }
  if (!data || typeof data !== 'object') throw new Error('El archivo no tiene el formato esperado.')
  return {
    watchlist: Array.isArray(data.watchlist) ? data.watchlist : null,
    clasificacion:
      data.clasificacion && typeof data.clasificacion === 'object' && !Array.isArray(data.clasificacion)
        ? data.clasificacion
        : {},
  }
}
