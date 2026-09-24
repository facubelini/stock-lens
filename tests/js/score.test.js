import { describe, expect, it } from 'vitest'
import { CORTES_SCORE, calcularScore, nivelScore } from '../../src/lib/score.js'

describe('calcularScore', () => {
  it('sin ninguna dimension devuelve null', () => {
    expect(calcularScore({})).toBeNull()
    expect(calcularScore({ per_trailing: -5, peg: 0 })).toBeNull() // PER/PEG <= 0 no cuentan
  })

  it('combina las tres dimensiones con sus pesos 40/30/30', () => {
    const r = calcularScore({ dist_sma200: 10, dist_ema50: 5, rsi: 55, per_trailing: 20, peg: 1.5 })
    // Tendencia: (10 + 5 + 50) / 100 -> 65 · Momentum: 100 · Valuacion: (70 + 75) / 2 = 72,5
    const [tend, mom, val] = r.partes
    expect(tend).toMatchObject({ k: 'Tendencia', v: 65, w: 0.4 })
    expect(mom).toMatchObject({ k: 'Momentum', v: 100, w: 0.3 })
    expect(val).toMatchObject({ k: 'Valuación', v: 73, w: 0.3 })
    expect(r.score).toBe(Math.round(65 * 0.4 + 100 * 0.3 + 72.5 * 0.3)) // 78
    expect(r.partes.reduce((a, p) => a + p.wEfectivo, 0)).toBeCloseTo(1)
  })

  it('topea las distancias a las medias', () => {
    const r = calcularScore({ dist_sma200: 100, dist_ema50: -100 })
    // SMA200 topea en +30, EMA50 en -20 -> bruto 10 -> 60
    expect(r.partes[0].v).toBe(60)
    expect(r.partes[0].calculo).toContain('tope ±30')
  })

  it('una media faltante cuenta como 0 y lo aclara en el calculo', () => {
    const r = calcularScore({ dist_sma200: 20 })
    expect(r.partes[0].v).toBe(70)
    expect(r.partes[0].calculo).toContain('la media faltante cuenta como 0')
  })

  it('re-normaliza el peso entre las dimensiones disponibles', () => {
    const r = calcularScore({ rsi: 55 })
    expect(r.score).toBe(100)
    expect(r.partes[0].wEfectivo).toBe(1)
    const r2 = calcularScore({ rsi: 100, per_trailing: 10 }) // momentum 1, valuacion 100, mitad y mitad
    expect(r2.score).toBe(Math.round((1 + 100) / 2))
  })

  it('momentum penaliza los extremos de RSI', () => {
    expect(calcularScore({ rsi: 90 }).partes[0].v).toBe(23) // 100 - 35 * 2,2
    expect(calcularScore({ rsi: 5 }).partes[0].v).toBe(0)
  })
})

describe('nivelScore', () => {
  it('usa los cortes favorable/neutral', () => {
    expect(nivelScore(null).txt).toBe('N/D')
    expect(nivelScore(CORTES_SCORE.favorable).txt).toBe('Favorable')
    expect(nivelScore(CORTES_SCORE.favorable - 1).txt).toBe('Neutral')
    expect(nivelScore(CORTES_SCORE.neutral).txt).toBe('Neutral')
    expect(nivelScore(CORTES_SCORE.neutral - 1).txt).toBe('Flojo')
    expect(nivelScore(0).txt).toBe('Flojo')
  })
})
