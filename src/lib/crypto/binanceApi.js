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

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
