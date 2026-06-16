import { useMemo, useState } from 'react'

// Estado compartido de las tablas: busqueda, filtro por pais e industria,
// y ordenamiento por columna. Devuelve las filas ya filtradas (el orden lo
// aplica el componente Tabla, porque puede ser dentro de cada grupo).
export function useTabla(filas, { camposBusqueda = ['ticker', 'nombre'], ordenInicial = null } = {}) {
  const [busqueda, setBusqueda] = useState('')
  const [pais, setPais] = useState('')
  const [industria, setIndustria] = useState('')
  const [sortKey, setSortKey] = useState(ordenInicial?.key ?? null)
  const [sortDir, setSortDir] = useState(ordenInicial?.dir ?? 'desc')

  const paises = useMemo(
    () =>
      [...new Set((filas ?? []).map((f) => f.pais).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, 'es'),
      ),
    [filas],
  )

  const industrias = useMemo(
    () =>
      [...new Set((filas ?? []).map((f) => f.industria).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, 'es'),
      ),
    [filas],
  )

  const camposKey = camposBusqueda.join(',')
  const filtradas = useMemo(() => {
    let r = filas ?? []
    if (pais) r = r.filter((f) => f.pais === pais)
    if (industria) r = r.filter((f) => f.industria === industria)
    const q = busqueda.trim().toLowerCase()
    if (q) {
      r = r.filter((f) =>
        camposBusqueda.some((c) => String(f[c] ?? '').toLowerCase().includes(q)),
      )
    }
    return r
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filas, pais, industria, busqueda, camposKey])

  const ordenar = (clave) => {
    if (sortKey === clave) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(clave)
      setSortDir('desc')
    }
  }

  return {
    busqueda,
    setBusqueda,
    pais,
    setPais,
    industria,
    setIndustria,
    paises,
    industrias,
    filtradas,
    sortKey,
    sortDir,
    ordenar,
  }
}
