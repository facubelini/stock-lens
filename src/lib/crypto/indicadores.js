// Indicadores tecnicos y motor de analisis para el Crypto Screener. Portado
// 1:1 desde "Crypto Screener v3" (proyecto propio, docs/v3/index.html) — ahi
// corre 100% client-side (fetch directo a Binance desde el browser), asi que
// entra tal cual en la arquitectura estatica de Stock Lens sin pipeline ni
// backend nuevo.

import { rsiSeries, stdEMAFull, srsiSerie, macdSerie, atrSerie } from './series.js'

// Los primitivos en serie viven en series.js; se re-exportan para no romper
// a quien los importaba de aca.
export { rsiSeries, stdEMAFull }

// EMA estandar (alpha = 2/(p+1)): usada para EMA20-50-200. Mismo seed que
// stdEMAFull (media de las primeras p), solo que devuelve el ultimo valor.
export function stdEMA(arr, p) {
  if (arr.length < p) return NaN
  const a = 2 / (p + 1)
  let v = arr.slice(0, p).reduce((a2, b) => a2 + b) / p
  for (let i = p; i < arr.length; i++) v = arr[i] * a + v * (1 - a)
  return v
}

// Los tres de abajo son el ULTIMO valor de su serie en series.js (verificado
// numericamente contra la implementacion anterior sobre velas reales de
// BTC/ETH/SOL: mismo resultado bit a bit). Tenerlos en un solo lugar evita
// que el screener y Cruces calculen distinto el mismo indicador.

// StochRSI (RSI 14, estocastico 14, %K suavizado 3). Devuelve NaN si no hay
// velas suficientes — antes devolvia 50, que se leia como "sin saturar" y
// nunca caia en la rama "StochRSI: sin datos" de analyzeKlines.
export function calcStochRSI(closes, rP = 14, stP = 14, sk = 3) {
  const serie = srsiSerie(closes, rP, stP, sk)
  return serie.length ? serie[serie.length - 1] : NaN
}

// Histograma del MACD en la ultima vela y en la anterior. Sin datos
// suficientes queda en 0 (igual que antes: "sin cruce").
export function calcMACD(closes) {
  const { cur, prv } = macdSerie(closes)
  const n = closes.length
  const histCur = n ? cur[n - 1] : NaN
  const histPrv = n ? prv[n - 1] : NaN
  return { histCur: isNaN(histCur) ? 0 : histCur, histPrv: isNaN(histPrv) ? 0 : histPrv }
}

export function calcBB(closes, p = 20) {
  if (closes.length < p) return 50
  const sl = closes.slice(-p)
  const mean = sl.reduce((a, b) => a + b) / p
  const std = Math.sqrt(sl.reduce((s, v) => s + (v - mean) ** 2, 0) / p)
  const up = mean + 2 * std
  const lo = mean - 2 * std
  const price = closes[closes.length - 1]
  return up === lo ? 50 : ((price - lo) / (up - lo)) * 100
}

// ATR de Wilder (14) en la ultima vela. NaN si no hay p+1 velas.
export function calcATR(highs, lows, closes, p = 14) {
  const serie = atrSerie(highs, lows, closes, p)
  return serie.length ? serie[serie.length - 1] : NaN
}

// Stop loss / take profits en base a ATR + un nivel de referencia por swing
// de las ultimas 20 velas. Los TP son multiplos del riesgo (distancia al SL):
// por defecto 1:1, 1:2 y 1:3, configurables desde la calculadora.
export const MULTIPLOS_TP_DEFAULT = [1, 2, 3]

