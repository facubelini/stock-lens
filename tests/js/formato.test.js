import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fechaISOEnAR,
  fmtAntiguedad,
  fmtFecha,
  fmtFechaCorta,
  fmtMarketCap,
  fmtNum,
  fmtPct,
  hoyAR,
  promedio,
  sumarDiasISO,
} from '../../src/lib/formato.js'

afterEach(() => vi.useRealTimers())

describe('fechas en hora de Buenos Aires (UTC-3)', () => {
  it('fechaISOEnAR: despues de las 21 hs de Argentina sigue siendo "hoy"', () => {
    expect(fechaISOEnAR(new Date('2026-09-24T01:30:00Z'))).toBe('2026-09-23') // 22:30 AR
    expect(fechaISOEnAR(new Date('2026-09-24T02:59:59Z'))).toBe('2026-09-23')
    expect(fechaISOEnAR(new Date('2026-09-24T03:00:00Z'))).toBe('2026-09-24') // 00:00 AR
  })

  it('hoyAR usa el reloj', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-12-31T23:30:00Z')) // 20:30 AR
    expect(hoyAR()).toBe('2026-12-31')
    vi.setSystemTime(new Date('2027-01-01T02:30:00Z')) // 23:30 AR del 31
    expect(hoyAR()).toBe('2026-12-31')
  })

  it('fmtFecha formatea en zona AR', () => {
    expect(fmtFecha('2026-09-24T01:30:00Z')).toMatch(/^23\/09\/2026,? 22:30 hs$/)
    expect(fmtFecha('2026-06-16T14:30:00-03:00')).toMatch(/^16\/06\/2026,? 14:30 hs$/)
    expect(fmtFecha(null)).toBe('N/D')
  })

  it('sumarDiasISO: aritmetica de calendario (fin de mes, bisiesto, anio)', () => {
    expect(sumarDiasISO('2024-02-28', 1)).toBe('2024-02-29')
    expect(sumarDiasISO('2025-02-28', 1)).toBe('2025-03-01')
    expect(sumarDiasISO('2026-12-31', 1)).toBe('2027-01-01')
    expect(sumarDiasISO('2026-03-01', -1)).toBe('2026-02-28')
    expect(sumarDiasISO('2026-09-23', 0)).toBe('2026-09-23')
  })

  it('fmtFechaCorta', () => {
    expect(fmtFechaCorta('2026-09-23')).toBe('23/09/2026')
    expect(fmtFechaCorta('2026-09-23T10:00:00')).toBe('23/09/2026')
    expect(fmtFechaCorta(null)).toBe('—')
    expect(fmtFechaCorta('raro')).toBe('raro')
  })

  it('fmtAntiguedad', () => {
    const ahora = Date.parse('2026-09-23T12:00:00Z')
    expect(fmtAntiguedad('2026-09-23T11:55:00Z', ahora)).toBe('hace 5 min')
    expect(fmtAntiguedad('2026-09-23T09:00:00Z', ahora)).toBe('hace 3 h')
    expect(fmtAntiguedad('2026-09-20T12:00:00Z', ahora)).toBe('hace 3 días')
    expect(fmtAntiguedad('2026-09-23T12:10:00Z', ahora)).toBe('hace 0 min') // futuro: no negativo
    expect(fmtAntiguedad('no-es-fecha', ahora)).toBe('N/D')
  })
})

describe('numeros es-AR', () => {
  it('fmtPct / fmtNum', () => {
    expect(fmtPct(1234.5)).toBe('1234,50%'.replace('1234', '1.234'))
    expect(fmtPct(2, { signo: true })).toBe('+2,00%')
    expect(fmtPct(-2, { signo: true })).toBe('-2,00%')
    expect(fmtPct(NaN)).toBe('N/D')
    expect(fmtNum(3.14159, 3)).toBe('3,142')
  })

  it('fmtMarketCap', () => {
    expect(fmtMarketCap(3.2e12)).toBe('3,2 T')
    expect(fmtMarketCap(4.567e9)).toBe('4,57 B')
    expect(fmtMarketCap(-2e6)).toBe('-2 M')
    expect(fmtMarketCap(null)).toBe('N/D')
  })

  it('promedio ignora nulos', () => {
    expect(promedio([{ v: 1 }, { v: null }, { v: 3 }, { v: NaN }], (x) => x.v)).toBe(2)
    expect(promedio([], (x) => x)).toBeNull()
  })
})
