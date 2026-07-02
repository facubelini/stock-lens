import { useRef, useState } from 'react'
import { useWatchlist } from '../lib/watchlist'
import { parsearExcelTickers, descargarTickersXlsx } from '../lib/excel'

const btn =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1 hover:border-terminal-accent hover:text-terminal-text'

// Barra global: armar "Mi lista" cargando un Excel o agregando tickers a mano.
export default function WatchlistBar() {
  const { watchlist, setWatchlist, limpiar, agregar } = useWatchlist()
  const inputRef = useRef(null)
  const [error, setError] = useState(null)
  const [nuevo, setNuevo] = useState('')

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

  const onAgregar = (e) => {
    e.preventDefault()
    const tk = nuevo.trim()
    if (!tk) return
    agregar(tk)
    setNuevo('')
  }

  return (
    <div className="border-b border-terminal-border bg-terminal-panel/50">
      <div className="flex w-full flex-wrap items-center gap-2 px-4 py-2 text-xs text-terminal-dim">
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

        {/* Alta manual de un ticker */}
        <form onSubmit={onAgregar} className="flex items-center gap-1">
          <input
            value={nuevo}
            onChange={(e) => setNuevo(e.target.value)}
            placeholder="+ ticker (ej. AAPL)"
            className="w-36 rounded border border-terminal-border bg-terminal-panel px-2 py-1 text-terminal-text focus:border-terminal-accent focus:outline-none"
          />
          <button type="submit" className={btn}>
            Agregar
          </button>
        </form>

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
            Cargá un Excel o agregá tickers a mano para armar <b>tu lista</b> (filtra las 3
            pestañas). Se guarda en tu navegador.
          </span>
        )}

        {error && <span className="text-terminal-down">{error}</span>}
      </div>
    </div>
  )
}
