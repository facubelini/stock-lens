import { useMemo, useRef, useState } from 'react'
import { getSymbols, getKlines, sleep } from '../lib/crypto/binanceApi'
import { analyzeKlines, calcTPSL, calcLeverage, getMMR } from '../lib/crypto/indicadores'

const INTERVALOS = [
  { valor: '15m', etiqueta: '15 minutos' },
  { valor: '1h', etiqueta: '1 hora' },
  { valor: '4h', etiqueta: '4 horas' },
  { valor: '1d', etiqueta: 'Diario' },
]
const MULTIPLOS_ATR = [1.5, 2.0, 3.0]
const APALANCAMIENTOS = [2, 3, 5, 7, 10, 15, 20, 25, 30, 50, 75, 100, 125]
const CORTO = ['se', 'sf', 'sh', 'sw']
const LARGO = ['le', 'lf', 'lo', 'lw']
const TAMANO_LOTE = 15

const COLOR_SENAL = {
  se: { bg: 'rgba(239,68,68,0.32)', text: '#fecaca' },
  sf: { bg: 'rgba(239,68,68,0.26)', text: '#fca5a5' },
  sh: { bg: 'rgba(239,68,68,0.19)', text: '#fca5a5' },
  sw: { bg: 'rgba(239,68,68,0.10)', text: '#f87171' },
  n: { bg: 'rgba(125,139,156,0.12)', text: '#9ca3af' },
  lw: { bg: 'rgba(34,197,94,0.10)', text: '#6ee7b7' },
  lo: { bg: 'rgba(34,197,94,0.19)', text: '#bbf7d0' },
  lf: { bg: 'rgba(34,197,94,0.26)', text: '#86efac' },
  le: { bg: 'rgba(34,197,94,0.32)', text: '#86efac' },
}

function fmtPrice(p) {
  if (p == null) return '—'
  if (p >= 1000) return '$' + p.toLocaleString('es-AR', { maximumFractionDigits: 2 })
  if (p >= 1) return '$' + p.toFixed(4)
  if (p >= 0.001) return '$' + p.toFixed(6)
  return '$' + p.toFixed(8)
}

function colorRSI(v) {
  if (v >= 70) return '#ef4444'
  if (v >= 55) return '#f97316'
  if (v <= 30) return '#22c55e'
  if (v <= 45) return '#84cc16'
  return '#6b7280'
}

function BarraRSI({ valor }) {
  return (
    <span className="ml-1 inline-block h-1 w-8 overflow-hidden rounded-full bg-terminal-border align-middle">
      <span className="block h-full rounded-full" style={{ width: `${valor}%`, backgroundColor: colorRSI(valor) }} />
    </span>
  )
}

function Insignia({ cls, children }) {
  const c = COLOR_SENAL[cls] ?? COLOR_SENAL.n
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[11px] font-bold tabular"
      style={{ backgroundColor: c.bg, color: c.text }}
    >
      {children}
    </span>
  )
}

