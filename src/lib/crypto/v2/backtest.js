// Backtest walk-forward, corre en el browser sobre las velas que ya trajo el
// escaneo (cero requests extra).
//
// Por que existe: no habia forma de saber la tasa de acierto de la v1, asi que
// cualquier cambio era a ciegas. Para acciones ya existe backtest_screener.json
// y su pestania; para cripto no habia nada equivalente.
//
// GARANTIAS CONTRA LOOKAHEAD (lo que hace que el numero valga algo):
//  1. Todas las series son causales: series[i] usa solo velas 0..i.
//  2. La vela en curso se descarta antes de todo (velasCerradas).
//  3. La decision se toma al CIERRE de la vela i y la entrada es a la
//     APERTURA de la vela i+1 — nunca al cierre de la misma vela que genero
//     la señal.
//  4. La tendencia de la temporalidad superior en el momento i usa solo velas
//     superiores YA CERRADAS a esa altura (mapaTendencia).
//  5. Si en una misma vela se tocan SL y TP, se asume SL (pesimista).
//
// APROXIMACION DECLARADA: el costo de funding usa el funding ACTUAL del
// simbolo como constante historica (el historial de funding no viene en las
// klines y pedirlo serian ~1000 filas extra por simbolo). Sirve para ordenar
// y comparar reglas, no como P&L exacto.

import { evaluarSetup, tendenciaEn, MINUTOS_INTERVALO } from './senal'
import { BT_MAX_VELAS_EN_TRADE, FEE_TAKER_PCT, FRACCION_TRAIN } from './config'

// Para cada vela i de entrada, el indice de la ultima vela superior cerrada a
// esa altura. Recorrido lineal con puntero (las dos series estan ordenadas).
export function mapaTendencia(sE, sT) {
  const mapa = new Array(sE.n).fill(-1)
  let j = -1
  for (let i = 0; i < sE.n; i++) {
    const limite = sE.tsCierre[i]
    while (j + 1 < sT.n && sT.tsCierre[j + 1] <= limite) j++
    mapa[i] = j
  }
  return mapa
}

// ── Regla del v2: confluencia + tendencia superior ─────────────────────────
export function reglaV2(sE, i, tendencia, opciones) {
  const ev = evaluarSetup(sE, i, tendencia, opciones)
  if (!ev) return null
  if (ev.veredicto === 'COMPRA') return { dir: 'LONG' }
  if (ev.veredicto === 'VENTA') return { dir: 'SHORT' }
  return null
}

// ── Benchmark: solo tendencia, sin ningun filtro de momentum ──────────────
// Es el PISO que cualquier filtro tiene que superar. Si la confluencia no le
// gana a "estar en la direccion de la tendencia y nada mas", entonces los
// filtros de RSI/MACD/StochRSI no aportan informacion.
export function reglaSoloTendencia(sE, i, tendencia) {
  if (tendencia === 'ALCISTA') return { dir: 'LONG' }
  if (tendencia === 'BAJISTA') return { dir: 'SHORT' }
  return null
}

