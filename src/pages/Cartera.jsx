import { useMemo } from 'react'
import { useJson } from '../lib/useJson'
import { useDatosCombinados } from '../lib/useDatosCombinados'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { useWatchlist, aplicarWatchlist } from '../lib/watchlist'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { calcularScore, nivelScore } from '../lib/score'
import { calcularDescuento } from '../lib/valuacion'
import { TIMEFRAMES, ESTILO_VERDICT, tieneSenal } from '../lib/screenerEstilos'
import { exportarCSV } from '../lib/csv'
import Controles from '../components/Controles'
import Tabla from '../components/Tabla'
import BotonPin from '../components/BotonPin'
import TickerLink from '../components/TickerLink'
import Pendientes from '../components/Pendientes'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { fmtPct, fmtNum, estiloValor, estiloRSI } from '../lib/formato'

const CAMPOS = ['ticker', 'nombre']

export default function Cartera() {
  const { filas: merged, cargando, error } = useDatosCombinados()
  const { data: screenerData, cargando: cargScreener } = useJson('screener.json')
  const { data: compData, cargando: cargComp } = useJson('comparables.json')
  const { watchlist } = useWatchlist()
  const { overrides } = useClasificacion()
  const { pins, isPinned, toggle } = usePins()

  const { filas: conWatchlist, pendientes } = useMemo(
    () => aplicarWatchlist(merged, watchlist),
    [merged, watchlist],
  )
  const base = useMemo(() => aplicarClasificacion(conWatchlist, overrides), [conWatchlist, overrides])

  const screenerPorTicker = useMemo(() => {
    const m = new Map()
    for (const f of Array.isArray(screenerData) ? screenerData : []) m.set(f.ticker, f)
    return m
  }, [screenerData])

  const medianaPorIndustria = useMemo(() => {
    const m = new Map()
    for (const g of Array.isArray(compData) ? compData : []) m.set(g.industria, g.mediana)
    return m
  }, [compData])

  const filas = useMemo(
    () =>
      base.map((r) => {
        const screenerFila = screenerPorTicker.get(r.ticker)
        const mediana = medianaPorIndustria.get(r.industria)
        return {
          ...r,
          _score: calcularScore(r),
          _screenerFila: screenerFila,
          _descuento: calcularDescuento(r, mediana),
        }
      }),
    [base, screenerPorTicker, medianaPorIndustria],
  )

  const t = useTabla(filas, { camposBusqueda: CAMPOS, ordenInicial: { key: '_score', dir: 'desc' } })

  const columnas = [
    {
      key: '_pin',
      label: '',
      align: 'center',
      sortable: false,
      csv: false,
      tdClass: 'w-6 px-0.5',
      render: (r) => <BotonPin ticker={r.ticker} isPinned={isPinned} toggle={toggle} />,
    },
    {
      key: 'ticker',
      label: 'Ticker',
      align: 'left',
      valor: (r) => r.ticker,
      render: (r) => (
        <span className="inline-flex items-center gap-1 font-semibold text-terminal-text">
          <TickerLink ticker={r.ticker} />
          {r.stale && (
            <span className="text-terminal-warn" title={`Dato arrastrado (${r.actualizado ?? '?'})`}>
              🕒
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'nombre',
      label: 'Empresa',
      align: 'left',
      valor: (r) => r.nombre,
      render: (r) => (
        <span className="block max-w-[150px] truncate text-terminal-dim" title={r.nombre}>
          {r.nombre || '—'}
        </span>
      ),
    },
    {
      key: '_score',
      label: 'Score',
      align: 'right',
      valor: (r) => r._score?.score,
      render: (r) => {
        if (r._score == null) return <span className="text-terminal-dim">N/D</span>
        const nivel = nivelScore(r._score.score)
        return (
          <span className="tabular font-semibold" style={{ color: nivel.color }}>
            {r._score.score}
          </span>
        )
      },
    },
    {
      key: 'var_pct',
      label: 'Var %',
      align: 'right',
      valor: (r) => r.var_pct,
      estilo: (r) => estiloValor(r.var_pct, 6),
      render: (r) => fmtPct(r.var_pct, { signo: true }),
    },
    {
      key: 'rsi',
      label: 'RSI',
      align: 'right',
      valor: (r) => r.rsi,
      estilo: (r) => estiloRSI(r.rsi),
      render: (r) => fmtNum(r.rsi, 1),
    },
    {
      key: '_señal',
      label: 'Screener',
      align: 'left',
      sortable: false,
      csv: false,
      render: (r) => {
        if (!r._screenerFila) return <span className="text-terminal-dim">N/D</span>
        return (
          <div className="flex flex-wrap gap-1">
            {TIMEFRAMES.map((tf) => {
              const dato = r._screenerFila[tf.key]
              if (!dato) return null
              const est = ESTILO_VERDICT[dato.verdict] ?? ESTILO_VERDICT.NEUTRAL
              return (
                <span
                  key={tf.key}
                  className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{ backgroundColor: est.bg, color: est.color }}
                  title={dato.motivo}
                >
                  {tf.label[0]}: {est.label}
                </span>
              )
            })}
          </div>
        )
      },
    },
    {
      key: '_descuento',
      label: 'Vs. industria',
      align: 'right',
      valor: (r) => r._descuento,
      estilo: (r) => estiloValor(r._descuento, 30),
      render: (r) =>
        r._descuento == null ? (
          <span className="text-terminal-dim">N/D</span>
        ) : (
          fmtPct(r._descuento, { signo: true })
        ),
      ayuda: 'Descuento vs. la mediana de tu industria en PER/EV-Sales/P-S (solo si hay comparables curados).',
    },
  ]

  const cargando2 = cargando || cargScreener || cargComp

  if (!watchlist) {
    return (
      <div>
        <div className="mb-4">
          <h1 className="text-lg font-bold text-terminal-text">Mi Cartera</h1>
          <p className="text-xs text-terminal-dim">
            Resumen de tu propia lista: score, señal del Screener y valuación vs. industria en una
            sola tabla, en vez de ir pestaña por pestaña.
          </p>
        </div>
        <Vacio texto='Cargá un Excel o agregá tickers a "Mi lista" (barra superior) para ver acá tu resumen consolidado.' />
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Mi Cartera</h1>
        <p className="text-xs text-terminal-dim">
          Resumen de tu propia lista: score, señal del Screener y valuación vs. industria en una
          sola tabla, en vez de ir pestaña por pestaña. Orientativo, no es recomendación de
          inversión.
        </p>
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
        onExportCSV={() => exportarCSV('stock-lens-mi-cartera.csv', columnas, t.filtradas)}
        total={filas.length}
        mostrados={t.filtradas.length}
      />

      <Pendientes pendientes={pendientes} watchlist={watchlist} />

      {cargando2 ? (
        <TablaSkeleton columnas={8} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : t.filtradas.length === 0 ? (
        <Vacio />
      ) : (
        <Tabla
          columnas={columnas}
          filas={t.filtradas}
          sortKey={t.sortKey}
          sortDir={t.sortDir}
          onSort={t.ordenar}
          pins={pins}
        />
      )}
    </div>
  )
}
