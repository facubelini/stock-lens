import { useState } from 'react'
import { descargarTickersXlsx } from '../lib/excel'
import { useWatchlist } from '../lib/watchlist'
import { getPat, agregarTickerRemoto } from '../lib/githubApi'

function BotonPublicar({ ticker }) {
  const [estado, setEstado] = useState(null) // 'cargando' | 'ok' | 'error'
  const [msg, setMsg] = useState('')

  const publicar = async () => {
    setEstado('cargando')
    try {
      const r = await agregarTickerRemoto(ticker)
      setEstado('ok')
      setMsg(r.agregado ? 'listo, esperá la corrida' : 'ya estaba en el Excel')
    } catch (err) {
      setEstado('error')
      setMsg(err.message)
    }
  }

  if (estado === 'ok') return <span className="text-terminal-accent">✓ {msg}</span>
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={publicar}
        disabled={estado === 'cargando'}
        title="Agregar a tickers.xlsx y disparar la actualización de datos"
        className="text-terminal-accent underline hover:text-terminal-text disabled:opacity-50"
      >
        {estado === 'cargando' ? 'publicando…' : '↻ publicar automático'}
      </button>
      {estado === 'error' && <span className="text-terminal-down" title={msg}>error</span>}
    </span>
  )
}

// Aviso de tickers de la lista que aún no tienen datos calculados.
// Cada uno trae una ✕ para quitarlo (útil ante typos del alta manual).
export default function Pendientes({ pendientes, watchlist }) {
  const { quitar } = useWatchlist()
  if (!pendientes?.length) return null
  const autoDisponible = Boolean(getPat())

  return (
    <div className="mb-3 rounded border border-terminal-warn/40 bg-terminal-warn/10 px-3 py-2 text-xs text-terminal-text">
      <b>{pendientes.length}</b> ticker(s) de tu lista todavía no tienen datos calculados:
      <span className="ml-1 inline-flex flex-wrap gap-2 align-middle">
        {pendientes.map((p) => (
          <span
            key={p.ticker}
            className="inline-flex items-center gap-1 rounded bg-terminal-panel px-1.5 py-0.5"
          >
            {p.ticker}
            {autoDisponible && <BotonPublicar ticker={p.ticker} />}
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
        {autoDisponible ? (
          <>
            Con el alta automática activada, cada ticker nuevo se publica solo al agregarlo. Si
            alguno quedó pendiente (typo corregido, error de red), usá "publicar automático" arriba.
          </>
        ) : (
          <>
            Para que tengan datos,{' '}
            <button
              type="button"
              onClick={() => descargarTickersXlsx(watchlist)}
              className="underline hover:text-terminal-accent"
            >
              descargá tu tickers.xlsx
            </button>{' '}
            , commiteálo al repo y corré el workflow "Actualizar datos" (o sumalos a{' '}
            <code>data/tickers.xlsx</code>). También podés activar el alta automática con el botón
            🔑 de arriba para que esto lo haga la app sola.
          </>
        )}
      </div>
    </div>
  )
}
