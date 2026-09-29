// Port 1:1 de scripts/pipeline/figuras.py (STOCKS, daily-only) a cripto:
// mismos umbrales, mismos estados de ciclo de vida, misma formula de score.
// La UNICA diferencia real es la temporalidad de las velas: en acciones
// figuras.py siempre trabaja con velas DIARIAS (yfinance interval="1d"); acá
// el llamador elige la temporalidad (1m/3m/15m/1h/4h/1d, las mismas del
// Crypto Screener v1) y "150 ruedas" / "90 ruedas" son simplemente 150/90
// VELAS de esa temporalidad — 150 velas de 1m son 2,5 horas, 150 velas de 1d
// son 7 meses. La geometria (zigzag + 4 detectores + ciclo de vida + score)
// es EXACTAMENTE la misma en cualquier temporalidad: no hay ningun ajuste
// especial para cripto en los umbrales.
//
// Convencion de este modulo (compartida con el resto de src/lib/crypto): los
// arrays de entrada son SOLO velas CERRADAS (la vela en curso se descarta
// antes de llamar aca, igual que analyzeKlines de indicadores.js).
//
// Los campos del "detalle" se dejan en snake_case (extremo_1, neckline_precio,
// hombro_izquierdo, dist_neckline_pct...) a proposito, para que calquen 1:1
// los nombres de figuras.py/figuras.json de la version STOCK y una comparacion
// numerica entre los dos ports sea directa (ver tests/js/crypto-figuras.test.js).

import { atrSerie } from './series.js'

// ── Umbrales (IDENTICOS a scripts/pipeline/figuras.py, mismas constantes FG_*) ──
export const FG_VENTANA = 150 // velas de la ventana de busqueda (ancha: el HCH necesita 5 swings)
export const FG_MIN_RUEDAS = 90 // minimo de historia (en VELAS de la temporalidad elegida) para intentar
export const FG_UMBRAL_MIN = 3.0 // % minimo del umbral adaptativo del ZigZag
export const FG_UMBRAL_ATR = 1.5 // multiplicador de ATR14% del umbral

export const FG_TOL_SIMETRIA_DOBLE = 3.0 // % de tolerancia entre los dos techos/pisos del doble techo/piso
export const FG_MIN_VALLE_DOBLE = 5.0 // % minimo que el valle/pico intermedio tiene que estar mas alla de los dos extremos
export const FG_TOL_HOMBROS = 5.0 // % de tolerancia entre los dos hombros del HCH
export const FG_MIN_CABEZA = 3.0 // % minimo que la cabeza tiene que sobresalir del promedio de los hombros
export const FG_TOL_NECKLINE_HCH = 8.0 // % maximo de diferencia entre los dos puntos de la neckline del HCH
export const FG_MAX_ANTIGUEDAD = 40 // velas: el extremo que cierra la figura no puede ser mas viejo que esto

export const FG_RUEDAS_CICLO = 15 // velas hacia atras donde se busca la ruptura (o la falla) de la figura
export const FG_RUEDAS_RECIEN = 3 // "Recién rompió": ruptura en las ultimas 3 velas
export const FG_TOL_FALLA = 3.0 // % del otro lado de la neckline que, despues de romper, cuenta como ruptura fallida
export const FG_SEGUIMIENTO = 3.0 // % a favor de la ruptura que confirma seguimiento (o 2 cierres seguidos a favor)
export const FG_SCORE_MIN = 55 // score minimo para publicar la figura

export const FG_RADIO_VOL = 2 // velas a cada lado de un swing donde se promedia el volumen
export const FG_CLIMAX_VOL = 1.5 // volumen >= 1,5x el promedio de 20 velas cuenta como "clímax" en la ruptura

export const TIPOS = ['doble_techo', 'doble_piso', 'hch', 'hch_invertido']
export const NOMBRE_TIPO = {
  doble_techo: 'Doble Techo',
  doble_piso: 'Doble Piso',
  hch: 'Hombro-Cabeza-Hombro',
  hch_invertido: 'HCH Invertido',
}
export const BAJISTA = { doble_techo: true, doble_piso: false, hch: true, hch_invertido: false }

// ── Helpers numericos (equivalentes a comun.py: es_valido / lineal / num) ──
function esValido(x) {
  return x != null && Number.isFinite(x)
}