// ── Regla de la v1: score aditivo ──────────────────────────────────────────
// Reimplementacion de la suma de analyzeKlines evaluable en cualquier vela,
// para poder correr las dos reglas sobre EXACTAMENTE los mismos datos. Es una
// comparacion de REGLA DE DECISION (aditiva vs confluencia): la v1 en
// produccion arranca aun mas atras porque ademas incluye la vela en curso y
// su "EMA200" es el promedio simple de la ventana.
export function reglaV1(sE, i) {
  const rsi = sE.rsi[i]
  const srsi = sE.srsi[i]
  const hist = sE.macdHist[i]
  const histPrev = sE.macdHist[i - 1]
  const bb = sE.bbPct[i]
  const e20 = sE.ema20[i]
  const e50 = sE.ema50[i]
  const e200 = sE.ema200[i]
  const precio = sE.cierres[i]
  const vol = sE.volRatio[i]
  if ([rsi, srsi, hist, histPrev, bb, precio].some((v) => v == null || isNaN(v))) return null

  let score = 0
  if (rsi >= 80) score -= 2
  else if (rsi >= 70) score -= 1
  else if (rsi <= 20) score += 2
  else if (rsi <= 30) score += 1

  if (!isNaN(srsi)) {
    if (srsi >= 90) score -= 2
    else if (srsi >= 80) score -= 1
    else if (srsi <= 10) score += 2
    else if (srsi <= 20) score += 1
  }

  if (hist < 0 && histPrev >= 0) score -= 2
  else if (hist > 0 && histPrev <= 0) score += 2
  else if (hist < 0 && hist < histPrev) score -= 1
  else if (hist > 0 && hist > histPrev) score += 1
  else if (hist < 0) score -= 0.5
  else score += 0.5

  if (bb > 100) score -= 1
  else if (bb > 90) score -= 0.5
  else if (bb < 0) score += 1
  else if (bb < 10) score += 0.5

  if (!isNaN(e20) && !isNaN(e50) && !isNaN(e200)) {
    if (precio < e20 && e20 < e50 && e50 < e200) score -= 2
    else if (precio > e20 && e20 > e50 && e50 > e200) score += 2
    else if (precio < e200 && precio < e50) score -= 1
    else if (precio > e200 && precio > e50) score += 1
    else if (precio < e200) score -= 0.5
    else score += 0.5
  }

  if (!isNaN(vol) && vol >= 2 && score <= -2) score -= 1
  if (!isNaN(vol) && vol >= 2 && score >= 2) score += 1

  // La v1 marca operable desde |score| >= 2 ('SHORT' / 'LONG').
  if (score <= -2) return { dir: 'SHORT', score }
  if (score >= 2) return { dir: 'LONG', score }
  return null
}

// ── Simulacion de una regla sobre un simbolo ───────────────────────────────
export function simular({
  sE,
  sT,
  mapa,
  regla,
  intervaloEntrada,
  atrMult = 2,
  feePct = FEE_TAKER_PCT,
  fundingPct = 0,
  rMultiploTP = 2,
  maxVelas = BT_MAX_VELAS_EN_TRADE,
  opcionesSetup = {},
  desde = 0,
  hasta = null,
}) {
  const trades = []
  const minutosVela = MINUTOS_INTERVALO[intervaloEntrada] ?? 60
  // Warmup: hace falta EMA200 + margen para StochRSI/MACD.
  const tope = Math.min(hasta ?? sE.n - 2, sE.n - 2)
  let i = Math.max(desde, 210)

  while (i < tope) {
    const j = mapa[i]
    const tendencia = j >= 0 ? tendenciaEn(sT, j) : 'N/D'
    const señal =
      regla === reglaV1
        ? reglaV1(sE, i)
        : regla === reglaSoloTendencia
          ? reglaSoloTendencia(sE, i, tendencia)
          : regla(sE, i, tendencia, { fundingPct, ...opcionesSetup })

    if (!señal) {
      i++
      continue
    }

    const atr = sE.atr[i]
    if (isNaN(atr) || atr <= 0) {
      i++
      continue
    }

    // Entrada a la apertura de la vela SIGUIENTE a la señal.
    const entrada = sE.apertura[i + 1]
    const esLong = señal.dir === 'LONG'
    const slDist = atr * atrMult
    const sl = esLong ? entrada - slDist : entrada + slDist
    const tp = esLong ? entrada + slDist * rMultiploTP : entrada - slDist * rMultiploTP
    const riesgoPct = (slDist / entrada) * 100

    let salida = null
    let motivoSalida = null
    let velasEnTrade = 0
    const hasta = Math.min(i + 1 + maxVelas, sE.n - 1)

    for (let k = i + 1; k <= hasta; k++) {
      velasEnTrade = k - i
      const tocaSL = esLong ? sE.bajos[k] <= sl : sE.altos[k] >= sl
      const tocaTP = esLong ? sE.altos[k] >= tp : sE.bajos[k] <= tp
      // Pesimista: si en la misma vela se tocan los dos, gana el stop.
      if (tocaSL) {
        salida = sl
        motivoSalida = 'SL'
        break
      }
      if (tocaTP) {
        salida = tp
        motivoSalida = 'TP'
        break
      }
    }
    if (salida == null) {
      salida = sE.cierres[hasta]
      motivoSalida = 'timeout'
      velasEnTrade = hasta - i
    }

    const brutoPct = esLong
      ? ((salida - entrada) / entrada) * 100
      : ((entrada - salida) / entrada) * 100
    const horas = (minutosVela * velasEnTrade) / 60
    const costoFunding = (esLong ? 1 : -1) * (fundingPct ?? 0) * (horas / 8)
    const costoPct = 2 * feePct + costoFunding
    const netoPct = brutoPct - costoPct
    const r = riesgoPct > 0 ? netoPct / riesgoPct : 0

    trades.push({
      i,
      dir: señal.dir,
      entrada,
      salida,
      motivoSalida,
      velasEnTrade,
      brutoPct: +brutoPct.toFixed(3),
      costoPct: +costoPct.toFixed(3),
      netoPct: +netoPct.toFixed(3),
      r: +r.toFixed(3),
      gano: netoPct > 0,
      ts: sE.tsApertura[i + 1],
    })

    // Sin trades solapados: se retoma despues de que cerro la posicion.
    i = i + velasEnTrade + 1
  }

  return trades
}

