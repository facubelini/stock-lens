import { describe, expect, it } from 'vitest'
import { APALANCAMIENTOS } from '../../src/lib/crypto/constantes.js'
import { calcLeverage, perfilApalancamiento, precioLiquidacion } from '../../src/lib/crypto/indicadores.js'

const PALANCAS = APALANCAMIENTOS.filter((l) => l >= 5) // 5x .. 125x
const MMRS = [0.004, 0.005, 0.01]

describe('precioLiquidacion (margen aislado, primer tramo)', () => {
  it('formula de Binance para long y short', () => {
    // Long: E(1 - 1/L)/(1 - MMR) · Short: E(1 + 1/L)/(1 + MMR)
    expect(precioLiquidacion(100, 10, 0.01, false).precio).toBeCloseTo((100 * 0.9) / 0.99, 10)
    expect(precioLiquidacion(100, 10, 0.01, true).precio).toBeCloseTo((100 * 1.1) / 1.01, 10)
  })

  for (const mmr of MMRS) {
    for (const lev of PALANCAS) {
      it(`${lev}x MMR ${mmr * 100}%: la liquidacion queda del lado correcto`, () => {
        const long = precioLiquidacion(100, lev, mmr, false)
        const short = precioLiquidacion(100, lev, mmr, true)
        expect(long.precio).toBeLessThanOrEqual(100)
        expect(short.precio).toBeGreaterThanOrEqual(100)
        expect(long.inviable).toBe(1 / lev <= mmr)
        expect(short.inviable).toBe(1 / lev <= mmr)
        if (!long.inviable) {
          expect(long.precio).toBeLessThan(100)
          expect(short.precio).toBeGreaterThan(100)
          // mas apalancamiento -> liquidacion mas cerca de la entrada
          const masLev = PALANCAS.find((l) => l > lev)
          if (masLev && 1 / masLev > mmr) {
            expect(precioLiquidacion(100, masLev, mmr, false).precio).toBeGreaterThan(long.precio)
            expect(precioLiquidacion(100, masLev, mmr, true).precio).toBeLessThan(short.precio)
          }
        }
      })
    }
  }

  it('125x con MMR 1% es inviable y el precio se clava en la entrada (nunca del lado equivocado)', () => {
    const l = precioLiquidacion(100, 125, 0.01, false)
    expect(l.inviable).toBe(true)
    expect(l.cruda).toBeGreaterThan(100) // la formula cruda daria POR ENCIMA de la entrada en un long
    expect(l.precio).toBe(100)
  })
})

describe('calcLeverage · slSafe', () => {
  const tpsl = (isShort, sl) => ({ isShort, entry: 100, sl, tps: [{ mult: 1, precio: isShort ? 95 : 105 }] })

  for (const lev of PALANCAS) {
    it(`${lev}x: el SL es seguro solo si salta ANTES que la liquidacion`, () => {
      const liqL = precioLiquidacion(100, lev, 0.01, false)
      const liqS = precioLiquidacion(100, lev, 0.01, true)
      if (liqL.inviable) {
        expect(calcLeverage(tpsl(false, 99.9), 10, lev, 'isolated').slSafe).toBe(false)
        return
      }
      // long: SL arriba de la liquidacion = seguro; abajo = no
      expect(calcLeverage(tpsl(false, (100 + liqL.precio) / 2), 10, lev, 'isolated').slSafe).toBe(true)
      expect(calcLeverage(tpsl(false, liqL.precio - 0.01), 10, lev, 'isolated').slSafe).toBe(false)
      // short: SL abajo de la liquidacion = seguro; arriba = no
      expect(calcLeverage(tpsl(true, (100 + liqS.precio) / 2), 10, lev, 'isolated').slSafe).toBe(true)
      expect(calcLeverage(tpsl(true, liqS.precio + 0.01), 10, lev, 'isolated').slSafe).toBe(false)
    })
  }

  it('en aislado, un SL mas alla de la liquidacion pierde el margen entero (+ comision de entrada)', () => {
    const r = calcLeverage(tpsl(false, 80), 100, 10, 'isolated', { mmr: 0.01, comision: 0.0005 })
    expect(r.slSafe).toBe(false)
    expect(r.slPnL).toBeCloseTo(-(100 + 1000 * 0.0005))
    expect(r.slPnL).toBe(r.perdidaLiquidacion)
    // en cruzado se reporta la perdida hasta el SL (no se topea en el margen)
    expect(calcLeverage(tpsl(false, 80), 100, 10, 'cross').slPnL).toBeLessThan(r.perdidaLiquidacion)
  })

  it('G/P netas de las dos comisiones', () => {
    const r = calcLeverage(tpsl(false, 99), 100, 10, 'isolated', { mmr: 0.01, comision: 0.001 })
    // qty = 1000 / 100 = 10; TP 105: bruto 50, comisiones 1000*0,001 + 1050*0,001 = 2,05
    expect(r.tps[0].pnl).toBeCloseTo(50 - 2.05)
    expect(r.tps[0].roe).toBe(+((r.tps[0].pnl / 100) * 100).toFixed(1)) // ROE sobre el margen, 1 decimal
    expect(r.posSize).toBe(1000)
  })

  it('sin datos devuelve null', () => {
    expect(calcLeverage(null, 10, 10, 'isolated')).toBeNull()
    expect(calcLeverage(tpsl(false, 99), 0, 10, 'isolated')).toBeNull()
  })
})

describe('perfilApalancamiento', () => {
  it('topes por grupo', () => {
    expect(perfilApalancamiento('BTCUSDT')).toMatchObject({ maxLev: 125, mmr: 0.004 })
    expect(perfilApalancamiento('ETHUSDT')).toMatchObject({ maxLev: 125, mmr: 0.005 })
    expect(perfilApalancamiento('SOLUSDT')).toMatchObject({ maxLev: 75, mmr: 0.01 })
    expect(perfilApalancamiento('PEPEUSDT')).toMatchObject({ maxLev: 50, mmr: 0.01 })
    expect(perfilApalancamiento('TSLAUSDT', { tradfi: true })).toMatchObject({ maxLev: 20 })
  })

  it('con el MMR de cada grupo, su tope maximo no es inviable', () => {
    for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'PEPEUSDT']) {
      const { maxLev, mmr } = perfilApalancamiento(s)
      expect(precioLiquidacion(100, maxLev, mmr, false).inviable).toBe(false)
    }
  })
})
