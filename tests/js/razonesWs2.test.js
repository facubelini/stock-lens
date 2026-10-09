import { describe, expect, it } from 'vitest'
import { chipsRazones, razonesWs2 } from '../../src/lib/razonesWs2.js'

function fila(extra = {}) {
  return {
    ticker: 'X',
    total_score: 80,
    pilares: {
      liderazgo: { pts: 38, rs: 92, rs_mes_ant: 70, pts_rs: 28, pts_aceleracion: 10 },
      tendencia: { pts: 16, pendiente_ema200: 0.14 },
      timing: { pts: 30, dist_max52_pct: -14.2, rsi: 47, dist_sma50_atr: 0.3, pts_profundidad: 22, pts_rsi: 11, pts_extension: 6 },
    },
    penalizacion: { pts: 0, flags: [] },
    caps: [],
    ...extra,
  }
}

describe('razonesWs2', () => {
  it('un líder que retrocedió: todo suma y los textos traen los números reales', () => {
    const { pros, contras } = razonesWs2(fila())
    expect(contras).toEqual([])
    expect(pros).toHaveLength(6)
    const texto = pros.map((p) => p.texto).join(' | ')
    expect(texto).toContain('RS 92')
    expect(texto).toContain('de 70,0 a 92,0')
    expect(texto).toContain('14,2%')
    expect(texto).toContain('RSI 47')
    expect(pros[0].puntos).toBeGreaterThanOrEqual(pros[1].puntos) // ordenado por puntos
  })

  it('un líder en máximos y sobrecomprado pierde los puntos de timing y lo explica', () => {
    const f = fila({
      pilares: {
        liderazgo: { pts: 38, rs: 92, rs_mes_ant: 70, pts_rs: 28, pts_aceleracion: 10 },
        tendencia: { pts: 16, pendiente_ema200: 0.14 },
        timing: { pts: 0, dist_max52_pct: -1, rsi: 82, dist_sma50_atr: 9, pts_profundidad: 0, pts_rsi: 0, pts_extension: 0 },
      },
    })
    const { pros, contras } = razonesWs2(f)
    const t = contras.map((c) => c.texto).join(' | ')
    expect(t).toContain('máximos de 52 semanas')
    expect(t).toContain('sobrecompra')
    expect(t).toContain('Extendido')
    expect(pros.map((p) => p.texto).join(' ')).not.toContain('Está en máximos')
  })

  it('suma penalizaciones y topes a lo que resta', () => {
    const { contras } = razonesWs2(
      fila({
        penalizacion: { pts: -15, flags: [{ clave: 'distribucion', pts: -15, emoji: '🩸', detalle: 'Distribución: 6 de 8 velas rojas' }] },
        caps: ['extendido'],
      }),
    )
    expect(contras[0]).toMatchObject({ puntos: -15 })
    expect(contras[0].texto).toContain('Distribución')
    expect(contras.at(-1).texto).toContain('topeado en 66')
  })

  it('sin un dato no inventa la línea', () => {
    const f = fila()
    f.pilares.timing.rsi = null
    f.pilares.timing.pts_rsi = null
    const { pros, contras } = razonesWs2(f)
    expect([...pros, ...contras].some((r) => r.texto.includes('RSI'))).toBe(false)
  })

  it('fila sin pilares devuelve vacío y los chips son los 3 que más aportan', () => {
    expect(razonesWs2({})).toEqual({ pros: [], contras: [], neutros: [] })
    const chips = chipsRazones(fila())
    expect(chips).toHaveLength(3)
    expect(chips[0]).toBe('RS 92')
  })
})
