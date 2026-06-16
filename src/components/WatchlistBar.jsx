import { useRef, useState } from 'react'
import { useWatchlist } from '../lib/watchlist'
import { parsearExcelTickers, descargarTickersXlsx } from '../lib/excel'

const btn =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1 hover:border-terminal-accent hover:text-terminal-text'

// Barra global: cargar / descargar / quitar la watchlist desde un Excel.
export default function WatchlistBar() {
  const { watchlist, setWatchlist, limpiar } = useWatchlist()
  const inputRef = useRef(null)
  const [error, setError] = useState(null)

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    try {
      const { filas, errores } = await parsearExcelTickers(file)
      if (errores.length) setError(errores[0])
      else setWatchlist(filas)
    } catch (err) {
      setError('No se pudo leer el archivo: ' + err.message)
    } finally {
      e.target.value = ''
    }
  }

  return (
    <div className="border-b border-terminal-border bg-terminal-panel/50">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2 text-xs text-terminal-dim">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={onFile}
          className="hidden"
        />
        <button type="button" className={btn} onClick={() => inputRef.current?.click()}>
          📄 Cargar Excel
        </button>

        {watchlist ? (
          <>
            <span className="text-terminal-text">
              Mi lista: <b>{watchlist.length}</b> tickers
            </span>
            <button type="button" className={btn} onClick={() => descargarTickersXlsx(watchlist)}>
              ⬇ tickers.xlsx
            </button>
            <button
              type="button"
              className="rounded border border-terminal-border px-2.5 py-1 hover:border-terminal-down hover:text-terminal-down"
              onClick={limpiar}
            >
              ✕ Quitar lista
            </button>
          </>
        ) : (
          <span>
            Subí tu Excel (<code>Ticker · Industria · Pais · Nombre</code>) para ver sólo tu lista.
            Se guarda en tu navegador.
          </span>
        )}

        {error && <span className="text-terminal-down">{error}</span>}
      </div>
    </div>
  )
}
