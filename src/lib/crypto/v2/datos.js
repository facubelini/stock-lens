// Universo del v2. La v1 hacia una sola llamada (exchangeInfo) y despues
// escaneaba los ~525 simbolos sin filtrar, y no usaba funding ni volumen
// porque pedirlos por simbolo era caro. Verificado que no hace falta: los dos
// endpoints devuelven TODOS los simbolos de una sola llamada
// (ticker/24hr: 752 simbolos, premiumIndex: 886). O sea, dos requests para
// todo el escaneo.

const BINANCE = 'https://fapi.binance.com'

async function json(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Binance respondio HTTP ${r.status} en ${url.split('/fapi')[1]}`)
  return r.json()
}

// Devuelve los perpetuos cripto USDT operables, con volumen negociado en 24h,
// variacion real de 24h y funding actual. Ordenados por volumen descendente.
export async function getUniversoV2({ minTurnover = 0 } = {}) {
  const [info, tickers, premium] = await Promise.all([
    json(`${BINANCE}/fapi/v1/exchangeInfo`),
    json(`${BINANCE}/fapi/v1/ticker/24hr`),
    json(`${BINANCE}/fapi/v1/premiumIndex`),
  ])

  const porTicker = new Map(tickers.map((t) => [t.symbol, t]))
  const porPremium = new Map(premium.map((p) => [p.symbol, p]))

  const universo = info.symbols
    .filter(
      (s) =>
        s.contractType === 'PERPETUAL' && // cripto; los TRADIFI_PERPETUAL van en su pestania
        s.quoteAsset === 'USDT' &&
        s.status === 'TRADING',
    )
    .map((s) => {
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

export async function getKlinesV2(symbol, interval, limit) {
  try {
    const r = await fetch(
      `${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    )
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