// Mapa lineal x0->y0, x1->y1, recortado al tramo [y0,y1] (sirve tambien con x0>x1).
function lineal(x, x0, x1, y0, y1) {
  if (!esValido(x) || x1 === x0) return y0
  const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)))
  return y0 + t * (y1 - y0)
}

// Redondea a 'dec' decimales; null si no es un numero finito.
export function num(v, dec = 2) {
  if (v == null || typeof v === 'boolean') return null
  const f = Number(v)
  if (!Number.isFinite(f)) return null
  const m = 10 ** dec
  return Math.round(f * m) / m
}

function _umbral(atrPct) {
  return esValido(atrPct) ? Math.max(FG_UMBRAL_MIN, FG_UMBRAL_ATR * atrPct) : FG_UMBRAL_MIN
}

// ── ZigZag adaptativo (port 1:1 de ws_zigzag, scripts/pipeline/vcp.py) ──
// Swings de un ZigZag sobre maximos/minimos: un giro se confirma cuando el
// precio se aleja 'umbralPct' % del extremo vigente. Devuelve
// [[posicion, 'H'|'L', precio], ...] con el ultimo extremo (sin confirmar) al final.
export function wsZigzag(high, low, umbralPct) {
  const u = umbralPct / 100
  const swings = []
  let tendencia = null
  let iMax = 0
  let iMin = 0
  let iExt = 0
  for (let i = 0; i < high.length; i++) {
    if (tendencia === null) {
      if (high[i] > high[iMax]) iMax = i
      if (low[i] < low[iMin]) iMin = i
      if (high[i] >= low[iMin] * (1 + u) && iMin < i) {
        swings.push([iMin, 'L', low[iMin]])
        tendencia = 'sube'
        iExt = i
      } else if (low[i] <= high[iMax] * (1 - u) && iMax < i) {
        swings.push([iMax, 'H', high[iMax]])
        tendencia = 'baja'
        iExt = i
      }
      continue
    }
    if (tendencia === 'sube') {
      if (high[i] >= high[iExt]) iExt = i
      else if (low[i] <= high[iExt] * (1 - u)) {
        swings.push([iExt, 'H', high[iExt]])
        tendencia = 'baja'
        iExt = i
      }
    } else {
      if (low[i] <= low[iExt]) iExt = i
      else if (high[i] >= low[iExt] * (1 + u)) {
        swings.push([iExt, 'L', low[iExt]])
        tendencia = 'sube'
        iExt = i
      }
    }
  }
  if (tendencia === 'sube') swings.push([iExt, 'H', high[iExt]])
  else if (tendencia === 'baja') swings.push([iExt, 'L', low[iExt]])
  return swings
}

// ── Series completas (equivalente al DataFrame de figuras.py, con arrays) ──
// 'serie' = { high, low, close, volume } (arrays paralelos, SOLO velas cerradas).

function sliceSerie(serie, hasta) {
  return {
    high: serie.high.slice(0, hasta),
    low: serie.low.slice(0, hasta),
    close: serie.close.slice(0, hasta),
    volume: serie.volume.slice(0, hasta),
  }
}

function swingsVentana(serie, atrPct) {
  const n = serie.close.length
  const desplazamiento = Math.max(0, n - FG_VENTANA)
  const sub = {
    high: serie.high.slice(desplazamiento),
    low: serie.low.slice(desplazamiento),
    close: serie.close.slice(desplazamiento),
    volume: serie.volume.slice(desplazamiento),
  }
  const swings = wsZigzag(sub.high, sub.low, _umbral(atrPct))
  return { sub, swings, desplazamiento }
}

// Recta entre dos puntos (posicion, precio); si son el mismo punto (los
// dobles techo/piso tienen una neckline de un solo punto) devuelve un nivel
// constante. Se evalua en cualquier posicion (incluso futuras).
function nivelRecta(p1, precio1, p2, precio2) {
  if (p2 === p1) return () => precio1
  const pend = (precio2 - precio1) / (p2 - p1)
  return (i) => precio1 + pend * (i - p1)
}

function volProm(vol, pos, radio = FG_RADIO_VOL) {
  const a = Math.max(0, pos - radio)
  const b = Math.min(vol.length - 1, pos + radio)
  let suma = 0
  let n = 0
  for (let i = a; i <= b; i++) {
    suma += vol[i]
    n++
  }
  return n ? suma / n : 0
}

