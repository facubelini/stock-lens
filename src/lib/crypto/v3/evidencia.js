// Mide qué hizo históricamente cada señal, con el SL/TP real.
//
// El v1 te dice "SHORT FUERTE" y no te dice nada más. Acá, para cada señal, se
// recorre la historia del símbolo, se encuentran todas las veces que se dio esa
// MISMA señal, se simula el trade con el SL y el TP por ATR, y se cuenta cómo
// salió. Después se agrega entre todos los símbolos del escaneo para tener una
// muestra grande.
//
// Todo se calcula con las velas que el escaneo ya bajó: no cuesta ni un pedido
// extra de red, solo CPU.
import { armarSeries, aportesEn } from './series.js'
import { crucesEn, CRUCE_POR_ID } from './cruces.js'

// Costo de ida y vuelta: 0,08% de comisión taker + ~0,04% de funding a 1-2
// días. Medido y discutido: por debajo de esto una señal no es operable.
export const COSTO_IDA_VUELTA = 0.0012

export const CONFIG_DEFECTO = {
  atrMult: 2, // distancia del stop, en ATR
  R: 2, // el TP está a R veces la distancia del stop
  maxVelas: 12, // si no toca ni SL ni TP, se sale a mercado
  minScore: 2, // |score| mínimo para considerar que hay señal
}

// Etiqueta de la señal. Igual que el v1 pero juntando EXTREMO con FUERTE,
// porque los extremos son demasiado raros para medirlos por separado.
export function bucketDe(score) {
  if (score <= -4) return 'SHORT FUERTE'
  if (score <= -2) return 'SHORT'
  if (score < 0) return 'SHORT DÉBIL'
  if (score >= 4) return 'LONG FUERTE'
  if (score >= 2) return 'LONG'
  if (score > 0) return 'LONG DÉBIL'
  return 'NEUTRAL'
}

// Simula un trade abierto en la vela i hacia la dirección dir, con el SL/TP
// por ATR. Devuelve el retorno neto de costos y en qué vela salió.
function simularTrade(s, i, dir, { atrMult, R, maxVelas }) {
  const entrada = s.closes[i]
  const sl = entrada - dir * s.atr[i] * atrMult
  const tp = entrada + dir * s.atr[i] * atrMult * R
  for (let j = i + 1; j <= i + maxVelas && j < s.n; j++) {
    const tocaSL = dir > 0 ? s.lows[j] <= sl : s.highs[j] >= sl
    const tocaTP = dir > 0 ? s.highs[j] >= tp : s.lows[j] <= tp
    // Si en la misma vela toca los dos no se sabe cuál fue primero: se asume
    // el peor caso (SL). Suponer lo contrario infla el backtest.
    if (tocaSL) return { ret: (dir * (sl - entrada)) / entrada - COSTO_IDA_VUELTA, salida: j, motivo: 'stop' }
    if (tocaTP) return { ret: (dir * (tp - entrada)) / entrada - COSTO_IDA_VUELTA, salida: j, motivo: 'objetivo' }
  }
  const fin = Math.min(i + maxVelas, s.n - 1)
  return { ret: (dir * (s.closes[fin] - entrada)) / entrada - COSTO_IDA_VUELTA, salida: fin, motivo: 'tiempo' }
}

// Trades disparados por CRUCES de indicadores. Cada tipo de cruce lleva su
// propia cuenta de solapamiento: dentro de un mismo tipo no se abre un trade
// nuevo hasta que cerró el anterior, pero dos tipos distintos pueden estar
// abiertos a la vez (son estrategias separadas, se miden por separado).
export function simularCruces(series, cfg = CONFIG_DEFECTO) {
  const s = series
  const trades = []
  const libre = new Map()
  for (let i = 221; i < s.n - cfg.maxVelas - 1; i++) {
    if (isNaN(s.atr[i]) || isNaN(s.ema200[i])) continue
    for (const id of crucesEn(i, s)) {
      if (i < (libre.get(id) ?? -1)) continue
      const dir = CRUCE_POR_ID.get(id).dir
      const r = simularTrade(s, i, dir, cfg)
      libre.set(id, r.salida)
      trades.push({ i, dir, bucket: id, ret: r.ret, motivo: r.motivo })
    }
  }
  return trades
}

// Recorre la historia de un símbolo y devuelve un trade por cada señal.
// No se abren trades solapados: hasta que no cierra uno no se abre el próximo,
// igual que operarías de verdad.
export function simularHistoria(series, cfg = CONFIG_DEFECTO) {
  const { atrMult, R, maxVelas, minScore } = cfg
  const s = series
  const trades = []
  let libreEn = -1
  for (let i = 220; i < s.n - maxVelas - 1; i++) {
    if (i < libreEn) continue
    if (isNaN(s.ema200[i]) || isNaN(s.macdCur[i]) || isNaN(s.atr[i]) || isNaN(s.srsi[i])) continue
    const a = aportesEn(i, s)
    if (Math.abs(a.total) < minScore) continue
    const dir = Math.sign(a.total)
    const entrada = s.closes[i]
    const sl = entrada - dir * s.atr[i] * atrMult
    const tp = entrada + dir * s.atr[i] * atrMult * R
    let bruto = null
    let salida = i + maxVelas
    let motivo = 'tiempo'
    for (let j = i + 1; j <= i + maxVelas; j++) {
      const tocaSL = dir > 0 ? s.lows[j] <= sl : s.highs[j] >= sl
      const tocaTP = dir > 0 ? s.highs[j] >= tp : s.lows[j] <= tp
      // Si en la misma vela toca los dos no se sabe cuál fue primero: se
      // asume el peor caso (SL). Suponer lo contrario infla el backtest.
      if (tocaSL) {
        bruto = (dir * (sl - entrada)) / entrada
        salida = j
        motivo = 'stop'
        break
      }
      if (tocaTP) {
        bruto = (dir * (tp - entrada)) / entrada
        salida = j
        motivo = 'objetivo'
        break
      }
    }
    if (bruto === null) bruto = (dir * (s.closes[i + maxVelas] - entrada)) / entrada
    libreEn = salida
    trades.push({ i, dir, bucket: bucketDe(a.total), ret: bruto - COSTO_IDA_VUELTA, motivo })
  }
  return trades
}

