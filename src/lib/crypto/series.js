// Los mismos indicadores del Crypto Screener, pero calculados EN SERIE (un
// valor por vela) en vez de solo en la ultima. Los usa el Screener de Cruces
// (que necesita la vela anterior para saber si hubo cruce) y el propio motor
// del screener: calcStochRSI, calcMACD y calcATR de indicadores.js son el
// ultimo valor de estas series, asi que no hay dos implementaciones de la
// misma cuenta que se puedan desincronizar.
//
// rsiSeries y stdEMAFull viven aca (y indicadores.js los re-exporta) para
// que la dependencia vaya en un solo sentido: indicadores -> series.

const NAN = Number.NaN

// EMA estandar (alpha = 2/(p+1)) devolviendo la serie completa (NaN mientras
// no hay suficientes velas). Seed = media simple de las primeras p.
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

// RSI de Wilder. OJO: devuelve un array MAS CORTO que closes (arranca en la
// vela p): rs[j] corresponde a closes[j + p]. rsiSerieAlineada lo alinea.
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

// MACD (12, 26, señal 9). cur = histograma (linea - señal) en cada vela,
// prv = el histograma de la vela anterior. linea/senal son las dos lineas
// que dibuja Binance, alineadas con closes.
export function macdSerie(closes) {
  const n = closes.length
  const cur = new Array(n).fill(NAN)
  const linea = new Array(n).fill(NAN)
  const senal = new Array(n).fill(NAN)
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
  for (let k = 0; k < valid.length; k++) linea[idx[k]] = valid[k]
  if (valid.length < 9) return { cur, prv: cur.slice(), linea, senal }
  const sig = stdEMAFull(valid, 9)
  for (let k = 0; k < valid.length; k++) {
    if (isNaN(sig[k])) continue
    senal[idx[k]] = sig[k]
    cur[idx[k]] = valid[k] - sig[k]
  }
  const prv = new Array(n).fill(NAN)
  let ultimo = NAN
  for (let i = 0; i < n; i++) {
    prv[i] = ultimo
    if (!isNaN(cur[i])) ultimo = cur[i]
  }
  return { cur, prv, linea, senal }
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

// Estocastico clasico (el "Estocástico 14 1 3" de Binance): %K es el precio
// dentro del rango de las ultimas p velas, suavizado; %D es la media de %K.
// OJO que NO es el StochRSI: este mira el PRECIO, el otro mira el RSI.
export function estocasticoSerie(highs, lows, closes, p = 14, suavK = 1, suavD = 3) {
  const n = closes.length
  const crudo = new Array(n).fill(NAN)
  for (let i = p - 1; i < n; i++) {
    let hi = -Infinity
    let lo = Infinity
    for (let j = i - p + 1; j <= i; j++) {
      if (highs[j] > hi) hi = highs[j]
      if (lows[j] < lo) lo = lows[j]
    }
    crudo[i] = hi === lo ? 50 : ((closes[i] - lo) / (hi - lo)) * 100
  }
  const k = sma(crudo, suavK)
  const d = sma(k, suavD)
  return { k, d }
}

// Media movil simple de una serie que puede empezar con NaN.
export function sma(serie, p) {
  const out = new Array(serie.length).fill(NAN)
  if (p <= 1) return serie.slice()
  let suma = 0
  let cuenta = 0
  for (let i = 0; i < serie.length; i++) {
    if (!isNaN(serie[i])) {
      suma += serie[i]
      cuenta++
    }
    if (i >= p) {
      if (!isNaN(serie[i - p])) {
        suma -= serie[i - p]
        cuenta--
      }
    }
    if (cuenta === p) out[i] = suma / p
  }
  return out
}

// EMA que tolera NaN al principio: arranca en el primer valor válido y usa
// el mismo seed (media de los primeros p válidos) que emaSerie. Hace falta
// para el SMI, que encadena EMAs sobre series que empiezan con NaN.
export function emaTolerante(serie, p) {
  const out = new Array(serie.length).fill(NAN)
  const idx = []
  for (let i = 0; i < serie.length; i++) if (!isNaN(serie[i])) idx.push(i)
  if (idx.length < p) return out
  const alpha = 2 / (p + 1)
  let v = 0
  for (let k = 0; k < p; k++) v += serie[idx[k]]
  v /= p
  out[idx[p - 1]] = v
  for (let k = p; k < idx.length; k++) {
    v = serie[idx[k]] * alpha + v * (1 - alpha)
    out[idx[k]] = v
  }
  return out
}

// SMI (Stochastic Momentum Index, de William Blau). A diferencia del
// estocástico clásico, que mide dónde está el cierre dentro del rango, el SMI
// mide la distancia del cierre al CENTRO del rango, y la suaviza dos veces.
// Va de -100 a +100 (0 = el cierre está justo en el medio del rango).
//
// Parámetros por defecto los de TradingView: %K 10, doble suavizado 3 y 3,
// señal EMA 3. Sobrecompra por encima de +40, sobreventa por debajo de -40.
export function smiSerie(highs, lows, closes, n = 10, r = 3, s = 3, sig = 3) {
  const len = closes.length
  const d = new Array(len).fill(NAN)
  const hl = new Array(len).fill(NAN)
  for (let i = n - 1; i < len; i++) {
    let hh = -Infinity
    let ll = Infinity
    for (let j = i - n + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j]
      if (lows[j] < ll) ll = lows[j]
    }
    d[i] = closes[i] - (hh + ll) / 2
    hl[i] = hh - ll
  }
  const ds = emaTolerante(emaTolerante(d, r), s)
  const dhl = emaTolerante(emaTolerante(hl, r), s)
  const smi = new Array(len).fill(NAN)
  for (let i = 0; i < len; i++) {
    if (isNaN(ds[i]) || isNaN(dhl[i]) || dhl[i] === 0) continue
    smi[i] = (200 * ds[i]) / dhl[i]
  }
  return { smi, señal: emaTolerante(smi, sig) }
}

// Arma todas las series de una vez. Acepta cualquier array de velas: el
// Screener de Cruces le pasa la vela en curso incluida a proposito.
export function armarSeries(klinesCerradas) {
  const closes = klinesCerradas.map((k) => +k[4])
  const highs = klinesCerradas.map((k) => +k[2])
  const lows = klinesCerradas.map((k) => +k[3])
  const vols = klinesCerradas.map((k) => +k[5])
  const { cur, prv, linea, senal } = macdSerie(closes)
  const rsi = rsiSerieAlineada(closes)
  const srsi = srsiSerie(closes)
  const est = estocasticoSerie(highs, lows, closes)
  const smi = smiSerie(highs, lows, closes)
  return {
    n: closes.length,
    closes,
    highs,
    lows,
    rsi,
    srsi,
    // Segunda linea del panel de RSI en Binance ("RSI 14 SMA 14").
    rsiSma: sma(rsi, 14),
    // %D del StochRSI: la media de 3 del %K que ya calculamos.
    srsiD: sma(srsi, 3),
    // Estocastico clasico, %K y %D.
    estK: est.k,
    estD: est.d,
    // SMI y su linea de señal.
    smi: smi.smi,
    smiSenal: smi.señal,
    macdCur: cur,
    macdPrv: prv,
    macdLinea: linea,
    macdSenal: senal,
    bb: bbSerie(closes),
    ema20: emaSerie(closes, 20),
    ema50: emaSerie(closes, 50),
    ema200: emaSerie(closes, 200),
    volRatio: volRatioSerie(vols),
    atr: atrSerie(highs, lows, closes),
  }
}
