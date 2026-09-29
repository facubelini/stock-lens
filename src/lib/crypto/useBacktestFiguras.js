import { useCallback, useEffect, useRef, useState } from 'react'
import { correrBacktestFiguras } from './backtestFiguras.js'
import { ErrorRateLimit, segundosBloqueado, esCancelacion } from './rateLimit.js'

// Cache de sessionStorage (NO localStorage a propósito: el resultado es "de
// esta sesión del navegador", no una evidencia persistida/validada — bajar
// ~40 símbolos x hasta 1000 velas diarias es caro, así que navegar a otra
// pestaña y volver no debe forzar una re-descarga, pero cerrar la pestaña sí
// debe olvidarlo, para no mostrar un resultado viejo como si fuera fresco).
const CLAVE_SESSION = 'figurasCriptoBacktest_v1'

function leerCache() {
  try {
    const crudo = sessionStorage.getItem(CLAVE_SESSION)
    return crudo ? JSON.parse(crudo) : null
  } catch {
    return null
  }
}

function guardarCache(datos) {
  try {
    sessionStorage.setItem(CLAVE_SESSION, JSON.stringify(datos))
  } catch {
    // sessionStorage lleno o deshabilitado (modo privado): el resultado sigue
    // en memoria de React vía el estado del hook, solo no sobrevive un F5.
  }
}

// Backtest de figuras chartistas cripto: acción SEPARADA y explícita (nunca
// se dispara sola al montar la página — ver FigurasChartistasCripto.jsx, que
// solo llama a 'correr' desde el onClick del botón). Cachea en sessionStorage
// para que cambiar de pestaña y volver no repita la descarga.
export function useBacktestFiguras() {
  const [resultado, setResultado] = useState(() => leerCache())
  const [corriendo, setCorriendo] = useState(false)
  const [progreso, setProgreso] = useState(null)
  const [errorMsg, setErrorMsg] = useState(null)
  const controllerRef = useRef(null)

  // Al salir de la pestaña se cancela una corrida en curso (mismo criterio
  // que useEscaneoBinance con el escaneo en vivo).
  useEffect(() => () => controllerRef.current?.abort(), [])

  const correr = useCallback(async () => {
    if (corriendo) return
    const bloqueo = segundosBloqueado()
    if (bloqueo > 0) {
      setErrorMsg(new ErrorRateLimit(bloqueo).message)
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    setCorriendo(true)
    setErrorMsg(null)
    setProgreso({ etapa: 'universo', hecho: 0, total: 0 })
    try {
      const datos = await correrBacktestFiguras({ signal: controller.signal, onProgreso: setProgreso })
      setResultado(datos)
      guardarCache(datos)
    } catch (e) {
      if (!esCancelacion(e)) setErrorMsg(e.message)
    } finally {
      setCorriendo(false)
      controllerRef.current = null
    }
  }, [corriendo])

  return { resultado, corriendo, progreso, errorMsg, correr }
}
