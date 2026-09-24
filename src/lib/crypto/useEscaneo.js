import { useCallback, useEffect, useRef, useState } from 'react'
import { getKlines, sleep } from './binanceApi.js'
import { ErrorRateLimit, segundosBloqueado, esCancelacion } from './rateLimit.js'
import { analyzeKlines } from './indicadores.js'
import { VELAS, TAMANO_LOTE, PAUSA_LOTE_MS, ENFRIAMIENTO_ESCANEO_S } from './constantes.js'

// Loop de escaneo compartido por "Crypto Screener", "Acciones Tokenizadas" y
// el "Screener de Cruces". Lo que cambia entre pestanias es el universo de
// simbolos (cargarSimbolos) y, en Cruces, la funcion que analiza las velas
// (analizar). La señal del v1 sale de la misma analyzeKlines, asi que
// cualquier cambio en la logica de scoring aplica a las dos primeras a la vez.

// ── Estado a nivel modulo (compartido por TODAS las pestanias) ─────────────
// Un solo escaneo a la vez en toda la app. Antes cada pestania tenia su
// propio ref "corriendo": si salias de /cripto a mitad de escaneo y volvias,
// el componente nuevo arrancaba de cero con el ref en false y el viejo seguia
// pidiendo velas de fondo — dos escaneos en paralelo contra el mismo
// presupuesto de peso de Binance.
let escaneoActivo = null // { controller, fin: Promise }
let finUltimoEscaneo = 0

// Segundos que faltan para poder re-escanear (0 = libre).
export function segundosEnfriamiento() {
  const falta = finUltimoEscaneo + ENFRIAMIENTO_ESCANEO_S * 1000 - Date.now()
  return falta > 0 ? Math.ceil(falta / 1000) : 0
}

const errorCancelado = () => {
  const e = new Error('Escaneo cancelado')
  e.name = 'AbortError'
  return e
}

// Pide las velas de cada simbolo por lotes y le pasa cada array a
// 'analizar'. Corta de una con rate limit / region bloqueada / cancelacion.
// Devuelve { filas, omitidos, klines: Map<symbol, velas> }.
export async function escanearLotes({ simbolos, intervalo, velas = VELAS, analizar, signal, onProgreso }) {
  const total = simbolos.length
  const klines = new Map()
  const filas = []
  let omitidos = 0
  onProgreso?.({ hecho: 0, total })
  for (let i = 0; i < total; i += TAMANO_LOTE) {
    if (signal?.aborted) throw errorCancelado()
    const lote = simbolos.slice(i, i + TAMANO_LOTE)
    const parciales = await Promise.all(
      lote.map(async (meta) => {
        const k = await getKlines(meta.symbol, intervalo, velas, { signal })
        if (!k) return null
        const fila = analizar(meta.symbol, k, meta)
        if (fila) klines.set(meta.symbol, k)
        return fila
      }),
    )
    for (const p of parciales) {
      if (p) filas.push(p)
      else omitidos++
    }
    onProgreso?.({ hecho: Math.min(i + TAMANO_LOTE, total), total })
    if (i + TAMANO_LOTE < total) await sleep(PAUSA_LOTE_MS)
  }
  return { filas, omitidos, klines }
}

// Cuenta regresiva de los dos "no se puede escanear todavia": el bloqueo de
// Binance (rate limit) y el enfriamiento entre escaneos. Antes el contador
// del bloqueo estaba copiado en cada pestania.
export function useCuentaRegresiva() {
  const [bloqueo, setBloqueo] = useState(() => segundosBloqueado())
  const [enfriamiento, setEnfriamiento] = useState(() => segundosEnfriamiento())
  const refrescar = useCallback(() => {
    setBloqueo(segundosBloqueado())
    setEnfriamiento(segundosEnfriamiento())
  }, [])
  const activo = bloqueo > 0 || enfriamiento > 0
  useEffect(() => {
    if (!activo) return
    const t = setInterval(refrescar, 1000)
    return () => clearInterval(t)
  }, [activo, refrescar])
  return { bloqueo, enfriamiento, refrescar }
}

export const fmtCuenta = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

const porScore = (a, b) => a.score - b.score