export function calcTPSL(r, klines, atrMult, multiplosTP = MULTIPLOS_TP_DEFAULT) {
  if (!klines || klines.length < 31) return null
  // ATR y swing salen de velas CERRADAS: el maximo/minimo de una vela a medio
  // hacer se mueve mientras la mirás, asi que el SL cambiaba de lugar solo.
  // La ENTRADA en cambio es el precio en vivo, que es al que realmente entras.
  const cerradas = klines.slice(0, -1)
  const closes = cerradas.map((k) => +k[4])
  const highs = cerradas.map((k) => +k[2])
  const lows = cerradas.map((k) => +k[3])
  const price = +klines[klines.length - 1][4]
  const atr = calcATR(highs, lows, closes, 14)
  if (isNaN(atr)) return null
  const slDist = atr * atrMult
  const isShort = ['se', 'sf', 'sh', 'sw'].includes(r.cls)
  const isActionable = isShort || ['le', 'lf', 'lo', 'lw'].includes(r.cls)
  if (!isActionable) return null
  const dir = isShort ? 1 : -1
  const pct = (v, b) => +(((v - b) / b) * 100).toFixed(2)
  const sl = price + dir * slDist
  const tps = multiplosTP.map((mult) => {
    const precio = price - dir * slDist * mult
    return { mult, precio, pct: pct(precio, price) }
  })
  const last20H = Math.max(...highs.slice(-20))
  const last20L = Math.min(...lows.slice(-20))
  const slSwing = isShort ? last20H * 1.003 : last20L * 0.997
  return {
    isShort,
    entry: price,
    atr,
    atrMult,
    slDist,
    sl,
    slPct: pct(sl, price),
    tps,
    // Compatibilidad: los tres primeros como campos sueltos.
    tp1: tps[0]?.precio,
    tp1Pct: tps[0]?.pct,
    tp2: tps[1]?.precio,
    tp2Pct: tps[1]?.pct,
    tp3: tps[2]?.precio,
    tp3Pct: tps[2]?.pct,
    slSwing,
    slSwingPct: pct(slSwing, price),
  }
}

// ── Apalancamiento ────────────────────────────────────────────────────────
// Tope de apalancamiento y tasa de margen de mantenimiento (MMR) del PRIMER
// tramo del "leverage bracket" de Binance, aproximados. Los reales salen de
// /fapi/v1/leverageBracket, que es un endpoint FIRMADO (pide API key), asi
// que desde un sitio estatico no se pueden leer. Aproximacion:
//   BTC             125× · MMR 0,40%
//   ETH             125× · MMR 0,50%
//   mayores (abajo)  75× · MMR 1%
//   resto cripto     50× · MMR 1%
//   TradFi (acciones/commodities tokenizadas) 20× · MMR 1%
// Valen para posiciones chicas: con nocionales grandes Binance pasa a tramos
// con menos apalancamiento y mas MMR. El valor exacto lo muestra Binance en
// el panel de la orden.
//
// Antes habia una tabla de MMR POR APALANCAMIENTO (5% en 125×, 2,5% en 100×)
// combinada con la formula Entry·(1 − 1/L + MMR): en 100× y 125× el MMR era
// mas grande que 1/L y la liquidacion de un LONG quedaba POR ENCIMA de la
// entrada, y el chequeo del SL (por distancia absoluta) decia "seguro".
const MAYORES = new Set([
  'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX', 'LINK', 'AVAX', 'LTC', 'BCH',
  'DOT', 'TON', 'SUI', 'XLM', 'ETC', 'NEAR', 'APT', 'UNI', 'FIL', 'ATOM',
])

export function perfilApalancamiento(symbolRaw, { tradfi = false } = {}) {
  const base = String(symbolRaw ?? '').replace(/USDT$/, '')
  if (tradfi) return { maxLev: 20, mmr: 0.01, grupo: 'TradFi (acciones/commodities)' }
  if (base === 'BTC') return { maxLev: 125, mmr: 0.004, grupo: 'BTC' }
  if (base === 'ETH') return { maxLev: 125, mmr: 0.005, grupo: 'ETH' }
  if (MAYORES.has(base)) return { maxLev: 75, mmr: 0.01, grupo: 'cripto mayor' }
  return { maxLev: 50, mmr: 0.01, grupo: 'resto de cripto' }
}

