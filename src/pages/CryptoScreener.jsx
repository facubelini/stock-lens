import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getSymbols, getKlines, sleep } from '../lib/crypto/binanceApi'
import { analyzeKlines } from '../lib/crypto/indicadores'
import { useCryptoScan } from '../lib/cryptoScan'
import { INTERVALOS, MULTIPLOS_ATR, CORTO, LARGO, COLOR_SENAL } from '../lib/crypto/constantes'
import { fmtPrice } from '../lib/crypto/formato'
import Insignia from '../components/crypto/Insignia'
import BarraRSI from '../components/crypto/BarraRSI'
import CalculadoraApalancamiento from '../components/crypto/CalculadoraApalancamiento'

const TAMANO_LOTE = 15

// ── Panel lateral: calculadora de apalancamiento/liquidacion ───────────────
function PanelApalancamiento({ fila, klines, atrMult, onCerrar }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onCerrar}>
      <div
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l-2 border-terminal-border bg-terminal-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-terminal-border bg-terminal-panel px-4 py-3">
          <Link
            to={`/cripto/${encodeURIComponent(fila.symbol.replace('/USDT', 'USDT'))}`}
            className="flex-1 font-semibold text-terminal-text hover:text-terminal-accent hover:underline"
            onClick={onCerrar}
            title="Ver en su propia página"
          >
            {fila.symbol}
          </Link>
          <button
            type="button"
            onClick={onCerrar}
            className="rounded border border-terminal-border px-2 py-1 text-xs text-terminal-dim hover:text-terminal-text"
          >
            ✕
          </button>
        </div>
        <CalculadoraApalancamiento fila={fila} klines={klines} atrMult={atrMult} />
      </div>
    </div>
  )
}

export default function CryptoScreener() {
  const [datos, setDatos] = useState([])
  const [corriendo, setCorriendo] = useState(false)
  const [progreso, setProgreso] = useState({ hecho: 0, total: 0 })
  const [ultimaActualizacion, setUltimaActualizacion] = useState(null)
  const [errorMsg, setErrorMsg] = useState(null)
  const [intervalo, setIntervalo] = useState('1h')
  const [multiploATR, setMultiploATR] = useState(2.0)
  const [filtro, setFiltro] = useState('all')
  const [busqueda, setBusqueda] = useState('')
  const [sortKey, setSortKey] = useState('score')
  const [sortAsc, setSortAsc] = useState(true)
  const [seleccionado, setSeleccionado] = useState(null)
  const cacheKlines = useRef(new Map())
  const { setUltimoScan } = useCryptoScan()

  const escanear = async () => {
    if (corriendo) return
    setCorriendo(true)
    setErrorMsg(null)
    try {
      const symbols = await getSymbols()
      const total = symbols.length
      setProgreso({ hecho: 0, total })
      cacheKlines.current = new Map()
      const resultados = []
      for (let i = 0; i < symbols.length; i += TAMANO_LOTE) {
        const lote = symbols.slice(i, Math.min(i + TAMANO_LOTE, symbols.length))
        const parciales = await Promise.all(
          lote.map(async (s) => {
            const k = await getKlines(s, intervalo, 200)
            if (k) cacheKlines.current.set(s, k)
            return analyzeKlines(s, k, multiploATR)
          }),
        )
        resultados.push(...parciales.filter(Boolean))
        const hecho = Math.min(i + TAMANO_LOTE, total)
        setProgreso({ hecho, total })
        if (i + TAMANO_LOTE < symbols.length) await sleep(150)
      }
      resultados.sort((a, b) => a.score - b.score)
      setDatos(resultados)
      setUltimaActualizacion(new Date().toLocaleTimeString('es-AR'))
      setUltimoScan(resultados)
    } catch (e) {
      setErrorMsg(e.message)
    } finally {
      setCorriendo(false)
    }
  }

  const conteos = useMemo(
    () => ({
      total: datos.length,
      short: datos.filter((r) => CORTO.includes(r.cls)).length,
      long: datos.filter((r) => LARGO.includes(r.cls)).length,
      neutral: datos.filter((r) => r.cls === 'n').length,
    }),
    [datos],
  )

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    let r = datos.filter((row) => {
      if (q && !row.symbol.toLowerCase().includes(q)) return false
      if (filtro === 'short') return CORTO.includes(row.cls)
      if (filtro === 'long') return LARGO.includes(row.cls)
      if (filtro === 'neutral') return row.cls === 'n'
      return true
    })
    r = [...r].sort((a, b) => {
      const va = a[sortKey] ?? 0
      const vb = b[sortKey] ?? 0
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va)
      return sortAsc ? va - vb : vb - va
    })
    return r
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datos, filtro, busqueda, sortKey, sortAsc])

  const ordenar = (clave) => {
    if (sortKey === clave) setSortAsc((a) => !a)
    else {
      setSortKey(clave)
      setSortAsc(true)
    }
  }

  const filaSeleccionada = seleccionado ? datos.find((r) => r.symbol === seleccionado) : null
  const klinesSeleccionado = filaSeleccionada
    ? cacheKlines.current.get(filaSeleccionada.symbol.replace('/USDT', 'USDT'))
    : null

  const columnas = [
    { key: 'symbol', label: 'Símbolo' },
    { key: 'price', label: 'Precio' },
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
        <h1 className="text-lg font-bold text-terminal-text">Crypto Screener</h1>
        <p className="text-xs text-terminal-dim">
          Escanea todos los futuros perpetuos USDT de Binance en busca de señales de{' '}
          <b>LONG</b>/<b>SHORT</b> (RSI + StochRSI + MACD + Bollinger + alineación de EMAs +
          volumen), con calculadora de apalancamiento y liquidación por posición. Corre 100% en tu
          navegador (sin backend) — igual que "Crypto Screener v3". Orientativo, no es
          recomendación de inversión.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="text-xs text-terminal-dim">Temporalidad</label>
        <select
          value={intervalo}
          onChange={(e) => setIntervalo(e.target.value)}
          className="rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
        >
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
          className="rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
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
          {corriendo ? '⏳ Escaneando…' : datos.length ? '▶ Re-escanear' : '▶ Escanear'}
        </button>
        {ultimaActualizacion && (
          <span className="text-xs text-terminal-dim">Actualizado: {ultimaActualizacion}</span>
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

      {!datos.length && !corriendo ? (
        <div className="rounded-lg border border-terminal-border bg-terminal-panel p-10 text-center text-sm text-terminal-dim">
          Presioná <b>Escanear</b> para analizar todos los futuros perpetuos de Binance.
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
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar símbolo…"
              className="ml-2 w-44 rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
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
                      key={r.symbol}
                      onClick={() => setSeleccionado(r.symbol)}
                      className="cursor-pointer border-t border-terminal-border transition-colors hover:brightness-125"
                      style={{ backgroundColor: c.bg, color: c.text }}
                    >
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold">
                        <Link
                          to={`/cripto/${encodeURIComponent(r.symbol.replace('/USDT', 'USDT'))}`}
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
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">{fmtPrice(r.price)}</td>
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
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold tabular" style={{ color: '#f87171' }}>
                        {r.sl_pct != null ? `${esCorto ? '+' : ''}${r.sl_pct}%` : '—'}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold tabular" style={{ color: '#4ade80' }}>
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
          klines={klinesSeleccionado}
          atrMult={multiploATR}
          onCerrar={() => setSeleccionado(null)}
        />
      )}
    </div>
  )
}
