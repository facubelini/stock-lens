import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useJson } from '../lib/useJson'
import { useWatchlist, aplicarWatchlist } from '../lib/watchlist'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { useCryptoScan } from '../lib/cryptoScan'
import { TIMEFRAMES, prioridadScreener } from '../lib/screenerEstilos'
import TickerLink from '../components/TickerLink'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'

const N_POR_LADO = 15

function mejorMotivo(fila) {
  // el timeframe con verdict mas fuerte (COMPRA > CERCA > VENTA), para el detalle.
  const orden = { COMPRA: 3, VENTA: 3, CERCA: 2, EXTENDIDO: 1, NEUTRAL: 0 }
  let mejor = null
  for (const { key, label } of TIMEFRAMES) {
    const d = fila[key]
    if (!d) continue
    if (!mejor || (orden[d.verdict] ?? 0) > (orden[mejor.d.verdict] ?? 0)) mejor = { label, d }
  }
  return mejor ? `${mejor.label}: ${mejor.d.verdict}` : ''
}

function Fila({ item }) {
  const positivo = item.conviccion >= 0
  return (
    <tr className="border-t border-terminal-border">
      <td className="whitespace-nowrap px-2 py-1.5">
        <span className="mr-1.5">{item.tipo === 'crypto' ? '🪙' : '📈'}</span>
        {item.tipo === 'crypto' ? (
          <Link
            to={`/cripto/${encodeURIComponent(item.ticker.replace('/USDT', 'USDT'))}`}
            className="font-semibold text-terminal-text hover:text-terminal-accent hover:underline"
          >
            {item.ticker}
          </Link>
        ) : (
          <TickerLink ticker={item.ticker} className="font-semibold text-terminal-text" />
        )}
      </td>
      <td className="max-w-[200px] truncate px-2 py-1.5 text-terminal-dim" title={item.nombre}>
        {item.nombre || '—'}
      </td>
      <td className="px-2 py-1.5 text-terminal-dim">{item.detalle}</td>
      <td
        className="whitespace-nowrap px-2 py-1.5 text-right font-bold tabular"
        style={{ color: positivo ? '#7ee2a8' : '#ff9d9d' }}
      >
        {item.conviccion > 0 ? '+' : ''}
        {item.conviccion.toFixed(1)}
      </td>
    </tr>
  )
}

export default function TopSenales() {
  const { data: screenerData, cargando, error } = useJson('screener.json')
  const { watchlist } = useWatchlist()
  const { overrides } = useClasificacion()
  const { ultimoScan } = useCryptoScan()

  const screenerRaw = useMemo(() => (Array.isArray(screenerData) ? screenerData : []), [screenerData])
  const { filas: conWatchlist } = useMemo(() => aplicarWatchlist(screenerRaw, watchlist), [screenerRaw, watchlist])
  const screenerFilas = useMemo(() => aplicarClasificacion(conWatchlist, overrides), [conWatchlist, overrides])

  const items = useMemo(() => {
    const stocks = screenerFilas
      .map((f) => ({
        tipo: 'stock',
        ticker: f.ticker,
        nombre: f.nombre,
        conviccion: prioridadScreener(f),
        detalle: mejorMotivo(f),
      }))
      .filter((it) => it.conviccion !== 0)

    const crypto = (ultimoScan?.resultados ?? []).map((r) => ({
      tipo: 'crypto',
      ticker: r.symbol,
      nombre: '',
      conviccion: r.score,
      detalle: r.signal,
      link: r.link,
    }))

    return [...stocks, ...crypto]
  }, [screenerFilas, ultimoScan])

  const alcistas = useMemo(
    () => [...items].filter((i) => i.conviccion > 0).sort((a, b) => b.conviccion - a.conviccion).slice(0, N_POR_LADO),
    [items],
  )
  const bajistas = useMemo(
    () => [...items].filter((i) => i.conviccion < 0).sort((a, b) => a.conviccion - b.conviccion).slice(0, N_POR_LADO),
    [items],
  )

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Top Señales</h1>
        <p className="text-xs text-terminal-dim">
          Mezcla las señales del <Link to="/screener" className="underline hover:text-terminal-accent">Screener</Link> de
          acciones con el último escaneo de{' '}
          <Link to="/cripto" className="underline hover:text-terminal-accent">Crypto Screener</Link>, ordenadas por
          convicción, para tener en una sola pantalla dónde poner atención. Orientativo, no es recomendación de
          inversión.
        </p>
        {!ultimoScan && (
          <p className="mt-2 text-xs text-terminal-warn">
            Todavía no corriste un escaneo de cripto en esta sesión — corré uno en Crypto Screener para que sus
            señales aparezcan acá también.
          </p>
        )}
      </div>

      {cargando ? (
        <TablaSkeleton columnas={4} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <h2 className="mb-2 text-sm font-semibold text-terminal-up">▲ Mejores oportunidades alcistas</h2>
            {alcistas.length === 0 ? (
              <Vacio texto="No hay señales alcistas ahora mismo." />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-terminal-border">
                <table className="min-w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                      <th className="px-2 py-2 font-semibold">Ticker</th>
                      <th className="px-2 py-2 font-semibold">Nombre</th>
                      <th className="px-2 py-2 font-semibold">Señal</th>
                      <th className="px-2 py-2 text-right font-semibold">Conv.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alcistas.map((it) => (
                      <Fila key={`${it.tipo}-${it.ticker}`} item={it} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-terminal-down">▼ Mejores oportunidades bajistas</h2>
            {bajistas.length === 0 ? (
              <Vacio texto="No hay señales bajistas ahora mismo." />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-terminal-border">
                <table className="min-w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                      <th className="px-2 py-2 font-semibold">Ticker</th>
                      <th className="px-2 py-2 font-semibold">Nombre</th>
                      <th className="px-2 py-2 font-semibold">Señal</th>
                      <th className="px-2 py-2 text-right font-semibold">Conv.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bajistas.map((it) => (
                      <Fila key={`${it.tipo}-${it.ticker}`} item={it} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