// Si la figura YA rompio su neckline dentro de esta misma ventana (despues de
// 'posFin', el swing que la cierra), devuelve si esa ruptura tuvo clímax de
// volumen (>= 1,5x el promedio de las 20 velas previas). false si todavia no
// rompio en esta ventana.
function spikeRuptura(close, vol, nivelFn, posFin, bajista) {
  const n = close.length
  for (let i = posFin + 1; i < n; i++) {
    const nivel = nivelFn(i)
    const cruzo = bajista ? close[i] < nivel : close[i] > nivel
    if (cruzo) {
      const desde = Math.max(0, i - 20)
      let suma = 0
      let cnt = 0
      for (let j = desde; j < i; j++) {
        suma += vol[j]
        cnt++
      }
      const prom20 = cnt ? suma / cnt : 0
      return prom20 > 0 && vol[i] / prom20 >= FG_CLIMAX_VOL
    }
  }
  return false
}

// Doble Techo (bajista=true) / Doble Piso (bajista=false): dos swings del
// mismo signo (H-H para el techo, L-L para el piso) de altura/profundidad
// similar (tolerancia ±3%), separados por EXACTAMENTE un swing intermedio del
// signo contrario que este al menos 5% mas alla de los dos extremos. Se toma
// la ULTIMA terna valida de la ventana cuyo segundo extremo no tenga mas de
// FG_MAX_ANTIGUEDAD velas.
export function detectarDoble(serie, atrPct, bajista) {
  const vacio = { detectado: false, score: 0 }
  if (serie.close.length < FG_MIN_RUEDAS) return vacio
  const { sub, swings, desplazamiento } = swingsVentana(serie, atrPct)
  const tipoExtremo = bajista ? 'H' : 'L'
  const tipoMedio = bajista ? 'L' : 'H'
  const n = sub.close.length
  const vol = sub.volume
  let mejor = null
  for (let i = 0; i < swings.length - 2; i++) {
    const s1 = swings[i]
    const s2 = swings[i + 1]
    const s3 = swings[i + 2]
    if (!(s1[1] === tipoExtremo && s2[1] === tipoMedio && s3[1] === tipoExtremo)) continue
    const p1 = s1[2]
    const p2 = s2[2]
    const p3 = s3[2]
    const ref = bajista ? Math.min(p1, p3) : Math.max(p1, p3)
    if (!ref) continue
    const simetriaPct = (Math.abs(p1 - p3) / ref) * 100
    if (simetriaPct > FG_TOL_SIMETRIA_DOBLE) continue
    const profundidadPct = bajista ? ((ref - p2) / ref) * 100 : ((p2 - ref) / ref) * 100
    if (profundidadPct < FG_MIN_VALLE_DOBLE) continue
    if (n - 1 - s3[0] > FG_MAX_ANTIGUEDAD) continue
    mejor = [s1, s2, s3, simetriaPct, profundidadPct]
  }
  if (mejor === null) return vacio
  const [s1, s2, s3, simetriaPct, profundidadPct] = mejor
  const p1 = s1[2]
  const p2 = s2[2]
  const p3 = s3[2]
  const nivelFn = nivelRecta(s2[0], p2, s2[0], p2)
  const breakoutSpike = spikeRuptura(sub.close, vol, nivelFn, s3[0], bajista)

  const ptsSimetria = lineal(simetriaPct, FG_TOL_SIMETRIA_DOBLE, 0, 0, 35)
  const profundidadAtr = esValido(atrPct) && atrPct ? profundidadPct / atrPct : profundidadPct / 3.0
  const ptsProfundidad = lineal(profundidadAtr, 1.5, 5.0, 0, 35)
  const vol1 = volProm(vol, s1[0])
  const vol3 = volProm(vol, s3[0])
  const ptsVol = (vol3 < vol1 ? 15 : 0) + (breakoutSpike ? 15 : 0)
  const score = Math.min(100.0, ptsSimetria + ptsProfundidad + ptsVol)

  // 'pos_neckline' en posiciones ABSOLUTAS de 'serie' (no de 'sub'): ver el
  // comentario de detectarHch, aca da lo mismo porque la neckline del doble
  // techo/piso es un solo punto sin pendiente, pero se corrige igual para no
  // depender de ese detalle de implementacion (mismo bug que se corrigio en
  // la version stock: posiciones LOCALES a la ventana filtrandose como si
  // fueran absolutas del historial completo).
  return {
    detectado: true,
    score: num(score, 1),
    pos_neckline: [s2[0] + desplazamiento, p2, s2[0] + desplazamiento, p2],
    nivel_invalidacion: bajista ? Math.max(p1, p3) : Math.min(p1, p3),
    detalle: {
      extremo_1: { hace: n - 1 - s1[0], precio: num(p1, 8) },
      extremo_2: { hace: n - 1 - s3[0], precio: num(p3, 8) },
      neckline_precio: num(p2, 8),
      neckline_hace: n - 1 - s2[0],
      neckline_pendiente_pct: 0.0,
      simetria_pct: num(simetriaPct, 2),
      profundidad_pct: num(profundidadPct, 2),
      vol_decreciente: vol3 < vol1,
    },
  }
}

