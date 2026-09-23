import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useMeta } from '../lib/useJson'
import { fmtFecha } from '../lib/formato'

// Navegacion agrupada por seccion: antes eran 19 links sueltos en un
// flex-wrap que en celular ocupaban ~465px de header sticky. En desktop
// cada grupo es un menu desplegable; en celular todo va a un menu hamburguesa
// y el header cerrado queda en una sola linea.
const SECCIONES = [
  {
    id: 'acciones',
    label: 'Acciones',
    items: [
      { to: '/', label: 'Listado', end: true },
      { to: '/medias', label: 'Medias móviles' },
      { to: '/fundamentales', label: 'Fundamentales' },
      { to: '/comparables', label: 'Comparables' },
      { to: '/historico', label: 'Histórico fundamental' },
    ],
  },
  {
    id: 'screening',
    label: 'Screening',
    items: [
      { to: '/screener', label: 'Screener técnico' },
      { to: '/scanner', label: '🔭 Scanner de setups' },
      { to: '/top', label: '🔥 Top Señales' },
      { to: '/oportunidades', label: '💡 Oportunidades' },
      { to: '/warren-score', label: '🎯 Warren Score' },
      { to: '/screeners', label: '📡 Radar de eventos' },
      { to: '/pre-post', label: '🌗 Pre/Post market' },
    ],
  },
  {
    id: 'cripto',
    label: 'Cripto',
    items: [
      { to: '/cripto', label: 'Crypto Screener' },
      { to: '/cruces', label: '🎯 Cruces' },
      { to: '/tokenizadas', label: '🪙 Acciones Tokenizadas' },
    ],
  },
  { id: 'cartera', to: '/cartera', label: '📋 Mi Cartera' },
  { id: 'macro', to: '/macro', label: '🌡️ Mercado' },
  { id: 'herramientas', to: '/herramientas', label: '🧮 Herramientas' },
]

function rutaActiva(pathname, item) {
  if (item.end) return pathname === item.to
  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}

const claseLink = ({ isActive }) =>
  `block rounded px-3 py-1.5 text-sm transition-colors ${
    isActive
      ? 'bg-terminal-accent font-semibold text-black'
      : 'text-terminal-dim hover:bg-terminal-panel2 hover:text-terminal-text'
  }`

