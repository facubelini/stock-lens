// Fetch directo a Binance Futures desde el browser (sin backend, sin CORS
// proxy) — igual que "Crypto Screener v3" cuando corre como sitio estatico.
const BINANCE = 'https://fapi.binance.com'

export async function getSymbols() {
  const r = await fetch(`${BINANCE}/fapi/v1/exchangeInfo`)
  const d = await r.json()
  return d.symbols
    .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
    .map((s) => s.symbol)
    .sort()
}

export async function getKlines(symbol, interval, limit = 200) {
  try {
    const r = await fetch(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`)
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

// "Fundamentals" de futuros — solo se piden en la vista de un símbolo (no en
// el escaneo masivo de la tabla: son 3 endpoints mas por simbolo, con ~530
// simbolos seria demasiada carga extra sobre Binance).
export async function getFundingRate(symbol) {
  try {
    const r = await fetch(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`)
    if (!r.ok) return null
    const d = await r.json()
    return { tasa: parseFloat(d.lastFundingRate) * 100, proximoFunding: d.nextFundingTime }
  } catch {
    return null
  }
}

export async function getOpenInterest(symbol) {
  try {
    const r = await fetch(`${BINANCE}/fapi/v1/openInterest?symbol=${symbol}`)
    if (!r.ok) return null
    const d = await r.json()
    return parseFloat(d.openInterest)
  } catch {
    return null
  }
}

export async function getLongShortRatio(symbol) {
  try {
    const r = await fetch(
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
  } catch {
    return null
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Universo "TradFi": perpetuos de acciones tokenizadas, ETFs, commodities e
// indices. OJO: Binance los marca con contractType 'TRADIFI_PERPETUAL', NO
// 'PERPETUAL' — por eso getSymbols() (que filtra los perpetuos cripto) no
// devuelve ninguno de estos, y hace falta esta funcion aparte.
// Devuelve objetos {symbol, base, tipo} porque la pestania agrupa por
// underlyingType (EQUITY / HK_EQUITY / COMMODITY / PREMARKET / ...).
export async function getSymbolsTradfi() {
  const r = await fetch(`${BINANCE}/fapi/v1/exchangeInfo`)
  const d = await r.json()
  return d.symbols
    .filter(
      (s) =>
        s.contractType === 'TRADIFI_PERPETUAL' &&
        s.quoteAsset === 'USDT' &&
        s.status === 'TRADING',
    )
    .map((s) => ({ symbol: s.symbol, base: s.baseAsset, tipo: s.underlyingType }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
}
