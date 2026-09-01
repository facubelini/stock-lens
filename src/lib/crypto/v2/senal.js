// Motor de señal del v2.
//
// Diferencia de fondo con la v1: la v1 SUMA señales de reversion a la media
// (RSI sobrecomprado => short, precio sobre la banda de Bollinger => short)
// con señales de tendencia (EMAs alineadas al alza => +2). Esas dos familias
// se cancelan: una alcista fuerte y extendida daba RSI 75 (-1) + StochRSI 85
// (-1) + MACD subiendo (+1) + BB 105% (-1) + EMA alcista completo (+2) = 0,
// o sea NEUTRAL justo donde la tendencia funciona; y un cuchillo cayendo daba
// +1,5, o sea LONG DEBIL abajo de todas sus medias.
//
// El v2 elige una sola estrategia — PULLBACK DENTRO DE TENDENCIA — y en vez
// de sumar EXIGE confluencia: la direccion la manda la tendencia de la
// temporalidad superior, y todas las condiciones de momentum tienen que dar
// a la vez. Mismo vocabulario de veredictos que el Screener de acciones.

import {
  TOL_ASL,
  TOL_CLAVE,
  TOL_EXTENSION,
  NEAR_FACTOR,
  RSI_BULL,
  RSI_BEAR,
  SRSI_TECHO_LONG,
  SRSI_PISO_SHORT,
  FUNDING_ALERTA_PCT,
  FEE_TAKER_PCT,
} from './config.js'

export const MINUTOS_INTERVALO = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 }

const dist = (precio, ref) => ((precio - ref) / ref) * 100

// ── Tendencia de la temporalidad superior ──────────────────────────────────
// Si no hay EMA200 (simbolo recien listado) devuelve 'N/D' y el simbolo NO se
// opera. La v1 en ese caso mostraba 'BAJISTA' fijo, porque evaluaba
// `!isNaN(ema200) && price > ema200` y el NaN caia al lado bajista — afecta al
// 6% de los perpetuos (31 de 525) y a muchos mas en temporalidad diaria.
export function tendenciaEn(s, i) {
  const c = s.cierres[i]
  const e50 = s.ema50[i]
  const e200 = s.ema200[i]
  if (isNaN(e200) || isNaN(e50)) return 'N/D'
  if (c > e200 && e50 > e200) return 'ALCISTA'
  if (c < e200 && e50 < e200) return 'BAJISTA'
  return 'RANGO'
}

// ── Costos reales de la operacion ──────────────────────────────────────────
// La v1 mostraba TP1 a 1:1 sin descontar nada. Con comisiones taker ida y
// vuelta mas funding, un 1:1 nominal rinde bastante menos, y a apalancamiento
// alto la diferencia deja de ser cosmetica.
export function calcularCostos({ dir, fundingPct, minutosVela, velasEstimadas = 20, feePct = FEE_TAKER_PCT }) {
  const feeIdaVuelta = 2 * feePct
  const horas = (minutosVela * velasEstimadas) / 60
  const periodos = horas / 8 // el funding se cobra cada 8h
  // Funding positivo lo paga el long; negativo, el short.
  const fundingCosto = (dir === 'LONG' ? 1 : -1) * (fundingPct ?? 0) * periodos
  return {
    feeIdaVuelta: +feeIdaVuelta.toFixed(4),
    fundingCosto: +fundingCosto.toFixed(4),
    total: +(feeIdaVuelta + fundingCosto).toFixed(4),
    horas: +horas.toFixed(1),
  }
}

