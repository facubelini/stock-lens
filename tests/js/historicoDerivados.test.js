import { describe, expect, it } from 'vitest'
import {
  estadisticas,
  fechasSemanales,
  lecturaPercentil,
  percentil,
  recortarRango,
  ttmASemanal,
} from '../../src/lib/historicoDerivados.js'

const DIA = 86400000
const utc = (iso) => Date.parse(`${iso}T00:00:00Z`)

describe('fechasSemanales', () => {
  it('viernes consecutivos desde inicio; la ultima es la fecha de la corrida', () => {
    const f = fechasSemanales({ inicio: '2026-09-04', ultima: '2026-09-23', precio: [1, 2, 3, 4] })
    expect(f.slice(0, 3)).toEqual([utc('2026-09-04'), utc('2026-09-11'), utc('2026-09-18')])
    expect(f[3]).toBe(utc('2026-09-23'))
  })
})

describe('ttmASemanal', () => {
  const fechas = ['2026-01-02', '2026-01-09', '2026-01-16', '2026-01-23'].map(utc)

  it('en cada semana, el ultimo valor YA presentado', () => {
    // [fin del periodo, fecha en que se conocio, valor]
    const puntos = [
      ['2025-09-30', '2026-01-05', 10],
      ['2025-12-31', '2026-01-16', 12],
    ]
    expect(ttmASemanal(puntos, fechas)).toEqual([null, 10, 12, 12])
  })

  it('vence despues de la vigencia (empresa que dejo de reportar)', () => {
    expect(ttmASemanal([['2025-09-30', '2026-01-01', 7]], fechas, 10)).toEqual([7, 7, null, null])
  })

  it('sin puntos -> todo null', () => {
    expect(ttmASemanal([], fechas)).toEqual([null, null, null, null])
    expect(ttmASemanal(undefined, fechas)).toEqual([null, null, null, null])
  })
})

describe('percentil', () => {
  it('% de observaciones por debajo, empates cuentan la mitad', () => {
    expect(percentil([1, 2, 3, 4], 3)).toBe(63) // (2 + 0,5) / 4
    expect(percentil([1, 2, 3, 4], 10)).toBe(100)
    expect(percentil([1, 2, 3, 4], 0)).toBe(0)
    expect(percentil([5, 5, 5], 5)).toBe(50)
    expect(percentil([], 1)).toBeNull()
    expect(percentil([1], null)).toBeNull()
  })
})

describe('estadisticas', () => {
  it('promedio, desvio poblacional, mediana, actual y z', () => {
    const serie = [2, 4, 4, 4, 5, 5, 7, 9].map((v, i) => ({ t: i * DIA, v }))
    serie.push({ t: 99 * DIA, v: null }) // el actual es el ultimo NO nulo
    const e = estadisticas(serie)
    expect(e).toMatchObject({ n: 8, promedio: 5, sd: 2, mediana: 4.5, min: 2, max: 9, actual: 9, tActual: 7 * DIA })
    expect(e.z).toBe(2)
    expect(e.percentil).toBe(94) // (7 + 0,5) / 8
    expect(e.cuantil(0)).toBe(2)
    expect(e.cuantil(1)).toBe(9)
  })

  it('ignora no finitos y pide al menos 2 valores', () => {
    expect(estadisticas([{ t: 0, v: 1 }, { t: 1, v: Infinity }])).toBeNull()
    expect(estadisticas([{ t: 0, v: 3 }, { t: 1, v: 3 }]).z).toBeNull() // sd 0
  })
})

describe('recortarRango', () => {
  const ahora = utc('2026-09-23')
  const serie = [utc('2020-01-01'), utc('2024-01-01'), utc('2026-01-01')].map((t) => ({ t, v: 1 }))

  it('recorta por anios y "max" devuelve todo', () => {
    expect(recortarRango(serie, '1y', ahora)).toHaveLength(1)
    expect(recortarRango(serie, '3y', ahora)).toHaveLength(2)
    expect(recortarRango(serie, 'max', ahora)).toBe(serie)
    expect(recortarRango(serie, 'no-existe', ahora)).toBe(serie)
  })
})

describe('lecturaPercentil', () => {
  it('segun el tipo de metrica', () => {
    expect(lecturaPercentil({ lectura: 'caro' }, 10).texto).toBe('barato vs. su historia')
    expect(lecturaPercentil({ lectura: 'caro' }, 90).tono).toBe('malo')
    expect(lecturaPercentil({ lectura: 'barato' }, 90).texto).toBe('barato vs. su historia')
    expect(lecturaPercentil({ lectura: 'alto' }, 80).texto).toBe('alto vs. su historia')
    expect(lecturaPercentil({ lectura: 'caro' }, 50).texto).toBe('en rango medio')
    expect(lecturaPercentil({ lectura: null }, 90)).toBeNull()
    expect(lecturaPercentil({ lectura: 'caro' }, null)).toBeNull()
  })
})