// cargarSimbolos: () => Promise<Array<{symbol, ...meta}>>. Con el analizador
// por defecto (analyzeKlines del v1) la meta extra (base, tipo, chg24h...) se
// copia tal cual en cada fila, para que la pestania pueda filtrar/agrupar por
// sus propios campos.
// analizar (opcional): (symbol, klines, meta) => fila | null.
// parametros: los que definen el resultado (temporalidad, ATR...). Se guarda
// una copia al arrancar cada escaneo (parametrosEscaneo) para que la pestania
// pueda avisar si el usuario los cambio despues y no mezclar datos viejos con
// parametros nuevos.
export function useEscaneoBinance({
  cargarSimbolos,
  intervalo,
  multiploATR,
  analizar,
  velas = VELAS,
  parametros,
  ordenar = porScore,
  alTerminar,
}) {
  const [datos, setDatos] = useState([])
  const [corriendo, setCorriendo] = useState(false)
  const [progreso, setProgreso] = useState({ hecho: 0, total: 0 })
  const [ultimaActualizacion, setUltimaActualizacion] = useState(null)
  const [errorMsg, setErrorMsg] = useState(null)
  const [parametrosEscaneo, setParametrosEscaneo] = useState(null)
  // Simbolos que quedaron sin fila: klines que fallaron o con menos velas de
  // las que pide el analizador (61 en el v1: 60 cerradas + la en curso).
  // Pasa con los recien listados en las temporalidades largas, asi que
  // conviene mostrarlo en vez de ocultarlo.
  const [omitidos, setOmitidos] = useState(0)
  const cacheKlines = useRef(new Map())
  const miEscaneo = useRef(null)
  const cuenta = useCuentaRegresiva()

  // Al salir de la pestania se cancela el escaneo propio (los fetch en vuelo
  // se abortan y el loop no arranca el lote siguiente).
  useEffect(
    () => () => {
      miEscaneo.current?.controller.abort()
    },
    [],
  )

  const escanear = useCallback(async () => {
    if (miEscaneo.current) return
    // Si Binance ya bloqueo la IP, no se arranca: cada pedido durante el
    // bloqueo lo extiende (medido: retry-after paso de 555s a 1024s con un
    // solo request de mas).
    const bloqueo = segundosBloqueado()
    if (bloqueo > 0) {
      setErrorMsg(new ErrorRateLimit(bloqueo).message)
      cuenta.refrescar()
      return
    }
    if (segundosEnfriamiento() > 0) {
      cuenta.refrescar()
      return
    }
    // Si otra pestania (o esta misma antes de desmontarse) tiene un escaneo
    // en curso, se cancela y se espera a que termine de soltar la red.
    if (escaneoActivo) {
      escaneoActivo.controller.abort()
      await escaneoActivo.fin.catch(() => {})
    }
    const controller = new AbortController()
    let terminar
    const yo = { controller, fin: new Promise((r) => (terminar = r)) }
    escaneoActivo = yo
    miEscaneo.current = yo

    setCorriendo(true)
    setErrorMsg(null)
    const params = parametros ?? { intervalo, multiploATR }
    const analizador =
      analizar ??
      ((symbol, k, { symbol: _s, ...meta }) => {
        const fila = analyzeKlines(symbol, k, multiploATR)
        // symbolRaw = el simbolo tal cual lo pide la API ('MSTRUSDT');
        // fila.symbol es el de mostrar ('MSTR/USDT').
        return fila ? { ...fila, ...meta, symbolRaw: symbol } : null
      })
    try {
      const simbolos = await cargarSimbolos({ signal: controller.signal })
      const { filas, omitidos: om, klines } = await escanearLotes({
        simbolos,
        intervalo,
        velas,
        analizar: analizador,
        signal: controller.signal,
        onProgreso: setProgreso,
      })
      if (ordenar) filas.sort(ordenar)
      cacheKlines.current = klines
      setDatos(filas)
      setOmitidos(om)
      setParametrosEscaneo(params)
      // Sin hourCycle, es-AR sale en 12 h y sin "p. m." (las 22:30 quedan "10:30:15").
      setUltimaActualizacion(new Date().toLocaleTimeString('es-AR', { hourCycle: 'h23' }))
      alTerminar?.(filas)
    } catch (e) {
      if (!esCancelacion(e)) setErrorMsg(e.message)
    } finally {
      finUltimoEscaneo = Date.now()
      if (escaneoActivo === yo) escaneoActivo = null
      miEscaneo.current = null
      terminar()
      setCorriendo(false)
      cuenta.refrescar()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cargarSimbolos, intervalo, multiploATR, analizar, velas, parametros, ordenar, alTerminar, cuenta.refrescar])

  return {
    datos,
    corriendo,
    progreso,
    ultimaActualizacion,
    errorMsg,
    omitidos,
    cacheKlines,
    parametrosEscaneo,
    bloqueo: cuenta.bloqueo,
    enfriamiento: cuenta.enfriamiento,
    escanear,
  }
}

// Compara los parametros del ultimo escaneo con los elegidos ahora.
export function parametrosCambiaron(escaneo, actuales) {
  if (!escaneo) return false
  return Object.keys(actuales).some((k) => escaneo[k] !== actuales[k])
}
