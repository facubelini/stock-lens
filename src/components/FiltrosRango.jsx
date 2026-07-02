import { GLOSARIO_POR_CLAVE } from '../lib/glosario'

// Filtros de rango (min/max) por ratio, estilo screener de Finviz. Se
// combinan con los filtros de industria/sector/búsqueda ya existentes.
export const RATIOS_FILTRABLES = [
  { key: 'per_trailing', label: 'PER' },
  { key: 'per_forward', label: 'PER fwd' },
  { key: 'peg', label: 'PEG' },
  { key: 'ev_sales', label: 'EV/Sales' },
  { key: 'pb', label: 'P/B' },
  { key: 'ps', label: 'P/S' },
  { key: 'market_cap', label: 'Market Cap', unidad: 'B', escala: 1e9 },
  { key: 'eps', label: 'EPS' },
  { key: 'profit_margin', label: 'Margen', unidad: '%' },
  { key: 'roe', label: 'ROE', unidad: '%' },
  { key: 'dividend_yield', label: 'Div. Yield', unidad: '%' },
  { key: 'beta', label: 'Beta' },
  { key: 'debt_to_equity', label: 'Deuda/Eq.' },
  { key: 'current_ratio', label: 'Liquidez' },
]

function rangoActivo(rg) {
  return rg && (rg.min !== '' || rg.max !== '')
}

// Filas sin dato en un ratio con filtro activo quedan afuera (no se puede
// confirmar que cumplan el rango), igual que hace Finviz.
export function aplicarFiltrosRango(filas, rangos) {
  const activos = RATIOS_FILTRABLES.filter((r) => rangoActivo(rangos[r.key]))
  if (!activos.length) return filas
  return filas.filter((fila) =>
    activos.every((r) => {
      const valor = fila[r.key]
      if (valor == null) return false
      const v = r.escala ? valor / r.escala : valor
      const rg = rangos[r.key]
      const min = rg.min === '' ? -Infinity : Number(rg.min)
      const max = rg.max === '' ? Infinity : Number(rg.max)
      return v >= min && v <= max
    }),
  )
}

const inputCls =
  'w-full rounded border border-terminal-border bg-terminal-bg px-1.5 py-1 text-xs text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

export default function FiltrosRango({ rangos, setRango, onLimpiar }) {
  const hayActivos = RATIOS_FILTRABLES.some((r) => rangoActivo(rangos[r.key]))

  return (
    <details className="mb-4 rounded-lg border border-terminal-border bg-terminal-panel">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-semibold text-terminal-text hover:text-terminal-accent">
        🎚️ Filtros por rango (screener){' '}
        {hayActivos && <span className="text-terminal-accent">· activos</span>}
      </summary>
      <div className="grid grid-cols-2 gap-3 border-t border-terminal-border p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {RATIOS_FILTRABLES.map((r) => {
          const rg = rangos[r.key] ?? { min: '', max: '' }
          const ayuda = GLOSARIO_POR_CLAVE[r.key]?.def
          return (
            <div key={r.key} className="flex flex-col gap-1">
              <span className="text-[11px] text-terminal-dim">
                {r.label}
                {r.unidad ? ` (${r.unidad})` : ''}
                {ayuda && (
                  <span title={ayuda} className="ml-0.5 cursor-help">
                    ⓘ
                  </span>
                )}
              </span>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  inputMode="decimal"
                  value={rg.min}
                  onChange={(e) => setRango(r.key, 'min', e.target.value)}
                  placeholder="min"
                  className={inputCls}
                />
                <span className="text-terminal-dim">–</span>
                <input
                  type="number"
                  inputMode="decimal"
                  value={rg.max}
                  onChange={(e) => setRango(r.key, 'max', e.target.value)}
                  placeholder="max"
                  className={inputCls}
                />
              </div>
            </div>
          )
        })}
      </div>
      {hayActivos && (
        <div className="border-t border-terminal-border px-3 py-2">
          <button
            type="button"
            onClick={onLimpiar}
            className="rounded border border-terminal-border px-2.5 py-1 text-xs text-terminal-dim hover:border-terminal-down hover:text-terminal-down"
          >
            ✕ Limpiar filtros de rango
          </button>
        </div>
      )}
    </details>
  )
}
