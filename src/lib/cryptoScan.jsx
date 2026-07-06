import { createContext, useCallback, useContext, useState } from 'react'

// Comparte el último escaneo de Crypto Screener con el resto de la app (para
// "Top Señales"), sin persistir nada: es data pesada/viva de la sesión, no
// algo que tenga sentido guardar entre visitas.
const Ctx = createContext(null)

export function CryptoScanProvider({ children }) {
  const [ultimoScan, setUltimoScanState] = useState(null) // { resultados, timestamp }

  const setUltimoScan = useCallback((resultados) => {
    setUltimoScanState({ resultados, timestamp: new Date().toLocaleTimeString('es-AR') })
  }, [])

  return <Ctx.Provider value={{ ultimoScan, setUltimoScan }}>{children}</Ctx.Provider>
}

export function useCryptoScan() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useCryptoScan debe usarse dentro de <CryptoScanProvider>')
  return c
}
