// Derivados client-side de public/data/fundamental/<TICKER>.json (lo escribe
// scripts/historico_fundamental.py): arma la serie semanal de cada metrica,
// recorta por rango y calcula promedio / desvio / percentil.

const DIA_MS = 24 * 60 * 60 * 1000

// Formatos compartidos por las metricas.
const fmtX = (v) => `${v.toFixed(v >= 100 ? 0 : 1)}x`
const fmtPctSigno = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
const fmtPct = (v) => `${v.toFixed(1)}%`
export function fmtAbrev(v) {
  const abs = Math.abs(v)
  const s = (n, suf) => `${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}${suf}`
  if (abs >= 1e12) return s(v / 1e12, 'T')
  if (abs >= 1e9) return s(v / 1e9, 'B')
  if (abs >= 1e6) return s(v / 1e6, 'M')
  if (abs >= 1e3) return s(v / 1e3, 'K')
  return v.toFixed(2)
}
const fmtPrecio = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2))

// lectura: como leer un percentil alto. 'caro' = multiplo (alto = caro),
// 'barato' = yield (alto = barato), 'alto' = margen/crecimiento (alto =
// mejor), null = sin lectura (precio/absolutos: tienen tendencia, el
// percentil no dice "barato/caro").
export const GRUPOS = [
  {
    id: 'valuacion',
    etiqueta: 'Valuación',
    metricas: [
      { id: 'pe', etiqueta: 'P/E (TTM)', fuente: 'semanal', fmt: fmtX, lectura: 'caro' },
      { id: 'ps', etiqueta: 'P/S (TTM)', fuente: 'semanal', fmt: fmtX, lectura: 'caro' },
      { id: 'ev_sales', etiqueta: 'EV/Sales (TTM)', fuente: 'semanal', fmt: fmtX, lectura: 'caro' },
      { id: 'ev_ebitda', etiqueta: 'EV/EBITDA (TTM)', fuente: 'semanal', fmt: fmtX, lectura: 'caro' },
      { id: 'p_fcf', etiqueta: 'P/FCF (TTM)', fuente: 'semanal', fmt: fmtX, lectura: 'caro' },
      { id: 'pb', etiqueta: 'P/B', fuente: 'semanal', fmt: fmtX, lectura: 'caro' },
      { id: 'fcf_yield', etiqueta: 'FCF yield', fuente: 'semanal', fmt: fmtPct, lectura: 'barato' },
      { id: 'div_yield', etiqueta: 'Dividend yield', fuente: 'semanal', fmt: fmtPct, lectura: 'barato' },
    ],
  },
  {
    id: 'crecimiento',
    etiqueta: 'Crecimiento',
    metricas: [
      { id: 'rev_yoy', etiqueta: 'Revenue YoY (TTM)', fuente: 'ttm', fmt: fmtPctSigno, lectura: 'alto' },
      { id: 'eps_yoy', etiqueta: 'EPS YoY (TTM)', fuente: 'ttm', fmt: fmtPctSigno, lectura: 'alto' },
    ],
  },
  {
    id: 'margenes',
    etiqueta: 'Márgenes',
    metricas: [
      { id: 'm_bruto', etiqueta: 'Margen bruto (TTM)', fuente: 'ttm', fmt: fmtPct, lectura: 'alto' },
      { id: 'm_oper', etiqueta: 'Margen operativo (TTM)', fuente: 'ttm', fmt: fmtPct, lectura: 'alto' },
      { id: 'm_neto', etiqueta: 'Margen neto (TTM)', fuente: 'ttm', fmt: fmtPct, lectura: 'alto' },
      { id: 'm_fcf', etiqueta: 'Margen FCF (TTM)', fuente: 'ttm', fmt: fmtPct, lectura: 'alto' },
    ],
  },
  {
    id: 'absolutos',
    etiqueta: 'Absolutos',
    metricas: [
      { id: 'revenue', etiqueta: 'Revenue (TTM)', fuente: 'ttm', fmt: fmtAbrev, lectura: null, moneda: true },
      { id: 'ebitda', etiqueta: 'EBITDA (TTM)', fuente: 'ttm', fmt: fmtAbrev, lectura: null, moneda: true },
      { id: 'ni', etiqueta: 'Net income (TTM)', fuente: 'ttm', fmt: fmtAbrev, lectura: null, moneda: true },
      { id: 'eps', etiqueta: 'EPS (TTM)', fuente: 'ttm', fmt: (v) => v.toFixed(2), lectura: null, moneda: true },
      { id: 'fcf', etiqueta: 'FCF (TTM)', fuente: 'ttm', fmt: fmtAbrev, lectura: null, moneda: true },
    ],
  },
  {
    id: 'precio',
    etiqueta: 'Precio',
    metricas: [
      { id: 'precio', etiqueta: 'Precio (USD)', fuente: 'semanal', fmt: fmtPrecio, lectura: null },
      { id: 'mcap', etiqueta: 'Market cap (USD)', fuente: 'semanal', fmt: fmtAbrev, lectura: null, escala: 1e6 },
      { id: 'ev', etiqueta: 'Enterprise value (USD)', fuente: 'semanal', fmt: fmtAbrev, lectura: null, escala: 1e6 },
    ],
  },
]

export const METRICAS = Object.fromEntries(
  GRUPOS.flatMap((g) => g.metricas.map((m) => [m.id, { ...m, grupo: g.id }])),
)

export const RANGOS = [
  { id: '1y', etiqueta: '1A', anios: 1 },
  { id: '3y', etiqueta: '3A', anios: 3 },
  { id: '5y', etiqueta: '5A', anios: 5 },
  { id: '10y', etiqueta: '10A', anios: 10 },
  { id: 'max', etiqueta: 'Máx', anios: null },
]

