import { descargarTickersXlsx } from '../lib/excel'
import { useWatchlist } from '../lib/watchlist'

// Aviso de tickers de la lista que aún no tienen datos calculados.
// Cada uno trae una ✕ para quitarlo (útil ante typos del alta manual).
export default function Pendientes({ pendientes, watchlist }) {
  const { quitar } = useWatchlist()
  if (!pendientes?.length) return null
  return (
    <div className="mb-3 rounded border border-terminal-warn/40 bg-terminal-warn/10 px-3 py-2 text-xs text-terminal-text">
      <b>{pendientes.length}</b> ticker(s) de tu lista todavía no tienen datos calculados:
      <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
        {pendientes.map((p) => (
          <span
            key={p.ticker}
            className="inline-flex items-center gap-1 rounded bg-terminal-panel px-1.5 py-0.5"
          >
            {p.ticker}
            <button
              type="button"
              onClick={() => quitar(p.ticker)}
              title="Quitar de mi lista"
              className="text-terminal-dim hover:text-terminal-down"
            >
              ✕
            </button>
          </span>
        ))}
      </span>
      <div className="mt-1.5 text-terminal-dim">
        Para que tengan datos,{' '}
        <button
          type="button"
          onClick={() => descargarTickersXlsx(watchlist)}
          className="underline hover:text-terminal-accent"
        >
          descargá tu tickers.xlsx
        </button>{' '}
        , commiteálo al repo y corré el workflow “Actualizar datos” (o sumalos a{' '}
        <code>data/tickers.xlsx</code>).
      </div>
    </div>
  )
}