// Comision taker por lado (Binance USDT-M, cuenta sin descuentos): 0,05%.
export const COMISION_TAKER = 0.0005

// Precio de liquidacion en margen AISLADO, primer tramo (monto de
// mantenimiento = 0). Sale de la formula de Binance
//   LP = (WB + cum − lado·Q·E) / (Q·MMR − lado·Q),  con WB = Q·E/L
// que simplificada queda:
//   Long:  LP = E · (1 − 1/L) / (1 − MMR)
//   Short: LP = E · (1 + 1/L) / (1 + MMR)
// Si 1/L <= MMR la posicion no tiene margen ni para el mantenimiento: se
// liquidaria apenas abre. Se marca como inviable y el precio se clava en la
// entrada, asi nunca queda del lado equivocado.
export function precioLiquidacion(entry, leverage, mmr, isShort) {
  const cruda = isShort ? (entry * (1 + 1 / leverage)) / (1 + mmr) : (entry * (1 - 1 / leverage)) / (1 - mmr)
  const inviable = 1 / leverage <= mmr
  const precio = isShort ? Math.max(cruda, entry) : Math.min(cruda, entry)
  return { precio, cruda, inviable }
}

// opciones: { mmr, comision } — mmr sale de perfilApalancamiento; comision es
// la taker por lado (se cobra al entrar y al salir, sobre el nocional de cada
// lado). Las G/P que devuelve son NETAS de las dos comisiones.
export function calcLeverage(tpsl, margin, leverage, mType, { mmr = 0.01, comision = COMISION_TAKER } = {}) {
  if (!tpsl || !margin || !leverage) return null
  const posSize = margin * leverage
  const qty = posSize / tpsl.entry
  const { isShort, entry, sl } = tpsl
  const lado = isShort ? -1 : 1

  const liq = precioLiquidacion(entry, leverage, mmr, isShort)
  const liqPrice = liq.precio
  const liqPct = +(((liqPrice - entry) / entry) * 100).toFixed(2)
  const liqDistPct = Math.abs(((liqPrice - entry) / entry) * 100)
  const slDistPct = Math.abs(((sl - entry) / entry) * 100)
  // Con signo: en un long el SL tiene que estar POR ENCIMA de la liquidacion
  // (salta antes al bajar); en un short, POR DEBAJO.
  const slSafe = !liq.inviable && (isShort ? sl < liqPrice : sl > liqPrice)

  const comisionEntrada = qty * entry * comision
  const comisionSalida = (salida) => qty * salida * comision
  const bruto = (salida) => lado * qty * (salida - entry)
  const neto = (salida) => bruto(salida) - comisionEntrada - comisionSalida(salida)
  const roe = (v) => +((v / margin) * 100).toFixed(1)

  // Liquidado en aislado se pierde el margen entero, mas la comision de
  // entrada que ya se habia pagado. Binance cobra ademas una tasa de
  // liquidacion que aca no se modela.
  const perdidaLiquidacion = -(margin + comisionEntrada)
  let slPnL = neto(sl)
  if (mType === 'isolated' && !slSafe) slPnL = perdidaLiquidacion

  const tps = (tpsl.tps ?? []).map((t) => {
    const pnl = neto(t.precio)
    return { ...t, pnl, roe: roe(pnl), comision: comisionEntrada + comisionSalida(t.precio) }
  })

  return {
    posSize,
    qty,
    mmr,
    imr: 1 / leverage,
    comision,
    liqPrice,
    liqCruda: liq.cruda,
    inviable: liq.inviable,
    liqPct,
    liqDistPct,
    slDistPct,
    slSafe,
    comisionEntrada,
    comisionSl: comisionEntrada + comisionSalida(sl),
    slBruto: bruto(sl),
    slPnL,
    slROE: roe(slPnL),
    perdidaLiquidacion,
    tps,
    // Compatibilidad con los tres TP fijos.
    tp1PnL: tps[0]?.pnl,
    tp1ROE: tps[0]?.roe,
    tp2PnL: tps[1]?.pnl,
    tp2ROE: tps[1]?.roe,
    tp3PnL: tps[2]?.pnl,
    tp3ROE: tps[2]?.roe,
  }
}

