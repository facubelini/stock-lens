import { createContext, useCallback, useContext, useState } from 'react'

// Alertas de precio: solo en el navegador (localStorage), sin backend ni
// notificacion push/email. Se marcan "cumplida" cuando la condicion ya se
// cumple con los datos mas recientes — el usuario tiene que entrar a la app
// para verlas, no hay forma de avisar si la tiene cerrada.
const KEY = 'stocklens_alertas'
const Ctx = createContext(null)

export const CAMPOS_ALERTA = { precio: 'Precio', rsi: 'RSI', var_pct: 'Var. % del día' }

function leer() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function AlertasProvider({ children }) {
  const [alertas, setAlertas] = useState(leer)

  const persistir = useCallback((lista) => {
    setAlertas(lista)
    try {
      localStorage.setItem(KEY, JSON.stringify(lista))
    } catch {
      /* almacenamiento no disponible: se pierde al recargar, sin romper nada */
    }
  }, [])

  const crear = useCallback(
    ({ ticker, campo, operador, valor }) => {
      const nueva = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ticker: String(ticker).toUpperCase(),
        campo,
        operador,
        valor: Number(valor),
        disparada: false,
        creada: new Date().toISOString(),
      }
      persistir([nueva, ...alertas])
    },
    [alertas, persistir],
  )

  const eliminar = useCallback((id) => persistir(alertas.filter((a) => a.id !== id)), [alertas, persistir])

  const marcarDisparada = useCallback(
    (id) => persistir(alertas.map((a) => (a.id === id ? { ...a, disparada: true } : a))),
    [alertas, persistir],
  )

  const reactivar = useCallback(
    (id) => persistir(alertas.map((a) => (a.id === id ? { ...a, disparada: false } : a))),
    [alertas, persistir],
  )

  return (
    <Ctx.Provider value={{ alertas, crear, eliminar, marcarDisparada, reactivar }}>{children}</Ctx.Provider>
  )
}

export function useAlertas() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAlertas debe usarse dentro de <AlertasProvider>')
  return c
}

// Evalua si la condicion se cumple AHORA con los datos actuales de su
// ticker, sin importar si ya estaba marcada "disparada" antes.
export function seCumpleAlerta(alerta, fila) {
  if (!fila) return false
  const valorActual = fila[alerta.campo]
  if (valorActual == null) return false
  return alerta.operador === 'mayor' ? valorActual >= alerta.valor : valorActual <= alerta.valor
}
