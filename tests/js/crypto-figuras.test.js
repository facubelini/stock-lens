import { describe, expect, it } from 'vitest'
import {
  FG_SCORE_MIN,
  TIPOS,
  atrPctSerie,
  detectarDoble,
  detectarHch,
  fgCiclo,
} from '../../src/lib/crypto/figuras.js'

// Deteccion y ciclo de vida de las 4 figuras chartistas
// (src/lib/crypto/figuras.js, port de scripts/pipeline/figuras.py) sobre OHLC
// sintetico: misma geometria de cada figura + su transicion de estado al
// romper la neckline, y que una serie sin figura (ruido puro) no dispare
// score alto. Mismas convenciones sinteticas que tests/test_figuras.py
// (conftest.ohlcv / conftest.tramos), portadas 1:1 a JS mas abajo.

// ── Helpers sinteticos (equivalentes a tests/conftest.py) ──────────────────
function tramos(inicio, ...puntos) {
  const serie = [Number(inicio)]
  for (const [n, destino] of puntos) {
    const ini = serie[serie.length - 1]
    for (let k = 1; k <= n; k++) serie.push(ini + (destino - ini) * (k / n))
  }
  return serie
}

// Open=cierre anterior, High/Low = cierre +- rango_pct%, volumen constante
// (o array). Devuelve 'serie' = {high, low, close, volume} (arrays paralelos).
function ohlcv(closes, { rangoPct = 0.5, volumen = 1_000_000 } = {}) {
  const c = closes.map(Number)
  const vol = Array.isArray(volumen) ? volumen : c.map(() => volumen)
  const open = c.map((_, i) => (i === 0 ? c[0] : c[i - 1]))
  const high = c.map((close, i) => Math.max(open[i], close) * (1 + rangoPct / 100))
  const low = c.map((close, i) => Math.min(open[i], close) * (1 - rangoPct / 100))
  return { high, low, close: c, volume: vol }
}

function cicloDe(tipo, cierres, rangoPct = 0.3) {
  const serie = ohlcv(cierres, { rangoPct })
  const atrPct = atrPctSerie(serie)
  return fgCiclo(tipo, serie, atrPct)
}

// ── Doble Techo: 100 -> 80 -> 99.5 (tops a <1% de diferencia, valle 20% abajo) ──
const LEAD = tramos(60, [40, 70]).slice(0, -1) // relleno de calentamiento (>= FG_MIN_RUEDAS antes de la figura)
const DOBLE_TECHO = LEAD.concat(tramos(70, [30, 100], [15, 80], [15, 99.5]))
const DT_COLA = tramos(99.5, [10, 90]).slice(1) // se aleja del segundo techo sin romper
const DT_ROTURA = tramos(90, [5, 74]).slice(1) // rompe la neckline (80)
const DT_SEGUIMIENTO = tramos(74, [4, 68]).slice(1)
const DT_FALLA = tramos(74, [4, 84]).slice(1) // vuelve >3% arriba de la neckline: ruptura fallida

