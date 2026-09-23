// Fetch directo a Binance Futures desde el browser (sin backend, sin CORS
// proxy). Es el UNICO modulo que arma URLs de fapi: todas las pestanias de
// cripto (Crypto Screener, Cruces, Acciones Tokenizadas, ficha, Altseason)
// piden por aca, asi que la guardia de rate limit y los mensajes de error
// son los mismos en todas.
export const BINANCE = 'https://fapi.binance.com'

// Guardia de rate limit compartida. Se agrego despues de que un escaneo se
// comiera un bloqueo de IP de Binance: los fetch de abajo hacian
// `if (!r.ok) return null`, o sea que un 429 se tragaba en silencio y el
// escaneo seguia disparando los cientos de pedidos restantes, escalando el
// limite blando a un baneo largo. NO cambia ninguna logica de señal.
import { ErrorRateLimit, pedirBinance, pedirJsonBinance, esCancelacion } from './rateLimit.js'
export { ErrorRateLimit, ErrorBinanceHttp, segundosBloqueado, esCancelacion } from './rateLimit.js'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Errores que NO se pueden tragar como "este simbolo fallo": rate limit,
// region bloqueada / WAF (tiran desde pedirBinance) y la cancelacion del
// escaneo. Todo lo demas en un pedido por simbolo se saltea.
function esFatal(e) {
  return e instanceof ErrorRateLimit || e?.name === 'ErrorBinanceHttp' || esCancelacion(e)
}

// ── exchangeInfo ──────────────────────────────────────────────────────────
// Antes se pedia (y se filtraba) en tres lugares distintos. Pesa 1 y
// devuelve TODOS los contratos (cripto y TradFi), asi que se cachea en
// memoria 10 minutos: el Crypto Screener, la paleta de comandos y Cruces
// comparten la misma respuesta.
const TTL_EXCHANGE_INFO_MS = 10 * 60 * 1000
let cacheInfo = null // { ts, promesa }

export function getExchangeInfo() {
  if (cacheInfo && Date.now() - cacheInfo.ts < TTL_EXCHANGE_INFO_MS) return cacheInfo.promesa
  const promesa = pedirJsonBinance(`${BINANCE}/fapi/v1/exchangeInfo`)
  cacheInfo = { ts: Date.now(), promesa }
  // Si falla no se queda cacheado el error: el proximo intento vuelve a pedir.
  promesa.catch(() => {
    if (cacheInfo?.promesa === promesa) cacheInfo = null
  })
  return promesa
}

// Contratos USDT operables de un tipo. OJO: Binance marca los perpetuos de
// acciones/ETFs/commodities con contractType 'TRADIFI_PERPETUAL', NO
// 'PERPETUAL' — por eso hay dos universos separados.
export function contratosOperables(info, contractType = 'PERPETUAL') {
  return info.symbols.filter(
    (s) => s.contractType === contractType && s.quoteAsset === 'USDT' && s.status === 'TRADING',
  )
}

// Perpetuos cripto USDT, solo los nombres (lo usan el Crypto Screener y la
// paleta de comandos).
export async function getSymbols() {
  const info = await getExchangeInfo()
  return contratosOperables(info, 'PERPETUAL')
    .map((s) => s.symbol)
    .sort()
}

