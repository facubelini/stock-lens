import { describe, expect, it } from 'vitest'
import { entradaDeEvento, infoDesde, masAntigua } from '../../src/lib/compraDesde.js'

describe('infoDesde', () => {
  it('calcula días y retorno desde el cierre de la fecha de inicio', () => {
    const r = infoDesde({ desde: '2026-09-15', precio: 100, precio_hoy: 104.2, aprox: false }, '2026-10-05')
    expect(r.dias).toBe(20)
    expect(r.retorno).toBeCloseTo(4.2, 5)
    expect(r.aprox).toBe(false)
  })
  it('sin precio de inicio no inventa retorno', () => {
    expect(infoDesde({ desde: '2026-09-15', precio: null, precio_hoy: 5 }, '2026-10-05').retorno).toBeNull()
    expect(infoDesde({ desde: '2026-09-15', precio: 0, precio_hoy: 5 }, '2026-10-05').retorno).toBeNull()
  })
  it('sin entrada devuelve null y marca aprox', () => {
    expect(infoDesde(null)).toBeNull()
    expect(infoDesde({ desde: '2026-10-05', precio: 1, precio_hoy: 1, aprox: true }, '2026-10-05')).toMatchObject({ dias: 0, aprox: true })
  })
})

describe('entradas', () => {
  it('entradaDeEvento usa fecha y precios de la fila', () => {
    expect(entradaDeEvento({ fecha: '2026-09-15', precio: 10, precio_hoy: 11 })).toEqual({ desde: '2026-09-15', precio: 10, precio_hoy: 11, aprox: false })
    expect(entradaDeEvento({ ticker: 'X' })).toBeNull()
  })
  it('masAntigua elige la fecha más vieja e ignora nulos', () => {
    expect(masAntigua([null, { desde: '2026-09-20' }, { desde: '2026-09-10' }]).desde).toBe('2026-09-10')
    expect(masAntigua([null])).toBeNull()
  })
})

import { resumenClave } from '../../src/lib/compraDesde.js'

describe('resumenClave', () => {
  const claves = {
    a: {
      inicio: '2026-10-05',
      tickers: {
        X: { desde: '2026-10-05', precio: 100, precio_hoy: 110 },
        Y: { desde: '2026-10-05', precio: 100, precio_hoy: 96 },
        Z: { desde: '2026-10-05', precio: null, precio_hoy: 5 },
      },
    },
  }
  it('promedia, saca mediana y cuenta ganadoras ignorando los sin precio', () => {
    const r = resumenClave(claves, 'a')
    expect(r).toMatchObject({ n: 3, conRetorno: 2, positivas: 1, inicio: '2026-10-05' })
    expect(r.promedio).toBeCloseTo(3, 6)
    expect(r.mediana).toBeCloseTo(3, 6)
  })
  it('clave inexistente devuelve null', () => {
    expect(resumenClave(claves, 'b')).toBeNull()
    expect(resumenClave(null, 'a')).toBeNull()
  })
})