describe('Doble Techo', () => {
  it('formándose', () => {
    const [, ciclo] = cicloDe('doble_techo', DOBLE_TECHO)
    expect(ciclo.estado).toBe('Formándose')
    expect(ciclo.score).toBeGreaterThanOrEqual(0)
    expect(ciclo.score).toBeLessThanOrEqual(100)
    expect(ciclo.detalle.neckline_precio).toBeCloseTo(80, 0)
  })

  it('recién rompió', () => {
    const serie = DOBLE_TECHO.concat(DT_COLA, tramos(90, [1, 74]).slice(1))
    const [, ciclo] = cicloDe('doble_techo', serie)
    expect(ciclo.estado).toBe('Recién rompió')
  })

  it('rompió y confirmó', () => {
    const serie = DOBLE_TECHO.concat(DT_COLA, DT_ROTURA, DT_SEGUIMIENTO)
    const [, ciclo] = cicloDe('doble_techo', serie)
    expect(ciclo.estado).toBe('Rompió y confirmó')
  })

  it('rompió y falló', () => {
    const serie = DOBLE_TECHO.concat(DT_COLA, DT_ROTURA, DT_FALLA)
    const [, ciclo] = cicloDe('doble_techo', serie)
    expect(ciclo.estado).toBe('Rompió y falló')
  })

  it('falló antes de romper (supera el segundo techo antes de perforar la neckline)', () => {
    const supera = tramos(99.5, [6, 106]).slice(1)
    const serie = DOBLE_TECHO.concat(supera)
    const [, ciclo] = cicloDe('doble_techo', serie)
    expect(ciclo.estado).toBe('Falló antes de romper')
  })

  it('asimétrico no detecta (segundo techo 10% más alto: no pasa la tolerancia de simetría 3%)', () => {
    const asimetrico = LEAD.concat(tramos(70, [30, 100], [15, 80], [15, 111]))
    const serie = ohlcv(asimetrico, { rangoPct: 0.3 })
    const atrPct = atrPctSerie(serie)
    expect(detectarDoble(serie, atrPct[atrPct.length - 1], true).detectado).toBe(false)
  })

  // Cross-check numérico contra Python (scripts/pipeline/figuras.py
  // _detectar_doble), MISMA serie sintética, calculado con:
  //   python -c "..." (ver reporte) -> score 64.1, pos_neckline [86, 79.76,
  //   86, 79.76], nivel_invalidacion 100.3, detalle con simetria_pct 0.5,
  //   profundidad_pct 20.08. Atrapa cualquier drift entre los dos ports.
  it('cross-check numérico contra el detector Python (misma serie sintética)', () => {
    const serie = ohlcv(DOBLE_TECHO, { rangoPct: 0.3 })
    const atrPct = atrPctSerie(serie)
    const r = detectarDoble(serie, atrPct[atrPct.length - 1], true)
    expect(r.detectado).toBe(true)
    expect(r.score).toBeCloseTo(64.1, 1)
    expect(r.pos_neckline).toEqual([86, 79.76, 86, 79.76])
    expect(r.nivel_invalidacion).toBeCloseTo(100.3, 1)
    expect(r.detalle.simetria_pct).toBeCloseTo(0.5, 1)
    expect(r.detalle.profundidad_pct).toBeCloseTo(20.08, 1)
    expect(r.detalle.extremo_1.precio).toBeCloseTo(100.3, 1)
    expect(r.detalle.extremo_2.precio).toBeCloseTo(99.8, 1)
  })
})

// ── Doble Piso: espejo (40 -> 60 -> 40.5) ──
const DOBLE_PISO = LEAD.concat(tramos(70, [30, 40], [15, 60], [15, 40.5]))

describe('Doble Piso', () => {
  it('formándose y rompe (confirma)', () => {
    const [, ciclo] = cicloDe('doble_piso', DOBLE_PISO)
    expect(ciclo.estado).toBe('Formándose')
    const cola = tramos(40.5, [10, 50]).slice(1)
    const rotura = tramos(50, [5, 64]).slice(1)
    const seguimiento = tramos(64, [4, 70]).slice(1)
    const [, ciclo2] = cicloDe('doble_piso', DOBLE_PISO.concat(cola, rotura, seguimiento))
    expect(ciclo2.estado).toBe('Rompió y confirmó')
  })
})

// ── HCH: hombro 90 / cabeza 110 / hombro 91, neckline en 75-76 ──
const LEAD_HCH = tramos(60, [40, 75]).slice(0, -1)
const HCH = LEAD_HCH.concat(tramos(75, [20, 90], [10, 75], [15, 110], [15, 76], [10, 91]))

