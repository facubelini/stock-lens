import { describe, expect, it } from 'vitest'
import { armarCandidatos } from '../../src/lib/candidatos.js'

// Pilar generico "lleno" (una fraccion x de su maximo) para armar warren
// rows sinteticos sin repetir la forma completa en cada test.
function pilar(pts, max) {
  return { pts, max }
}

function warrenBase(ticker, extra = {}) {
  return {
    ticker,
    nombre: `${ticker} Inc.`,
    sector: 'Technology',
    total_score: 70,
    rank: 1,
    total: 1,
    datos_suficientes: true,
    stage: { n: 2, label: 'Avance confirmado', tip: 'tip' },
    caps: [],
    pilares: {
      tendencia: pilar(20, 25),
      fuerza: pilar(22, 30), // 73% >= 60%
      contraccion: pilar(18, 30), // 60% >= 50%
      gatillo: pilar(10, 15),
    },
    penalizacion: { pts: 0, flags: [] },
    ...extra,
  }
}

function rotacionLiderando(ticker) {
  return { ticker, nombre: `${ticker} Inc.`, sector: 'Technology', market_cap_usd: 1e9, rs_score: 80, rs_score_semana_ant: 60, cuadrante: 'liderando', historial: [80] }
}

function screenerAlineado(ticker) {
  return {
    ticker,
    nombre: `${ticker} Inc.`,
    industria: 'Software',
    diario: { verdict: 'COMPRA', estado: 'Bull', rsi: 55 },
    semanal: { verdict: 'CERCA', estado: 'Bull', rsi: 60 },
    mensual: { verdict: 'NEUTRAL', estado: 'Bull', rsi: 50 },
  }
}

const vcpArmado = (ticker) => ({ ticker, estado: 'Armado', score: 72, contracciones: 3, pivote: 100, dist_pivote_pct: -2.1, vol_decreciente: true })

