import { useCallback, useRef, useState } from 'react'
import { getKlines, sleep } from './binanceApi'
import { analyzeKlines } from './indicadores'

// Se pide en lotes para no dispararle ~500 requests de golpe a Binance.
const TAMANO_LOTE = 15

// Loop de escaneo compartido por "Crypto Screener" y "Acciones Tokenizadas".
// Lo unico que cambia entre las dos pestanias es el universo de simbolos
// (cargarSimbolos) — la señal sale de la misma analyzeKlines, asi que
// cualquier cambio en la logica de scoring aplica a las dos a la vez.
//
// cargarSimbolos: () => Promise<Array<{symbol, ...meta}>>. La meta extra
// (base, tipo, ...) se copia tal cual en cada fila del resultado, para que la
// pestania pueda filtrar/agrupar por sus propios campos.
export function useEscaneoBinance({ cargarSimbolos, intervalo, multiploATR, alTerminar }) {
  const [datos, setDatos] = useState([])
  const [corriendo, setCorriendo] = useState(false)
  const [progreso, setProgreso] = useState({ hecho: 0, total: 0 })
  const [ultimaActualizacion, setUltimaActualizacion] = useState(null)
  const [errorMsg, setErrorMsg] = useState(null)
  // Simbolos que quedaron sin fila: klines que fallaron o con menos de 60
  // velas (analyzeKlines devuelve null). Pasa con los recien listados en las
  // temporalidades largas, asi que conviene mostrarlo en vez de ocultarlo.
  const [omitidos, setOmitidos] = useState(0)
  const cacheKlines = useRef(new Map())
  const corriendoRef = useRef(false)

  const escanear = useCallback(async () => {
    if (corriendoRef.current) return
    corriendoRef.current = true
    setCorriendo(true)
    setErrorMsg(null)
    try {
      const simbolos = await cargarSimbolos()
      const total = simbolos.length
      setProgreso({ hecho: 0, total })
      cacheKlines.current = new Map()
      const resultados = []
      for (let i = 0; i < simbolos.length; i += TAMANO_LOTE) {
        const lote = simbolos.slice(i, Math.min(i + TAMANO_LOTE, simbolos.length))
        const parciales = await Promise.all(
          lote.map(async ({ symbol, ...meta }) => {
            const k = await getKlines(symbol, intervalo, 200)
            if (k) cacheKlines.current.set(symbol, k)
            const fila = analyzeKlines(symbol, k, multiploATR)
            // symbolRaw = el simbolo tal cual lo pide la API ('MSTRUSDT');
            // fila.symbol es el de mostrar ('MSTR/USDT').
            return fila ? { ...fila, ...meta, symbolRaw: symbol } : null
          }),
        )
        resultados.push(...parciales.filter(Boolean))
        const hecho = Math.min(i + TAMANO_LOTE, total)
        setProgreso({ hecho, total })
        if (i + TAMANO_LOTE < simbolos.length) await sleep(150)
      }
      resultados.sort((a, b) => a.score - b.score)
      setDatos(resultados)
      setOmitidos(total - resultados.length)
      setUltimaActualizacion(new Date().toLocaleTimeString('es-AR'))
      alTerminar?.(resultados)
    } catch (e) {
      setErrorMsg(e.message)
    } finally {
      corriendoRef.current = false
      setCorriendo(false)
    }
  }, [cargarSimbolos, intervalo, multiploATR, alTerminar])

  return {
    datos,
    corriendo,
    progreso,
    ultimaActualizacion,
    errorMsg,
    omitidos,
    cacheKlines,
    escanear,
  }
}