function isoAms(iso) {
  const [a, m, d] = iso.split('-').map(Number)
  return Date.UTC(a, m - 1, d)
}

// Fechas (ms UTC) de la serie semanal: viernes consecutivos desde `inicio`;
// la ultima es `ultima` (el cierre del dia de la corrida, puede no ser viernes).
export function fechasSemanales(semanal) {
  const n = semanal.precio.length
  const t0 = isoAms(semanal.inicio)
  const fechas = Array.from({ length: n }, (_, i) => t0 + i * 7 * DIA_MS)
  if (n && semanal.ultima) fechas[n - 1] = isoAms(semanal.ultima)
  return fechas
}

// Una serie TTM ([[fin, conocido, valor], ...] ordenada por presentacion)
// llevada a las fechas semanales: en cada semana, el ultimo valor YA
// PRESENTADO (conocido <= semana), vigente hasta `vigencia` dias (despues se
// corta: una empresa que dejo de reportar no queda con un dato eterno).
// Misma logica que a_semanal() del pipeline.
export function ttmASemanal(puntos, fechas, vigenciaDias = 460) {
  const salida = new Array(fechas.length).fill(null)
  if (!puntos?.length) return salida
  const conocidos = puntos.map((p) => isoAms(p[1]))
  const vig = vigenciaDias * DIA_MS
  let j = -1
  for (let i = 0; i < fechas.length; i++) {
    while (j + 1 < puntos.length && conocidos[j + 1] <= fechas[i]) j++
    if (j >= 0 && fechas[i] - conocidos[j] <= vig) salida[i] = puntos[j][2]
  }
  return salida
}

// Serie {t, v}[] de una metrica para un ticker ya cargado.
export function serieMetrica(datos, metricaId) {
  if (!datos?.disponible || !datos.semanal) return []
  const m = METRICAS[metricaId]
  if (!m) return []
  const fechas = fechasSemanales(datos.semanal)
  let valores
  if (m.fuente === 'semanal') {
    valores = datos.semanal[metricaId] ?? []
    // market cap / EV vienen en millones de USD
    if (m.escala) valores = valores.map((v) => (v == null ? null : v * m.escala))
  } else {
    valores = ttmASemanal(datos.ttm?.[metricaId], fechas, datos.ttm?.vigencia?.[metricaId])
    // corte: reportante anual cuyo ultimo 20-F todavia no esta en la API de
    // la SEC; desde esa fecha el ultimo dato ya no es el vigente.
    if (datos.ttm?.corte) {
      const corte = isoAms(datos.ttm.corte)
      valores = valores.map((v, i) => (fechas[i] > corte ? null : v))
    }
  }
  return fechas.map((t, i) => ({ t, v: valores[i] ?? null }))
}

export function recortarRango(serie, rangoId, ahora = Date.now()) {
  const r = RANGOS.find((x) => x.id === rangoId)
  if (!r?.anios) return serie
  const corte = ahora - r.anios * 365.25 * DIA_MS
  return serie.filter((p) => p.t >= corte)
}

// Percentil del valor actual: % de observaciones por debajo (los empates
// cuentan la mitad). Misma definicion que percentil() del pipeline.
export function percentil(valores, actual) {
  if (actual == null || !valores.length) return null
  let menores = 0
  let iguales = 0
  for (const v of valores) {
    if (v < actual) menores++
    else if (v === actual) iguales++
  }
  return Math.round(((menores + 0.5 * iguales) / valores.length) * 100)
}

// Estadisticas de la serie visible: promedio, desvio estandar (poblacional),
// mediana, min/max, valor actual (ultimo no nulo), su percentil y a cuantos
// desvios esta del promedio (z = (actual - promedio) / σ).
export function estadisticas(serie) {
  const vals = serie.map((p) => p.v).filter((v) => v != null && Number.isFinite(v))
  if (vals.length < 2) return null
  const n = vals.length
  const promedio = vals.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - promedio) ** 2, 0) / n)
  const orden = [...vals].sort((a, b) => a - b)
  const mediana = n % 2 ? orden[(n - 1) / 2] : (orden[n / 2 - 1] + orden[n / 2]) / 2
  let actual = null
  let tActual = null
  for (let i = serie.length - 1; i >= 0; i--) {
    if (serie[i].v != null) {
      actual = serie[i].v
      tActual = serie[i].t
      break
    }
  }
  return {
    n,
    promedio,
    sd,
    mediana,
    min: orden[0],
    max: orden[n - 1],
    actual,
    tActual,
    percentil: percentil(vals, actual),
    z: sd > 0 && actual != null ? (actual - promedio) / sd : null,
    cuantil: (q) => orden[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))],
  }
}

// "p23 → barato vs. su historia": lectura del percentil segun la metrica.
export function lecturaPercentil(metrica, p) {
  if (p == null || !metrica?.lectura) return null
  const bajo = p <= 25
  const alto = p >= 75
  if (!bajo && !alto) return { texto: 'en rango medio', tono: 'neutro' }
  if (metrica.lectura === 'caro') return bajo ? { texto: 'barato vs. su historia', tono: 'bueno' } : { texto: 'caro vs. su historia', tono: 'malo' }
  if (metrica.lectura === 'barato') return alto ? { texto: 'barato vs. su historia', tono: 'bueno' } : { texto: 'caro vs. su historia', tono: 'malo' }
  return alto ? { texto: 'alto vs. su historia', tono: 'bueno' } : { texto: 'bajo vs. su historia', tono: 'malo' }
}

export function fmtFechaMs(t) {
  const d = new Date(t)
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`
}
