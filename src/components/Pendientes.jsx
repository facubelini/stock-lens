import { descargarTickersXlsx } from '../lib/excel'

// Aviso de tickers de la watchlist que aún no tienen datos calculados.
export default function Pendientes({ pendientes, watchlist }) {
  if (!pendientes?.length) return null
  return (
    <div className="mb-3 rounded border border-terminal-warn/40 bg-terminal-warn/10 px-3 py-2 text-xs text-terminal-text">
      <b>{pendientes.length}</b> ticker(s) de tu lista todavía no tienen datos calculados:{' '}
      <span className="text-terminal-dim">{pendientes.map((p) => p.ticker).join(', ')}</span>.{' '}
      Para incluirlos,{' '}
      <button
        type="button"
        onClick={() => descargarTickersXlsx(watchlist)}
        className="underline hover:text-terminal-accent"
      >
        descargá tu tickers.xlsx
      </button>{' '}
      , commiteálo al repo y corré el workflow “Actualizar datos”.
    </div>
  )
}
