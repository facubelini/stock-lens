import { useEffect, useState } from 'react'

// Hook para traer un JSON estatico desde public/data/.
// Usa import.meta.env.BASE_URL para funcionar tanto en dev ('/') como en
// GitHub Pages ('/stock-lens/').
export function useJson(nombre) {
  const [data, setData] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let activo = true
    setCargando(true)
    setError(null)

    const url = `${import.meta.env.BASE_URL}data/${nombre}`
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`No se pudo cargar ${nombre} (HTTP ${r.status})`)
        return r.json()
      })
      .then((json) => {
        if (activo) {
          setData(json)
          setCargando(false)
        }
      })
      .catch((e) => {
        if (activo) {
          setError(e.message)
          setCargando(false)
        }
      })

    return () => {
      activo = false
    }
  }, [nombre])

  return { data, cargando, error }
}