function MenuDesplegable({ seccion, abierto, onToggle, onCerrar, pathname }) {
  const ref = useRef(null)
  const activa = seccion.items.some((it) => rutaActiva(pathname, it))
  const actual = seccion.items.find((it) => rutaActiva(pathname, it))

  // Click afuera cierra.
  useEffect(() => {
    if (!abierto) return undefined
    const fuera = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onCerrar()
    }
    document.addEventListener('mousedown', fuera)
    return () => document.removeEventListener('mousedown', fuera)
  }, [abierto, onCerrar])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={abierto}
        aria-haspopup="true"
        className={`flex items-center gap-1 rounded px-3 py-1.5 text-sm transition-colors ${
          activa
            ? 'bg-terminal-accent font-semibold text-black'
            : 'text-terminal-dim hover:bg-terminal-panel2 hover:text-terminal-text'
        }`}
      >
        {seccion.label}
        {/* Pestaña activa dentro del grupo (sin el emoji), en pantallas anchas. */}
        {actual && (
          <span className="hidden font-normal 2xl:inline">· {actual.label.replace(/^[^\p{L}\p{N}]+/u, '')}</span>
        )}
        <span aria-hidden="true" className="text-[10px]">
          ▾
        </span>
      </button>
      {abierto && (
        <div className="absolute left-0 top-full z-40 mt-1 min-w-[220px] rounded-lg border border-terminal-border bg-terminal-panel p-1 shadow-xl">
          {seccion.items.map((it) => (
            <NavLink key={it.to} to={it.to} end={it.end} className={claseLink} onClick={onCerrar}>
              {it.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

// compacto = version de una linea para el header de desktop (fecha + cantidad
// de tickers sin datos, el detalle queda en el tooltip).
function InfoActualizacion({ meta, className = '', compacto = false }) {
  const invalidos = meta?.tickers_invalidos?.length ?? 0
  return (
    <div className={`group relative cursor-help text-xs text-terminal-dim ${className}`} tabIndex={0}>
      <span>{compacto ? '🕒 ' : 'Última actualización: '}</span>
      <span className="text-terminal-text">{meta ? fmtFecha(meta.ultima_actualizacion) : '—'}</span>
      {invalidos > 0 && (
        <span className="ml-2 text-terminal-warn">· {compacto ? `⚠ ${invalidos}` : `${invalidos} ticker(s) sin datos`}</span>
      )}
      <div className="absolute right-0 z-40 mt-1 hidden w-72 rounded border border-terminal-border bg-terminal-panel p-2.5 text-[11px] leading-relaxed text-terminal-dim shadow-lg group-hover:block group-focus:block">
        Última actualización de los datos. Reflejan la última corrida del pipeline (yfinance) en
        GitHub Actions, no son en tiempo real tick a tick. Se actualizan periódicamente durante el
        horario de mercado.
        {invalidos > 0 && <> {invalidos} ticker(s) del Excel no devolvieron datos en yfinance.</>}
      </div>
    </div>
  )
}

export default function Header() {
  const meta = useMeta()
  const { pathname } = useLocation()
  const [abierto, setAbierto] = useState(null) // id del desplegable abierto (desktop)
  const [menuMovil, setMenuMovil] = useState(false)

  // Al navegar se cierra cualquier menu.
  useEffect(() => {
    setAbierto(null)
    setMenuMovil(false)
  }, [pathname])

  // Esc cierra el desplegable / menu movil.
  useEffect(() => {
    if (!abierto && !menuMovil) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setAbierto(null)
        setMenuMovil(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [abierto, menuMovil])

  const cerrar = () => setAbierto(null)

  return (
    <header className="sticky top-0 z-30 border-b border-terminal-border bg-terminal-bg/95 backdrop-blur">
      <div className="flex w-full items-center justify-between gap-3 px-4 py-2">
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-lg font-bold tracking-tight text-terminal-accent lg:text-xl">🔍 Stock Lens</span>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('stocklens:abrir-buscador'))}
            title="Buscar un ticker (Ctrl+K)"
            aria-label="Buscar un ticker (Ctrl+K)"
            className="ml-1 rounded border border-terminal-border px-2 py-1 text-xs text-terminal-dim hover:border-terminal-accent hover:text-terminal-text"
          >
            🔎 <span className="hidden sm:inline lg:hidden xl:inline">Ctrl+K</span>
          </button>
        </div>

        {/* Desktop: grupos desplegables + links sueltos */}
        <nav aria-label="Secciones" className="hidden flex-1 flex-wrap items-center gap-0.5 lg:flex">
          {SECCIONES.map((s) =>
            s.items ? (
              <MenuDesplegable
                key={s.id}
                seccion={s}
                pathname={pathname}
                abierto={abierto === s.id}
                onToggle={() => setAbierto((a) => (a === s.id ? null : s.id))}
                onCerrar={cerrar}
              />
            ) : (
              <NavLink key={s.id} to={s.to} className={claseLink}>
                {s.label}
              </NavLink>
            ),
          )}
        </nav>

        <InfoActualizacion meta={meta} compacto className="hidden shrink-0 whitespace-nowrap xl:block" />

        {/* Celular / tablet: hamburguesa */}
        <button
          type="button"
          onClick={() => setMenuMovil((v) => !v)}
          aria-expanded={menuMovil}
          aria-controls="menu-movil"
          aria-label={menuMovil ? 'Cerrar menú' : 'Abrir menú'}
          className="rounded border border-terminal-border px-2.5 py-1 text-lg leading-none text-terminal-dim hover:border-terminal-accent hover:text-terminal-text lg:hidden"
        >
          {menuMovil ? '✕' : '☰'}
        </button>
      </div>

      {menuMovil && (
        <nav
          id="menu-movil"
          aria-label="Secciones"
          className="max-h-[calc(100vh-56px)] overflow-y-auto border-t border-terminal-border px-4 pb-3 pt-2 lg:hidden"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {SECCIONES.filter((s) => s.items).map((s) => (
              <div key={s.id}>
                <div className="mb-1 px-3 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">{s.label}</div>
                {s.items.map((it) => (
                  <NavLink key={it.to} to={it.to} end={it.end} className={claseLink}>
                    {it.label}
                  </NavLink>
                ))}
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1 border-t border-terminal-border pt-2">
            {SECCIONES.filter((s) => !s.items).map((s) => (
              <NavLink key={s.id} to={s.to} className={claseLink}>
                {s.label}
              </NavLink>
            ))}
          </div>
          <InfoActualizacion meta={meta} className="mt-2 px-3" />
        </nav>
      )}
    </header>
  )
}
