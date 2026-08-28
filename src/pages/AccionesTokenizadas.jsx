import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getSymbolsTradfi } from '../lib/crypto/binanceApi'
import { useEscaneoBinance } from '../lib/crypto/useEscaneo'
import {
  INTERVALOS,
  MULTIPLOS_ATR,
  CORTO,
  LARGO,
  COLOR_SENAL,
  CATEGORIAS_TRADFI,
  CATEGORIA_DEFAULT,
} from '../lib/crypto/constantes'
import { fmtPrecioAccion } from '../lib/crypto/formato'
import { useJson } from '../lib/useJson'
import Insignia from '../components/crypto/Insignia'
import BarraRSI from '../components/crypto/BarraRSI'
import PanelApalancamiento from '../components/crypto/PanelApalancamiento'

const selectCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

function cat(tipo) {
  return CATEGORIAS_TRADFI[tipo] ?? CATEGORIA_DEFAULT
}

export default function AccionesTokenizadas() {
  const [intervalo, setIntervalo] = useState('1h')
  const [multiploATR, setMultiploATR] = useState(2.0)
  const [filtro, setFiltro] = useState('all')
  const [categoria, setCategoria] = useState('all')
  const [busqueda, setBusqueda] = useState('')
  const [sortKey, setSortKey] = useState('score')
  const [sortAsc, setSortAsc] = useState(true)
  const [seleccionado, setSeleccionado] = useState(null)

  // Precios de cierre de la accion real (pipeline yfinance) para calcular la
  // diferencia contra el perpetuo, que cotiza 24/7.
  const { data: medias } = useJson('medias.json')
  const precioReal = useMemo(() => {
    const m = new Map()
    for (const f of medias ?? []) if (f.precio != null) m.set(f.ticker, f.precio)
    return m
  }, [medias])

  const cargarSimbolos = useCallback(() => getSymbolsTradfi(), [])
  const { datos, corriendo, progreso, ultimaActualizacion, errorMsg, omitidos, cacheKlines, escanear } =
    useEscaneoBinance({ cargarSimbolos, intervalo, multiploATR })

  // Se le pega a cada fila el precio de la accion real y la diferencia %.
  const filas = useMemo(
    () =>
      datos.map((r) => {
        const real = precioReal.get(r.base)
        return {
          ...r,
          precio_real: real ?? null,
          dif_real: real ? +(((r.price - real) / real) * 100).toFixed(2) : null,
        }
      }),
    [datos, precioReal],
  )

  const conteos = useMemo(
    () => ({
      total: filas.length,
      short: filas.filter((r) => CORTO.includes(r.cls)).length,
      long: filas.filter((r) => LARGO.includes(r.cls)).length,
      neutral: filas.filter((r) => r.cls === 'n').length,
    }),
    [filas],
  )

  const categorias = useMemo(() => {
    const c = new Map()
    for (const r of filas) c.set(r.tipo, (c.get(r.tipo) ?? 0) + 1)
    return [...c.entries()].sort((a, b) => cat(a[0]).orden - cat(b[0]).orden)
  }, [filas])

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    const r = filas.filter((row) => {
      if (q && !row.symbol.toLowerCase().includes(q)) return false
      if (categoria !== 'all' && row.tipo !== categoria) return false
      if (filtro === 'short') return CORTO.includes(row.cls)
      if (filtro === 'long') return LARGO.includes(row.cls)
      if (filtro === 'neutral') return row.cls === 'n'
      return true
    })
    return r.sort((a, b) => {
      const va = a[sortKey] ?? 0
      const vb = b[sortKey] ?? 0
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va)
      return sortAsc ? va - vb : vb - va
    })
  }, [filas, filtro, categoria, busqueda, sortKey, sortAsc])

  const ordenar = (clave) => {
    if (sortKey === clave) setSortAsc((a) => !a)
    else {
      setSortKey(clave)
      setSortAsc(true)
    }
  }

  const filaSeleccionada = seleccionado ? filas.find((r) => r.symbolRaw === seleccionado) : null

  const columnas = [
    { key: 'symbol', label: 'Símbolo' },
    { key: 'tipo', label: 'Mercado' },
    { key: 'price', label: 'Perp' },
    { key: 'dif_real', label: 'vs cierre', titulo: 'Diferencia entre el perpetuo (cotiza 24/7) y el último cierre de la acción real según el pipeline de yfinance. Fuera del horario de mercado incluye el movimiento que la acción todavía no reflejó.' },
    { key: 'chg24h', label: '24h %' },
    { key: 'score', label: 'Score' },
    { key: 'signal', label: 'Señal' },
    { key: 'rsi', label: 'RSI' },
    { key: 'srsi', label: 'StochRSI' },
    { key: 'bb_pct', label: 'BB %' },
    { key: 'ema_trend', label: 'EMA' },
    { key: 'vol_ratio', label: 'Vol×' },
    { key: 'sl_pct', label: 'SL %' },
    { key: 'tp2_pct', label: 'TP2 %' },
  ]

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Acciones Tokenizadas</h1>
        <p className="text-xs text-terminal-dim">
          Misma lógica que el Crypto Screener (RSI + StochRSI + MACD + Bollinger + alineación de
          EMAs + volumen, con calculadora de apalancamiento y liquidación), pero sobre los{' '}
          <b>perpetuos de acciones tokenizadas</b> de Binance Futures — así podés operar{' '}
          <b>short</b> en MSTR, TSLA o NVDA sin pedir prestado el papel. Incluye ETFs apalancados
          (SOXL, TQQQ, UVXY), commodities (oro, petróleo) y pre-IPO (OPENAI, ANTHROPIC). Cotizan
          24/7, incluso con el mercado cerrado. Corre 100% en tu navegador. Orientativo, no es
          recomendación de inversión.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="text-xs text-terminal-dim">Temporalidad</label>
        <select value={intervalo} onChange={(e) => setIntervalo(e.target.value)} className={selectCls}>
          {INTERVALOS.map((i) => (
            <option key={i.valor} value={i.valor}>
              {i.etiqueta}
            </option>
          ))}
        </select>
        <label className="text-xs text-terminal-dim">SL (ATR ×)</label>
        <select
          value={multiploATR}
          onChange={(e) => setMultiploATR(Number(e.target.value))}
          className={selectCls}
        >
          {MULTIPLOS_ATR.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={escanear}
          disabled={corriendo}
          className="rounded bg-terminal-accent px-3 py-1.5 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50"
        >
          {corriendo ? '⏳ Escaneando…' : filas.length ? '▶ Re-escanear' : '▶ Escanear'}
        </button>
        {ultimaActualizacion && (
          <span className="text-xs text-terminal-dim">
            Actualizado: {ultimaActualizacion}
            {omitidos > 0 && (
              <span title="Símbolos sin suficiente historial en esta temporalidad (recién listados): hacen falta 60 velas mínimo.">
                {' '}
                · {omitidos} sin historial suficiente
              </span>
            )}
          </span>
        )}
      </div>

      {corriendo && (
        <div className="mb-4 h-1 w-full overflow-hidden rounded bg-terminal-border">
          <div
            className="h-full bg-terminal-accent transition-all"
            style={{ width: `${progreso.total ? (progreso.hecho / progreso.total) * 100 : 0}%` }}
          />
        </div>
      )}

      {errorMsg && (
        <div className="mb-4 rounded border border-terminal-down/40 bg-terminal-down/10 px-3 py-2 text-xs text-terminal-down">
          Error: {errorMsg}
        </div>
      )}

      {!filas.length && !corriendo ? (
        <div className="rounded-lg border border-terminal-border bg-terminal-panel p-10 text-center text-sm text-terminal-dim">
          Presioná <b>Escanear</b> para analizar los perpetuos de acciones tokenizadas de Binance.
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {[
              { k: 'all', l: `TODOS: ${conteos.total}`, cls: 'bg-terminal-panel2 text-terminal-text' },
              { k: 'short', l: `SHORT: ${conteos.short}`, cls: 'bg-terminal-down/20 text-terminal-down' },
              { k: 'long', l: `LONG: ${conteos.long}`, cls: 'bg-terminal-up/20 text-terminal-up' },
              { k: 'neutral', l: `NEUTRAL: ${conteos.neutral}`, cls: 'bg-terminal-border text-terminal-dim' },
            ].map((p) => (
              <button
                key={p.k}
                type="button"
                onClick={() => setFiltro(p.k)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${p.cls} ${
                  filtro === p.k ? 'ring-2 ring-terminal-accent' : ''
                }`}
              >
                {p.l}
              </button>
            ))}
            <select
              value={categoria}
              onChange={(e) => setCategoria(e.target.value)}
              className={selectCls}
              title="Filtrar por mercado del subyacente"
            >
              <option value="all">Todos los mercados</option>
              {categorias.map(([tipo, n]) => (
                <option key={tipo} value={tipo}>
                  {cat(tipo).etiqueta} ({n})
                </option>
              ))}
            </select>
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar símbolo…"
              className="w-44 rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
            />
            <span className="ml-auto text-xs text-terminal-dim">
              {filtrados.length} resultado(s) · click en una fila para la calculadora
            </span>
          </div>

          <div className="overflow-x-auto rounded-lg border border-terminal-border">
            <table className="min-w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                  {columnas.map((c) => (
                    <th
                      key={c.key}
                      onClick={() => ordenar(c.key)}
                      title={c.titulo}
                      className={`cursor-pointer whitespace-nowrap px-2 py-2.5 font-semibold hover:text-terminal-text ${
                        sortKey === c.key ? 'text-terminal-accent' : ''
                      }`}
                    >
                      {c.label}
                      {sortKey === c.key ? (sortAsc ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtrados.map((r) => {
                  const esCorto = CORTO.includes(r.cls)
                  const c = COLOR_SENAL[r.cls] ?? COLOR_SENAL.n
                  return (
                    <tr
                      key={r.symbolRaw}
                      onClick={() => setSeleccionado(r.symbolRaw)}
                      className="cursor-pointer border-t border-terminal-border transition-colors hover:brightness-125"
                      style={{ backgroundColor: c.bg, color: c.text }}
                    >
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold">
                        <Link
                          to={`/tokenizadas/${encodeURIComponent(r.symbolRaw)}`}
                          onClick={(e) => e.stopPropagation()}
                          className="hover:underline"
                          style={{ color: 'inherit' }}
                          title="Ver en su propia página"
                        >
                          {r.symbol}
                        </Link>
                        <a
                          href={r.link}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="ml-1 opacity-60 hover:opacity-100"
                          style={{ color: 'inherit' }}
                          title="Abrir en Binance Futures"
                        >
                          ↗
                        </a>
                        {r.precio_real != null && (
                          <Link
                            to={`/ticker/${encodeURIComponent(r.base)}`}
                            onClick={(e) => e.stopPropagation()}
                            className="ml-1 opacity-60 hover:opacity-100"
                            style={{ color: 'inherit' }}
                            title={`Ver el análisis de ${r.base} en Stock Lens`}
                          >
                            🔍
                          </Link>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-xs text-terminal-dim">
                        {cat(r.tipo).corta}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {fmtPrecioAccion(r.price)}
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 tabular"
                        title={
                          r.precio_real != null
                            ? `Perp ${fmtPrecioAccion(r.price)} vs cierre de ${r.base} ${fmtPrecioAccion(r.precio_real)}`
                            : 'La acción real no está en tu tickers.xlsx'
                        }
                      >
                        {r.dif_real != null ? (
                          <span style={{ color: r.dif_real >= 0 ? '#4ade80' : '#f87171' }}>
                            {r.dif_real >= 0 ? '+' : ''}
                            {r.dif_real}%
                          </span>
                        ) : (
                          <span className="text-terminal-dim">—</span>
                        )}
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 tabular"
                        style={{ color: r.chg24h >= 0 ? '#4ade80' : '#f87171' }}
                      >
                        {r.chg24h >= 0 ? '+' : ''}
                        {r.chg24h.toFixed(2)}%
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-bold tabular">
                        {r.score > 0 ? '+' : ''}
                        {r.score}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <Insignia cls={r.cls}>{r.signal}</Insignia>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.rsi}
                        <BarraRSI valor={r.rsi} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.srsi}
                        <BarraRSI valor={r.srsi} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">{r.bb_pct}%</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold">
                        {r.ema_trend === 'ALCISTA' ? '↑ ' : '↓ '}
                        {r.ema_trend}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.vol_ratio >= 2 ? <b>×{r.vol_ratio}</b> : `×${r.vol_ratio}`}
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 font-semibold tabular"
                        style={{ color: '#f87171' }}
                      >
                        {r.sl_pct != null ? `${esCorto ? '+' : ''}${r.sl_pct}%` : '—'}
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 font-semibold tabular"
                        style={{ color: '#4ade80' }}
                      >
                        {r.tp2_pct != null ? `${r.tp2_pct > 0 ? '+' : ''}${r.tp2_pct}%` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {filaSeleccionada && (
        <PanelApalancamiento
          fila={filaSeleccionada}
          klines={cacheKlines.current.get(filaSeleccionada.symbolRaw)}
          atrMult={multiploATR}
          to={`/tokenizadas/${encodeURIComponent(filaSeleccionada.symbolRaw)}`}
          onCerrar={() => setSeleccionado(null)}
        />
      )}
    </div>
  )
}
