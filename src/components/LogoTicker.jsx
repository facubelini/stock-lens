import { useState } from 'react'

// Logo circular de la empresa al lado del ticker, estilo warrenbife.com.
//
// Fuente elegida: financialmodelingprep.com/image-stock/{TICKER}.png — es la
// misma que usa warrenbife.com y, probado a mano en el navegador (28/09/2026)
// con AAPL, MSFT, GOOGL, AMZN, NVDA, TSLA, META, JPM, KO, XOM, DIS, V, MA,
// WMT, PG, devuelve el logo real sin pedir API key. Alternativas descartadas:
// IEX (storage.googleapis.com/iex/api/logos) esta dada de baja, eodhd.com
// pide referrer/plan pago para el logo, y Clearbit necesitaria un mapeo
// ticker→dominio (mas trabajo, sin necesidad si esta opcion ya anda gratis).
// Sin SLA formal: si en el futuro empieza a pedir key o cae, el onerror ya
// deja el placeholder de letra, así que el sitio no se rompe.
const LOGO_URL = (ticker) => `https://financialmodelingprep.com/image-stock/${ticker}.png`

// CEDEARs (.BA) y BDRs (.SA) son la misma empresa que su ticker de EEUU — se
// pide el logo con el ticker "pelado". Los .BA sin equivalente en EEUU
// (ALUA, PAMP, TXAR, etc.) simplemente no tienen logo ahi: cae al placeholder
// de letra, no hace falta mapearlos a mano.
function tickerBase(ticker) {
  return String(ticker ?? '')
    .trim()
    .toUpperCase()
    .replace(/\.(BA|SA)$/, '')
}

// Tickers cuyo logo ya dio error (404, etc.) en esta sesión — evita
// reintentar la carga de red en cada fila que repite el mismo ticker (ej.
// Listado con ~400 filas): una vez roto, las próximas instancias arrancan
// directo en el placeholder.
const logosRotos = new Set()

// Color determinístico a partir del string del ticker (mismo ticker, mismo
// color siempre), para el placeholder cuando no hay logo.
function colorDesdeTexto(texto) {
  let hash = 0
  for (let i = 0; i < texto.length; i++) {
    hash = (hash << 5) - hash + texto.charCodeAt(i)
    hash |= 0
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 55%, 32%)`
}

function Placeholder({ base, tam, className }) {
  const iniciales = base.slice(0, base.length > 3 ? 1 : 2) || '?'
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold leading-none text-terminal-text ${className}`}
      style={{
        width: tam,
        height: tam,
        backgroundColor: colorDesdeTexto(base || '?'),
        fontSize: Math.max(8, Math.round(tam * 0.4)),
      }}
    >
      {iniciales}
    </span>
  )
}

// { ticker, tam: diametro en px, className: clases extra }
export default function LogoTicker({ ticker, tam = 20, className = '' }) {
  const base = tickerBase(ticker)
  const [roto, setRoto] = useState(() => !base || logosRotos.has(base))

  if (roto) return <Placeholder base={base} tam={tam} className={className} />

  return (
    <img
      src={LOGO_URL(base)}
      alt=""
      aria-hidden="true"
      width={tam}
      height={tam}
      loading="lazy"
      decoding="async"
      className={`inline-block shrink-0 rounded-full bg-white object-contain ${className}`}
      style={{ width: tam, height: tam }}
      onError={() => {
        logosRotos.add(base)
        setRoto(true)
      }}
    />
  )
}
