// Los mismos indicadores del v1, pero calculados EN SERIE (un valor por vela)
// en vez de solo en la última. Sin esto no se puede medir qué hizo una señal
// históricamente, que es todo el punto del v3.
//
// Está validado contra el motor del v1: para el último índice, aportesEn()
// devuelve exactamente el mismo score que analyzeKlines(). Si tocás algo acá,
// corré esa comprobación de nuevo (hay un test en la propia pestaña).
import { rsiSeries, stdEMAFull } from '../indicadores.js'

const NAN = Number.NaN

// StochRSI del v1: rsiP=14, stochP=14, suavizado k=3 (SMA de los 3 crudos).
export function srsiSerie(closes, rP = 14, stP = 14, sk = 3) {
  const out = new Array(closes.length).fill(NAN)
  const rs = rsiSeries(closes, rP) // rs[j] <-> closes[j + rP]
  if (rs.length < stP + sk - 1) return out
  const raw = []
  for (let i = stP - 1; i < rs.length; i++) {
    const w = rs.slice(i - stP + 1, i + 1)
    const lo = Math.min(...w)
    const hi = Math.max(...w)
    raw.push(hi === lo ? 50 : ((rs[i] - lo) / (hi - lo)) * 100)
  }
  for (let m = sk - 1; m < raw.length; m++) {
    let s = 0
    for (let j = m - sk + 1; j <= m; j++) s += raw[j]
    out[m + stP - 1 + rP] = s / sk
  }
  return out
}

export function rsiSerieAlineada(closes, p = 14) {
  const out = new Array(closes.length).fill(NAN)
  const rs = rsiSeries(closes, p)
  for (let j = 0; j < rs.length; j++) out[j + p] = rs[j]
  return out
}

// Histograma del MACD: valor actual y el inmediatamente anterior.
export function macdSerie(closes) {
  const n = closes.length
  const cur = new Array(n).fill(NAN)
  const fast = stdEMAFull(closes, 12)
  const slow = stdEMAFull(closes, 26)
  const macd = fast.map((v, i) => (isNaN(v) || isNaN(slow[i]) ? NAN : v - slow[i]))
  const idx = []
  const valid = []
  for (let i = 0; i < n; i++) {
    if (!isNaN(macd[i])) {
      idx.push(i)
      valid.push(macd[i])
    }
  }
  if (valid.length < 9) return { cur, prv: cur.slice() }
  const sig = stdEMAFull(valid, 9)
  for (let k = 0; k < valid.length; k++) if (!isNaN(sig[k])) cur[idx[k]] = valid[k] - sig[k]
  const prv = new Array(n).fill(NAN)
  let ultimo = NAN
  for (let i = 0; i < n; i++) {
    prv[i] = ultimo
    if (!isNaN(cur[i])) ultimo = cur[i]
  }
  return { cur, prv }
}

export function bbSerie(closes, p = 20) {
  const out = new Array(closes.length).fill(NAN)
  let suma = 0
  let suma2 = 0
  for (let i = 0; i < closes.length; i++) {
    suma += closes[i]
    suma2 += closes[i] * closes[i]
    if (i >= p) {
      suma -= closes[i - p]
      suma2 -= closes[i - p] * closes[i - p]
    }
    if (i >= p - 1) {
      const mean = suma / p
      const varz = Math.max(0, suma2 / p - mean * mean)
      const std = Math.sqrt(varz)
      const up = mean + 2 * std
      const lo = mean - 2 * std
      out[i] = up === lo ? 50 : ((closes[i] - lo) / (up - lo)) * 100
    }
  }
  return out
}

export function volRatioSerie(vols, p = 20) {
  const out = new Array(vols.length).fill(NAN)
  let suma = 0
  for (let i = 0; i < vols.length; i++) {
    suma += vols[i]
    if (i >= p) suma -= vols[i - p]
    if (i >= p - 1) {
      const prom = suma / p
      out[i] = prom ? vols[i] / prom : NAN
    }
  }
  return out
}

