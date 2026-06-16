// Helpers de formato (es-AR), colores e intensidades para las tablas.

export const ND = 'N/D'

const nf2 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function esNulo(v) {
  return v === null || v === undefined || Number.isNaN(v)
}

// 1234.5 -> "1.234,50" | con signo opcional para variaciones
export function fmtPct(v, { signo = false } = {}) {
  if (esNulo(v)) return ND
  const prefijo = signo && v > 0 ? '+' : ''
  return `${prefijo}${nf2.format(v)}%`
}

export function fmtNum(v, dec = 2) {
  if (esNulo(v)) return ND
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  }).format(v)
}

export function fmtPrecio(v) {
  if (esNulo(v)) return ND
  return nf2.format(v)
}

// Market cap abreviado al estilo financiero US (T/B/M/K), que es el que usan
// los traders argentinos al mirar mercados de USA.
export function fmtMarketCap(v) {
  if (esNulo(v)) return ND
  const abs = Math.abs(v)
  const fmt = (n) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(n)
  if (abs >= 1e12) return `${fmt(v / 1e12)} T`
  if (abs >= 1e9) return `${fmt(v / 1e9)} B`
  if (abs >= 1e6) return `${fmt(v / 1e6)} M`
  if (abs >= 1e3) return `${fmt(v / 1e3)} K`
  return fmt(v)
}

// ISO con offset -> "16/06/2026 14:30 hs" (zona Buenos Aires)
export function fmtFecha(iso) {
  if (!iso) return ND
  try {
    const d = new Date(iso)
    const s = new Intl.DateTimeFormat('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Argentina/Buenos_Aires',
    }).format(d)
    return `${s} hs`
  } catch {
    return iso
  }
}

// Promedio ignorando nulos / NaN.
export function promedio(arr, fn) {
  const vals = (arr ?? []).map(fn).filter((v) => !esNulo(v))
  if (!vals.length) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

// ----- Colores e intensidad -----
const VERDE = '34, 197, 94'
const ROJO = '239, 68, 68'
const CELESTE = '56, 189, 248'

function rgba(base, alpha) {
  return `rgba(${base}, ${alpha})`
}

// Fondo coloreado segun signo y magnitud (para Var% y distancias a medias).
// escala = magnitud que se considera "fuerte" (alfa cercano al maximo).
export function estiloValor(v, escala = 6) {
  if (esNulo(v)) return {}
  const a = Math.min(0.12 + (Math.abs(v) / escala) * 0.6, 0.78)
  const base = v >= 0 ? VERDE : ROJO
  return { backgroundColor: rgba(base, a), color: v >= 0 ? '#dcffe8' : '#ffe1e1' }
}

// RSI: >70 sobrecompra (rojo), <30 sobreventa (celeste), zona media neutra.
export function estiloRSI(v) {
  if (esNulo(v)) return {}
  if (v >= 70) {
    const a = Math.min(0.18 + ((v - 70) / 30) * 0.55, 0.75)
    return { backgroundColor: rgba(ROJO, a), color: '#ffe1e1' }
  }
  if (v <= 30) {
    const a = Math.min(0.18 + ((30 - v) / 30) * 0.55, 0.75)
    return { backgroundColor: rgba(CELESTE, a), color: '#e2f6ff' }
  }
  return {}
}

// Heuristica visual de "barato/caro" para PER (NO es recomendacion de inversion).
export function estiloPER(v) {
  if (esNulo(v) || v <= 0) return {}
  if (v < 15) return { color: '#7ee2a8' }
  if (v > 35) return { color: '#ff9d9d' }
  return {}
}

// Heuristica visual para PEG.
export function estiloPEG(v) {
  if (esNulo(v) || v <= 0) return {}
  if (v < 1) return { color: '#7ee2a8' }
  if (v > 2) return { color: '#ff9d9d' }
  return {}
}

export function claseAlineacion(align) {
  if (align === 'right') return 'text-right'
  if (align === 'center') return 'text-center'
  return 'text-left'
}
