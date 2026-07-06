import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { useWatchlist, aplicarWatchlist } from '../lib/watchlist'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { exportarCSV } from '../lib/csv'
import { getPat, dispararActualizacionDatos } from '../lib/githubApi'
import Controles from '../components/Controles'
import Pendientes from '../components/Pendientes'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'

const CAMPOS = ['ticker', 'nombre']
const TIMEFRAMES = [
  { key: 'diario', label: 'Diario' },
  { key: 'semanal', label: 'Semanal' },
  { key: 'mensual', label: 'Mensual' },
]

const ESTILO_VERDICT = {
  COMPRA: { bg: 'rgba(34, 197, 94, 0.22)', color: '#7ee2a8', label: 'COMPRA' },
  CERCA: { bg: 'rgba(56, 189, 248, 0.18)', color: '#7dd3fc', label: 'CERCA' },
  EXTENDIDO: { bg: 'rgba(245, 165, 36, 0.18)', color: '#fbbf62', label: 'EXTENDIDO' },
  NEUTRAL: { bg: 'rgba(148, 163, 184, 0.12)', color: '#9aa7b5', label: 'NEUTRAL' },
  VENTA: { bg: 'rgba(239, 68, 68, 0.2)', color: '#ff9d9d', label: 'VENTA' },
}

// Prioridad para ordenar: favorece COMPRA/CERCA, penaliza VENTA. El diario
// pesa un poco menos que semanal/mensual (una senal de mas largo plazo es
// mas relevante para "esta para comprar" que un rebote de un dia).
const PESO_VERDICT = { COMPRA: 4, CERCA: 2.5, EXTENDIDO: 0.5, NEUTRAL: 0, VENTA: -3 }
const PESO_TF = { diario: 0.8, semanal: 1.1, mensual: 1.1 }

function prioridad(fila) {
  return TIMEFRAMES.reduce((acc, { key }) => {
    const v = fila[key]?.verdict
    return acc + (v ? (PESO_VERDICT[v] ?? 0) * PESO_TF[key] : 0)
  }, 0)
}

function tieneSenal(fila) {
  return TIMEFRAMES.some((tf) => {
    const v = fila[tf.key]?.verdict
    return v === 'COMPRA' || v === 'CERCA'
  })
}

function Celda({ dato }) {
  if (!dato) {
    return <span className="text-terminal-dim">N/D</span>
  }
  const est = ESTILO_VERDICT[dato.verdict] ?? ESTILO_VERDICT.NEUTRAL
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className="inline-block w-fit rounded px-1.5 py-0.5 text-[11px] font-semibold tabular"
        style={{ backgroundColor: est.bg, color: est.color }}
      >
        {est.label}
      </span>
      <span className="text-[11px] leading-snug text-terminal-dim" title={dato.motivo}>
        {dato.motivo}
      </span>
    </div>
  )
}

