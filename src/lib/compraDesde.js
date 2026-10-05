import { useJson } from './useJson'
import { hoyAR } from './formato'

// "Desde cuándo cumple" cada señal de compra (public/data/compra_desde.json,
// armado en scripts/pipeline/compra_desde.py). Cada entrada guarda la fecha
// en que empezó la racha actual y el cierre de ese día; acá se compara contra
// el precio de hoy para ver si la señal "funcionó".
//
// aprox = la racha llega hasta el primer día registrado (empezó antes: la
// fecha es "desde al menos").

export function useCompraDesde() {
  const { data } = useJson('compra_desde.json')
  return data?.claves ?? null
}

export function entradaDesde(claves, clave, ticker) {
  return claves?.[clave]?.tickers?.[ticker] ?? null
}

function diasEntre(desdeISO, hastaISO) {
  return Math.round((Date.parse(hastaISO) - Date.parse(desdeISO)) / 86400000)
}

/**
 * { desde, dias, retorno, aprox, precio, precioHoy } a partir de una entrada
 * ({desde, precio, precio_hoy, aprox}). retorno = % desde el cierre de ese día
 * hasta hoy (null si falta algún precio). null si no hay entrada.
 */
export function infoDesde(entrada, hoy = hoyAR()) {
  if (!entrada?.desde) return null
  const { desde, precio, precio_hoy: precioHoy } = entrada
  const retorno = precio > 0 && precioHoy != null ? (precioHoy / precio - 1) * 100 : null
  return { desde, dias: Math.max(0, diasEntre(desde, hoy)), retorno, aprox: Boolean(entrada.aprox), precio: precio ?? null, precioHoy: precioHoy ?? null }
}

// Entrada de una señal puntual (rebote/cruce EMA200, cruce RSI semanal): la
// fecha y el precio del evento ya vienen en la propia fila de senales.json.
export function entradaDeEvento(fila) {
  if (!fila?.fecha) return null
  return { desde: fila.fecha, precio: fila.precio, precio_hoy: fila.precio_hoy, aprox: false }
}

// La mas antigua de varias entradas (p. ej. las 3 temporalidades del Screener).
export function masAntigua(entradas) {
  return entradas.filter(Boolean).sort((a, b) => a.desde.localeCompare(b.desde))[0] ?? null
}
