import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useJson } from '../lib/useJson'
import { getSymbols } from '../lib/crypto/binanceApi'

const MAX_RESULTADOS = 8

// Paleta de comandos (Ctrl+K / Cmd+K): buscar un ticker (acción o cripto) y
// saltar directo a su vista de detalle, sin pasar por el buscador de cada
// tabla. Los símbolos de cripto se traen recién al abrir la paleta la
// primera vez (no en cada carga de la app) y quedan cacheados en memoria.
export default function ComandoPaleta() {
  const [abierta, setAbierta] = useState(false)
  const [query, setQuery] = useState('')
  const [activo, setActivo] = useState(0)
  const [cripto, setCripto] = useState(null) // null = todavia no se pidio
  const inputRef = useRef(null)
  const navigate = useNavigate()
  const { data } = useJson('listado.json')

  const acciones = useMemo(() => data?.acciones ?? [], [data])

  useEffect(() => {
    if (abierta && cripto === null) {
      getSymbols()
        .then((simbolos) => setCripto(simbolos))
        .catch(() => setCripto([]))
    }
  }, [abierta, cripto])

  const resultados = useMemo(() => {
    const q = query.trim().toUpperCase()
    const accionesItem = (f) => ({ tipo: 'stock', ticker: f.ticker, nombre: f.nombre })
    const criptoItem = (s) => ({ tipo: 'crypto', ticker: s, nombre: 'Futuro perpetuo USDT' })

    if (!q) {
      return acciones.slice(0, MAX_RESULTADOS).map(accionesItem)
    }

    const accPorTicker = acciones.filter((f) => f.ticker.toUpperCase().startsWith(q)).map(accionesItem)
    const cryptoPorTicker = (cripto ?? [])
      .filter((s) => s.toUpperCase().startsWith(q))
      .map(criptoItem)
    const accPorNombre = acciones
      .filter((f) => !f.ticker.toUpperCase().startsWith(q) && (f.nombre ?? '').toUpperCase().includes(q))
      .map(accionesItem)

    return [...accPorTicker, ...cryptoPorTicker, ...accPorNombre].slice(0, MAX_RESULTADOS)
  }, [acciones, cripto, query])

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setAbierta((v) => !v)
      } else if (e.key === 'Escape' && abierta) {
        setAbierta(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [abierta])

  // Permite abrirla también desde un botón (ej. el hint del Header), sin
  // tener que levantar el estado hasta App.
  useEffect(() => {
    const abrir = () => setAbierta(true)
    window.addEventListener('stocklens:abrir-buscador', abrir)
    return () => window.removeEventListener('stocklens:abrir-buscador', abrir)
  }, [])

  useEffect(() => {
    if (abierta) {
      setQuery('')
      setActivo(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [abierta])

  useEffect(() => setActivo(0), [query])

  const ir = (item) => {
    setAbierta(false)
    if (item.tipo === 'crypto') navigate(`/cripto/${encodeURIComponent(item.ticker)}`)
    else navigate(`/ticker/${encodeURIComponent(item.ticker)}`)
  }

  const onKeyDownInput = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActivo((a) => Math.min(a + 1, resultados.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActivo((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (resultados[activo]) ir(resultados[activo])
    }
  }

  if (!abierta) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 px-4 pt-24"
      onClick={() => setAbierta(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-terminal-border bg-terminal-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDownInput}
          placeholder="Buscar ticker, empresa o cripto… (Esc para cerrar)"
          className="w-full border-b border-terminal-border bg-transparent px-4 py-3 text-sm text-terminal-text focus:outline-none"
        />
        {resultados.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-terminal-dim">Sin resultados.</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {resultados.map((item, i) => (
              <li key={`${item.tipo}-${item.ticker}`}>
                <button
                  type="button"
                  onClick={() => ir(item)}
                  onMouseEnter={() => setActivo(i)}
                  className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm ${
                    i === activo ? 'bg-terminal-accent/15 text-terminal-text' : 'text-terminal-dim'
                  }`}
                >
                  <span className="font-semibold text-terminal-text">
                    {item.tipo === 'crypto' ? '🪙 ' : '📈 '}
                    {item.tipo === 'crypto' ? item.ticker.replace('USDT', '/USDT') : item.ticker}
                  </span>
                  <span className="truncate text-xs text-terminal-dim">{item.nombre}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-terminal-border px-4 py-1.5 text-[11px] text-terminal-dim">
          ↑↓ para navegar · Enter para abrir · Ctrl+K para abrir/cerrar
        </div>
      </div>
    </div>
  )
}