describe('Hombro-Cabeza-Hombro', () => {
  it('formándose', () => {
    const [, ciclo] = cicloDe('hch', HCH)
    expect(ciclo.estado).toBe('Formándose')
    expect(ciclo.detalle.simetria_pct).toBeLessThan(5)
  })

  it('rompe y confirma', () => {
    const cola = tramos(91, [8, 82]).slice(1)
    const rotura = tramos(82, [5, 68]).slice(1)
    const seguimiento = tramos(68, [4, 60]).slice(1)
    const [, ciclo] = cicloDe('hch', HCH.concat(cola, rotura, seguimiento))
    expect(ciclo.estado).toBe('Rompió y confirmó')
  })

  it('hombros asimétricos no detecta', () => {
    const asimetrico = LEAD_HCH.concat(tramos(75, [20, 90], [10, 75], [15, 110], [15, 76], [10, 103]))
    const serie = ohlcv(asimetrico, { rangoPct: 0.3 })
    const atrPct = atrPctSerie(serie)
    expect(detectarHch(serie, atrPct[atrPct.length - 1], true).detectado).toBe(false)
  })

  it('con historial largo la neckline no explota (regresión de posiciones locales vs. absolutas)', () => {
    // 'sub' (la ventana de FG_VENTANA velas) es una COLA de la serie completa;
    // si las posiciones de los swings de la neckline no se convierten a
    // absolutas antes de guardarlas, ciclo() las extrapola como si el
    // desplazamiento fuera 0 y el nivel "de hoy" explota. Un relleno largo
    // ANTES de la figura tiene que dar practicamente el mismo resultado que
    // sin relleno.
    const rellenoLargo = tramos(60, [600, 60]).slice(0, -1) // >> FG_VENTANA, simula historial largo previo (plano en 60)
    const conRelleno = rellenoLargo.concat(HCH)
    const [, ciclo] = cicloDe('hch', conRelleno)
    expect(ciclo.estado).toBe('Formándose')
    const nivel = ciclo.detalle.neckline_precio
    expect(Math.abs(ciclo.neckline_precio_hoy - nivel) / nivel).toBeLessThan(0.15)
    expect(ciclo.dist_neckline_pct).toBeGreaterThanOrEqual(-50)
    expect(ciclo.dist_neckline_pct).toBeLessThanOrEqual(50)
  })

  // Cross-check numérico contra Python (_detectar_hch), misma serie HCH:
  // score 58.3, pos_neckline [71, 74.775, 101, 75.772], nivel_invalidacion
  // 110.33, simetria_pct 1.11, profundidad_pct 21.55.
  it('cross-check numérico contra el detector Python (misma serie sintética)', () => {
    const serie = ohlcv(HCH, { rangoPct: 0.3 })
    const atrPct = atrPctSerie(serie)
    const r = detectarHch(serie, atrPct[atrPct.length - 1], true)
    expect(r.detectado).toBe(true)
    expect(r.score).toBeCloseTo(58.3, 1)
    expect(r.pos_neckline[0]).toBe(71)
    expect(r.pos_neckline[1]).toBeCloseTo(74.775, 2)
    expect(r.pos_neckline[2]).toBe(101)
    expect(r.pos_neckline[3]).toBeCloseTo(75.772, 2)
    expect(r.nivel_invalidacion).toBeCloseTo(110.33, 1)
    expect(r.detalle.simetria_pct).toBeCloseTo(1.11, 1)
    expect(r.detalle.profundidad_pct).toBeCloseTo(21.55, 1)
  })
})

// ── HCH invertido: espejo (hombro 95 / cabeza 60 / hombro 94, neckline 119-120) ──
const LEAD_HCHI = tramos(60, [40, 110]).slice(0, -1)
const HCH_INV = LEAD_HCHI.concat(tramos(110, [20, 95], [10, 120], [15, 60], [15, 119], [10, 94]))

describe('HCH Invertido', () => {
  it('formándose', () => {
    const [, ciclo] = cicloDe('hch_invertido', HCH_INV)
    expect(ciclo.estado).toBe('Formándose')
  })
})

describe('Score y control de ruido', () => {
  it('el score queda en [0, 100] para los 4 tipos', () => {
    const casos = [
      ['doble_techo', DOBLE_TECHO],
      ['doble_piso', DOBLE_PISO],
      ['hch', HCH],
      ['hch_invertido', HCH_INV],
    ]
    for (const [tipo, serie] of casos) {
      const [, ciclo] = cicloDe(tipo, serie)
      expect(ciclo).not.toBeNull()
      expect(ciclo.score).toBeGreaterThanOrEqual(0)
      expect(ciclo.score).toBeLessThanOrEqual(100)
    }
  })

  it('ruido puro no supera casi nunca el umbral de publicación', () => {
    // Una caminata aleatoria puede, por azar, dejar que el ZigZag arme una
    // secuencia H-L-H o H-L-H-L-H que pase la geometria minima — lo que no
    // puede pasar casi nunca es que el SCORE supere FG_SCORE_MIN (eso mediria
    // ademas simetria ajustada, profundidad en ATR y volumen a favor, todo
    // alineado por casualidad). PRNG determinístico (mulberry32 + Box-Muller)
    // para que el test sea reproducible entre corridas.
    let conScoreAlto = 0
    let total = 0
    for (let semilla = 1; semilla <= 40; semilla++) {
      const rng = mulberry32(semilla * 2654435761)
      const normal = () => {
        const u1 = Math.max(rng(), 1e-12)
        const u2 = rng()
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
      }
      const retornos = Array.from({ length: 200 }, () => normal() * 0.012)
      let acumulado = 0
      const precios = retornos.map((r) => {
        acumulado += r
        return 100 * Math.exp(acumulado)
      })
      const vol = Array.from({ length: 200 }, () => 5e5 + rng() * 1.5e6)
      const serie = ohlcv(precios, { rangoPct: 0.5, volumen: vol })
      const atrPct = atrPctSerie(serie)
      for (const tipo of TIPOS) {
        total++
        const [, ciclo] = fgCiclo(tipo, serie, atrPct)
        if (ciclo && ciclo.estado != null && ciclo.score >= FG_SCORE_MIN) conScoreAlto++
      }
    }
    expect(conScoreAlto / total).toBeLessThan(0.15)
  })
})

// PRNG determinístico chico (mulberry32), solo para el control de ruido de arriba.
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