// Estacionalidad (retorno promedio por mes calendario), a partir de velas
// mensuales (interval='1M' de Binance). Misma logica que el lado Python de
// acciones (generar_datos.py calcular_estacionalidad_y_mensual) — si se
// toca uno, tocar el otro. Requiere al menos 2 años de velas cerradas;
// muchas altcoins nuevas no van a tener suficiente historial todavia.
export function calcularEstacionalidad(klinesMensuales) {
  if (!klinesMensuales || klinesMensuales.length < 25) return null
  // La ultima vela mensual es el mes en curso (incompleto): compararla
  // contra el cierre del mes anterior no es "el retorno de ese mes".
  const cerradas = klinesMensuales.slice(0, -1)
  if (cerradas.length < 24) return null

  const porMes = new Map()
  for (let i = 1; i < cerradas.length; i++) {
    const anterior = +cerradas[i - 1][4]
    const actual = +cerradas[i][4]
    if (!anterior) continue
    const retorno = ((actual / anterior) - 1) * 100
    const mes = new Date(cerradas[i][0]).getUTCMonth() + 1
    if (!porMes.has(mes)) porMes.set(mes, [])
    porMes.get(mes).push(retorno)
  }

  const salida = []
  for (let mes = 1; mes <= 12; mes++) {
    const valores = porMes.get(mes)
    if (!valores?.length) continue
    const prom = valores.reduce((a, b) => a + b, 0) / valores.length
    const positivos = valores.filter((v) => v > 0).length
    salida.push({
      mes,
      retorno_prom: +prom.toFixed(2),
      positivos_pct: +((positivos / valores.length) * 100).toFixed(0),
      n: valores.length,
    })
  }
  return salida.length ? salida : null
}

// Cuanto subio/bajo en ventanas fijas de 1h, 4h y 1 dia, a partir de velas de
// 15m. Punta = precio EN VIVO; base = el cierre de N velas atras. La ventana
// real cae entre el periodo y el periodo menos 15 minutos, porque la vela en
// curso puede estar recien abierta.
//
// OJO: el 'chg24h' de analyzeKlines NO es esto. Cuenta 24 VELAS de la
// temporalidad elegida, que en 15m son 6 horas y en 4h son 4 dias. Para
// "cuanto subio/bajo" hay que mirar esta funcion.
export function calcularVariaciones(k15m) {
  if (!k15m || k15m.length < 2) return null
  const cierres = k15m.map((k) => +k[4])
  const vivo = cierres[cierres.length - 1]
  // velas de 15m que entran en cada ventana: 1h = 4, 4h = 16, 1 dia = 96
  const pct = (velas) => {
    const i = cierres.length - 1 - velas
    if (i < 0) return null
    const base = cierres[i]
    return base ? +(((vivo - base) / base) * 100).toFixed(2) : null
  }
  return { h1: pct(4), h4: pct(16), d1: pct(96), precio: vivo }
}

