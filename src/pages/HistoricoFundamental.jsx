import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { getPat, agregarTickerHistorico, quitarTickerHistorico } from '../lib/githubApi'
import GraficoRatio from '../components/GraficoRatio'
import { TablaSkeleton, MensajeError } from '../components/Estados'

const LIMITE = 10

const RATIOS = [
  { campo: 'per_ltm', etiqueta: 'Price / Earnings - P/E (LTM)', color: '#a855f7', formato: (v) => `${v.toFixed(1)}x` },
  { campo: 'ev_sales_ltm', etiqueta: 'EV / Sales (LTM)', color: '#f97316', formato: (v) => `${v.toFixed(1)}x` },
  { campo: 'ps_ltm', etiqueta: 'Price / Sales - P/S (LTM)', color: '#22c55e', formato: (v) => `${v.toFixed(1)}x` },
]

const inputCls =
  'w-40 rounded border border-terminal-border bg-terminal-panel px-2 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

export default function HistoricoFundamental() {
  const { data, cargando, error } = useJson('historico_fundamental.json')
  const tickers = useMemo(() => (Array.isArray(data?.tickers) ? data.tickers : []), [data])
  const [nuevo, setNuevo] = useState('')
  const [estado, setEstado] = useState(null) // { tipo, ticker, texto }
  const patConfigurado = Boolean(getPat())

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
    setEstado({ tipo: 'cargando', ticker })
    try {
      await quitarTickerHistorico(ticker)
      setEstado({ tipo: 'ok', ticker, texto: 'sacado, la actualización ya arrancó.' })
    } catch (err) {
      setEstado({ tipo: 'error', ticker, texto: err.message })
    }
  }

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Histórico Fundamental</h1>
        <p className="text-xs text-terminal-dim">
          Evolución de <b>P/E</b>, <b>EV/Sales</b> y <b>P/S</b> (LTM, trailing twelve months) para
          hasta {LIMITE} tickers elegidos a mano, con datos oficiales de{' '}
          <b>SEC EDGAR</b> combinados con el precio histórico. Solo funciona para empresas que
          reportan a la SEC (listadas en EEUU o con ADR) — acciones que cotizan únicamente en
          Merval no van a tener datos acá. No incluye versiones "NTM" (forward) ni PEG: requieren
          estimaciones de analistas históricas, que no existen gratis.
        </p>
      </div>

      {patConfigurado ? (
        <form onSubmit={agregar} className="mb-4 flex flex-wrap items-center gap-2">
          <input
            value={nuevo}
            onChange={(e) => setNuevo(e.target.value)}
            placeholder="+ ticker (ej. AAPL)"
            className={inputCls}
          />
          <button
            type="submit"
            className="rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-dim hover:border-terminal-accent hover:text-terminal-text"
          >
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
                  {RATIOS.map((r) => (
                    <GraficoRatio
                      key={r.campo}
                      ticker={t.ticker}
                      nombre={t.nombre}
                      etiqueta={r.etiqueta}
                      color={r.color}
                      serie={t.serie}
                      campo={r.campo}
                      formatoValor={r.formato}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