// ── Panel lateral: calculadora de apalancamiento/liquidacion ───────────────
function PanelApalancamiento({ fila, klines, atrMult, onCerrar }) {
  const [margen, setMargen] = useState(20)
  const [apalancamiento, setApalancamiento] = useState(10)
  const [tipoMargen, setTipoMargen] = useState('isolated')

  const tpsl = useMemo(() => calcTPSL(fila, klines, atrMult), [fila, klines, atrMult])
  const lev = useMemo(
    () => (tpsl ? calcLeverage(tpsl, margen, apalancamiento, tipoMargen) : null),
    [tpsl, margen, apalancamiento, tipoMargen],
  )

  const esCorto = CORTO.includes(fila.cls)
  const colorDir = esCorto ? '#f87171' : '#4ade80'
  const f$ = (v) => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2)
  const fROE = (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60"
      onClick={onCerrar}
    >
      <div
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l-2 border-terminal-border bg-terminal-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-terminal-border bg-terminal-panel px-4 py-3">
          <div className="flex-1 font-semibold text-terminal-text">{fila.symbol}</div>
          <button
            type="button"
            onClick={onCerrar}
            className="rounded border border-terminal-border px-2 py-1 text-xs text-terminal-dim hover:text-terminal-text"
          >
            ✕
          </button>
        </div>

        <div className="p-4">
          <div className="mb-3">
            <div className="mb-1 text-sm text-terminal-text">
              {fmtPrice(fila.price)}{' '}
              <span className={fila.chg24h >= 0 ? 'text-terminal-up' : 'text-terminal-down'}>
                {fila.chg24h >= 0 ? '+' : ''}
                {fila.chg24h}% 24h
              </span>
            </div>
            <Insignia cls={fila.cls}>{fila.signal}</Insignia>{' '}
            <span className="text-xs text-terminal-dim">
              Score: {fila.score > 0 ? '+' : ''}
              {fila.score}
            </span>
          </div>
          <hr className="mb-3 border-terminal-border" />

          {!tpsl ? (
            <p className="text-sm text-terminal-dim">Señal NEUTRAL — sin niveles sugeridos.</p>
          ) : (
            <>
              <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
                Apalancamiento y margen
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-terminal-dim">Margen (USD)</label>
                  <input
                    type="number"
                    min={1}
                    value={margen}
                    onChange={(e) => setMargen(Number(e.target.value) || 0)}
                    className="w-full rounded border border-terminal-border bg-terminal-bg px-2 py-1.5 text-sm font-semibold text-terminal-text focus:border-terminal-accent focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-terminal-dim">Apalancamiento</label>
                  <select
                    value={apalancamiento}
                    onChange={(e) => setApalancamiento(Number(e.target.value))}
                    className="w-full rounded border border-terminal-border bg-terminal-bg px-2 py-1.5 text-sm font-semibold text-terminal-text focus:border-terminal-accent focus:outline-none"
                  >
                    {APALANCAMIENTOS.map((l) => (
                      <option key={l} value={l}>
                        {l}×
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-terminal-dim">Tipo margen</label>
                  <div className="flex overflow-hidden rounded border border-terminal-border">
                    <button
                      type="button"
                      onClick={() => setTipoMargen('isolated')}
                      className={`flex-1 py-1.5 text-[11px] font-semibold ${
                        tipoMargen === 'isolated' ? 'bg-terminal-accent text-black' : 'text-terminal-dim'
                      }`}
                    >
                      🔒 Aislado
                    </button>
                    <button
                      type="button"
                      onClick={() => setTipoMargen('cross')}
                      className={`flex-1 py-1.5 text-[11px] font-semibold ${
                        tipoMargen === 'cross' ? 'bg-terminal-accent text-black' : 'text-terminal-dim'
                      }`}
                    >
                      🔄 Cruzado
                    </button>
                  </div>
                </div>
              </div>

              {lev && (
                <>
                  <div className="mb-3 grid grid-cols-2 gap-1.5 rounded bg-terminal-bg p-3">
                    <div className="text-xs">
                      <span className="mb-0.5 block text-[10px] uppercase text-terminal-dim">Posición</span>
                      <span className="font-bold text-terminal-text">
                        ${lev.posSize.toLocaleString('es-AR', { maximumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div className="text-xs">
                      <span className="mb-0.5 block text-[10px] uppercase text-terminal-dim">Entrada</span>
                      <span className="font-bold text-terminal-text">{fmtPrice(tpsl.entry)}</span>
                    </div>
                    <div className="text-xs">
                      <span className="mb-0.5 block text-[10px] uppercase text-terminal-dim">Cantidad</span>
                      <span className="font-bold text-terminal-text">{lev.qty.toFixed(5)}</span>
                    </div>
                    <div className="text-xs">
                      <span className="mb-0.5 block text-[10px] uppercase text-terminal-dim">Mant. margen</span>
                      <span className="font-bold text-terminal-text">{(lev.mmr * 100).toFixed(2)}%</span>
                    </div>
                  </div>

                  <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
                    Resultados con apalancamiento
                  </div>
                  <table className="mb-2 w-full border-collapse text-sm">
                    <thead>
                      <tr className="bg-terminal-bg text-[10px] uppercase text-terminal-dim">
                        <td className="px-2 py-1.5">Nivel</td>
                        <td className="px-2 py-1.5 text-right">Precio</td>
                        <td className="px-2 py-1.5 text-right">G/P</td>
                        <td className="px-2 py-1.5 text-right">ROE</td>
                      </tr>
                    </thead>
                    <tbody>
                      {!lev.slSafe && (
                        <tr>
                          <td colSpan={4} className="bg-terminal-down/20 px-2 py-1.5 text-center text-[11px] text-terminal-down">
                            ⚠️ SL está más lejos que la liquidación — no se activará
                          </td>
                        </tr>
                      )}
                      <tr className="border-t border-terminal-border" style={{ backgroundColor: 'rgba(124,58,237,.12)' }}>
                        <td className="px-2 py-1.5 font-semibold" style={{ color: '#c084fc' }}>⚡ Liquidación</td>
                        <td className="px-2 py-1.5 text-right font-bold" style={{ color: '#c084fc' }}>{fmtPrice(lev.liqPrice)}</td>
                        <td className="px-2 py-1.5 text-right font-bold text-terminal-down">−${margen.toFixed(2)}</td>
                        <td className="px-2 py-1.5 text-right text-terminal-down">−100%</td>
                      </tr>
                      <tr className="border-t border-terminal-border" style={{ backgroundColor: 'rgba(248,113,113,.07)' }}>
                        <td className="px-2 py-1.5 font-semibold text-terminal-down">🛑 Stop Loss</td>
                        <td className="px-2 py-1.5 text-right font-bold text-terminal-down">{fmtPrice(tpsl.sl)}</td>
                        <td className="px-2 py-1.5 text-right font-bold text-terminal-down">{f$(lev.slPnL)}</td>
                        <td className="px-2 py-1.5 text-right text-terminal-down">{fROE(lev.slROE)}</td>
                      </tr>
                      <tr className="border-t border-terminal-border bg-terminal-bg">
                        <td className="px-2 py-1.5 font-semibold" style={{ color: '#60a5fa' }}>🎯 Entrada</td>
                        <td className="px-2 py-1.5 text-right font-bold" style={{ color: '#60a5fa' }}>{fmtPrice(tpsl.entry)}</td>
                        <td className="px-2 py-1.5 text-right text-terminal-dim">$0.00</td>
                        <td className="px-2 py-1.5 text-right text-terminal-dim">0%</td>
                      </tr>
                      <tr className="border-t border-terminal-border" style={{ backgroundColor: 'rgba(134,239,172,.04)' }}>
                        <td className="px-2 py-1.5 font-semibold text-terminal-up">✅ TP1 · 1:1</td>
                        <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{fmtPrice(tpsl.tp1)}</td>
                        <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{f$(lev.tp1PnL)}</td>
                        <td className="px-2 py-1.5 text-right text-terminal-up">{fROE(lev.tp1ROE)}</td>
                      </tr>
                      <tr className="border-t border-terminal-border" style={{ backgroundColor: 'rgba(74,222,128,.07)' }}>
                        <td className="px-2 py-1.5 font-semibold text-terminal-up">✅ TP2 · 1:2</td>
                        <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{fmtPrice(tpsl.tp2)}</td>
                        <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{f$(lev.tp2PnL)}</td>
                        <td className="px-2 py-1.5 text-right text-terminal-up">{fROE(lev.tp2ROE)}</td>
                      </tr>
                      <tr className="border-t border-terminal-border" style={{ backgroundColor: 'rgba(34,197,94,.10)' }}>
                        <td className="px-2 py-1.5 font-semibold text-terminal-up">✅ TP3 · 1:3</td>
                        <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{fmtPrice(tpsl.tp3)}</td>
                        <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{f$(lev.tp3PnL)}</td>
                        <td className="px-2 py-1.5 text-right text-terminal-up">{fROE(lev.tp3ROE)}</td>
                      </tr>
                    </tbody>
                  </table>

                  {tipoMargen === 'isolated' ? (
                    <div className="rounded border border-terminal-info/30 bg-terminal-info/10 p-2.5 text-xs leading-relaxed text-terminal-info">
                      🔒 <b>Margen aislado:</b> tu pérdida máxima es exactamente ${margen.toFixed(2)}. La posición se
                      liquida sin afectar el resto de tu cuenta.
                    </div>
                  ) : (
                    <div className="rounded border border-terminal-warn/30 bg-terminal-warn/10 p-2.5 text-xs leading-relaxed text-terminal-warn">
                      🔄 <b>Margen cruzado:</b> Binance puede usar todo tu balance para evitar la liquidación. Podés
                      perder más que el margen depositado. El precio de liquidación es estimado.
                    </div>
                  )}
                  {!lev.slSafe && (
                    <div className="mt-2 rounded border border-terminal-down/30 bg-terminal-down/10 p-2.5 text-xs leading-relaxed text-terminal-down">
                      ⚠️ <b>Peligro:</b> con {apalancamiento}× el precio de liquidación ({fmtPrice(lev.liqPrice)}) está
                      más cerca que el Stop Loss. Reducí el apalancamiento o ajustá el SL.
                    </div>
                  )}
                </>
              )}

              <p className="mt-3 text-[11px] text-terminal-dim">
                ATR(14): {fmtPrice(tpsl.atr)} · SL swing ref: {fmtPrice(tpsl.slSwing)} ({tpsl.slSwingPct > 0 ? '+' : ''}
                {tpsl.slSwingPct}%)
              </p>
            </>
          )}

          <hr className="my-3 border-terminal-border" />
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">Indicadores</div>
          <div className="text-xs leading-relaxed text-terminal-text">
            {fila.details.split(' · ').map((s) => (
              <div key={s}>• {s}</div>
            ))}
          </div>

          <a
            href={fila.link}
            target="_blank"
            rel="noreferrer"
            className="mt-4 block rounded bg-terminal-accent px-3 py-2 text-center text-sm font-bold text-black hover:opacity-90"
          >
            Abrir en Binance Futures →
          </a>
        </div>
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
                        <a
                          href={r.link}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="hover:underline"
                          style={{ color: 'inherit' }}
                        >
                          {r.symbol}
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
