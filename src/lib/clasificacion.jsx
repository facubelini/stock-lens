import { createContext, useCallback, useContext, useState } from 'react'

// Overrides manuales de industria/sector por ticker (para casos que yfinance
// no clasifica bien o no clasifica del todo, ej. ETFs o Fiserv). Persistido en
// localStorage. Usa Context (como WatchlistProvider) para que un cambio hecho
// desde el editor de una fila se refleje al toque en todas las pestañas.
const KEY = 'stocklens_clasificacion'
const Ctx = createContext(null)

function leer() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

export function ClasificacionProvider({ children }) {
  const [overrides, setOverrides] = useState(leer)

  // campos: { industria?, sector? }. Un valor vacio borra ese campo.
  const setOverride = useCallback((ticker, campos) => {
    setOverrides((prev) => {
      const next = { ...prev }
      const actual = { ...(next[ticker] ?? {}) }
      for (const [campo, valor] of Object.entries(campos)) {
        const v = (valor ?? '').trim()
        if (v) actual[campo] = v
        else delete actual[campo]
      }
      if (Object.keys(actual).length) next[ticker] = actual
      else delete next[ticker]
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* almacenamiento no disponible: ignorar */
      }
      return next
    })
  }, [])

  return <Ctx.Provider value={{ overrides, setOverride }}>{children}</Ctx.Provider>
}

export function useClasificacion() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useClasificacion debe usarse dentro de <ClasificacionProvider>')
  return c
}

// Aplica los overrides del usuario por encima de industria/sector automaticos.
export function aplicarClasificacion(filas, overrides) {
  if (!overrides || !Object.keys(overrides).length) return filas ?? []
  return (filas ?? []).map((f) => {
    const o = overrides[f.ticker]
    if (!o) return f
    return { ...f, industria: o.industria || f.industria, sector: o.sector || f.sector }
  })
}
