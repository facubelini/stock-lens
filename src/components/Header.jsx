import { NavLink } from 'react-router-dom'
import { useJson } from '../lib/useJson'
import { fmtFecha } from '../lib/formato'

const tabs = [
  { to: '/', label: 'Listado', end: true },
  { to: '/medias', label: 'Medias móviles' },
  { to: '/fundamentales', label: 'Fundamentales' },
  { to: '/comparables', label: 'Comparables' },
  { to: '/oportunidades', label: '💡 Oportunidades' },
  { to: '/screener', label: 'Screener' },
  { to: '/historico', label: 'Histórico Fundamental' },
  { to: '/cripto', label: 'Crypto Screener' },
  { to: '/top', label: '🔥 Top Señales' },
  { to: '/cartera', label: '📋 Mi Cartera' },
  { to: '/macro', label: '🌡️ Mercado' },
  { to: '/herramientas', label: '🧮 Herramientas' },
  { to: '/screeners', label: '📡 Screeners' },
  { to: '/scanner', label: '🔭 Scanner' },
  { to: '/warren-score', label: '🎯 Warren Score' },
  { to: '/valuaciones', label: '💎 Valuaciones' },
]

export default function Header() {
  const { data: meta } = useJson('meta.json')

  const invalidos = meta?.tickers_invalidos?.length ?? 0

  return (
    <header className="sticky top-0 z-30 border-b border-terminal-border bg-terminal-bg/95 backdrop-blur">
      <div className="flex w-full flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl font-bold tracking-tight text-terminal-accent">
            🔍 Stock Lens
          </span>
          <span className="hidden text-xs text-terminal-dim sm:inline">· análisis de acciones</span>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('stocklens:abrir-buscador'))}
            title="Buscar un ticker (Ctrl+K)"
            className="ml-1 rounded border border-terminal-border px-2 py-1 text-xs text-terminal-dim hover:border-terminal-accent hover:text-terminal-text"
          >
            🔎 <span className="hidden sm:inline">Ctrl+K</span>
          </button>
        </div>

        <nav className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                `rounded px-3 py-1.5 text-sm transition-colors ${
                  isActive
                    ? 'bg-terminal-accent font-semibold text-black'
                    : 'text-terminal-dim hover:bg-terminal-panel2 hover:text-terminal-text'
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>

        <div className="group relative cursor-help text-xs text-terminal-dim">
          <span>Última actualización: </span>
          <span className="text-terminal-text">
            {meta ? fmtFecha(meta.ultima_actualizacion) : '—'}
          </span>
          {invalidos > 0 && (
            <span className="ml-2 text-terminal-warn">· {invalidos} ticker(s) sin datos</span>
          )}
          <div className="absolute right-0 z-40 mt-1 hidden w-72 rounded border border-terminal-border bg-terminal-panel p-2.5 text-[11px] leading-relaxed text-terminal-dim shadow-lg group-hover:block">
            Los datos reflejan la última corrida del pipeline (yfinance) en GitHub Actions, no son
            en tiempo real tick a tick. Se actualizan periódicamente durante el horario de mercado.
          </div>
        </div>
      </div>
    </header>
  )
}
