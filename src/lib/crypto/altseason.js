// Altseason Index calculado en el navegador, directo contra Binance.
//
// Antes salia de crypto_historial.json, que escribia un workflow de GitHub
// Actions. Ese workflow nunca anduvo (Binance responde 451 a los runners de
// EEUU: 1 corrida buena de 155), asi que el historial quedo con 3 entradas y
// el indice quedo en null para siempre mientras la UI decia "esperando
// historial". Desde el browser del usuario (Argentina) fapi responde bien.
//
// FORMULA
//   universo = los N perpetuos USDT con mas volumen negociado en 24h, sin BTC,
//              sin stablecoins y sin tokens de oro
//   ret(x)   = cierre(x, hoy−1) / cierre(x, hoy−1−D) − 1
//              (velas DIARIAS CERRADAS; la de hoy, a medio hacer, no entra)
//   indice   = 100 × #{x : ret(x) > ret(BTC)} / #{x con D+1 velas cerradas}
// CRITERIO (umbrales convencionales, los de blockchaincenter.net):
//   >= 75  temporada de altcoins · <= 25  temporada de Bitcoin · en el medio, mixto
// Diferencia con el indice "oficial": ese usa el top 50 por market cap y 90
// dias; aca es el top por volumen de futuros y 30 dias (Binance no da market
// cap), asi que es un proxy de la rotacion, no el mismo numero.
//
// COSTO: ticker/24hr (peso 40) + exchangeInfo (1, cacheado) + N+1 pedidos de
// klines con limit <= 100 (peso 1 cada uno) ≈ 92 de los 2400 por minuto.
import { BINANCE, getExchangeInfo, contratosOperables, getKlines, sleep } from './binanceApi.js'
import { pedirJsonBinance } from './rateLimit.js'

export const N_ALTS = 50
export const DIAS = 30
export const UMBRAL_ALTSEASON = 75
export const UMBRAL_BTC = 25

// Stablecoins y tokens atados a un activo fijo: "le ganan" o "le pierden" a
// BTC por construccion, no por rotacion.
const EXCLUIDOS = new Set([
  'BTC', 'USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USDE', 'PYUSD', 'RLUSD',
  'USD1', 'EUR', 'EURI', 'AEUR', 'PAXG', 'XAUT', 'BTCDOM', 'WBTC',
])

const LOTE = 10
const PAUSA_MS = 150

// Retorno de D dias sobre velas diarias CERRADAS. klines trae D+2 velas: las
// D+1 cerradas y la de hoy (en curso), que se descarta.
export function retornoCerrado(klines, dias = DIAS) {
  if (!klines || klines.length < dias + 2) return null
  const cerradas = klines.slice(0, -1)
  const fin = +cerradas[cerradas.length - 1][4]
  const ini = +cerradas[cerradas.length - 1 - dias][4]
  if (!ini || !fin) return null
  return fin / ini - 1
}

// Parte pura del calculo (testeable sin red).
// alts: Array<{ symbol, ret }> con ret ya calculado (null = sin historial).
export function calcularIndice(retBtc, alts) {
  const validos = alts.filter((a) => a.ret != null)
  if (retBtc == null || validos.length < 10) return null
  const ganaron = validos.filter((a) => a.ret > retBtc)
  return {
    pct: Math.round((ganaron.length / validos.length) * 100),
    ganaron: ganaron.length,
    n: validos.length,
    sinHistorial: alts.length - validos.length,
  }
}

export function clasificarAltseason(pct) {
  if (pct == null) return null
  if (pct >= UMBRAL_ALTSEASON) return 'Temporada de altcoins'
  if (pct <= UMBRAL_BTC) return 'Temporada de Bitcoin'
  return 'Mixto'
}

// Trae todo de Binance y calcula. Devuelve el indice + el detalle para
// mostrarlo (mejores/peores, retorno de BTC, ventana usada, cuanto tardo).
export async function obtenerAltseason({ n = N_ALTS, dias = DIAS, signal } = {}) {
  const t0 = Date.now()
  const [info, tickers] = await Promise.all([
    getExchangeInfo(),
    pedirJsonBinance(`${BINANCE}/fapi/v1/ticker/24hr`, { signal }),
  ])
  const perpetuos = new Map(contratosOperables(info, 'PERPETUAL').map((s) => [s.symbol, s.baseAsset]))
  const universo = tickers
    .filter((t) => perpetuos.has(t.symbol) && !EXCLUIDOS.has(perpetuos.get(t.symbol)))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, n)
    .map((t) => t.symbol)

  const limite = dias + 2
  const kBtc = await getKlines('BTCUSDT', '1d', limite, { signal })
  const retBtc = retornoCerrado(kBtc, dias)
  if (retBtc == null) throw new Error('No se pudieron traer las velas diarias de BTCUSDT.')

  const alts = []
  for (let i = 0; i < universo.length; i += LOTE) {
    const lote = universo.slice(i, i + LOTE)
    const parciales = await Promise.all(
      lote.map(async (symbol) => ({ symbol, ret: retornoCerrado(await getKlines(symbol, '1d', limite, { signal }), dias) })),
    )
    alts.push(...parciales)
    if (i + LOTE < universo.length) await sleep(PAUSA_MS)
  }

  const indice = calcularIndice(retBtc, alts)
  if (!indice) throw new Error('Muy pocos perpetuos con 30 días de historial para calcular el índice.')
  const ordenados = alts.filter((a) => a.ret != null).sort((a, b) => b.ret - a.ret)
  // Fecha del ultimo cierre usado (la vela diaria de Binance cierra 00:00 UTC).
  const cerradasBtc = kBtc.slice(0, -1)
  return {
    ...indice,
    retornoBtc: retBtc * 100,
    dias,
    desde: +cerradasBtc[cerradasBtc.length - 1 - dias][6] + 1,
    hasta: +cerradasBtc[cerradasBtc.length - 1][6] + 1,
    mejores: ordenados.slice(0, 3).map((a) => ({ symbol: a.symbol, ret: a.ret * 100 })),
    peores: ordenados.slice(-3).reverse().map((a) => ({ symbol: a.symbol, ret: a.ret * 100 })),
    calculadoEn: Date.now(),
    duracionMs: Date.now() - t0,
  }
}

// ── Cache ~1h (memoria + sessionStorage) ─────────────────────────────────
// El indice sale de velas DIARIAS cerradas: no cambia en toda la hora, asi
// que no tiene sentido pegarle a Binance cada vez que se abre Macro.
export const TTL_ALTSEASON_MS = 60 * 60 * 1000
const CLAVE = 'stocklens.altseason.v1'
let enMemoria = null

export function leerCacheAltseason() {
  const vigente = (d) => d && Date.now() - d.calculadoEn < TTL_ALTSEASON_MS
  if (vigente(enMemoria)) return enMemoria
  try {
    const d = JSON.parse(globalThis.sessionStorage?.getItem(CLAVE) ?? 'null')
    if (vigente(d)) return (enMemoria = d)
  } catch {
    // sessionStorage bloqueado o corrupto: se recalcula.
  }
  return null
}

export function guardarCacheAltseason(d) {
  enMemoria = d
  try {
    globalThis.sessionStorage?.setItem(CLAVE, JSON.stringify(d))
  } catch {
    // Sin sessionStorage queda solo en memoria.
  }
}