// H-C-H (bajista=true): 5 swings CONSECUTIVOS H-L-H-L-H con la cabeza (el H
// del medio) al menos FG_MIN_CABEZA% mas alta que el promedio de los dos
// hombros, hombros dentro de ±5% entre si. La neckline es la recta entre los
// dos L intermedios; si estan a mas de FG_TOL_NECKLINE_HCH% uno del otro se
// descarta (seria un canal, no un cuello). H-C-H invertido (bajista=false):
// mismo esquema con L-H-L-H-L, cabeza mas BAJA que los hombros.
export function detectarHch(serie, atrPct, bajista) {
  const vacio = { detectado: false, score: 0 }
  if (serie.close.length < FG_MIN_RUEDAS) return vacio
  const { sub, swings, desplazamiento } = swingsVentana(serie, atrPct)
  const tipoHombro = bajista ? 'H' : 'L'
  const tipoValle = bajista ? 'L' : 'H'
  const n = sub.close.length
  const vol = sub.volume
  const esperado = [tipoHombro, tipoValle, tipoHombro, tipoValle, tipoHombro]
  let mejor = null
  for (let i = 0; i < swings.length - 4; i++) {
    const s = swings.slice(i, i + 5)
    if (!s.every((x, k) => x[1] === esperado[k])) continue
    const [hi, l1, cab, l2, hd] = s
    const pHi = hi[2]
    const pL1 = l1[2]
    const pCab = cab[2]
    const pL2 = l2[2]
    const pHd = hd[2]
    const refHombros = (pHi + pHd) / 2
    if (!refHombros || !Math.min(pHi, pHd)) continue
    const simetriaPct = (Math.abs(pHi - pHd) / Math.min(pHi, pHd)) * 100
    if (simetriaPct > FG_TOL_HOMBROS) continue
    const prominenciaPct = bajista ? ((pCab - refHombros) / refHombros) * 100 : ((refHombros - pCab) / refHombros) * 100
    if (prominenciaPct < FG_MIN_CABEZA) continue
    const refNeck = bajista ? Math.min(pL1, pL2) : Math.max(pL1, pL2)
    if (!refNeck) continue
    const pendNeckPct = (Math.abs(pL1 - pL2) / refNeck) * 100
    if (pendNeckPct > FG_TOL_NECKLINE_HCH) continue
    if (n - 1 - hd[0] > FG_MAX_ANTIGUEDAD) continue
    mejor = [hi, l1, cab, l2, hd, simetriaPct, prominenciaPct]
  }
  if (mejor === null) return vacio
  const [hi, l1, cab, l2, hd, simetriaPct, prominenciaPct] = mejor
  const pHi = hi[2]
  const pL1 = l1[2]
  const pCab = cab[2]
  const pL2 = l2[2]
  const pHd = hd[2]
  // nivelFn LOCAL a 'sub' (para el clímax de ruptura dentro de esta misma
  // ventana, mas abajo): valido porque tanto la posicion de anclaje como las
  // posiciones donde se evalua son locales, todas en el mismo marco.
  const nivelFn = nivelRecta(l1[0], pL1, l2[0], pL2)
  const pendientePct = l2[0] !== l1[0] ? (((pL2 - pL1) / (l2[0] - l1[0])) / ((pL1 + pL2) / 2)) * 100 : 0.0
  const breakoutSpike = spikeRuptura(sub.close, vol, nivelFn, hd[0], bajista)

  const ptsSimetria = lineal(simetriaPct, FG_TOL_HOMBROS, 0, 0, 30)
  const prominenciaAtr = esValido(atrPct) && atrPct ? prominenciaPct / atrPct : prominenciaPct / 3.0
  const ptsProminencia = lineal(prominenciaAtr, 1.0, 5.0, 0, 35)
  const vi = volProm(vol, hi[0])
  const vc = volProm(vol, cab[0])
  const vd = volProm(vol, hd[0])
  const decrecCount = (vc < vi ? 1 : 0) + (vd < vi ? 1 : 0)
  const ptsVolDecrec = { 0: 0, 1: 10, 2: 20 }[decrecCount]
  const ptsVol = Math.min(35, ptsVolDecrec + (breakoutSpike ? 15 : 0))
  const score = Math.min(100.0, ptsSimetria + ptsProminencia + ptsVol)

  // 'sub' es la COLA de 'serie' (tail(FG_VENTANA)): las posiciones de los
  // swings son locales a 'sub'. ciclo() evalua la neckline en posiciones
  // ABSOLUTAS de la 'serie' completa (para poder interpolar/extrapolar contra
  // cierres de velas futuras, incluso mucho despues de esta ventana), asi que
  // hay que correrlas por 'desplazamiento' antes de guardarlas en
  // 'pos_neckline' — este es EXACTAMENTE el bug de neckline-position que la
  // version stock tuvo y corrigio (posiciones locales a la ventana usadas
  // como si fueran absolutas del historial completo): con mas historial que
  // FG_VENTANA la pendiente se extrapolaria miles de posiciones de mas y el
  // nivel "de hoy" daria un numero absurdo. Se porta ya corregido desde el
  // arranque.
  return {
    detectado: true,
    score: num(score, 1),
    pos_neckline: [l1[0] + desplazamiento, pL1, l2[0] + desplazamiento, pL2],
    nivel_invalidacion: bajista ? Math.max(pHi, pCab, pHd) : Math.min(pHi, pCab, pHd),
    detalle: {
      hombro_izquierdo: { hace: n - 1 - hi[0], precio: num(pHi, 8) },
      cabeza: { hace: n - 1 - cab[0], precio: num(pCab, 8) },
      hombro_derecho: { hace: n - 1 - hd[0], precio: num(pHd, 8) },
      neckline_precio: num(pL2, 8),
      neckline_hace: n - 1 - l2[0],
      neckline_pendiente_pct: num(pendientePct, 3),
      simetria_pct: num(simetriaPct, 2),
      profundidad_pct: num(prominenciaPct, 2),
      vol_decreciente: decrecCount >= 1,
    },
  }
}

