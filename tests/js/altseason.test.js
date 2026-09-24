import { beforeEach, describe, expect, it, vi } from 'vitest'

// La red se mockea entera: obtenerAltseason solo habla con binanceApi.js /
// rateLimit.js, asi se prueba el armado del universo y el calculo sin Binance.
const velas = new Map()
vi.mock('../../src/lib/crypto/binanceApi.js', () => ({
  BINANCE: 'https://fapi.binance.com',
  getExchangeInfo: vi.fn(async () => ({ symbols: [] })),
  contratosOperables: vi.fn(() => universoFalso.map((s) => ({ symbol: s.symbol, baseAsset: s.base }))),
  getKlines: vi.fn(async (symbol) => velas.get(symbol) ?? []),
  sleep: vi.fn(async () => {}),
}))
vi.mock('../../src/lib/crypto/rateLimit.js', () => ({
  pedirJsonBinance: vi.fn(async () => universoFalso.map((s) => ({ symbol: s.symbol, quoteVolume: String(s.vol) }))),
}))

const { calcularIndice, clasificarAltseason, obtenerAltseason, retornoCerrado, UMBRAL_ALTSEASON, UMBRAL_BTC } =
  await import('../../src/lib/crypto/altseason.js')

let universoFalso = []

// klines diarias: [openTime, open, high, low, close, volume, closeTime]; la
// ultima es la vela en curso (se descarta).
function klines(cierres, enCurso = 999) {
  const dia = 86400000
  return [...cierres, enCurso].map((c, i) => [i * dia, c, c, c, c, 1, (i + 1) * dia - 1])
}

describe('retornoCerrado', () => {
  it('usa solo velas cerradas: D dias hacia atras desde la ultima cerrada', () => {
    // 3 cerradas + la en curso; D = 2: 110 / 100 - 1
    expect(retornoCerrado(klines([100, 105, 110], 5000), 2)).toBeCloseTo(0.1)
  })
  it('sin historial suficiente o precio 0 -> null', () => {
    expect(retornoCerrado(klines([100, 110]), 2)).toBeNull()
    expect(retornoCerrado(null, 2)).toBeNull()
    expect(retornoCerrado(klines([0, 5, 10]), 2)).toBeNull()
  })
})

describe('calcularIndice', () => {
  const alts = (rets) => rets.map((ret, i) => ({ symbol: `A${i}USDT`, ret }))

  it('% de alts que le ganaron a BTC sobre las que tienen historial', () => {
    const r = calcularIndice(0.05, alts([0.1, 0.2, 0.06, 0.01, -0.1, 0.0, 0.03, 0.04, 0.5, 0.051, null, null]))
    expect(r).toEqual({ pct: 50, ganaron: 5, n: 10, sinHistorial: 2 })
  })
  it('empatar con BTC no cuenta como ganarle', () => {
    expect(calcularIndice(0.05, alts(Array(10).fill(0.05))).ganaron).toBe(0)
  })
  it('menos de 10 validos o sin BTC -> null', () => {
    expect(calcularIndice(0.05, alts(Array(9).fill(0.1)))).toBeNull()
    expect(calcularIndice(null, alts(Array(20).fill(0.1)))).toBeNull()
  })
})

it('clasificarAltseason', () => {
  expect(clasificarAltseason(null)).toBeNull()
  expect(clasificarAltseason(UMBRAL_ALTSEASON)).toBe('Temporada de altcoins')
  expect(clasificarAltseason(UMBRAL_BTC)).toBe('Temporada de Bitcoin')
  expect(clasificarAltseason(50)).toBe('Mixto')
})

describe('obtenerAltseason (red mockeada)', () => {
  beforeEach(() => {
    velas.clear()
    // BTC sube 10% en 2 dias; 12 alts: la mitad sube 20%, la otra mitad 0%.
    universoFalso = [
      { symbol: 'BTCUSDT', base: 'BTC', vol: 9e12 },
      { symbol: 'USDCUSDT', base: 'USDC', vol: 8e12 }, // stablecoin: afuera
      { symbol: 'PAXGUSDT', base: 'PAXG', vol: 7e12 }, // oro: afuera
      ...Array.from({ length: 12 }, (_, i) => ({ symbol: `ALT${i}USDT`, base: `ALT${i}`, vol: 1e9 - i })),
      { symbol: 'CHICAUSDT', base: 'CHICA', vol: 1 }, // fuera del top N por volumen
    ]
    velas.set('BTCUSDT', klines([100, 105, 110]))
    universoFalso.slice(3, 15).forEach((s, i) => velas.set(s.symbol, klines(i % 2 ? [100, 100, 100] : [100, 110, 120])))
  })

  it('arma el universo (top N por volumen, sin BTC/stables/oro) y calcula', async () => {
    const r = await obtenerAltseason({ n: 12, dias: 2 })
    expect(r.n).toBe(12)
    expect(r.ganaron).toBe(6)
    expect(r.pct).toBe(50)
    expect(r.retornoBtc).toBeCloseTo(10)
    expect(r.mejores[0].ret).toBeCloseTo(20)
    expect(r.peores[0].ret).toBeCloseTo(0)
    expect([...r.mejores, ...r.peores].some((a) => ['USDCUSDT', 'PAXGUSDT', 'CHICAUSDT'].includes(a.symbol))).toBe(false)
  })

  it('sin velas de BTC tira error', async () => {
    velas.delete('BTCUSDT')
    await expect(obtenerAltseason({ n: 12, dias: 2 })).rejects.toThrow(/BTCUSDT/)
  })
})