// ── Evaluacion del setup en la vela i ──────────────────────────────────────
// s        = series de la temporalidad de ENTRADA
// tendencia= veredicto de la temporalidad SUPERIOR en el mismo momento
// Devuelve null si no hay datos suficientes en esa vela.
export function evaluarSetup(s, i, tendencia, opciones = {}) {
  const { fundingPct = null, permitirRango = false } = opciones
  const precio = s.cierres[i]
  const clave = s.ema50[i]
  const asl = s.asl[i]
  const e20 = s.ema20[i]
  const rsi = s.rsi[i]
  const srsi = s.srsi[i]
  const srsiPrev = s.srsi[i - 1]
  const hist = s.macdHist[i]
  const histPrev = s.macdHist[i - 1]

  if ([precio, clave, asl, e20, rsi, srsi, srsiPrev, hist, histPrev].some((v) => v == null || isNaN(v))) {
    return null
  }

  if (tendencia === 'N/D') {
    return { dir: null, veredicto: 'SIN DATOS', motivos: ['sin EMA200: historial insuficiente'], conviccion: 0 }
  }
  if (tendencia === 'RANGO' && !permitirRango) {
    return {
      dir: null,
      veredicto: 'NEUTRAL',
      motivos: ['sin tendencia definida en la temporalidad superior'],
      conviccion: 0,
    }
  }

  const esLong = tendencia === 'ALCISTA' || (tendencia === 'RANGO' && precio > clave)
  const dir = esLong ? 'LONG' : 'SHORT'

  // Condiciones de momentum: tienen que dar TODAS, no sumar.
  const cond = esLong
    ? [
        { ok: precio >= clave, txt: 'precio sobre EMA50', falla: 'precio bajo EMA50' },
        { ok: hist > 0, txt: 'MACD alcista', falla: 'MACD no alcista' },
        {
          ok: srsi > srsiPrev && srsi < SRSI_TECHO_LONG,
          txt: 'StochRSI girando al alza sin agotarse',
          falla: srsi >= SRSI_TECHO_LONG ? `StochRSI ${srsi.toFixed(0)} agotado` : 'StochRSI no gira al alza',
        },
        { ok: rsi >= RSI_BULL, txt: `RSI ${rsi.toFixed(0)}`, falla: `RSI ${rsi.toFixed(0)} debajo de ${RSI_BULL}` },
      ]
    : [
        { ok: precio <= clave, txt: 'precio bajo EMA50', falla: 'precio sobre EMA50' },
        { ok: hist < 0, txt: 'MACD bajista', falla: 'MACD no bajista' },
        {
          ok: srsi < srsiPrev && srsi > SRSI_PISO_SHORT,
          txt: 'StochRSI girando a la baja sin agotarse',
          falla: srsi <= SRSI_PISO_SHORT ? `StochRSI ${srsi.toFixed(0)} agotado` : 'StochRSI no gira a la baja',
        },
        { ok: rsi <= RSI_BEAR, txt: `RSI ${rsi.toFixed(0)}`, falla: `RSI ${rsi.toFixed(0)} arriba de ${RSI_BEAR}` },
      ]

  const cumplidas = cond.filter((c) => c.ok).length
  const todas = cumplidas === cond.length

  // Zona de pullback: cerca de la media clave O de la ASL. Extendido = lejos
  // de la EMA20, que es entrar tarde en el tramo.
  const dClave = Math.abs(dist(precio, clave))
  const dAsl = Math.abs(dist(precio, asl))
  const dE20 = Math.abs(dist(precio, e20))
  const enZona = dClave <= TOL_CLAVE || dAsl <= TOL_ASL
  const enZonaCerca = dClave <= TOL_CLAVE * NEAR_FACTOR || dAsl <= TOL_ASL * NEAR_FACTOR
  const extendido = dE20 > TOL_EXTENSION

  const motivos = []
  let veredicto
  if (todas && enZona && !extendido) {
    veredicto = esLong ? 'COMPRA' : 'VENTA'
    motivos.push(...cond.map((c) => c.txt))
    motivos.push(`en zona de pullback (EMA50 ${dClave.toFixed(1)}% · ASL ${dAsl.toFixed(1)}%)`)
  } else if (todas && extendido) {
    veredicto = 'EXTENDIDO'
    motivos.push('confluencia completa pero estirado')
    motivos.push(`${dE20.toFixed(1)}% sobre la EMA20 (max ${TOL_EXTENSION}%)`)
  } else if (cumplidas >= cond.length - 1 && enZonaCerca) {
    veredicto = 'CERCA'
    motivos.push(...cond.filter((c) => c.ok).map((c) => c.txt))
    motivos.push(...cond.filter((c) => !c.ok).map((c) => `falta: ${c.falla}`))
  } else {
    veredicto = 'NEUTRAL'
    motivos.push(...cond.filter((c) => !c.ok).map((c) => `falta: ${c.falla}`))
  }

  // Funding en contra: longs apiñados pagando funding alto es combustible de
  // squeeze. Degrada el veredicto en vez de ignorarlo (la v1 ni lo miraba en
  // el escaneo, solo lo mostraba en la ficha del simbolo).
  let fundingEnContra = false
  if (fundingPct != null) {
    const enContra = dir === 'LONG' ? fundingPct : -fundingPct
    if (enContra > FUNDING_ALERTA_PCT) {
      fundingEnContra = true
      motivos.push(`funding ${fundingPct > 0 ? '+' : ''}${fundingPct.toFixed(4)}% en contra`)
      if (veredicto === 'COMPRA' || veredicto === 'VENTA') veredicto = 'CERCA'
    }
  }

  // Conviccion 0-10, solo para ordenar la tabla — la señal es el veredicto,
  // no este numero (justamente el problema de la v1 era decidir por un score).
  let conviccion = cumplidas * 1.5 // 0-6
  if (enZona) conviccion += 2
  else if (enZonaCerca) conviccion += 1
  if (!extendido) conviccion += 1
  if (tendencia !== 'RANGO') conviccion += 1
  if (fundingEnContra) conviccion -= 1.5
  conviccion = Math.max(0, Math.min(10, conviccion))

  return {
    dir,
    veredicto,
    motivos,
    conviccion: +conviccion.toFixed(1),
    cumplidas,
    totalCond: cond.length,
    enZona,
    extendido,
    distClave: +dist(precio, clave).toFixed(2),
    distAsl: +dist(precio, asl).toFixed(2),
    distE20: +dist(precio, e20).toFixed(2),
    fundingEnContra,
  }
}

