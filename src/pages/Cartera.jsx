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
const COLORES_SECTOR = ['#f5a524', '#38bdf8', '#7ee2a8', '#c084fc', '#f87171', '#facc15', '#4ade80', '#fb923c']

// Normaliza una serie de precios a % de variación desde el primer punto,
// para poder comparar activos de escalas muy distintas en un mismo eje.
function normalizarSerie(spark) {
  if (!spark || spark.length < 2 || !spark[0]) return null
  const base = spark[0]
  return spark.map((v) => (v / base - 1) * 100)
}

function GraficoVsBenchmark({ cartera, spy, dias }) {
  const ANCHO = 700
  const ALTO = 150
  const todos = [...cartera, ...spy]
  const min = Math.min(...todos)
  const max = Math.max(...todos)
  const rango = max - min || 1
  const paso = ANCHO / (cartera.length - 1)
  const puntos = (arr) =>
    arr
      .map((v, i) => `${(i * paso).toFixed(1)},${(ALTO - 6 - ((v - min) / rango) * (ALTO - 12)).toFixed(1)}`)
      .join(' ')
  const ultimoCartera = cartera[cartera.length - 1]
  const ultimoSpy = spy[spy.length - 1]

  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 font-semibold text-terminal-accent">
            <span className="inline-block h-2 w-2 rounded-full bg-terminal-accent" />
            Mi Cartera {ultimoCartera >= 0 ? '+' : ''}
            {ultimoCartera.toFixed(1)}%
          </span>
          <span className="flex items-center gap-1.5 text-terminal-dim">
            <span className="inline-block h-2 w-2 rounded-full bg-terminal-dim" />
            SPY {ultimoSpy >= 0 ? '+' : ''}
            {ultimoSpy.toFixed(1)}%
          </span>
        </div>
        <span className="text-terminal-dim">últimos {dias} días</span>
      </div>
      <svg viewBox={`0 0 ${ANCHO} ${ALTO}`} className="block w-full" preserveAspectRatio="none">
        <polyline points={puntos(spy)} fill="none" stroke="#7d8b9c" strokeWidth="1.5" strokeDasharray="4 3" />
        <polyline points={puntos(cartera)} fill="none" stroke="#f5a524" strokeWidth="2" />
      </svg>
      <p className="mt-1 text-[11px] text-terminal-dim">
        Promedio simple (no ponderado por tamaño de posición) del % de variación de tus tickers
        seguidos, contra el mismo período en SPY.
      </p>
    </div>
  )
}

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

  // Diversificación: concentración de tu lista por sector.
  const concentracionSector = useMemo(() => {
    if (!filas.length) return []
    const conteo = new Map()
    for (const f of filas) {
      const clave = f.sector || 'Sin sector'
      conteo.set(clave, (conteo.get(clave) ?? 0) + 1)
    }
    const total = filas.length
    return [...conteo.entries()]
      .map(([sector, n]) => ({ sector, n, pct: (n / total) * 100 }))
      .sort((a, b) => b.n - a.n)
  }, [filas])

  // Mi Cartera vs. SPY: promedio simple del % de variación de tus tickers
  // (usando el sparkline de ~180 ruedas que ya trae listado.json) contra el
  // mismo período en SPY. Fetch aparte porque SPY puede no estar en tu lista.
  const { data: listadoData } = useJson('listado.json')
  const spySpark = useMemo(() => {
    const acciones = listadoData?.acciones ?? []
    return acciones.find((a) => a.ticker === 'SPY')?.spark ?? null
  }, [listadoData])

  const comparativaBenchmark = useMemo(() => {
    const conSpark = filas.filter((f) => Array.isArray(f.spark) && f.spark.length > 1)
    if (!conSpark.length || !spySpark || spySpark.length < 2) return null
    const dias = Math.min(...conSpark.map((f) => f.spark.length), spySpark.length)
    if (dias < 2) return null
    const normalizadas = conSpark.map((f) => normalizarSerie(f.spark.slice(-dias))).filter(Boolean)
    if (!normalizadas.length) return null
    const cartera = []
    for (let i = 0; i < dias; i++) {
      const suma = normalizadas.reduce((acc, serie) => acc + serie[i], 0)
      cartera.push(suma / normalizadas.length)
    }
    const spy = normalizarSerie(spySpark.slice(-dias))
    return spy ? { cartera, spy, dias } : null
  }, [filas, spySpark])

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

      {(concentracionSector.length > 0 || comparativaBenchmark) && (
        <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {concentracionSector.length > 0 && (
            <div className="rounded-lg border border-terminal-border bg-terminal-panel p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-terminal-dim">
                Diversificación por sector
              </div>
              <div className="flex flex-col gap-1.5">
                {concentracionSector.map((s, i) => (
                  <div key={s.sector} className="flex items-center gap-2 text-xs">
                    <span className="w-32 shrink-0 truncate text-terminal-dim" title={s.sector}>
                      {s.sector}
                    </span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-terminal-border">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${s.pct}%`,
                          backgroundColor: s.pct >= 40 ? '#ef4444' : COLORES_SECTOR[i % COLORES_SECTOR.length],
                        }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right tabular text-terminal-text">
                      {s.n} · {s.pct.toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
              {concentracionSector[0]?.pct >= 40 && (
                <p className="mt-2 text-[11px] text-terminal-warn">
                  ⚠️ Casi la mitad (o más) de tu lista está en {concentracionSector[0].sector} — poca
                  diversificación si ese sector cae en conjunto.
                </p>
              )}
            </div>
          )}

          {comparativaBenchmark && (
            <GraficoVsBenchmark
              cartera={comparativaBenchmark.cartera}
              spy={comparativaBenchmark.spy}
              dias={comparativaBenchmark.dias}
            />
          )}
        </div>
      )}

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