// Ciclo de vida generico (Formándose / Recién rompió / Rompió y confirmó /
// Rompió sin confirmar / Falló antes de romper / Rompió y falló): se
// re-detecta la figura con los datos cortados en cada una de las ultimas
// FG_RUEDAS_CICLO velas, porque la ruptura crea un swing nuevo y la deteccion
// de HOY ya no ve la figura vieja. Devuelve [hoyConEstado, fila|null].
function ciclo(serie, atrPctSerie, detectarFn, bajista, cache = {}) {
  const n = serie.close.length
  const closes = serie.close

  function det(i) {
    if (!(i in cache)) {
      const a = atrPctSerie[i]
      cache[i] = detectarFn(sliceSerie(serie, i + 1), esValido(a) ? a : null)
    }
    return cache[i]
  }

  const hoy = det(n - 1)

  function fila(base, estado, extra = {}) {
    const nivelFn = nivelRecta(...base.pos_neckline)
    const nivelHoy = nivelFn(n - 1)
    const precio = closes[n - 1]
    return {
      score: base.score,
      detalle: base.detalle,
      neckline_precio_hoy: num(nivelHoy, 8),
      dist_neckline_pct: nivelHoy ? num((precio / nivelHoy - 1) * 100, 2) : null,
      estado,
      ...extra,
    }
  }

  // 1. Ruptura en las ultimas FG_RUEDAS_CICLO velas (la mas reciente).
  for (let hace = 0; hace <= FG_RUEDAS_CICLO; hace++) {
    const b = n - 1 - hace
    if (b < FG_MIN_RUEDAS) break
    // una ruptura bajista siempre cierra mas abajo que la vela anterior (y al reves la alcista)
    if ((closes[b] < closes[b - 1]) !== bajista) continue
    const base = det(b - 1)
    if (!base.detectado) continue
    const nivelFn = nivelRecta(...base.pos_neckline)
    const nivelAnt = nivelFn(b - 1)
    const nivelB = nivelFn(b)
    const cruce = bajista
      ? closes[b - 1] >= nivelAnt && closes[b] < nivelB
      : closes[b - 1] <= nivelAnt && closes[b] > nivelB
    if (!cruce) continue
    const tramo = closes.slice(b)
    const distTramo = tramo.map((c, k) => (c / nivelFn(b + k) - 1) * 100)
    const fallo = bajista ? distTramo.some((d) => d > FG_TOL_FALLA) : distTramo.some((d) => d < -FG_TOL_FALLA)
    let estado
    if (fallo) {
      estado = 'Rompió y falló'
    } else if (hace < FG_RUEDAS_RECIEN) {
      estado = 'Recién rompió'
    } else {
      let ok
      if (bajista) {
        const seguimiento =
          Math.min(...distTramo) <= -FG_SEGUIMIENTO || tramo.slice(1).filter((v) => v < tramo[0]).length >= 2
        ok = distTramo.every((d) => d <= 0) && seguimiento
      } else {
        const seguimiento =
          Math.max(...distTramo) >= FG_SEGUIMIENTO || tramo.slice(1).filter((v) => v > tramo[0]).length >= 2
        ok = distTramo.every((d) => d >= 0) && seguimiento
      }
      estado = ok ? 'Rompió y confirmó' : 'Rompió sin confirmar'
    }
    return [{ ...hoy, estado }, fila(base, estado, { hace_ruptura: hace })]
  }

  // 2. Figura completa hoy, sin ruptura todavia.
  if (hoy.detectado) return [{ ...hoy, estado: 'Formándose' }, fila(hoy, 'Formándose')]

  // 3. Figura que se invalido: el precio supero/perforo sus propios extremos antes de romper la neckline.
  for (let hace = 1; hace <= FG_RUEDAS_CICLO; hace++) {
    const i = n - 1 - hace
    if (i < FG_MIN_RUEDAS) break
    const base = det(i)
    if (base.detectado) {
      const lim = base.nivel_invalidacion
      const tramo = closes.slice(i + 1)
      const invalido = bajista ? tramo.some((c) => c > lim) : tramo.some((c) => c < lim)
      if (invalido) {
        return [{ ...hoy, estado: 'Falló antes de romper' }, fila(base, 'Falló antes de romper', { hace_base: hace })]
      }
      break
    }
  }
  return [{ ...hoy, estado: null }, null]
}

