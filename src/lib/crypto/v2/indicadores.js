// Indicadores del v2 como SERIES ALINEADAS al array de entrada: out[i] es el
// valor del indicador en la vela i, con NaN mientras no haya velas
// suficientes. La v1 devuelve solo el ultimo valor (o series con offset), y
// eso hace imposible backtestear sin recalcular todo en cada paso.
//
// Todas las series son CAUSALES: out[i] depende unicamente de arr[0..i]. Es
// la propiedad que hace que el backtest no tenga lookahead.

const media = (a) => a.reduce((s, x) => s + x, 0) / a.length

// Velas cerradas: Binance devuelve la vela en curso como ultimo elemento, con
// volumen parcial y precio que todavia se mueve. Incluirla hace que la señal
// dependa de cuando apretaste "Escanear" en vez de del mercado (medido: el
// vol_ratio de BTC daba 1,29 con la vela incompleta y 0,57 con la cerrada).
// El v2 trabaja siempre sin ella.
export function velasCerradas(klines) {
  if (!klines || klines.length < 2) return []
  return klines.slice(0, -1)
}

export function serieOHLCV(klines) {
  return {
    apertura: klines.map((k) => +k[1]),
    altos: klines.map((k) => +k[2]),
    bajos: klines.map((k) => +k[3]),
    cierres: klines.map((k) => +k[4]),
    volumenes: klines.map((k) => +k[5]),
    tsApertura: klines.map((k) => k[0]),
    tsCierre: klines.map((k) => k[6]),
  }
}

// EMA estandar (alpha = 2/(p+1)), sembrada con la SMA de las primeras p.
export function emaSerie(arr, p) {
  const out = new Array(arr.length).fill(NaN)
  if (arr.length < p) return out
  const a = 2 / (p + 1)
  let v = media(arr.slice(0, p))
  out[p - 1] = v
  for (let i = p; i < arr.length; i++) {
    v = arr[i] * a + v * (1 - a)
    out[i] = v
  }
  return out
}

// Igual que emaSerie pero tolera NaN al principio del array (lo necesita la
// linea de señal del MACD, que se calcula sobre la serie MACD).
function emaSerieConNaN(arr, p) {
  const out = new Array(arr.length).fill(NaN)
  const ini = arr.findIndex((v) => !isNaN(v))
  if (ini === -1 || arr.length - ini < p) return out
  const a = 2 / (p + 1)
  let v = media(arr.slice(ini, ini + p))
  out[ini + p - 1] = v
  for (let i = ini + p; i < arr.length; i++) {
    if (isNaN(arr[i])) continue
    v = arr[i] * a + v * (1 - a)
    out[i] = v
  }
  return out
}

// WMA lineal: pesos 1..p. La necesita la ASL.
export function wmaSerie(arr, p) {
  const out = new Array(arr.length).fill(NaN)
  if (arr.length < p) return out
  const denom = (p * (p + 1)) / 2
  for (let i = p - 1; i < arr.length; i++) {
    let s = 0
    for (let j = 0; j < p; j++) s += arr[i - p + 1 + j] * (j + 1)
    out[i] = s / denom
  }
  return out
}

// ASL (Adaptive Support Line) = promedio de EMA21 y WMA21 lineal. Misma
// formula que usa el analizador v8 y el Screener de acciones.
export function aslSerie(cierres) {
  const e = emaSerie(cierres, 21)
  const w = wmaSerie(cierres, 21)
  return cierres.map((_, i) => (isNaN(e[i]) || isNaN(w[i]) ? NaN : (e[i] + w[i]) / 2))
}

// RSI de Wilder, alineado.
export function rsiSerie(cierres, p = 14) {
  const out = new Array(cierres.length).fill(NaN)
  if (cierres.length <= p) return out
  let ag = 0
  let al = 0
  for (let i = 1; i <= p; i++) {
    const d = cierres[i] - cierres[i - 1]
    ag += d > 0 ? d : 0
    al += d < 0 ? -d : 0
  }
  ag /= p
  al /= p
  out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al)
  const a = 1 / p
  for (let i = p + 1; i < cierres.length; i++) {
    const d = cierres[i] - cierres[i - 1]
    ag = ag * (1 - a) + (d > 0 ? d : 0) * a
    al = al * (1 - a) + (d < 0 ? -d : 0) * a
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al)
  }
  return out
}

