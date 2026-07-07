import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { exportarCSV } from '../lib/csv'
import { getPat, dispararActualizacionDatos } from '../lib/githubApi'
import { TIMEFRAMES, ESTILO_VERDICT, tieneSenal, prioridadScreener } from '../lib/screenerEstilos'
import Controles from '../components/Controles'
import TickerLink from '../components/TickerLink'
import BacktestScreener from '../components/BacktestScreener'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'

const CAMPOS = ['ticker', 'nombre']
const prioridad = prioridadScreener

function tieneSenalEn(fila, tfKeys) {
  return tfKeys.some((key) => tieneSenal(fila[key]))
}

function tieneSenalEnTodas(fila, tfKeys) {
  return tfKeys.every((key) => tieneSenal(fila[key]))
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
  const { overrides } = useClasificacion()
  const filas = useMemo(
    () => aplicarClasificacion(raw, overrides),
    [raw, overrides],
  )
  const [tfFiltro, setTfFiltro] = useState({ diario: true, semanal: true, mensual: true })
  const [exigirTodas, setExigirTodas] = useState(false)
  const [refresh, setRefresh] = useState(null) // { tipo: 'cargando'|'ok'|'error', texto }
  const toggleTf = (key) => setTfFiltro((prev) => ({ ...prev, [key]: !prev[key] }))
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

  const tfKeysActivas = useMemo(
    () => TIMEFRAMES.map((tf) => tf.key).filter((key) => tfFiltro[key]),
    [tfFiltro],
  )

  const filtradas = useMemo(() => {
    const base =
      tfKeysActivas.length > 0
        ? t.filtradas.filter((f) =>
            exigirTodas ? tieneSenalEnTodas(f, tfKeysActivas) : tieneSenalEn(f, tfKeysActivas),
          )
        : t.filtradas
    return [...base].sort((a, b) => prioridad(b) - prioridad(a))
  }, [t.filtradas, tfKeysActivas, exigirTodas])

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
          <div
            className="flex flex-wrap items-center gap-2 rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-dim"
            title={
              exigirTodas
                ? 'Muestra activos con señal (COMPRA/CERCA) en TODAS las temporalidades tildadas a la vez'
                : 'Muestra activos con señal (COMPRA/CERCA) en cualquiera de las temporalidades tildadas'
            }
          >
            <span className="text-xs">Señal en:</span>
            {TIMEFRAMES.map((tf) => (
              <label
                key={tf.key}
                className="flex cursor-pointer select-none items-center gap-1 hover:text-terminal-text"
              >
                <input
                  type="checkbox"
                  checked={Boolean(tfFiltro[tf.key])}
                  onChange={() => toggleTf(tf.key)}
                  className="accent-terminal-accent"
                />
                {tf.label}
              </label>
            ))}
            <span className="mx-1 h-4 w-px bg-terminal-border" />
            <label className="flex cursor-pointer select-none items-center gap-1 hover:text-terminal-text">
              <input
                type="checkbox"
                checked={exigirTodas}
                onChange={(e) => setExigirTodas(e.target.checked)}
                className="accent-terminal-accent"
              />
              Exigir todas a la vez (AND)
            </label>
          </div>
        }
        onExportCSV={() => exportarCSV('stock-lens-screener.csv', colsCSV, filtradas)}
        total={filas.length}
        mostrados={filtradas.length}
      />

      {cargando ? (
        <TablaSkeleton columnas={6} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : filtradas.length === 0 ? (
        <Vacio
          texto={
            tfKeysActivas.length > 0
              ? `Ninguna acción tiene señal de COMPRA o CERCA ${
                  exigirTodas ? 'a la vez en' : 'en'
                } ${tfKeysActivas
                  .map((k) => TIMEFRAMES.find((tf) => tf.key === k).label)
                  .join(exigirTodas ? ' + ' : '/')} ahora mismo. Probá ${
                  exigirTodas ? 'destildar "Exigir todas a la vez" o' : ''
                } cambiar la temporalidad.`
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
                    <TickerLink ticker={f.ticker} />
                    {f.divergencia_rsi && (
                      <span
                        className="ml-1"
                        title={`Divergencia ${f.divergencia_rsi.tipo} en RSI diario, detectada hace ${f.divergencia_rsi.hace_ruedas} rueda(s) — heurística, no es una señal infalible`}
                      >
                        {f.divergencia_rsi.tipo === 'alcista' ? '📈' : '📉'}
                      </span>
                    )}
                    {f.cruce_medias && (
                      <span
                        className="ml-1"
                        title={`${f.cruce_medias.tipo === 'golden' ? 'Golden cross' : 'Death cross'} (EMA50 x SMA200), hace ${f.cruce_medias.hace_ruedas} rueda(s)`}
                      >
                        {f.cruce_medias.tipo === 'golden' ? '🌟' : '💀'}
                      </span>
                    )}
                    {f.stale && (
                      <span
                        className="ml-1 text-terminal-warn"
                        title={`Dato arrastrado de la última corrida exitosa (${f.actualizado ?? '?'}), yfinance falló hoy para este ticker`}
                      >
                        🕒
                      </span>
                    )}
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

      <BacktestScreener />
    </div>
  )
}