// Universo "TradFi": perpetuos de acciones tokenizadas, ETFs, commodities e
// indices. Devuelve objetos {symbol, base, tipo} porque la pestania agrupa
// por underlyingType (EQUITY / HK_EQUITY / COMMODITY / PREMARKET / ...).
export async function getSymbolsTradfi() {
  const info = await getExchangeInfo()
  return contratosOperables(info, 'TRADIFI_PERPETUAL')
    .map((s) => ({ symbol: s.symbol, base: s.baseAsset, tipo: s.underlyingType }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
}

// Universo con liquidez (lo usan Cruces y el Altseason). Los dos endpoints de
// mercado devuelven TODOS los simbolos de una sola llamada (ticker/24hr: ~750
// simbolos, peso 40; premiumIndex: ~890, peso 10), o sea que funding y
// volumen salen gratis sin pedirlos simbolo por simbolo.
// Devuelve los perpetuos cripto USDT operables con volumen negociado en 24h,
// variacion real de 24h y funding actual, ordenados por volumen descendente.
export async function getUniverso({ minTurnover = 0, conFunding = true } = {}) {
  const [info, tickers, premium] = await Promise.all([
    getExchangeInfo(),
    pedirJsonBinance(`${BINANCE}/fapi/v1/ticker/24hr`),
    conFunding ? pedirJsonBinance(`${BINANCE}/fapi/v1/premiumIndex`) : Promise.resolve([]),
  ])

  const porTicker = new Map(tickers.map((t) => [t.symbol, t]))
  const porPremium = new Map(premium.map((p) => [p.symbol, p]))

  const universo = contratosOperables(info, 'PERPETUAL').map((s) => {
    const t = porTicker.get(s.symbol)
    const p = porPremium.get(s.symbol)
    return {
      symbol: s.symbol,
      base: s.baseAsset,
      turnover: t ? +t.quoteVolume : null,
      chg24hReal: t ? +t.priceChangePercent : null,
      // lastFundingRate viene como decimal (0.00004158) -> 0.004158%
      fundingPct: p?.lastFundingRate != null ? +p.lastFundingRate * 100 : null,
      proxFunding: p?.nextFundingTime ?? null,
    }
  })

  const conVolumen = universo.filter((u) => u.turnover != null)
  const filtrado = conVolumen.filter((u) => u.turnover >= minTurnover)
  filtrado.sort((a, b) => b.turnover - a.turnover)

  return {
    simbolos: filtrado,
    totalDisponible: universo.length,
    descartadosPorLiquidez: conVolumen.length - filtrado.length,
    sinVolumen: universo.length - conVolumen.length,
  }
}

// ── Pedidos por simbolo ───────────────────────────────────────────────────
// Devuelven null si ese simbolo puntual falla (transitorio o inexistente, se
// lo saltea), pero PROPAGAN rate limit / region / cancelacion para que el
// escaneo se corte de una.
export async function getKlines(symbol, interval, limit = 200, { signal } = {}) {
  try {
    const r = await pedirBinance(
      `${BINANCE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
      { signal },
    )
    if (!r.ok) return null
    return await r.json()
  } catch (e) {
    if (esFatal(e)) throw e
    return null
  }
}

// "Fundamentals" de futuros — solo se piden en la vista de un símbolo (no en
// el escaneo masivo de la tabla: son 3 endpoints mas por simbolo, con ~530
// simbolos seria demasiada carga extra sobre Binance).
export async function getFundingRate(symbol) {
  try {
    const r = await pedirBinance(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`)
    if (!r.ok) return null
    const d = await r.json()
    return { tasa: parseFloat(d.lastFundingRate) * 100, proximoFunding: d.nextFundingTime }
  } catch (e) {
    if (esFatal(e)) throw e
    return null
  }
}

export async function getOpenInterest(symbol) {
  try {
    const r = await pedirBinance(`${BINANCE}/fapi/v1/openInterest?symbol=${symbol}`)
    if (!r.ok) return null
    const d = await r.json()
    return parseFloat(d.openInterest)
  } catch (e) {
    if (esFatal(e)) throw e
    return null
  }
}

export async function getLongShortRatio(symbol) {
  try {
    const r = await pedirBinance(
      `${BINANCE}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`,
    )
    if (!r.ok) return null
    const d = await r.json()
    const ultimo = d?.[0]
    if (!ultimo) return null
    return {
      ratio: parseFloat(ultimo.longShortRatio),
      largos: parseFloat(ultimo.longAccount) * 100,
      cortos: parseFloat(ultimo.shortAccount) * 100,
    }
  } catch (e) {
    if (esFatal(e)) throw e
    return null
  }
}

// Variacion real de 24h para TODOS los simbolos en un solo pedido (762
// simbolos, peso 40 medido — contra 2400 por minuto no se siente).
// Hace falta porque el 'chg24h' que calcula analyzeKlines son 24 VELAS de la
// temporalidad elegida: 6 horas en 15m, 4 dias en 4h, 24 dias en diario.
// Devuelve Map<symbol, %>. Si falla por algo no fatal devuelve un Map vacio
// (la tabla cae al 24h aproximado de analyzeKlines en vez de no escanear).
export async function getTicker24h() {
  try {
    const d = await pedirJsonBinance(`${BINANCE}/fapi/v1/ticker/24hr`)
    return new Map(d.map((t) => [t.symbol, +t.priceChangePercent]))
  } catch (e) {
    if (esFatal(e)) throw e
    return new Map()
  }
}