// StochRSI %K suavizado, alineado.
export function stochRsiSerie(cierres, rP = 14, stP = 14, sk = 3) {
  const rsi = rsiSerie(cierres, rP)
  const crudo = new Array(cierres.length).fill(NaN)
  for (let i = stP - 1; i < cierres.length; i++) {
    let lo = Infinity
    let hi = -Infinity
    let ok = true
    for (let j = i - stP + 1; j <= i; j++) {
      if (j < 0 || isNaN(rsi[j])) {
        ok = false
        break
      }
      if (rsi[j] < lo) lo = rsi[j]
      if (rsi[j] > hi) hi = rsi[j]
    }
    if (!ok) continue
    crudo[i] = hi === lo ? 50 : ((rsi[i] - lo) / (hi - lo)) * 100
  }
  const out = new Array(cierres.length).fill(NaN)
  for (let i = sk - 1; i < cierres.length; i++) {
    let s = 0
    let ok = true
    for (let j = i - sk + 1; j <= i; j++) {
      if (j < 0 || isNaN(crudo[j])) {
        ok = false
        break
      }
      s += crudo[j]
    }
    if (ok) out[i] = s / sk
  }
  return out
}

// Histograma MACD (12/26/9), alineado.
export function macdHistSerie(cierres) {
  const rapida = emaSerie(cierres, 12)
  const lenta = emaSerie(cierres, 26)
  const macd = cierres.map((_, i) =>
    isNaN(rapida[i]) || isNaN(lenta[i]) ? NaN : rapida[i] - lenta[i],
  )
  const senal = emaSerieConNaN(macd, 9)
  return cierres.map((_, i) => (isNaN(macd[i]) || isNaN(senal[i]) ? NaN : macd[i] - senal[i]))
}

// ATR de Wilder, alineado.
export function atrSerie(altos, bajos, cierres, p = 14) {
  const n = cierres.length
  const tr = new Array(n).fill(NaN)
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      altos[i] - bajos[i],
      Math.abs(altos[i] - cierres[i - 1]),
      Math.abs(bajos[i] - cierres[i - 1]),
    )
  }
  const out = new Array(n).fill(NaN)
  if (n <= p) return out
  let v = 0
  for (let i = 1; i <= p; i++) v += tr[i]
  v /= p
  out[p] = v
  const a = 1 / p
  for (let i = p + 1; i < n; i++) {
    v = v * (1 - a) + tr[i] * a
    out[i] = v
  }
  return out
}

// %B de Bollinger (0 = banda inferior, 100 = superior), alineado.
export function bbPctSerie(cierres, p = 20) {
  const out = new Array(cierres.length).fill(NaN)
  for (let i = p - 1; i < cierres.length; i++) {
    const w = cierres.slice(i - p + 1, i + 1)
    const m = media(w)
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / p)
    const up = m + 2 * sd
    const lo = m - 2 * sd
    out[i] = up === lo ? 50 : ((cierres[i] - lo) / (up - lo)) * 100
  }
  return out
}

// Ratio de volumen contra el promedio de las 20 velas ANTERIORES (no
// incluye la vela i en su propio promedio, que era otro sesgo de la v1).
export function volRatioSerie(volumenes, p = 20) {
  const out = new Array(volumenes.length).fill(NaN)
  for (let i = p; i < volumenes.length; i++) {
    const prom = media(volumenes.slice(i - p, i))
    out[i] = prom === 0 ? NaN : volumenes[i] / prom
  }
  return out
}

// Todas las series de una vez, para no recalcular por vela en el backtest.
export function calcularSeries(klines) {
  const o = serieOHLCV(klines)
  return {
    ...o,
    n: klines.length,
    ema20: emaSerie(o.cierres, 20),
    ema50: emaSerie(o.cierres, 50),
    ema200: emaSerie(o.cierres, 200),
    asl: aslSerie(o.cierres),
    rsi: rsiSerie(o.cierres),
    srsi: stochRsiSerie(o.cierres),
    macdHist: macdHistSerie(o.cierres),
    atr: atrSerie(o.altos, o.bajos, o.cierres),
    bbPct: bbPctSerie(o.cierres),
    volRatio: volRatioSerie(o.volumenes),
  }
}
