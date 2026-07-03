import { useRef, useState } from 'react'
import { useWatchlist } from '../lib/watchlist'
import { parsearExcelTickers, descargarTickersXlsx } from '../lib/excel'
import { getPat, setPat, agregarTickerRemoto } from '../lib/githubApi'

const btn =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1 hover:border-terminal-accent hover:text-terminal-text'

const inputCls =
  'mt-1 w-full rounded border border-terminal-border bg-terminal-bg px-2 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

function ModalConfigPat({ onClose }) {
  const [valor, setValor] = useState('')
  const [guardado, setGuardado] = useState(Boolean(getPat()))

  const guardar = () => {
    setPat(valor)
    setGuardado(Boolean(valor.trim()))
    setValor('')
  }

  const borrar = () => {
    setPat('')
    setGuardado(false)
    setValor('')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-terminal-border bg-terminal-panel p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 text-sm font-semibold text-terminal-text">
          Alta/baja automática de tickers
        </h3>
        <p className="mb-3 text-xs leading-relaxed text-terminal-dim">
          Con un GitHub token configurado, al apretar <b>Agregar</b> la app suma el ticker a{' '}
          <code>data/tickers.xlsx</code> del repo y dispara "Actualizar datos" sola. También podés
          sacar un ticker para siempre (ej. se deslistó, ya no te interesa) desde el botón ✏️ de
          cada fila en Listado/Fundamentales — no hace falta descargar el Excel ni tocar nada a
          mano. El token se guarda solo en este navegador y se usa únicamente para llamar a la API
          de GitHub.
        </p>
        <p className="mb-3 text-xs text-terminal-dim">
          Necesitás un{' '}
          <a
            href="https://github.com/settings/tokens?type=beta"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-terminal-accent"
          >
            fine-grained token
          </a>{' '}
          sobre el repo <code>facubelini/stock-lens</code> con permisos <b>Contents: Read and
          write</b> y <b>Actions: Read and write</b>.
        </p>

        {guardado && (
          <p className="mb-2 text-xs text-terminal-accent">✓ Token configurado en este navegador.</p>
        )}

        <input
          type="password"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          placeholder="github_pat_..."
          className={inputCls}
        />

        <div className="mt-3 flex items-center justify-between gap-2">
          {guardado ? (
            <button
              type="button"
              onClick={borrar}
              className="rounded border border-terminal-border px-2.5 py-1.5 text-xs text-terminal-dim hover:border-terminal-down hover:text-terminal-down"
            >
              Borrar token
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-terminal-border px-2.5 py-1.5 text-xs text-terminal-dim hover:text-terminal-text"
            >
              Cerrar
            </button>
            <button
              type="button"
              onClick={guardar}
              disabled={!valor.trim()}
              className="rounded bg-terminal-accent px-2.5 py-1.5 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-40"
            >
              Guardar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Barra global: armar "Mi lista" cargando un Excel o agregando tickers a mano.
export default function WatchlistBar() {
  const { watchlist, setWatchlist, limpiar, agregar } = useWatchlist()
  const inputRef = useRef(null)
  const [error, setError] = useState(null)
  const [nuevo, setNuevo] = useState('')
  const [mostrarConfig, setMostrarConfig] = useState(false)
  const [estadoAlta, setEstadoAlta] = useState(null) // { tipo: 'cargando'|'ok'|'error', ticker, texto }

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

  const onAgregar = async (e) => {
    e.preventDefault()
    const tk = nuevo.trim().toUpperCase()
    if (!tk) return
    agregar(tk)
    setNuevo('')

    if (!getPat()) {
      setEstadoAlta(null)
      return
    }

    setEstadoAlta({ tipo: 'cargando', ticker: tk })
    try {
      const r = await agregarTickerRemoto(tk)
      setEstadoAlta({
        tipo: 'ok',
        ticker: tk,
        texto: r.agregado
          ? 'agregado al repo, la actualización de datos ya arrancó (unos minutos).'
          : 'ya estaba en tickers.xlsx.',
      })
    } catch (err) {
      setEstadoAlta({ tipo: 'error', ticker: tk, texto: err.message })
    }
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

        <button
          type="button"
          className={btn}
          onClick={() => setMostrarConfig(true)}
          title="Configurar alta automática de tickers"
        >
          {getPat() ? '🔑 Auto: ON' : '🔑 Configurar auto'}
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

        {estadoAlta && (
          <span
            className={
              estadoAlta.tipo === 'error'
                ? 'text-terminal-down'
                : estadoAlta.tipo === 'ok'
                  ? 'text-terminal-accent'
                  : 'text-terminal-dim'
            }
          >
            {estadoAlta.tipo === 'cargando'
              ? `Publicando ${estadoAlta.ticker}…`
              : `${estadoAlta.ticker}: ${estadoAlta.texto}`}
          </span>
        )}
      </div>

      {mostrarConfig && <ModalConfigPat onClose={() => setMostrarConfig(false)} />}
    </div>
  )
}
