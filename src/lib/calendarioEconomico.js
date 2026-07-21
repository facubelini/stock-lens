// Calendario de eventos macro de EEUU: FOMC (fechas exactas, verificadas a
// mano en federalreserve.gov/monetarypolicy/fomccalendars.htm) + NFP/CPI
// (aproximados por regla de calendario, el BLS no publica una API publica
// de fechas de release). Todo client-side, sin pipeline nuevo.
//
// Mantenimiento: la Fed publica el calendario del año siguiente a mitad de
// año — hay que agregar las fechas nuevas ahi (y borrar las que ya pasaron
// hace mucho, si se quiere prolijidad).
const FOMC_FECHAS = [
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
// cronológicamente. `exacto: false` marca fechas aproximadas (CPI).
export function calendarioEconomico(hoy = new Date()) {
  const eventos = []

  for (const fecha of FOMC_FECHAS) {
    eventos.push({ fecha, tipo: 'FOMC', label: 'Decisión de tasas (FOMC)', exacto: true })
  }

  // NFP ("Employment Situation" del BLS): siempre un viernes, casi siempre
  // el primero del mes — regla estable, se marca como fecha exacta.
  for (let i = 0; i < 6; i++) {
    const base = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + i, 1))
    eventos.push({
      fecha: _iso(_primerViernes(base.getUTCFullYear(), base.getUTCMonth())),
      tipo: 'NFP',
      label: 'Nóminas no agrícolas (empleo, BLS)',
      exacto: true,
    })
  }

  // CPI: el BLS no tiene una regla tan fija como NFP — suele salir entre
  // el 10 y el 15 del mes. Se aproxima al día 12, marcado como no exacto.
  for (let i = 0; i < 6; i++) {
    eventos.push({
      fecha: _iso(new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + i, 12))),
      tipo: 'CPI',
      label: 'Inflación (CPI, BLS)',
      exacto: false,
    })
  }

  const hoyISO = _iso(hoy)
  return eventos.filter((e) => e.fecha >= hoyISO).sort((a, b) => a.fecha.localeCompare(b.fecha))
}
