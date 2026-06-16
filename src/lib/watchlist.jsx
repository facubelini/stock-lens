import { createContext, useCallback, useContext, useState } from 'react'

// Watchlist global del usuario, cargada desde un Excel y persistida en el
// navegador. Cuando hay una watchlist activa, las 3 pestañas muestran sólo
// esos tickers (con la industria/país/nombre del Excel del usuario).
const KEY = 'stocklens_watchlist'
const Ctx = createContext(null)

function leer() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY))
    return Array.isArray(v) && v.length ? v : null
  } catch {
    return null
  }
}

export function WatchlistProvider({ children }) {
  const [watchlist, setW] = useState(leer)

  const setWatchlist = useCallback((arr) => {
    const val = Array.isArray(arr) && arr.length ? arr : null
    setW(val)
    try {
      if (val) localStorage.setItem(KEY, JSON.stringify(val))
      else localStorage.removeItem(KEY)
    } catch {
      /* almacenamiento no disponible */
    }
  }, [])

  const limpiar = useCallback(() => setWatchlist(null), [setWatchlist])

  return (
    <Ctx.Provider value={{ watchlist, setWatchlist, limpiar }}>{children}</Ctx.Provider>
  )
}

export function useWatchlist() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useWatchlist debe usarse dentro de <WatchlistProvider>')
  return c
}

// Aplica la watchlist a un set de filas con datos: filtra a esos tickers,
// pisa industria/país/nombre con los del usuario, y reporta los pendientes
// (tickers de la lista que todavía no tienen datos calculados).
export function aplicarWatchlist(filas, watchlist) {
  if (!watchlist) return { filas, pendientes: [] }
  const porTicker = new Map((filas ?? []).map((f) => [String(f.ticker).toUpperCase(), f]))
  const out = []
  const pendientes = []
  for (const w of watchlist) {
    const f = porTicker.get(w.ticker)
    if (f) {
      out.push({
        ...f,
        industria: w.industria || f.industria,
        pais: w.pais || f.pais,
        nombre: w.nombre || f.nombre,
      })
    } else {
      pendientes.push(w)
    }
  }
  return { filas: out, pendientes }
}
