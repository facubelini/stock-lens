import { describe, expect, it } from 'vitest'
import { chequearFrescura, esFinDeSemana, horasDesde, umbralHoras } from '../../src/lib/frescura'

describe('esFinDeSemana', () => {
  it('lunes no es fin de semana', () => {
    // 2026-09-21 es lunes (UTC-3 => sigue siendo lunes en AR a mediodia UTC)
    expect(esFinDeSemana(new Date('2026-09-21T12:00:00Z'))).toBe(false)
  })

  it('sabado es fin de semana', () => {
    expect(esFinDeSemana(new Date('2026-09-19T12:00:00Z'))).toBe(true)
  })

  it('domingo es fin de semana', () => {
    expect(esFinDeSemana(new Date('2026-09-20T12:00:00Z'))).toBe(true)
  })
})

describe('umbralHoras', () => {
  it('26 en semana, 74 el fin de semana', () => {
    expect(umbralHoras(new Date('2026-09-21T12:00:00Z'))).toBe(26)
    expect(umbralHoras(new Date('2026-09-19T12:00:00Z'))).toBe(74)
  })
})

describe('horasDesde', () => {
  it('calcula la diferencia en horas', () => {
    const ahora = new Date('2026-09-21T12:00:00Z')
    const antes = new Date('2026-09-21T06:00:00Z').toISOString()
    expect(horasDesde(antes, ahora)).toBeCloseTo(6, 5)
  })

  it('null si falta el iso', () => {
    expect(horasDesde(null)).toBeNull()
    expect(horasDesde(undefined)).toBeNull()
  })

  it('null si el iso es invalido', () => {
    expect(horasDesde('no-es-una-fecha')).toBeNull()
  })
})

describe('chequearFrescura', () => {
  it('no desactualizado por debajo del umbral en semana', () => {
    const ahora = new Date('2026-09-22T12:00:00Z') // martes
    const meta = new Date('2026-09-22T00:00:00Z').toISOString() // 12h antes
    const r = chequearFrescura(meta, ahora)
    expect(r.desactualizado).toBe(false)
    expect(r.umbral).toBe(26)
  })

  it('desactualizado por encima del umbral en semana (27h)', () => {
    const ahora = new Date('2026-09-22T12:00:00Z') // martes
    const meta = new Date('2026-09-21T09:00:00Z').toISOString() // 27h antes
    const r = chequearFrescura(meta, ahora)
    expect(r.desactualizado).toBe(true)
  })

  it('no desactualizado el fin de semana con 30h (umbral 74)', () => {
    const ahora = new Date('2026-09-20T12:00:00Z') // domingo
    const meta = new Date('2026-09-19T06:00:00Z').toISOString() // 30h antes
    const r = chequearFrescura(meta, ahora)
    expect(r.desactualizado).toBe(false)
    expect(r.umbral).toBe(74)
  })

  it('desactualizado el fin de semana por encima de 74h', () => {
    const ahora = new Date('2026-09-20T12:00:00Z') // domingo
    const meta = new Date('2026-09-17T09:00:00Z').toISOString() // 75h antes
    const r = chequearFrescura(meta, ahora)
    expect(r.desactualizado).toBe(true)
  })

  it('no desactualizado si falta meta (nada que avisar)', () => {
    expect(chequearFrescura(null).desactualizado).toBe(false)
  })
})
