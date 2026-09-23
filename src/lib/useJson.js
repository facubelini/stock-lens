import { useEffect, useState } from 'react'

// Hook para traer un JSON estatico desde public/data/.
// Usa import.meta.env.BASE_URL para funcionar tanto en dev ('/') como en
// GitHub Pages ('/stock-lens/').
//
// Cache a nivel modulo (compartido por toda la app): cada archivo se pide UNA
// sola vez aunque lo usen 5 componentes a la vez (se reusa la promesa en
// vuelo) y el JSON ya parseado queda en memoria, asi que cambiar de pestaña no
// vuelve a bajar ni parsear listado.json/fundamentales.json. Los errores NO se
// cachean (el proximo montaje reintenta). TTL de 10 min: el pipeline corre
// cada ~hora y GitHub Pages cachea ~10 min, si la pestaña queda abierta toda
// la tarde se vuelve a pedir en vez de mostrar datos de la mañana.
const TTL_MS = 10 * 60 * 1000
const cache = new Map() // nombre -> { promesa, data, ts }

function urlDe(nombre) {
  return `${import.meta.env.BASE_URL}data/${nombre}`
}

function entradaVigente(nombre) {
  const e = cache.get(nombre)
  if (!e) return null
  if (e.data !== undefined && Date.now() - e.ts > TTL_MS) {
    cache.delete(nombre)
    return null
  }
  return e
}

// Promesa con el JSON parseado (deduplicada). El error lleva `status` (HTTP)
// para poder distinguir un 404 (archivo que no existe en este layout de
// datos) de una falla de red.
export function cargarJson(nombre) {
  const vigente = entradaVigente(nombre)
  if (vigente) return vigente.promesa
  const entrada = { promesa: null, data: undefined, ts: 0 }
  entrada.promesa = fetch(urlDe(nombre))
    .then((r) => {
      // El dev server de Vite (y algunos hostings con fallback SPA) responden
      // un archivo inexistente con index.html y status 200: se trata como 404.
      const esHtml = (r.headers.get('content-type') ?? '').includes('text/html')
      if (!r.ok || esHtml) {
        const status = r.ok ? 404 : r.status
        const err = new Error(`No se pudo cargar ${nombre} (HTTP ${status})`)
        err.status = status
        throw err
      }
      return r.json()
    })
    .then(
      (json) => {
        entrada.data = json
        entrada.ts = Date.now()
        return json
      },
      (err) => {
        if (cache.get(nombre) === entrada) cache.delete(nombre)
        throw err
      },
    )
  cache.set(nombre, entrada)
  return entrada.promesa
}

// Prueba varios archivos en orden y devuelve el primero que exista: sirve
// para convivir con dos layouts de datos (ej. historial/<T>.json nuevo vs.
// screener_historial.json viejo). Solo pasa al siguiente ante un 404; un
// error de red corta ahi mismo.
export async function cargarPrimero(nombres) {
  let ultimo = null
  for (const n of nombres) {
    try {
      return { data: await cargarJson(n), fuente: n }
    } catch (e) {
      ultimo = e
      if (e.status !== 404) throw e
    }
  }
  throw ultimo ?? new Error('Sin archivos para cargar')
}

function estadoInicial(clave, nombres) {
  if (!clave) return { clave, data: null, fuente: null, cargando: false, error: null }
  const e = entradaVigente(nombres[0])
  if (e?.data !== undefined) return { clave, data: e.data, fuente: nombres[0], cargando: false, error: null }
  return { clave, data: null, fuente: null, cargando: true, error: null }
}

// Hook generico: `nombres` es uno o varios archivos (fallback ante 404).
// Pasar null/'' no pide nada (carga diferida, ej. solo al abrir un modal).
function useJsonBase(nombres) {
  const lista = nombres ? (Array.isArray(nombres) ? nombres : [nombres]) : []
  const clave = lista.join('|')
  const [estado, setEstado] = useState(() => estadoInicial(clave, lista))
  // Si cambio el nombre, el estado guardado es de otro archivo: se descarta
  // en el mismo render (sin esperar al efecto) para no mostrar datos cruzados.
  const actual = estado.clave === clave ? estado : estadoInicial(clave, lista)

  useEffect(() => {
    if (!clave) {
      setEstado(estadoInicial(clave, []))
      return undefined
    }
    const nombresEf = clave.split('|')
    const e = entradaVigente(nombresEf[0])
    if (e?.data !== undefined) {
      setEstado((s) =>
        s.clave === clave && s.data === e.data ? s : { clave, data: e.data, fuente: nombresEf[0], cargando: false, error: null },
      )
      return undefined
    }
    // `activo` evita setState despues de desmontar (o si cambio el archivo
    // pedido). No se aborta el fetch en si: esta compartido con otros
    // componentes via el cache.
    let activo = true
    setEstado((s) => (s.clave === clave && s.cargando ? s : { clave, data: null, fuente: null, cargando: true, error: null }))
    cargarPrimero(nombresEf).then(
      ({ data, fuente }) => activo && setEstado({ clave, data, fuente, cargando: false, error: null }),
      (err) => activo && setEstado({ clave, data: null, fuente: null, cargando: false, error: err.message, status: err.status }),
    )
    return () => {
      activo = false
    }
  }, [clave])

  return actual
}

export function useJson(nombre) {
  const { data, cargando, error, status } = useJsonBase(nombre)
  return { data, cargando, error, status }
}

// Igual que useJson pero con archivos alternativos: devuelve ademas `fuente`
// (cual de los nombres respondio) para saber que forma tienen los datos.
export function useJsonPrimero(nombres) {
  return useJsonBase(nombres)
}

// meta.json via el mismo cache: fecha de la ultima corrida del pipeline. Las
// filas solo traen su propio `actualizado` cuando estan arrastradas (stale).
export function useMeta() {
  return useJson('meta.json').data
}