// EMA estándar en serie, con el mismo seed que stdEMA (media de las primeras p).
export function emaSerie(arr, p) {
  const out = new Array(arr.length).fill(NAN)
  if (arr.length < p) return out
  const alpha = 2 / (p + 1)
  let v = arr.slice(0, p).reduce((a, b) => a + b, 0) / p
  out[p - 1] = v
  for (let i = p; i < arr.length; i++) {
    v = arr[i] * alpha + v * (1 - alpha)
    out[i] = v
  }
  return out
}

// ATR de Wilder en serie.
export function atrSerie(highs, lows, closes, p = 14) {
  const out = new Array(closes.length).fill(NAN)
  if (closes.length < p + 1) return out
  const tr = [0]
  for (let i = 1; i < closes.length; i++) {
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    )
  }
  let v = tr.slice(1, p + 1).reduce((a, b) => a + b, 0) / p
  out[p] = v
  for (let i = p + 1; i < tr.length; i++) {
    v = v * (1 - 1 / p) + tr[i] * (1 / p)
    out[i] = v
  }
  return out
}

// Arma todas las series de una vez, sobre velas YA CERRADAS.
export function armarSeries(klinesCerradas) {
  const closes = klinesCerradas.map((k) => +k[4])
  const highs = klinesCerradas.map((k) => +k[2])
  const lows = klinesCerradas.map((k) => +k[3])
  const vols = klinesCerradas.map((k) => +k[5])
  const { cur, prv } = macdSerie(closes)
  return {
    n: closes.length,
    closes,
    highs,
    lows,
    rsi: rsiSerieAlineada(closes),
    srsi: srsiSerie(closes),
    macdCur: cur,
    macdPrv: prv,
    bb: bbSerie(closes),
    ema20: emaSerie(closes, 20),
    ema50: emaSerie(closes, 50),
    ema200: emaSerie(closes, 200),
    volRatio: volRatioSerie(vols),
    atr: atrSerie(highs, lows, closes),
  }
}

// Aportes del score del v1 en el índice i. MISMAS ramas que analyzeKlines:
// si cambian allá, tienen que cambiar acá o la evidencia deja de medir la
// señal que el screener muestra.
export function aportesEn(i, s) {
  const a = {}
  const r = s.rsi[i]
  a.rsi = r >= 80 ? -2 : r >= 70 ? -1 : r <= 20 ? 2 : r <= 30 ? 1 : 0
  const sr = s.srsi[i]
  a.srsi = isNaN(sr) ? 0 : sr >= 90 ? -2 : sr >= 80 ? -1 : sr <= 10 ? 2 : sr <= 20 ? 1 : 0
  const hc = s.macdCur[i]
  const hp = s.macdPrv[i]
  a.macd =
    hc < 0 && hp >= 0 ? -2
    : hc > 0 && hp <= 0 ? 2
    : hc < 0 && hc < hp ? -1
    : hc > 0 && hc > hp ? 1
    : hc < 0 ? -0.5
    : 0.5
  const bb = s.bb[i]
  a.bb = bb > 100 ? -1 : bb > 90 ? -0.5 : bb < 0 ? 1 : bb < 10 ? 0.5 : 0
  const p = s.closes[i]
  const e20 = s.ema20[i]
  const e50 = s.ema50[i]
  const e200 = s.ema200[i]
  a.ema =
    isNaN(e20) || isNaN(e50) || isNaN(e200) ? 0
    : p < e20 && e20 < e50 && e50 < e200 ? -2
    : p > e20 && e20 > e50 && e50 > e200 ? 2
    : p < e200 && p < e50 ? -1
    : p > e200 && p > e50 ? 1
    : p < e200 ? -0.5
    : 0.5
  const sub = a.rsi + a.srsi + a.macd + a.bb + a.ema
  const vr = s.volRatio[i]
  a.vol = vr >= 2 && sub <= -2 ? -1 : vr >= 2 && sub >= 2 ? 1 : 0
  a.total = +(sub + a.vol).toFixed(1)
  return a
}