describe('armarCandidatos — embudo completo', () => {
  it('un ticker que pasa las 5 etapas queda en la lista final con positivos armados', () => {
    const { embudo, candidatos } = armarCandidatos({
      warrenRows: [warrenBase('GANA')],
      senales: { ema200: { diario: {}, semanal: {} }, vcp: [vcpArmado('GANA')], rsi_semanal: { alcista: [], bajista: [] } },
      screenerRows: [screenerAlineado('GANA')],
      rotacion: { acciones: [rotacionLiderando('GANA')], recien_a_lideres: [], aceleracion_inusual: [] },
    })
    expect(embudo.map((e) => e.cantidad)).toEqual([1, 1, 1, 1, 1, 1])
    expect(candidatos).toHaveLength(1)
    const c = candidatos[0]
    expect(c.ticker).toBe('GANA')
    expect(c.positivos.some((p) => p.includes('Warren Score 70'))).toBe(true)
    expect(c.positivos.some((p) => p.includes('cuadrante Liderando'))).toBe(true)
    expect(c.positivos.some((p) => p.includes('Base VCP "Armado"'))).toBe(true)
    expect(c.positivos.some((p) => p.includes('Screener técnico alineado'))).toBe(true)
    expect(c.negativos.some((n) => n.includes('mensual'))).toBe(true) // NEUTRAL en mensual -> queda como negativo
  })

  it('sin Warren Score (datos_suficientes false) ni siquiera entra al universo', () => {
    const { embudo } = armarCandidatos({ warrenRows: [{ ticker: 'SINDATOS', datos_suficientes: false, total_score: null }] })
    expect(embudo[0].cantidad).toBe(0)
  })

  it('gate roto (cap gate_ema200) lo saca en la etapa 2', () => {
    const { embudo } = armarCandidatos({
      warrenRows: [warrenBase('ROTO', { caps: ['gate_ema200'] })],
    })
    expect(embudo[0].cantidad).toBe(1) // entra al universo
    expect(embudo[1].cantidad).toBe(0) // no pasa el gate
  })

  it('pilares debiles (Fuerza RS bajo el umbral) lo saca en la etapa 3', () => {
    const { embudo } = armarCandidatos({
      warrenRows: [warrenBase('DEBIL', { pilares: { ...warrenBase('DEBIL').pilares, fuerza: pilar(10, 30) } })],
    })
    expect(embudo[1].cantidad).toBe(1)
    expect(embudo[2].cantidad).toBe(0)
  })

  it('la bandera 🩸 (distribucion) excluye aunque los pilares esten bien', () => {
    const { embudo } = armarCandidatos({
      warrenRows: [warrenBase('DISTRIB', { penalizacion: { pts: -15, flags: [{ emoji: '🩸', clave: 'distribucion', pts: -15, detalle: 'x' }] } })],
    })
    expect(embudo[2].cantidad).toBe(0)
  })

  it('sin cuadrante Liderando (y sin recien_a_lideres/aceleracion) lo saca en la etapa 4', () => {
    const { embudo } = armarCandidatos({
      warrenRows: [warrenBase('REZAGADO')],
      rotacion: { acciones: [{ ...rotacionLiderando('REZAGADO'), cuadrante: 'rezagando' }] },
    })
    expect(embudo[2].cantidad).toBe(1)
    expect(embudo[3].cantidad).toBe(0)
  })

  it('"recien_a_lideres" pasa la etapa de rotacion aunque el cuadrante actual no sea liderando', () => {
    const { embudo } = armarCandidatos({
      warrenRows: [warrenBase('RECIEN')],
      rotacion: { acciones: [{ ...rotacionLiderando('RECIEN'), cuadrante: 'recuperando' }], recien_a_lideres: ['RECIEN'] },
    })
    expect(embudo[3].cantidad).toBe(1)
  })

  it('sin ningun gatillo tecnico (ni VCP ni EMA200 ni RSI semanal) lo saca en la etapa 5', () => {
    const { embudo } = armarCandidatos({
      warrenRows: [warrenBase('SINGATILLO')],
      rotacion: { acciones: [rotacionLiderando('SINGATILLO')] },
      senales: { vcp: [{ ticker: 'SINGATILLO', estado: 'Formándose' }] },
    })
    expect(embudo[3].cantidad).toBe(1)
    expect(embudo[4].cantidad).toBe(0)
  })

  it('screener sin alinear (menos de 2 temporalidades COMPRA/CERCA, o con VENTA) lo saca en la etapa 6', () => {
    const { embudo } = armarCandidatos({
      warrenRows: [warrenBase('SINSCREENER')],
      rotacion: { acciones: [rotacionLiderando('SINSCREENER')] },
      senales: { vcp: [vcpArmado('SINSCREENER')] },
      screenerRows: [{ ticker: 'SINSCREENER', diario: { verdict: 'COMPRA' }, semanal: { verdict: 'VENTA' }, mensual: { verdict: 'NEUTRAL' } }],
    })
    expect(embudo[4].cantidad).toBe(1)
    expect(embudo[5].cantidad).toBe(0)
  })

  it('el gatillo por EMA200 semanal y por RSI semanal tambien cuenta (no solo VCP)', () => {
    const base = { warrenRows: [warrenBase('EMA'), warrenBase('RSI')], rotacion: { acciones: [rotacionLiderando('EMA'), rotacionLiderando('RSI')] }, screenerRows: [screenerAlineado('EMA'), screenerAlineado('RSI')] }
    const { embudo } = armarCandidatos({
      ...base,
      senales: {
        ema200: { diario: {}, semanal: { rebote: [{ ticker: 'EMA', hace: 2, climax_ratio: 2.1, climax_ola: true, rs_contacto: 50, rs_hoy: 88 }] } },
        rsi_semanal: { alcista: [{ ticker: 'RSI', hace: 0, rsi: 58, sma14: 54, rs: 91 }] },
      },
    })
    expect(embudo[4].cantidad).toBe(2)
  })

  it('ordena los candidatos por puntaje (mas gatillos/cuadrante liderando primero)', () => {
    const { candidatos } = armarCandidatos({
      warrenRows: [warrenBase('UNO', { total_score: 70 }), warrenBase('DOS', { total_score: 65 })],
      rotacion: { acciones: [rotacionLiderando('UNO'), rotacionLiderando('DOS')] },
      senales: { vcp: [vcpArmado('UNO'), vcpArmado('DOS')], rsi_semanal: { alcista: [{ ticker: 'DOS', hace: 0, rsi: 55, sma14: 50, rs: 80 }] } },
      screenerRows: [screenerAlineado('UNO'), screenerAlineado('DOS')],
    })
    // UNO: 70 + 1 gatillo×4 + cuadrante liderando(5) = 79 · DOS: 65 + 2 gatillos×4 + 5 = 78
    expect(candidatos.map((c) => c.ticker)).toEqual(['UNO', 'DOS'])
  })
})
