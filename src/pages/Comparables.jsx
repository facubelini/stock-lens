import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { GLOSARIO_POR_CLAVE } from '../lib/glosario'
import Glosario from '../components/Glosario'
import TickerLink from '../components/TickerLink'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { fmtNum, fmtPct, fmtMarketCap, estiloPER, estiloPEG, claseAlineacion } from '../lib/formato'

const ayudaDe = (key) => GLOSARIO_POR_CLAVE[key]?.def

// Mismas columnas de ratios que Fundamentales, pero sin depender de esa pagina
// (los datos de comparables tienen forma distinta: un grupo por industria).
const COLUMNAS = [
  { key: 'per_trailing', label: 'PER', dec: 1, estilo: estiloPER },
  { key: 'per_forward', label: 'PER fwd', dec: 1, estilo: estiloPER },
  { key: 'peg', label: 'PEG', dec: 2, estilo: estiloPEG },
  { key: 'ev_sales', label: 'EV/Sales', dec: 2 },
  { key: 'pb', label: 'P/B', dec: 2 },
  { key: 'ps', label: 'P/S', dec: 2 },
  { key: 'market_cap', label: 'Market Cap', esCap: true },
  { key: 'eps', label: 'EPS', dec: 2 },
  { key: 'profit_margin', label: 'Margen', esPct: true },
  { key: 'roe', label: 'ROE', esPct: true },
  { key: 'dividend_yield', label: 'Div. Yield', esPct: true },
  { key: 'beta', label: 'Beta', dec: 2 },
  { key: 'debt_to_equity', label: 'Deuda/Eq.', dec: 2 },
  { key: 'current_ratio', label: 'Liquidez', dec: 2 },
]

function renderValor(col, valor) {
  if (col.esCap) return fmtMarketCap(valor)
  if (col.esPct) return fmtPct(valor)
  return fmtNum(valor, col.dec ?? 2)
}

export default function Comparables() {
  const { data, cargando, error } = useJson('comparables.json')
  const grupos = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const [industriaSel, setIndustriaSel] = useState('')

  const grupo = useMemo(() => {
    if (!grupos.length) return null
    return grupos.find((g) => g.industria === industriaSel) ?? grupos[0]
  }, [grupos, industriaSel])

  const pares = useMemo(() => {
    if (!grupo) return []
    return [...grupo.pares].sort((a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0))
  }, [grupo])

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Comparables</h1>
        <p className="text-xs text-terminal-dim">
          Para cada industria, un universo de empresas de referencia (curado a mano, puede incluir
          tickers que no están en tu watchlist) para ver dónde se ubican los ratios de tu empresa
          frente a la <b>mediana de la industria</b>.
        </p>
      </div>

      <Glosario />

      {cargando ? (
        <TablaSkeleton columnas={8} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : grupos.length === 0 ? (
        <Vacio texto="Todavía no hay comparables generados para tus industrias." />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <select
              className="rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
              value={grupo?.industria ?? ''}
              onChange={(e) => setIndustriaSel(e.target.value)}
            >
              {grupos.map((g) => (
                <option key={g.industria} value={g.industria}>
                  {g.industria} · {g.pares.length}
                </option>
              ))}
            </select>
            <span className="text-xs text-terminal-dim">
              <span className="text-terminal-accent">★</span> ya está en tu watchlist
            </span>
          </div>

          <div className="overflow-x-auto rounded-lg border border-terminal-border">
            <table className="min-w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                  <th className="whitespace-nowrap px-1.5 py-2.5 font-semibold">Ticker</th>
                  <th className="whitespace-nowrap px-1.5 py-2.5 font-semibold">Empresa</th>
                  {COLUMNAS.map((c) => (
                    <th
                      key={c.key}
                      className={`px-1.5 py-2.5 font-semibold leading-tight ${claseAlineacion('right')}`}
                    >
                      {c.label}
                      {ayudaDe(c.key) && (
                        <span title={ayudaDe(c.key)} className="ml-0.5 cursor-help font-normal text-terminal-dim">
                          ⓘ
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t-2 border-terminal-border bg-terminal-panel2">
                  <td className="whitespace-nowrap px-1.5 py-2 font-semibold text-terminal-accent" colSpan={2}>
                    Mediana · n={pares.length}
                  </td>
                  {COLUMNAS.map((c) => (
                    <td key={c.key} className="px-1.5 py-2 text-right tabular text-terminal-info">
                      {renderValor(c, grupo?.mediana?.[c.key])}
                    </td>
                  ))}
                </tr>
                {pares.map((p) => (
                  <tr
                    key={p.ticker}
                    className={`border-t border-terminal-border transition-colors hover:bg-terminal-panel2/60 ${
                      p.en_portfolio ? 'bg-terminal-accent/5' : ''
                    }`}
                  >
                    <td className="whitespace-nowrap px-1.5 py-1.5 font-semibold text-terminal-text">
                      {p.en_portfolio && <span className="text-terminal-accent">★ </span>}
                      <TickerLink ticker={p.ticker} />
                    </td>
                    <td className="max-w-[180px] truncate px-1.5 py-1.5 text-terminal-dim" title={p.nombre}>
                      {p.nombre || '—'}
                    </td>
                    {COLUMNAS.map((c) => (
                      <td
                        key={c.key}
                        className="px-1.5 py-1.5 text-right tabular"
                        style={c.estilo ? c.estilo(p[c.key]) : undefined}
                      >
                        {renderValor(c, p[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