// fg_ciclo-like para 'tipo' en TIPOS: detecta + ciclo de vida.
export function fgCiclo(tipo, serie, atrPctSerie, cache) {
  const bajista = BAJISTA[tipo]
  const detectarFn =
    tipo === 'doble_techo' || tipo === 'doble_piso'
      ? (s, a) => detectarDoble(s, a, bajista)
      : (s, a) => detectarHch(s, a, bajista)
  return ciclo(serie, atrPctSerie, detectarFn, bajista, cache ?? {})
}

// Serie de ATR14% (ATR de Wilder / cierre * 100), alineada a 'serie.close'.
export function atrPctSerie(serie) {
  const atr = atrSerie(serie.high, serie.low, serie.close, 14)
  return atr.map((a, i) => (Number.isFinite(a) && serie.close[i] ? (a / serie.close[i]) * 100 : Number.NaN))
}

// Normaliza velas crudas de Binance (arrays [openTime, open, high, low,
// close, volume, closeTime, ...]) al formato {openTime, open, high, low,
// close, volume} que usa este modulo. El llamador tiene que pasar SOLO velas
// CERRADAS (slice(0,-1), misma convencion que analyzeKlines/calcTPSL).
export function velasNormalizadas(klinesRaw) {
  return klinesRaw.map((k) => ({
    openTime: +k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }))
}

// Detecta las 4 figuras chartistas sobre un array de velas CERRADAS (objetos
// {openTime,open,high,low,close,volume} — ver velasNormalizadas). Devuelve
// una lista de 0 a 4 dicts (una por tipo con estado != null y score >=
// FG_SCORE_MIN), igual criterio que figuras_ticker de la version stock.
export function figurasSimbolo(velas) {
  if (!velas || velas.length < FG_MIN_RUEDAS) return []
  const serie = {
    high: velas.map((v) => v.high),
    low: velas.map((v) => v.low),
    close: velas.map((v) => v.close),
    volume: velas.map((v) => (Number.isFinite(v.volume) ? v.volume : 0)),
  }
  const atrPct = atrPctSerie(serie)
  const salida = []
  for (const tipo of TIPOS) {
    const [, c] = fgCiclo(tipo, serie, atrPct)
    if (!c || c.estado == null || (c.score ?? 0) < FG_SCORE_MIN) continue
    salida.push({ tipo, ...c })
  }
  return salida
}