export default function Screener() {
  const { data, cargando, error } = useJson('screener.json')
  const raw = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const { watchlist } = useWatchlist()
  const { overrides } = useClasificacion()
  const { filas: conWatchlist, pendientes } = useMemo(
    () => aplicarWatchlist(raw, watchlist),
    [raw, watchlist],
  )
  const filas = useMemo(
    () => aplicarClasificacion(conWatchlist, overrides),
    [conWatchlist, overrides],
  )
  const [soloConSenal, setSoloConSenal] = useState(true)
  const [refresh, setRefresh] = useState(null) // { tipo: 'cargando'|'ok'|'error', texto }
  const t = useTabla(filas, { camposBusqueda: CAMPOS })

  const onRefrescar = async () => {
    if (!getPat()) {
      setRefresh({
        tipo: 'error',
        texto: 'Configurá tu GitHub token (barra superior, "🔑 Configurar auto") para poder disparar la actualización.',
      })
      return
    }
    setRefresh({ tipo: 'cargando' })
    try {
      await dispararActualizacionDatos()
      setRefresh({
        tipo: 'ok',
        texto:
          'Actualización disparada. El pipeline tarda unos minutos en correr y GitHub Pages cachea los JSON hasta 10 min más.',
      })
    } catch (err) {
      setRefresh({ tipo: 'error', texto: err.message })
    }
  }

  const filtradas = useMemo(() => {
    const base = soloConSenal ? t.filtradas.filter(tieneSenal) : t.filtradas
    return [...base].sort((a, b) => prioridad(b) - prioridad(a))
  }, [t.filtradas, soloConSenal])

  const colsCSV = [
    { key: 'ticker', label: 'Ticker' },
    { key: 'nombre', label: 'Empresa' },
    { key: 'industria', label: 'Industria' },
    ...TIMEFRAMES.flatMap(({ key, label }) => [
      { key: `${key}_verdict`, label: `${label} - Veredicto`, valorCSV: (r) => r[key]?.verdict ?? '' },
      { key: `${key}_motivo`, label: `${label} - Motivo`, valorCSV: (r) => r[key]?.motivo ?? '' },
    ]),
  ]

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-terminal-text">Screener</h1>
          <p className="text-xs text-terminal-dim">
            Para cada acción de tu lista, un veredicto <b>Diario / Semanal / Mensual</b>: exige
            confluencia de tendencia (medias adaptativas) + <b>MACD</b> + <b>SMI</b> + RSI, y una
            zona de pullback contra la media clave o el <b>ASL</b> (soporte adaptativo, EMA+WMA) —
            combina el indicador de TradingView con la lógica del analizador v8. <b>COMPRA</b> =
            confluencia alcista en pullback · <b>CERCA</b> = confluencia alcista acercándose ·{' '}
            <b>EXTENDIDO</b> = alcista pero lejos de ambas referencias, esperar retroceso ·{' '}
            <b>VENTA</b> = confluencia bajista confirmada. Orientativo, no es recomendación de
            inversión.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={onRefrescar}
            disabled={refresh?.tipo === 'cargando'}
            className="whitespace-nowrap rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-xs text-terminal-dim hover:border-terminal-accent hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-50"
            title="Dispara el pipeline (Actualizar datos) fuera del cron habitual"
          >
            {refresh?.tipo === 'cargando' ? '⏳ Actualizando…' : '🔄 Actualizar ahora'}
          </button>
          {refresh && refresh.tipo !== 'cargando' && (
            <span
              className={`max-w-xs text-right text-[11px] leading-snug ${
                refresh.tipo === 'error' ? 'text-terminal-down' : 'text-terminal-accent'
              }`}
            >
              {refresh.texto}
            </span>
          )}
        </div>
      </div>

      <Controles
        busqueda={t.busqueda}
        setBusqueda={t.setBusqueda}
        pais={t.pais}
        setPais={t.setPais}
        paises={t.paises}
        industria={t.industria}
        setIndustria={t.setIndustria}
        industrias={t.industrias}
        extra={
          <label className="flex cursor-pointer select-none items-center gap-1.5 rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-dim hover:text-terminal-text">
            <input
              type="checkbox"
              checked={soloConSenal}
              onChange={(e) => setSoloConSenal(e.target.checked)}
              className="accent-terminal-accent"
            />
            Sólo con señal (COMPRA/CERCA)
          </label>
        }
        onExportCSV={() => exportarCSV('stock-lens-screener.csv', colsCSV, filtradas)}
        total={filas.length}
        mostrados={filtradas.length}
      />

      <Pendientes pendientes={pendientes} watchlist={watchlist} />

      {cargando ? (
        <TablaSkeleton columnas={6} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : filtradas.length === 0 ? (
        <Vacio
          texto={
            soloConSenal
              ? 'Ninguna acción tiene señal de COMPRA o CERCA ahora mismo. Probá destildar "Sólo con señal".'
              : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-terminal-border">
          <table className="min-w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                <th className="whitespace-nowrap px-2 py-2.5 font-semibold">Ticker</th>
                <th className="whitespace-nowrap px-2 py-2.5 font-semibold">Empresa</th>
                <th className="whitespace-nowrap px-2 py-2.5 font-semibold">Industria</th>
                {TIMEFRAMES.map((tf) => (
                  <th key={tf.key} className="px-2 py-2.5 font-semibold">
                    {tf.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtradas.map((f) => (
                <tr
                  key={f.ticker}
                  className="border-t border-terminal-border transition-colors hover:bg-terminal-panel2/60"
                >
                  <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-terminal-text">
                    {f.ticker}
                  </td>
                  <td
                    className="max-w-[160px] truncate px-2 py-1.5 text-terminal-dim"
                    title={f.nombre}
                  >
                    {f.nombre || '—'}
                  </td>
                  <td
                    className="max-w-[130px] truncate px-2 py-1.5 text-terminal-dim"
                    title={f.industria}
                  >
                    {f.industria || '—'}
                  </td>
                  {TIMEFRAMES.map((tf) => (
                    <td key={tf.key} className="px-2 py-1.5 align-top">
                      <Celda dato={f[tf.key]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
