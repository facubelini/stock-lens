import { useMemo } from 'react'
import { useJson } from '../lib/useJson'
import { hoyAR, sumarDiasISO, fmtFechaCorta } from '../lib/formato'
import TickerLink from './TickerLink'

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
const DIAS_CORTO = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']

function diaSemanaISO(fechaISO) {
  const [a, m, d] = fechaISO.split('-').map(Number)
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay() // 0 = domingo … 6 = sábado
}

// Lunes a viernes de la semana en curso (hora Argentina), como 'AAAA-MM-DD'.
function semanaActual() {
  const hoy = hoyAR()
  const dow = diaSemanaISO(hoy)
  const aLunes = dow === 0 ? -6 : 1 - dow
  const lunes = sumarDiasISO(hoy, aLunes)
  const viernes = sumarDiasISO(lunes, 4)
  return { lunes, viernes }
}

// Tira compacta de earnings que caen esta semana (lunes a viernes), armada
// en el cliente desde fundamentales.json (proximo_earnings.fecha por
// ticker) — no depende del pipeline de señales. El campo del pipeline solo
// trae fecha (y a veces fecha_fin si es un rango estimado); no distingue
// antes/después del cierre, así que NO se muestra BMO/AMC (no inventarlo).
export default function TiraEarnings() {
  const { data, cargando, error } = useJson('fundamentales.json')

  const filas = useMemo(() => {
    const arr = Array.isArray(data) ? data : Object.values(data ?? {})
    const { lunes, viernes } = semanaActual()
    return arr
      .filter((f) => f && typeof f === 'object' && f.proximo_earnings?.fecha)
      .map((f) => ({ ticker: f.ticker, nombre: f.nombre, fecha: String(f.proximo_earnings.fecha).slice(0, 10), estimado: f.proximo_earnings.estimado }))
      .filter((f) => f.fecha >= lunes && f.fecha <= viernes)
      .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.ticker.localeCompare(b.ticker))
  }, [data])

  if (cargando || error || filas.length === 0) return null

  return (
    <div className="mb-4 min-w-0 overflow-hidden rounded-lg border border-terminal-border bg-terminal-panel">
      <div className="flex items-center justify-between gap-2 border-b border-terminal-border bg-terminal-panel2 px-3 py-1.5">
        <h2 className="text-xs font-semibold text-terminal-text">📅 Earnings de la semana</h2>
        <span
          className="text-[11px] text-terminal-dim"
          title="Antes de abrir una posición de corto plazo, revisá si el activo reporta esta semana."
        >
          {filas.length} este semana ⓘ
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto px-3 py-2">
        {filas.map((f) => (
          <div
            key={f.ticker}
            className="flex shrink-0 flex-col items-start gap-0.5 rounded border border-terminal-border px-2 py-1"
            title={`${f.nombre} · reporta el ${fmtFechaCorta(f.fecha)}${f.estimado ? ' (fecha estimada)' : ''}`}
          >
            <TickerLink ticker={f.ticker} className="text-xs font-semibold" />
            <span className="whitespace-nowrap text-[10px] text-terminal-dim">
              {DIAS_CORTO[diaSemanaISO(f.fecha)]} {fmtFechaCorta(f.fecha)}
              {f.estimado ? ' (est.)' : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Exportado solo para poder probar la lógica de semana desde afuera sin
// duplicarla (ver verificación manual en el reporte).
export { semanaActual, diaSemanaISO, DIAS }
