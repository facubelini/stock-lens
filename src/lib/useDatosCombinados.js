import { useMemo } from 'react'
import { useJson } from './useJson'

// Combina listado + medias + fundamentales en un solo array por ticker.
// Lo usa la pestaña Listado para calcular el score (que necesita métricas
// de las tres fuentes) y mostrar el sparkline. Los tres JSON salen del cache
// compartido de useJson: combinarlos en varias paginas no los vuelve a bajar.
export function useDatosCombinados() {
  const l = useJson('listado.json')
  const m = useJson('medias.json')
  const f = useJson('fundamentales.json')

  const cargando = l.cargando || m.cargando || f.cargando
  // Se juntan los errores de las tres fuentes (antes se mostraba solo el
  // primero y no se sabia si faltaba algo mas).
  const errores = [l.error, m.error, f.error].filter(Boolean)
  const error = errores.length ? errores.join(' · ') : null

  const filas = useMemo(() => {
    const La = l.data?.acciones ?? []
    const Ma = Array.isArray(m.data) ? m.data : (m.data?.acciones ?? [])
    const Fa = Array.isArray(f.data) ? f.data : (f.data?.acciones ?? [])
    const map = new Map()
    for (const x of La) map.set(x.ticker, { ...x })
    for (const x of Ma) map.set(x.ticker, { ...(map.get(x.ticker) ?? {}), ...x })
    for (const x of Fa) map.set(x.ticker, { ...(map.get(x.ticker) ?? {}), ...x })
    return [...map.values()]
  }, [l.data, m.data, f.data])

  return { filas, cargando, error }
}