// Estadística de un conjunto de trades, con el chequeo de estabilidad.
export function resumir(trades) {
  if (!trades.length) return null
  const rets = trades.map((t) => t.ret)
  const n = rets.length
  const media = rets.reduce((a, b) => a + b, 0) / n
  const ganadores = rets.filter((r) => r > 0).length
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - media) ** 2, 0) / Math.max(1, n - 1))
  const t = sd > 0 ? media / (sd / Math.sqrt(n)) : NaN

  // Estabilidad: se parte en 4 tramos temporales y se mira si la expectativa es
  // positiva en todos. Una señal que solo funciona en un tramo no es una
  // ventaja, es un régimen de mercado.
  //
  // Los tramos se cortan sobre el rango donde REALMENTE hay trades, no sobre la
  // historia completa: los primeros 220 índices no tienen ninguno (hace falta
  // esa cantidad de velas para que exista la EMA200), y partir por la historia
  // entera dejaba el primer cuarto vacío y el test se quedaba en 3 tramos.
  // Con un solo bucle, no con Math.min(...idx): el spread de un array de más
  // de ~100k elementos revienta el stack (medido: falla en 130.000, y la
  // agregación de cruces sobre 200 símbolos llega a ese orden).
  let desde = Infinity
  let hasta = -Infinity
  for (const tr of trades) {
    if (tr.i < desde) desde = tr.i
    if (tr.i > hasta) hasta = tr.i
  }
  hasta += 1
  const corte = Math.max(1, (hasta - desde) / 4)
  const tramos = [[], [], [], []]
  for (const tr of trades) tramos[Math.min(3, Math.floor((tr.i - desde) / corte))].push(tr.ret)
  const mediasTramo = tramos.map((x) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : null))
  const conDatos = mediasTramo.filter((x) => x != null)
  const positivos = conDatos.filter((x) => x > 0).length

  return {
    n,
    aciertos: (ganadores / n) * 100,
    expectativa: media,
    t,
    porObjetivo: (trades.filter((x) => x.motivo === 'objetivo').length / n) * 100,
    porStop: (trades.filter((x) => x.motivo === 'stop').length / n) * 100,
    mediasTramo,
    tramosPositivos: positivos,
    tramosConDatos: conDatos.length,
  }
}

// Veredicto legible a partir del resumen. Deliberadamente exigente: por
// defecto una señal NO tiene respaldo.
export function veredicto(r) {
  if (!r || r.n < 30) return { nivel: 'sin-datos', texto: 'Sin muestra suficiente' }
  if (r.tramosConDatos >= 3 && r.tramosPositivos === r.tramosConDatos && r.expectativa > 0)
    return { nivel: 'respaldada', texto: `Positiva en los ${r.tramosConDatos} tramos` }
  if (r.expectativa > 0 && r.tramosPositivos >= Math.ceil(r.tramosConDatos / 2))
    return { nivel: 'dudosa', texto: `Positiva en ${r.tramosPositivos} de ${r.tramosConDatos} tramos` }
  if (r.expectativa > 0) return { nivel: 'dudosa', texto: `Inestable (${r.tramosPositivos}/${r.tramosConDatos} tramos)` }
  return { nivel: 'sin-respaldo', texto: 'Expectativa negativa' }
}

// Procesa un símbolo entero: series + evidencia + señal actual.
export function analizarSimbolo(klines, cfg = CONFIG_DEFECTO) {
  if (!klines || klines.length < 260) return null
  const cerradas = klines.slice(0, -1)
  const s = armarSeries(cerradas)
  const i = s.n - 1
  if (isNaN(s.ema200[i]) || isNaN(s.macdCur[i]) || isNaN(s.srsi[i])) return null
  const a = aportesEn(i, s)
  const trades = simularHistoria(s, cfg)
  return {
    // Cruces que ocurrieron en la ÚLTIMA vela cerrada: son los que estarían
    // dando entrada ahora.
    crucesAhora: crucesEn(i, s),
    tradesCruces: simularCruces(s, cfg),
    score: a.total,
    aportes: a,
    bucket: bucketDe(a.total),
    precioSenal: s.closes[i],
    precioVivo: +klines[klines.length - 1][4],
    atrPct: isNaN(s.atr[i]) ? null : (s.atr[i] / s.closes[i]) * 100,
    rsi: s.rsi[i],
    trades,
    totalVelas: s.n,
    // evidencia SOLO de este símbolo (muestra chica, es referencia)
    propia: resumir(trades.filter((t) => t.bucket === bucketDe(a.total))),
  }
}
