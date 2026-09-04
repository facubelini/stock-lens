// Indicadores tecnicos y motor de analisis para el Crypto Screener. Portado
// 1:1 desde "Crypto Screener v3" (proyecto propio, docs/v3/index.html) — ahi
// corre 100% client-side (fetch directo a Binance desde el browser), asi que
// entra tal cual en la arquitectura estatica de Stock Lens sin pipeline ni
// backend nuevo.

// EMA de Wilder (alpha = 1/p): usada para ATR, igual que en RSI.
export function wilderEMA(arr, p) {
  if (arr.length < p) return NaN
  let v = arr.slice(0, p).reduce((a, b) => a + b) / p
  const a = 1 / p
  for (let i = p; i < arr.length; i++) v = v * (1 - a) + arr[i] * a
  return v
}

// EMA estandar (alpha = 2/(p+1)): usada para MACD/EMA20-50-200.
export function stdEMA(arr, p) {
  if (arr.length < p) return NaN
  const a = 2 / (p + 1)
  let v = arr.slice(0, p).reduce((a2, b) => a2 + b) / p
  for (let i = p; i < arr.length; i++) v = arr[i] * a + v * (1 - a)
  return v
}

// Igual que stdEMA pero devuelve la serie completa (NaN mientras no hay
// suficientes velas) — la necesita MACD para el histograma actual/previo.
export function stdEMAFull(arr, p) {
  if (arr.length < p) return arr.map(() => NaN)
  const a = 2 / (p + 1)
  const out = new Array(p - 1).fill(NaN)
  let v = arr.slice(0, p).reduce((s, x) => s + x) / p
  out.push(v)
  for (let i = p; i < arr.length; i++) {
    v = arr[i] * a + v * (1 - a)
    out.push(v)
  }
  return out
}

export function rsiSeries(closes, p = 14) {
  const g = []
  const l = []
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    g.push(d > 0 ? d : 0)
    l.push(d < 0 ? -d : 0)
  }
  if (g.length < p) return []
  const a = 1 / p
  let ag = g.slice(0, p).reduce((s, x) => s + x) / p
  let al = l.slice(0, p).reduce((s, x) => s + x) / p
  const out = [al === 0 ? 100 : 100 - 100 / (1 + ag / al)]
  for (let i = p; i < g.length; i++) {
    ag = ag * (1 - a) + g[i] * a
    al = al * (1 - a) + l[i] * a
    out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al))
  }
  return out
}

export function calcStochRSI(closes, rP = 14, stP = 14, sk = 3) {
  const rs = rsiSeries(closes, rP)
  if (rs.length < stP + sk) return 50
  const raw = []
  for (let i = stP - 1; i < rs.length; i++) {
    const w = rs.slice(i - stP + 1, i + 1)
    const lo = Math.min(...w)
    const hi = Math.max(...w)
    raw.push(hi === lo ? 50 : ((rs[i] - lo) / (hi - lo)) * 100)
  }
  if (raw.length < sk) return 50
  let k = 0
  for (let i = raw.length - sk; i < raw.length; i++) k += raw[i]
  return k / sk
}

export function calcMACD(closes) {
  const fast = stdEMAFull(closes, 12)
  const slow = stdEMAFull(closes, 26)
  const macd = fast.map((v, i) => (isNaN(v) || isNaN(slow[i]) ? NaN : v - slow[i]))
  const valid = macd.filter((v) => !isNaN(v))
  if (valid.length < 9) return { histCur: 0, histPrv: 0 }
  const sig = stdEMAFull(valid, 9)
  const hist = sig.map((v, i) => (isNaN(v) ? NaN : valid[i] - v)).filter((v) => !isNaN(v))
  return { histCur: hist[hist.length - 1] ?? 0, histPrv: hist[hist.length - 2] ?? 0 }
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

export function calcATR(highs, lows, closes, p = 14) {
  const trs = []
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])))
  }
  return wilderEMA(trs, p)
}

// Stop loss / take profits en base a ATR (mismos multiplos 1:1/1:2/1:3 que el
// original) + un nivel de referencia por swing de las ultimas 20 velas.
export function calcTPSL(r, klines, atrMult) {
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
  const sl = price + dir * slDist
  const tp1 = price - dir * slDist
  const tp2 = price - dir * slDist * 2
  const tp3 = price - dir * slDist * 3
  const last20H = Math.max(...highs.slice(-20))
  const last20L = Math.min(...lows.slice(-20))
  const slSwing = isShort ? last20H * 1.003 : last20L * 0.997
  const pct = (v, b) => +(((v - b) / b) * 100).toFixed(2)
  return {
    isShort,
    entry: price,
    atr,
    slDist,
    sl,
    slPct: pct(sl, price),
    tp1,
    tp1Pct: pct(tp1, price),
    tp2,
    tp2Pct: pct(tp2, price),
    tp3,
    tp3Pct: pct(tp3, price),
    slSwing,
    slSwingPct: pct(slSwing, price),
  }
}

// Tasa de margen de mantenimiento aproximada por tramo de apalancamiento
// (estilo Binance USDT-M). Orientativo — Binance ajusta esto por símbolo.
export function getMMR(lev) {
  if (lev <= 10) return 0.004
  if (lev <= 25) return 0.005
  if (lev <= 50) return 0.0065
  if (lev <= 75) return 0.01
  if (lev <= 100) return 0.025
  return 0.05 // 125x
}

export function calcLeverage(tpsl, margin, leverage, mType) {
  if (!tpsl || !margin || !leverage) return null
  const posSize = margin * leverage
  const qty = posSize / tpsl.entry
  const mmr = getMMR(leverage)
  const imr = 1 / leverage
  const { isShort, entry, sl, tp1, tp2, tp3 } = tpsl

  const pnl = (exit) => (isShort ? qty * (entry - exit) : qty * (exit - entry))
  const slPnL = pnl(sl)
  const tp1PnL = pnl(tp1)
  const tp2PnL = pnl(tp2)
  const tp3PnL = pnl(tp3)

  // En aislado la perdida no puede superar el margen depositado.
  const effSlPnL = mType === 'isolated' ? Math.max(slPnL, -margin) : slPnL
  const roe = (v) => +((v / margin) * 100).toFixed(1)

  // Precio de liquidacion (formula aislada estilo Binance):
  // Long: Liq = Entry x (1 - IMR + MMR) · Short: Liq = Entry x (1 + IMR - MMR)
  const liqPrice = !isShort ? entry * (1 - imr + mmr) : entry * (1 + imr - mmr)
  const liqPct = +(((liqPrice - entry) / entry) * 100).toFixed(2)

  const liqDistPct = Math.abs(((liqPrice - entry) / entry) * 100)
  const slDistPct = Math.abs(((sl - entry) / entry) * 100)
  const slSafe = liqDistPct > slDistPct // el SL dispara antes que la liquidacion

  return {
    posSize,
    qty,
    mmr,
    liqPrice,
    liqPct,
    liqDistPct,
    slDistPct,
    slSafe,
    slPnL: effSlPnL,
    slROE: roe(effSlPnL),
    tp1PnL,
    tp1ROE: roe(tp1PnL),
    tp2PnL,
    tp2ROE: roe(tp2PnL),
    tp3PnL,
    tp3ROE: roe(tp3PnL),
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
    srsi: +srsiVal.toFixed(1),
    bb_pct: +bbPct.toFixed(1),
    ema_trend: !isNaN(ema200) && price > ema200 ? 'ALCISTA' : 'BAJISTA',
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
