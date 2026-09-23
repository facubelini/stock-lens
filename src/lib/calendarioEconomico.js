import { fechaISOEnAR, fmtFechaCorta, sumarDiasISO } from './formato'

// Calendario de eventos macro de EEUU: FOMC (fechas exactas, verificadas a
// mano en federalreserve.gov/monetarypolicy/fomccalendars.htm) + NFP/CPI
// (aproximados por regla de calendario, el BLS no publica una API publica
// de fechas de release). Todo client-side, sin pipeline nuevo.
//
// Mantenimiento: la Fed publica el calendario del año siguiente a mitad de
// año — hay que agregar las fechas nuevas ahi (y borrar las que ya pasaron
// hace mucho, si se quiere prolijidad).
export const FOMC_FECHAS = [
  // 2026 (reuniones restantes del año)
  '2026-07-29',
  '2026-09-16',
  '2026-10-28',
  '2026-12-09',
  // 2027
  '2027-01-27',
  '2027-03-17',
  '2027-04-28',
  '2027-06-09',
  '2027-07-28',
  '2027-09-15',
  '2027-10-27',
  '2027-12-08',
]

function _primerViernes(anio, mes) {
  const d = new Date(Date.UTC(anio, mes, 1))
  const offset = (5 - d.getUTCDay() + 7) % 7
  d.setUTCDate(1 + offset)
  return d
}

function _iso(d) {
  return d.toISOString().slice(0, 10)
}

// Próximos eventos macro de EEUU desde `hoy` en adelante, ordenados
// cronológicamente. `exacto: false` marca fechas aproximadas (NFP, CPI).
// "Hoy" es la fecha de Buenos Aires, no la de UTC (desde las 21 hs AR el
// UTC ya es el dia siguiente y el evento de hoy desaparecia).
export function calendarioEconomico(hoy = new Date()) {
  const eventos = []
  const hoyISO = fechaISOEnAR(hoy)
  const [anio, mesUno] = hoyISO.split('-').map(Number)
  const mes = mesUno - 1

  for (const fecha of FOMC_FECHAS) {
    eventos.push({ fecha, tipo: 'FOMC', label: 'Decisión de tasas (FOMC)', exacto: true })
  }

  // NFP ("Employment Situation" del BLS): casi siempre el primer viernes del
  // mes, pero no siempre (si el viernes 1-2 cae muy pegado al cierre del
  // mes de referencia, o por feriados, el BLS lo corre una semana). Se marca
  // como aproximado.
  for (let i = 0; i < 6; i++) {
    const base = new Date(Date.UTC(anio, mes + i, 1))
    eventos.push({
      fecha: _iso(_primerViernes(base.getUTCFullYear(), base.getUTCMonth())),
      tipo: 'NFP',
      label: 'Nóminas no agrícolas (empleo, BLS)',
      exacto: false,
    })
  }

  // CPI: el BLS no tiene una regla tan fija como NFP — suele salir entre
  // el 10 y el 15 del mes. Se aproxima al día 12, marcado como no exacto.
  for (let i = 0; i < 6; i++) {
    eventos.push({
      fecha: _iso(new Date(Date.UTC(anio, mes + i, 12))),
      tipo: 'CPI',
      label: 'Inflación (CPI, BLS)',
      exacto: false,
    })
  }

  // Aviso cuando la lista de FOMC cargada a mano se queda corta (quedan 2
  // reuniones o menos): en vez de "desaparecer" las decisiones de tasas del
  // calendario sin explicacion, se agrega una fila recordando actualizarla.
  const ultimaFomc = FOMC_FECHAS[FOMC_FECHAS.length - 1]
  const fomcRestantes = FOMC_FECHAS.filter((f) => f >= hoyISO).length
  if (fomcRestantes <= 2) {
    eventos.push({
      fecha: ultimaFomc >= hoyISO ? sumarDiasISO(ultimaFomc, 1) : hoyISO,
      tipo: 'FOMC',
      label: `Sin fechas FOMC cargadas después del ${fmtFechaCorta(ultimaFomc)} (actualizar calendarioEconomico.js)`,
      exacto: false,
      aviso: true,
    })
  }

  return eventos.filter((e) => e.fecha >= hoyISO).sort((a, b) => a.fecha.localeCompare(b.fecha))
}
