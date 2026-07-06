import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { getPat, agregarTickerHistorico, quitarTickerHistorico } from '../lib/githubApi'
import { conCrecimientoYoY, OPCIONES_VENTANA } from '../lib/historicoDerivados'
import { fmtFecha, fmtMarketCap } from '../lib/formato'
import { exportarCSV } from '../lib/csv'
import GraficoRatio from '../components/GraficoRatio'
import GraficoComparativo from '../components/GraficoComparativo'
import { TablaSkeleton, MensajeError } from '../components/Estados'

const LIMITE = 20
const CAMPOS_YOY = ['eps_ttm', 'revenue_ttm']

const RATIOS_MULTIPLO = [
  { campo: 'per_ltm', etiqueta: 'Price / Earnings - P/E (LTM)', color: '#a855f7', formato: (v) => `${v.toFixed(1)}x` },
  { campo: 'ev_sales_ltm', etiqueta: 'EV / Sales (LTM)', color: '#f97316', formato: (v) => `${v.toFixed(1)}x` },
  { campo: 'ps_ltm', etiqueta: 'Price / Sales - P/S (LTM)', color: '#22c55e', formato: (v) => `${v.toFixed(1)}x` },
]
const RATIOS_DENOMINADOR = [
  { campo: 'eps_ttm', etiqueta: 'EPS (TTM)', color: '#38bdf8', formato: (v) => `$${v.toFixed(2)}` },
  { campo: 'revenue_ttm', etiqueta: 'Revenue (TTM)', color: '#facc15', formato: (v) => fmtMarketCap(v) },
]
const RATIOS_MARGEN = [
  {
    campo: 'margen_neto_ttm',
    etiqueta: 'Margen neto (TTM)',
    color: '#2dd4bf',
    formato: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`,
  },
]
const RATIOS_YOY = [
  {
    campo: 'eps_ttm_yoy',
    etiqueta: 'Crecimiento EPS (TTM, interanual)',
    color: '#f472b6',
    formato: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`,
  },
  {
    campo: 'revenue_ttm_yoy',
    etiqueta: 'Crecimiento Revenue (TTM, interanual)',
    color: '#4ade80',
    formato: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`,
  },
]
const TODOS_RATIOS = [...RATIOS_MULTIPLO, ...RATIOS_DENOMINADOR, ...RATIOS_MARGEN, ...RATIOS_YOY]

const inputCls =
  'w-40 rounded border border-terminal-border bg-terminal-panel px-2 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'
const selectCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'
const btnCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-dim ' +
  'hover:border-terminal-accent hover:text-terminal-text'

export default function HistoricoFundamental() {
  const { data, cargando, error } = useJson('historico_fundamental.json')
  const tickers = useMemo(() => (Array.isArray(data?.tickers) ? data.tickers : []), [data])
  const [nuevo, setNuevo] = useState('')
  const [estado, setEstado] = useState(null) // { tipo, ticker, texto }
  const [ventanaMeses, setVentanaMeses] = useState(0)
  const [modoComparar, setModoComparar] = useState(false)
  const [tickersComparar, setTickersComparar] = useState([])
  const [ratioComparar, setRatioComparar] = useState('per_ltm')
  const patConfigurado = Boolean(getPat())

  // Serie de cada ticker con el crecimiento interanual ya calculado, para que
  // todos los graficos (multiplo/denominador/YoY/comparativo) lean de un
  // mismo lugar.
  const seriesPorTicker = useMemo(() => {
    const mapa = new Map()
    for (const t of tickers) {
      if (t.disponible) mapa.set(t.ticker, conCrecimientoYoY(t.serie, CAMPOS_YOY))
    }
    return mapa
  }, [tickers])

  const disponibles = useMemo(() => tickers.filter((t) => t.disponible), [tickers])

  const filasCSV = useMemo(
    () =>
      disponibles.flatMap((t) =>
        (seriesPorTicker.get(t.ticker) ?? []).map((p) => ({ ticker: t.ticker, nombre: t.nombre, ...p })),
      ),
    [disponibles, seriesPorTicker],
  )
  const colsCSV = [
    { key: 'ticker', label: 'Ticker' },
    { key: 'nombre', label: 'Empresa' },
    { key: 'fecha', label: 'Fecha' },
    ...TODOS_RATIOS.map((r) => ({ key: r.campo, label: r.etiqueta })),
  ]

  const agregar = async (e) => {
    e.preventDefault()
    const tk = nuevo.trim().toUpperCase()
    if (!tk) return
    if (tickers.length >= LIMITE) {
      setEstado({ tipo: 'error', ticker: tk, texto: `Ya hay ${LIMITE} tickers, sacá uno primero.` })
      return
    }
    setNuevo('')
    setEstado({ tipo: 'cargando', ticker: tk })
    try {
      const r = await agregarTickerHistorico(tk)
      setEstado({
        tipo: 'ok',
        ticker: tk,
        texto: r.agregado
          ? 'agregado, la actualización del histórico ya arrancó (puede tardar unos minutos).'
          : 'ya estaba en la lista.',
      })
    } catch (err) {
      setEstado({ tipo: 'error', ticker: tk, texto: err.message })
    }
  }

  const quitar = async (ticker) => {
    setTickersComparar((prev) => prev.filter((t) => t !== ticker))
    setEstado({ tipo: 'cargando', ticker })
    try {
      await quitarTickerHistorico(ticker)
      setEstado({ tipo: 'ok', ticker, texto: 'sacado, la actualización ya arrancó.' })
    } catch (err) {
      setEstado({ tipo: 'error', ticker, texto: err.message })
    }
  }

  const toggleComparar = (ticker) =>
    setTickersComparar((prev) => (prev.includes(ticker) ? prev.filter((t) => t !== ticker) : [...prev, ticker]))

  const ratioComparado = TODOS_RATIOS.find((r) => r.campo === ratioComparar) ?? TODOS_RATIOS[0]
  const seriesComparar = disponibles
    .filter((t) => tickersComparar.includes(t.ticker))
    .map((t) => ({ ticker: t.ticker, nombre: t.nombre, serie: seriesPorTicker.get(t.ticker) }))

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-terminal-text">Histórico Fundamental</h1>
          <p className="text-xs text-terminal-dim">
            Evolución de <b>P/E</b>, <b>EV/Sales</b>, <b>P/S</b> (LTM), <b>EPS</b>, <b>Revenue</b>{' '}
            (TTM, con crecimiento interanual) y <b>margen neto</b> (TTM) para hasta {LIMITE} tickers
            elegidos a mano, con datos oficiales de <b>SEC EDGAR</b> combinados con el precio
            histórico. Solo funciona para empresas que reportan a la SEC (listadas en EEUU o con
            ADR) — acciones que cotizan únicamente en Merval no van a tener datos acá. No incluye
            versiones "NTM" (forward) ni PEG: el crecimiento histórico del EPS puede ser muy
            ruidoso o negativo, y dividir el PER por eso suele dar un número sin sentido.
          </p>
          {data?.actualizado && (
            <p className="mt-1 text-[11px] text-terminal-dim">
              Última actualización: {fmtFecha(data.actualizado)} (corre semanalmente)
            </p>
          )}
        </div>
        {disponibles.length > 0 && (
          <button type="button" className={btnCls} onClick={() => exportarCSV('stock-lens-historico-fundamental.csv', colsCSV, filasCSV)}>
            ⬇ CSV
          </button>
        )}
      </div>

      {patConfigurado ? (
        <form onSubmit={agregar} className="mb-4 flex flex-wrap items-center gap-2">
          <input
            value={nuevo}
            onChange={(e) => setNuevo(e.target.value)}
            placeholder="+ ticker (ej. AAPL)"
            className={inputCls}
          />
          <button type="submit" className={btnCls}>
            Agregar
          </button>
          <span className="text-xs text-terminal-dim">
            {tickers.length} / {LIMITE} tickers
          </span>
          {estado && (
            <span
              className={
                estado.tipo === 'error'
                  ? 'text-xs text-terminal-down'
                  : estado.tipo === 'ok'
                    ? 'text-xs text-terminal-accent'
                    : 'text-xs text-terminal-dim'
              }
            >
              {estado.tipo === 'cargando' ? `Procesando ${estado.ticker}…` : `${estado.ticker}: ${estado.texto}`}
            </span>
          )}
        </form>
      ) : (
        <p className="mb-4 rounded border border-terminal-border bg-terminal-panel px-3 py-2 text-xs text-terminal-dim">
          Para elegir tickers necesitás configurar el alta/baja automática — botón 🔑 en la barra
          de Listado/Fundamentales.
        </p>
      )}

      {cargando ? (
        <TablaSkeleton columnas={4} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : tickers.length === 0 ? (
        <div className="rounded-lg border border-terminal-border bg-terminal-panel p-8 text-center text-sm text-terminal-dim">
          Todavía no elegiste ningún ticker para el histórico fundamental.
        </div>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <label className="text-xs text-terminal-dim">Ver:</label>
            <select
              className={selectCls}
              value={ventanaMeses}
              onChange={(e) => setVentanaMeses(Number(e.target.value))}
            >
              {OPCIONES_VENTANA.map((o) => (
                <option key={o.valor} value={o.valor}>
                  {o.etiqueta}
                </option>
              ))}
            </select>
            {disponibles.length >= 2 && (
              <button
                type="button"
                onClick={() => setModoComparar((v) => !v)}
                className={`${btnCls} ${modoComparar ? 'border-terminal-accent text-terminal-text' : ''}`}
              >
                🔀 Comparar tickers
              </button>
            )}
          </div>

          {modoComparar && disponibles.length >= 2 && (
            <div className="mb-6 flex flex-col gap-3 rounded-lg border border-terminal-border bg-terminal-panel p-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-terminal-dim">Tickers:</span>
                {disponibles.map((t) => (
                  <label key={t.ticker} className="flex cursor-pointer items-center gap-1 text-sm text-terminal-text">
                    <input
                      type="checkbox"
                      checked={tickersComparar.includes(t.ticker)}
                      onChange={() => toggleComparar(t.ticker)}
                      className="accent-terminal-accent"
                    />
                    {t.ticker}
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-terminal-dim">Ratio:</span>
                <select className={selectCls} value={ratioComparar} onChange={(e) => setRatioComparar(e.target.value)}>
                  {TODOS_RATIOS.map((r) => (
                    <option key={r.campo} value={r.campo}>
                      {r.etiqueta}
                    </option>
                  ))}
                </select>
              </div>
              {tickersComparar.length < 2 ? (
                <p className="text-xs text-terminal-dim">Elegí al menos 2 tickers para superponerlos.</p>
              ) : (
                <GraficoComparativo
                  series={seriesComparar}
                  campo={ratioComparado.campo}
                  etiqueta={ratioComparado.etiqueta}
                  formatoValor={ratioComparado.formato}
                  ventanaMeses={ventanaMeses}
                />
              )}
            </div>
          )}

          <div className="flex flex-col gap-6">
            {tickers.map((t) => (
              <div key={t.ticker} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-terminal-text">{t.ticker}</span>
                  {t.nombre && <span className="text-xs text-terminal-dim">{t.nombre}</span>}
                  {patConfigurado && (
                    <button
                      type="button"
                      onClick={() => quitar(t.ticker)}
                      title="Sacar de la lista de histórico"
                      className="ml-auto text-xs text-terminal-dim hover:text-terminal-down"
                    >
                      ✕ quitar
                    </button>
                  )}
                </div>

                {!t.disponible ? (
                  <div className="rounded-lg border border-terminal-warn/40 bg-terminal-warn/10 px-3 py-2 text-xs text-terminal-text">
                    Sin datos: {t.motivo}
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {TODOS_RATIOS.map((r) => (
                      <GraficoRatio
                        key={r.campo}
                        ticker={t.ticker}
                        nombre={t.nombre}
                        etiqueta={r.etiqueta}
                        color={r.color}
                        serie={seriesPorTicker.get(t.ticker)}
                        campo={r.campo}
                        formatoValor={r.formato}
                        ventanaMeses={ventanaMeses}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
