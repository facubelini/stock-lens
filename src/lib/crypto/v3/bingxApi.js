// Adaptador de BingX Perpetual Futures.
//
// OJO — POR QUE ESTO NO CORRE EN EL NAVEGADOR: BingX no manda el header
// 'Access-Control-Allow-Origin', asi que el browser bloquea el fetch por CORS
// (verificado desde https://facubelini.github.io: Binance responde bien y
// BingX tira "Failed to fetch"). Es el mismo problema que la API de IOL. Por
// eso la pestania v3 NO escanea en vivo: los datos los genera
// scripts/bingx_screener.js en GitHub Actions y quedan en
// public/data/bingx_screener.json.
//
// Decision de diseño: las klines de BingX se NORMALIZAN al formato de arrays
// de Binance, asi el motor del v2 (indicadores/senal/backtest) se reusa tal
// cual, sin una sola linea duplicada.

const BINGX = 'https://open-api.bingx.com'

// BingX devuelve las velas con el campo 'time' = apertura. Para armar el
// closeTime que espera el motor hace falta la duracion del intervalo.
export const MS_INTERVALO = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
}

// Maximo real del endpoint: pedir 1440 devuelve 1000 y 1500 tira error 109400.
export const MAX_VELAS_BINGX = 1000

async function json(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`BingX HTTP ${r.status} en ${url.split('/openApi')[1]}`)
  const d = await r.json()
  if (d.code !== 0) throw new Error(`BingX code ${d.code}: ${d.msg || 'sin mensaje'}`)
  return d.data
}

// Universo BingX: perpetuos -USDT operables, con volumen 24h, variacion real
// y funding. Los tres endpoints devuelven TODOS los simbolos de una sola
// llamada, igual que en Binance.
export async function getUniversoV3({ minTurnover = 0 } = {}) {
  const [contratos, tickers, premium] = await Promise.all([
    json(`${BINGX}/openApi/swap/v2/quote/contracts`),
    json(`${BINGX}/openApi/swap/v2/quote/ticker`),
    json(`${BINGX}/openApi/swap/v2/quote/premiumIndex`),
  ])

  const porTicker = new Map(tickers.map((t) => [t.symbol, t]))
  const porPremium = new Map(premium.map((p) => [p.symbol, p]))

  const universo = contratos
    .filter((c) => c.symbol?.endsWith('-USDT') && c.status === 1)
    .map((c) => {
      const t = porTicker.get(c.symbol)
      const p = porPremium.get(c.symbol)
      return {
        symbol: c.symbol, // 'BTC-USDT'
        base: c.symbol.replace('-USDT', ''),
        turnover: t ? +t.quoteVolume : null,
        chg24hReal: t ? +t.priceChangePercent : null,
        fundingPct: p?.lastFundingRate != null ? +p.lastFundingRate * 100 : null,
        proxFunding: p?.nextFundingTime ?? null,
        // BingX cobra 0.05% taker en todos los USDT, pero se lee del contrato
        // por si cambia o difiere en algun simbolo.
        feeTakerPct: c.takerFeeRate != null ? +c.takerFeeRate * 100 : 0.05,
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

// Klines normalizadas al formato de Binance:
// [openTime, open, high, low, close, volume, closeTime]
// Dos diferencias de BingX que hay que corregir:
//  1. devuelve objetos {open,close,high,low,volume,time}, no arrays;
//  2. viene en orden DESCENDENTE (la vela mas nueva primero), y el motor
//     asume ascendente con la vela en curso al final.
export async function getKlinesV3(symbol, interval, limit = MAX_VELAS_BINGX) {
  const n = Math.min(limit, MAX_VELAS_BINGX)
  let data
  try {
    data = await json(
      `${BINGX}/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${interval}&limit=${n}`,
    )
  } catch {
    return null
  }
  if (!Array.isArray(data) || !data.length) return null
  const dur = MS_INTERVALO[interval] ?? 3_600_000
  const asc = [...data].sort((a, b) => a.time - b.time)
  return asc.map((k) => [
    Number(k.time),
    String(k.open),
    String(k.high),
    String(k.low),
    String(k.close),
    String(k.volume),
    Number(k.time) + dur - 1,
  ])
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
