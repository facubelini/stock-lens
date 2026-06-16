import { useCallback, useRef, useState } from 'react'

// Favoritos persistentes en localStorage (mismo patron que tus otras apps).
// Implementacion robusta: usamos un ref para leer el set actual y hacemos
// setState por valor (no updater) + escritura directa. Asi evitamos el
// doble-invoque de updaters de React.StrictMode y los closures obsoletos.
const KEY = 'stocklens_favoritos'

function leerLS() {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || '[]'))
  } catch {
    return new Set()
  }
}

export function usePins() {
  const [pins, setPins] = useState(leerLS)
  const ref = useRef(pins)
  ref.current = pins

  const toggle = useCallback((ticker) => {
    const next = new Set(ref.current)
    if (next.has(ticker)) next.delete(ticker)
    else next.add(ticker)
    ref.current = next
    setPins(next)
    try {
      localStorage.setItem(KEY, JSON.stringify([...next]))
    } catch {
      /* almacenamiento no disponible: ignorar */
    }
  }, [])

  const isPinned = useCallback((ticker) => pins.has(ticker), [pins])

  return { pins, toggle, isPinned }
}