// ── Estadisticas ──────────────────────────────────────────────────────────
export function estadisticas(trades) {
  const n = trades.length
  if (!n) {
    return { trades: 0, aciertos: 0, tasaAcierto: null, rPromedio: null, expectativa: null, profitFactor: null, rTotal: 0, maxDD: 0, porSalida: {} }
  }
  const ganadores = trades.filter((t) => t.gano)
  const sumaR = trades.reduce((s, t) => s + t.r, 0)
  const ganancias = trades.filter((t) => t.netoPct > 0).reduce((s, t) => s + t.netoPct, 0)
  const perdidas = Math.abs(trades.filter((t) => t.netoPct < 0).reduce((s, t) => s + t.netoPct, 0))

  // Drawdown maximo sobre la curva acumulada en R.
  let acum = 0
  let pico = 0
  let maxDD = 0
  for (const t of trades) {
    acum += t.r
    if (acum > pico) pico = acum
    const dd = pico - acum
    if (dd > maxDD) maxDD = dd
  }

  const porSalida = {}
  for (const t of trades) porSalida[t.motivoSalida] = (porSalida[t.motivoSalida] ?? 0) + 1

  return {
    trades: n,
    aciertos: ganadores.length,
    tasaAcierto: +((ganadores.length / n) * 100).toFixed(1),
    rPromedio: +(sumaR / n).toFixed(3),
    expectativa: +(sumaR / n).toFixed(3), // R esperado por trade
    profitFactor: perdidas === 0 ? null : +(ganancias / perdidas).toFixed(2),
    rTotal: +sumaR.toFixed(2),
    maxDD: +maxDD.toFixed(2),
    porSalida,
  }
}

// Corre las 3 reglas sobre el mismo simbolo, separando TRAIN y TEST.
// El corte es por INDICE de vela, o sea temporal: train = la parte vieja de
// la ventana, test = la parte reciente que la eleccion de parametros no vio.
export function backtestSimbolo({ sE, sT, intervaloEntrada, atrMult, feePct, fundingPct, rMultiploTP }) {
  const mapa = mapaTendencia(sE, sT)
  const corte = Math.floor(sE.n * FRACCION_TRAIN)
  const comun = { sE, sT, mapa, intervaloEntrada, atrMult, feePct, fundingPct, rMultiploTP }
  const reglas = { v2: reglaV2, v1: reglaV1, piso: reglaSoloTendencia }
  const out = {}
  for (const [nombre, regla] of Object.entries(reglas)) {
    out[nombre] = {
      train: simular({ ...comun, regla, desde: 0, hasta: corte }),
      test: simular({ ...comun, regla, desde: corte, hasta: null }),
    }
  }
  return out
}