// Score de -10 a +10 (negativo = SHORT, positivo = LONG) a partir de RSI +
// StochRSI + MACD + Bollinger + alineacion de EMAs + confirmacion de volumen.
//
// El score se calcula SOLO sobre velas CERRADAS. Binance devuelve la vela en
// curso como ultimo elemento del array y hasta este arreglo entraba al calculo
// como si fuera un cierre, con dos efectos feos:
//  1. La señal repintaba. Escaneabas a mitad de hora, veias SHORT FUERTE,
//     entrabas, y cuando la vela cerraba el score era otro — o sea que operabas
//     una señal que despues no existia.
//  2. El bonus de volumen (±1 si volRatio >= 2) comparaba el volumen PARCIAL
//     de la vela en curso contra el promedio de 20 velas completas, asi que
//     casi nunca disparaba al principio de la vela y disparaba de mas al final.
// 'price' y 'chg24h' si usan el precio en vivo: son informativos para la tabla
// y no entran al score.
export function analyzeKlines(symbol, klines, atrMult) {
  if (!klines || klines.length < 61) return null
  const precioVivo = +klines[klines.length - 1][4]
  const cerradas = klines.slice(0, -1)
  const closes = cerradas.map((k) => +k[4])
  const highs = cerradas.map((k) => +k[2])
  const lows = cerradas.map((k) => +k[3])
  const volumes = cerradas.map((k) => +k[5])
  // Precio al que se evaluo la señal = ultimo cierre. Los % de SL/TP van
  // contra este, no contra el precio en vivo.
  const price = closes[closes.length - 1]

  const rs = rsiSeries(closes)
  const rsiVal = rs[rs.length - 1] ?? 50
  const srsiVal = calcStochRSI(closes)
  const { histCur, histPrv } = calcMACD(closes)
  const bbPct = calcBB(closes)
  const ema20 = stdEMA(closes, 20)
  const ema50 = stdEMA(closes, 50)
  const ema200 = stdEMA(closes, 200)
  const atrVal = calcATR(highs, lows, closes)
  const atrPct = isNaN(atrVal) ? 0 : (atrVal / price) * 100
  const volAvg = volumes.slice(-20).reduce((a, b) => a + b) / 20
  const volRatio = volumes[volumes.length - 1] / volAvg
  const lb = Math.min(24, closes.length - 1)
  const base24 = closes[closes.length - 1 - lb]
  const chg24h = ((precioVivo - base24) / base24) * 100

  // Aportes al score, uno por bloque de indicador. 'puntos' con signo: > 0
  // empuja a LONG, < 0 empuja a SHORT, 0 no mueve la aguja. La ficha los
  // separa en pros y contras SEGUN el lado de la señal, asi que cada rama
  // tiene que dejar su aporte aca — incluidas las de ±0.5, que antes movian
  // el score en silencio sin aparecer en ninguna parte de la UI.
  const aportes = []
  const ap = (bloque, texto, puntos) => aportes.push({ bloque, texto, puntos })

  if (rsiVal >= 80) ap('RSI', `RSI ${rsiVal.toFixed(1)}: sobrecompra severa`, -2)
  else if (rsiVal >= 70) ap('RSI', `RSI ${rsiVal.toFixed(1)}: sobrecompra`, -1)
  else if (rsiVal <= 20) ap('RSI', `RSI ${rsiVal.toFixed(1)}: sobreventa severa`, 2)
  else if (rsiVal <= 30) ap('RSI', `RSI ${rsiVal.toFixed(1)}: sobreventa`, 1)
  else ap('RSI', `RSI ${rsiVal.toFixed(1)}: sin saturar`, 0)

  if (isNaN(srsiVal)) ap('StochRSI', 'StochRSI: sin datos', 0)
  else if (srsiVal >= 90) ap('StochRSI', `StochRSI ${srsiVal.toFixed(1)}: sobrecompra severa`, -2)
  else if (srsiVal >= 80) ap('StochRSI', `StochRSI ${srsiVal.toFixed(1)}: sobrecompra`, -1)
  else if (srsiVal <= 10) ap('StochRSI', `StochRSI ${srsiVal.toFixed(1)}: sobreventa severa`, 2)
  else if (srsiVal <= 20) ap('StochRSI', `StochRSI ${srsiVal.toFixed(1)}: sobreventa`, 1)
  else ap('StochRSI', `StochRSI ${srsiVal.toFixed(1)}: sin saturar`, 0)

  if (histCur < 0 && histPrv >= 0) ap('MACD', 'MACD: cruce bajista recién', -2)
  else if (histCur > 0 && histPrv <= 0) ap('MACD', 'MACD: cruce alcista recién', 2)
  else if (histCur < 0 && histCur < histPrv) ap('MACD', 'MACD: bajo cero y empeorando', -1)
  else if (histCur > 0 && histCur > histPrv) ap('MACD', 'MACD: sobre cero y mejorando', 1)
  else if (histCur < 0) ap('MACD', 'MACD: bajo cero pero recuperando', -0.5)
  else ap('MACD', 'MACD: sobre cero pero perdiendo fuerza', 0.5)

  // Math.round(-0.1) es -0, que se imprime "-0%". Se normaliza a 0.
  const bbRed = Math.round(bbPct) === 0 ? 0 : Math.round(bbPct)
  if (bbPct > 100) ap('Bollinger', `BB ${bbRed}%: por encima de la banda superior`, -1)
  else if (bbPct > 90) ap('Bollinger', `BB ${bbRed}%: pegado a la banda superior`, -0.5)
  else if (bbPct < 0) ap('Bollinger', `BB ${bbRed}%: por debajo de la banda inferior`, 1)
  else if (bbPct < 10) ap('Bollinger', `BB ${bbRed}%: pegado a la banda inferior`, 0.5)
  else ap('Bollinger', `BB ${bbRed}%: en el medio del canal`, 0)

  if (isNaN(ema20) || isNaN(ema50) || isNaN(ema200)) {
    ap('Tendencia', 'Sin velas suficientes para la EMA200', 0)
  } else if (price < ema20 && ema20 < ema50 && ema50 < ema200) {
    ap('Tendencia', 'EMAs alineadas a la baja (precio < 20 < 50 < 200)', -2)
  } else if (price > ema20 && ema20 > ema50 && ema50 > ema200) {
    ap('Tendencia', 'EMAs alineadas al alza (precio > 20 > 50 > 200)', 2)
  } else if (price < ema200 && price < ema50) {
    ap('Tendencia', 'Precio bajo la EMA200 y la EMA50', -1)
  } else if (price > ema200 && price > ema50) {
    ap('Tendencia', 'Precio sobre la EMA200 y la EMA50', 1)
  } else if (price < ema200) {
    ap('Tendencia', 'Bajo la EMA200 pero sobre la EMA50', -0.5)
  } else {
    ap('Tendencia', 'Sobre la EMA200 pero bajo la EMA50', 0.5)
  }

  // El volumen no vota solo: solo CONFIRMA lo que ya venian diciendo los
  // demas bloques, asi que se evalua contra el subtotal (igual que antes).
  const subtotal = aportes.reduce((a, x) => a + x.puntos, 0)
  const vx = `Vol ×${volRatio.toFixed(1)}`
  if (volRatio >= 2 && subtotal <= -2) ap('Volumen', `${vx}: confirma la bajada`, -1)
  else if (volRatio >= 2 && subtotal >= 2) ap('Volumen', `${vx}: confirma la subida`, 1)
  else if (volRatio >= 2) ap('Volumen', `${vx}: alto, pero el resto no marca lado`, 0)
  else ap('Volumen', `${vx}: sin volumen que confirme`, 0)

  const score = +aportes.reduce((a, x) => a + x.puntos, 0).toFixed(1)

  let label
  let cls
  if (score <= -7) [label, cls] = ['SHORT EXTREMO', 'se']
  else if (score <= -4) [label, cls] = ['SHORT FUERTE', 'sf']
  else if (score <= -2) [label, cls] = ['SHORT', 'sh']
  else if (score < 0) [label, cls] = ['SHORT DÉBIL', 'sw']
  else if (score >= 7) [label, cls] = ['LONG EXTREMO', 'le']
  else if (score >= 4) [label, cls] = ['LONG FUERTE', 'lf']
  else if (score >= 2) [label, cls] = ['LONG', 'lo']
  else if (score > 0) [label, cls] = ['LONG DÉBIL', 'lw']
  else [label, cls] = ['NEUTRAL', 'n']

  const isShort = ['se', 'sf', 'sh', 'sw'].includes(cls)
  const isLong = ['le', 'lf', 'lo', 'lw'].includes(cls)
  const slDist = atrVal * atrMult
  const sl_pct = isShort ? +((slDist / price) * 100).toFixed(2) : isLong ? -+((slDist / price) * 100).toFixed(2) : null
  const tp2_pct = isShort
    ? -+(((slDist * 2) / price) * 100).toFixed(2)
    : isLong
      ? +(((slDist * 2) / price) * 100).toFixed(2)
      : null

  // ── Valores EN CURSO ──────────────────────────────────────────────────
  // Los mismos indicadores pero incluyendo la vela abierta: son los que ves en
  // el grafico de Binance. NO entran al score (eso sigue saliendo del cierre,
  // para que la señal no repinte), pero sin mostrarlos el screener y el
  // grafico se contradicen — y en diario la contradiccion llega a 22 puntos
  // de RSI, porque "la ultima vela cerrada" son hasta 24 horas de atraso.
  const closesVivo = klines.map((k) => +k[4])
  const rsVivo = rsiSeries(closesVivo)
  const rsiVivo = rsVivo[rsVivo.length - 1] ?? rsiVal
  const srsiVivo = calcStochRSI(closesVivo)
  const bbVivo = calcBB(closesVivo)
  // Cuanto lleva transcurrido de la vela en curso. Con la vela recien abierta
  // el valor cerrado es practicamente del periodo anterior entero.
  const ultima = klines[klines.length - 1]
  const abre = +ultima[0]
  const cierra = +ultima[6]
  const pctVela = cierra > abre ? Math.min(100, Math.max(0, ((Date.now() - abre) / (cierra - abre)) * 100)) : null

  const base = symbol.replace('USDT', '')
  return {
    symbol: symbol.replace('USDT', '/USDT'),
    symbolRaw: symbol,
    link: `https://www.binance.com/es/futures/${base}USDT`,
    // price = precio de AHORA (lo que muestra la columna "Precio"), que puede
    // diferir de precioSenal si la vela en curso ya se movio.
    price: precioVivo,
    precioSenal: price,
    chg24h: +chg24h.toFixed(2),
    rsi: +rsiVal.toFixed(1),
    // null si no hubo velas para calcularlo (la tabla muestra '—').
    srsi: isNaN(srsiVal) ? null : +srsiVal.toFixed(1),
    bb_pct: +bbPct.toFixed(1),
    // Mismos indicadores sobre la vela en curso (lo que muestra Binance).
    rsi_vivo: +rsiVivo.toFixed(1),
    srsi_vivo: isNaN(srsiVivo) ? null : +srsiVivo.toFixed(1),
    bb_pct_vivo: +bbVivo.toFixed(1),
    pct_vela: pctVela == null ? null : +pctVela.toFixed(0),
    // Sin EMA200 (menos de 200 velas cerradas: recien listados, o diario de
    // un simbolo joven) no hay tendencia: null, la tabla muestra '—'. Antes
    // caia en 'BAJISTA' por descarte.
    ema_trend: isNaN(ema200) ? null : price > ema200 ? 'ALCISTA' : 'BAJISTA',
    vol_ratio: +volRatio.toFixed(2),
    atr_pct: +atrPct.toFixed(2),
    score,
    signal: label,
    cls,
    // Aportes desglosados: la ficha los parte en pros y contras segun el lado.
    aportes,
    sl_pct,
    tp2_pct,
    details: aportes.map((a) => a.texto).join(' · '),
  }
}
