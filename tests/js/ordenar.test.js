import { describe, expect, it } from 'vitest'
import { ariaSort, compararValores, crearComparador } from '../../src/lib/ordenar.js'

describe('compararValores', () => {
  it('nulos y NaN siempre al final, en las dos direcciones', () => {
    const vals = [3, null, 1, NaN, undefined, 2]
    expect([...vals].sort((a, b) => compararValores(a, b, 'asc')).slice(0, 3)).toEqual([1, 2, 3])
    expect([...vals].sort((a, b) => compararValores(a, b, 'desc')).slice(0, 3)).toEqual([3, 2, 1])
    for (const dir of ['asc', 'desc']) {
      const ult = [...vals].sort((a, b) => compararValores(a, b, dir)).slice(3)
      expect(ult.every((v) => v == null || Number.isNaN(v))).toBe(true)
    }
    expect(compararValores(null, undefined)).toBe(0)
  })

  it('strings con localeCompare en español (acentos y ñ)', () => {
    const nombres = ['Ñandú', 'Nación', 'Árbol', 'zeta', 'Banco']
    expect([...nombres].sort((a, b) => compararValores(a, b, 'asc'))).toEqual(['Árbol', 'Banco', 'Nación', 'Ñandú', 'zeta'])
  })

  it('numeros por resta, desc por defecto', () => {
    expect([1, 10, 2].sort((a, b) => compararValores(a, b))).toEqual([10, 2, 1])
    expect([-1.5, -3, 0].sort((a, b) => compararValores(a, b, 'asc'))).toEqual([-3, -1.5, 0])
  })
})

describe('crearComparador', () => {
  const filas = [
    { ticker: 'AAA', v: 1 },
    { ticker: 'BBB', v: 3 },
    { ticker: 'CCC', v: null },
    { ticker: 'DDD', v: 2 },
  ]

  it('ordena por el getter', () => {
    const orden = [...filas].sort(crearComparador((f) => f.v, 'desc')).map((f) => f.ticker)
    expect(orden).toEqual(['BBB', 'DDD', 'AAA', 'CCC'])
  })

  it('los favoritos van primero y despues se aplica el orden', () => {
    const pins = new Set(['AAA', 'CCC'])
    const orden = [...filas].sort(crearComparador((f) => f.v, 'desc', pins)).map((f) => f.ticker)
    expect(orden).toEqual(['AAA', 'CCC', 'BBB', 'DDD'])
  })

  it('sin getter no reordena (salvo pins)', () => {
    expect(crearComparador(null)(filas[0], filas[1])).toBe(0)
  })
})

it('ariaSort', () => {
  expect(ariaSort(false, 'asc')).toBe('none')
  expect(ariaSort(true, 'asc')).toBe('ascending')
  expect(ariaSort(true, 'desc')).toBe('descending')
})