// Mapea el veredicto a las clases de color/insignia que ya usa la app, para
// poder reusar Insignia y la calculadora de apalancamiento sin tocarlas.
export function clsDeVeredicto(veredicto, dir) {
  if (veredicto === 'COMPRA') return 'lf'
  if (veredicto === 'VENTA') return 'sf'
  if (veredicto === 'CERCA') return dir === 'LONG' ? 'lo' : 'sh'
  if (veredicto === 'EXTENDIDO') return dir === 'LONG' ? 'lw' : 'sw'
  return 'n'
}

export const VEREDICTOS_OPERABLES = ['COMPRA', 'VENTA']

// ── Fila de la tabla ──────────────────────────────────────────────────────
// Incluye los campos que espera CalculadoraApalancamiento (price, chg24h,
// cls, signal, score, details, link) para poder reusarla tal cual.
export function armarFila({
  symbol,
  seriesEntrada,
  seriesTendencia,
  meta,
  intervaloEntrada,
  atrMult,
  feePct,
  rMultiploTP = 2,
}) {
  const sE = seriesEntrada
  const i = sE.n - 1
  if (i < 1) return null

  const j = sT_ultimoIndice(seriesTendencia)
  const tendencia = j == null ? 'N/D' : tendenciaEn(seriesTendencia, j)
  const fundingPct = meta?.fundingPct ?? null

  const ev = evaluarSetup(sE, i, tendencia, { fundingPct })
  if (!ev) return null

  const precio = sE.cierres[i]
  const atr = sE.atr[i]
  const cls = clsDeVeredicto(ev.veredicto, ev.dir)
  const costos = calcularCostos({
    dir: ev.dir ?? 'LONG',
    fundingPct,
    minutosVela: MINUTOS_INTERVALO[intervaloEntrada] ?? 60,
    feePct,
  })

  // SL/TP en ATR, y su version neta de costos.
  const slPct = isNaN(atr) ? null : +((atr * atrMult * 100) / precio).toFixed(2)
  const tp2Pct = slPct == null ? null : +(slPct * rMultiploTP).toFixed(2)
  const slNetoPct = slPct == null ? null : +(slPct + costos.total).toFixed(2)
  const tpNetoPct = tp2Pct == null ? null : +(tp2Pct - costos.total).toFixed(2)
  const rrNeto = slNetoPct && tpNetoPct ? +(tpNetoPct / slNetoPct).toFixed(2) : null

  // Sirve para Binance ('BTCUSDT') y para BingX ('BTC-USDT').
  const base = symbol.replace(/-?USDT$/, '')
  return {
    symbol: `${base}/USDT`,
    symbolRaw: symbol,
    base,
    link: `https://www.binance.com/es/futures/${base}USDT`,
    price: precio,
    // 24h de verdad: viene de ticker/24hr. La v1 mostraba "24h %" pero
    // calculaba 24 VELAS hacia atras (6h en 15m, 4 dias en 4h, 24 dias en 1d).
    chg24h: meta?.chg24hReal ?? 0,
    turnover: meta?.turnover ?? null,
    fundingPct,
    tendencia,
    dir: ev.dir,
    veredicto: ev.veredicto,
    conviccion: ev.conviccion,
    cumplidas: ev.cumplidas,
    totalCond: ev.totalCond,
    distClave: ev.distClave,
    distAsl: ev.distAsl,
    distE20: ev.distE20,
    extendido: ev.extendido,
    fundingEnContra: ev.fundingEnContra,
    rsi: +sE.rsi[i].toFixed(1),
    srsi: +sE.srsi[i].toFixed(1),
    bbPct: isNaN(sE.bbPct[i]) ? null : +sE.bbPct[i].toFixed(1),
    volRatio: isNaN(sE.volRatio[i]) ? null : +sE.volRatio[i].toFixed(2),
    atrPct: isNaN(atr) ? null : +((atr / precio) * 100).toFixed(2),
    slPct,
    tp2Pct,
    slNetoPct,
    tpNetoPct,
    rrNeto,
    costoTotalPct: costos.total,
    costoFee: costos.feeIdaVuelta,
    costoFunding: costos.fundingCosto,
    // compatibilidad con Insignia / CalculadoraApalancamiento
    cls,
    signal: ev.veredicto,
    score: ev.conviccion,
    details: ev.motivos.join(' · '),
  }
}

// Ultimo indice con datos utiles de la serie de tendencia (la ultima vela ya
// viene descartada por velasCerradas).
function sT_ultimoIndice(sT) {
  if (!sT || !sT.n) return null
  return sT.n - 1
}
