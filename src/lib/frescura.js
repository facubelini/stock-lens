// Frescura de los datos publicados (meta.json ultima_actualizacion): cuantas
// horas hace que corrio el pipeline por ultima vez, y si eso ya es "viejo"
// para el banner de aviso (src/components/BannerDatosDesactualizados.jsx).
// Umbral mas laxo el fin de semana (74h): el mercado no opera, así que un
// viernes a la tarde sin corridas hasta el lunes es normal, no una falla.
export const UMBRAL_HORAS_SEMANA = 26
export const UMBRAL_HORAS_FIN_DE_SEMANA = 74

const TZ = 'America/Argentina/Buenos_Aires'

// 0 = domingo … 6 = sábado, en la zona horaria de Argentina (no la del
// navegador: alguien mirando la app desde otro huso no tiene que ver un
// umbral distinto).
function diaDeSemanaAR(fecha) {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(fecha)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(partes)
}

export function esFinDeSemana(fecha = new Date()) {
  const d = diaDeSemanaAR(fecha)
  return d === 0 || d === 6
}

export function umbralHoras(fecha = new Date()) {
  return esFinDeSemana(fecha) ? UMBRAL_HORAS_FIN_DE_SEMANA : UMBRAL_HORAS_SEMANA
}

export function horasDesde(iso, ahora = new Date()) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return (ahora.getTime() - t) / 3_600_000
}

// { desactualizado, horas, umbral } — desactualizado=false si falta el dato
// (no hay nada que avisar todavía, no es un error del banner).
export function chequearFrescura(metaIso, ahora = new Date()) {
  const horas = horasDesde(metaIso, ahora)
  const umbral = umbralHoras(ahora)
  return { desactualizado: horas !== null && horas > umbral, horas, umbral }
}
