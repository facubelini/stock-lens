import { useMemo, useState } from 'react'

const inputCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

// Buscador con autocompletado por ticker/nombre — compartido entre
// Herramientas.jsx y Valuaciones.jsx (antes copiado y pegado entre las dos).
export default function BuscadorTicker({ filas, excluir = [], onAdd, placeholder = 'Agregar ticker…' }) {
  const [q, setQ] = useState('')
  const sugeridos = useMemo(() => {
    const qq = q.trim().toUpperCase()
    if (!qq) return []
    return filas
      .filter((f) => !excluir.includes(f.ticker))
      .filter((f) => f.ticker.includes(qq) || (f.nombre ?? '').toUpperCase().includes(qq))
      .slice(0, 8)
  }, [q, filas, excluir])

  return (
    <div className="relative">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className={`${inputCls} w-56`}
      />
      {sugeridos.length > 0 && (
        <div className="absolute z-20 mt-1 w-56 overflow-hidden rounded border border-terminal-border bg-terminal-panel shadow-lg">
          {sugeridos.map((f) => (
            <button
              key={f.ticker}
              type="button"
              onClick={() => {
                onAdd(f.ticker)
                setQ('')
              }}
              className="block w-full truncate px-2.5 py-1.5 text-left text-sm hover:bg-terminal-panel2"
            >
              <span className="font-semibold text-terminal-text">{f.ticker}</span>{' '}
              <span className="text-terminal-dim">{f.nombre}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
