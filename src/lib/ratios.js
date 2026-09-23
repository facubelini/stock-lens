// Definiciones de ratios fundamentales compartidas por Fundamentales,
// Comparables, TickerDetalle, FiltrosRango y Herramientas (antes cada pagina
// tenia su propia copia de la lista, con labels/decimales que se iban
// desincronizando).
import { fmtMarketCap, fmtNum, fmtPct, estiloPER, estiloPEG } from './formato'

export const RECOMENDACION_LABEL = {
  strong_buy: 'Compra fuerte',
  buy: 'Compra',
  hold: 'Mantener',
  underperform: 'Bajo rendimiento',
  sell: 'Venta',
  strong_sell: 'Venta fuerte',
}

// Market cap comparable entre tickers: el pipeline manda `market_cap_usd`
// (convertido); si no viene, `market_cap` solo sirve si la moneda es USD (o
// no se informa, datos viejos). Un CEDEAR .BA en pesos NO se mezcla con uno
// en dolares — queda en null y va al final de cualquier orden.
export function marketCapUsd(f) {
  if (!f) return null
  if (f.market_cap_usd != null) return f.market_cap_usd
  if (!f.moneda || f.moneda === 'USD') return f.market_cap ?? null
  return null
}

// Moneda a mostrar como aviso (solo si no es USD).
export function monedaNoUsd(f) {
  return f?.moneda && f.moneda !== 'USD' ? f.moneda : null
}

// { key, label, dec, estilo?, esCap?, esPct?, unidad?, escala? }
// `valor(fila)` (opcional) = de donde sale el numero; por defecto fila[key].
export const RATIOS = [
  { key: 'per_trailing', label: 'PER', dec: 1, estilo: estiloPER },
  { key: 'per_forward', label: 'PER fwd', dec: 1, estilo: estiloPER },
  { key: 'peg', label: 'PEG', dec: 2, estilo: estiloPEG },
  { key: 'ev_sales', label: 'EV/Sales', dec: 2 },
  { key: 'pb', label: 'P/B', dec: 2 },
  { key: 'ps', label: 'P/S', dec: 2 },
  { key: 'market_cap', label: 'Market Cap', esCap: true, unidad: 'B USD', escala: 1e9, valor: marketCapUsd },
  { key: 'eps', label: 'EPS', dec: 2 },
  { key: 'profit_margin', label: 'Margen', esPct: true, unidad: '%' },
  { key: 'roe', label: 'ROE', esPct: true, unidad: '%' },
  { key: 'dividend_yield', label: 'Div. Yield', esPct: true, unidad: '%' },
  { key: 'beta', label: 'Beta', dec: 2 },
  { key: 'debt_to_equity', label: 'Deuda/Eq.', dec: 2 },
  { key: 'current_ratio', label: 'Liquidez', dec: 2 },
]

export const RATIOS_ANALISTAS = [
  { key: 'target_mean_price', label: 'Precio objetivo', dec: 2 },
  { key: 'upside_pct', label: 'Upside', esPct: true },
]

export const RATIO_POR_CLAVE = Object.fromEntries(
  [...RATIOS, ...RATIOS_ANALISTAS].map((r) => [r.key, r]),
)

export function valorRatio(def, fila) {
  if (!fila) return null
  return def.valor ? def.valor(fila) : fila[def.key]
}

// Texto de un valor ya extraido.
export function renderValor(def, valor) {
  if (def.esCap) return fmtMarketCap(valor)
  if (def.esPct) return fmtPct(valor)
  return fmtNum(valor, def.dec ?? 2)
}

// Texto del ratio de una fila completa. Market cap sin conversion a USD se
// muestra igual, pero con la moneda al lado para que no se lea como dolares.
export function renderRatio(def, fila) {
  const v = valorRatio(def, fila)
  if (def.esCap && v == null && fila?.market_cap != null) {
    return `${fmtMarketCap(fila.market_cap)} ${fila.moneda ?? ''}`.trim()
  }
  return renderValor(def, v)
}
