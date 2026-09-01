import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { COLOR_SENAL } from '../lib/crypto/constantes'
import { BT_MIN_TRADES } from '../lib/crypto/v2/config'
import Insignia from '../components/crypto/Insignia'
import BarraRSI from '../components/crypto/BarraRSI'
import { TablaSkeleton, Vacio } from '../components/Estados'

const selectCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

const VEREDICTOS = ['COMPRA', 'VENTA', 'CERCA', 'EXTENDIDO', 'NEUTRAL', 'SIN DATOS']
const colorTendencia = { ALCISTA: '#4ade80', BAJISTA: '#f87171', RANGO: '#9ca3af', 'N/D': '#6b7280' }

function fmtCompacto(n) {
  if (n == null) return '—'
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(0) + 'M'
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K'
  return '$' + n.toFixed(0)
}

function fmtPrecio(p) {
  if (p == null) return '—'
  if (p >= 1000) return '$' + p.toLocaleString('es-AR', { maximumFractionDigits: 2 })
  if (p >= 1) return '$' + p.toFixed(3)
  if (p >= 0.001) return '$' + p.toFixed(5)
  return '$' + p.toFixed(8)
}

function Celda({ st, resaltar }) {
  if (!st || st.trades === 0) return <td className="px-2 py-1.5 text-terminal-dim">sin trades</td>
  const color = st.expectativa > 0 ? '#4ade80' : st.expectativa < 0 ? '#f87171' : undefined
  return (
    <td className={`whitespace-nowrap px-2 py-1.5 tabular ${resaltar ? 'bg-terminal-accent/10' : ''}`}>
      <span className="font-bold" style={{ color }}>
        {st.expectativa > 0 ? '+' : ''}
        {st.expectativa}
      </span>
      <span className="ml-1 text-[11px] text-terminal-dim">
        R · {st.tasaAcierto}% · n={st.trades}
        {st.trades < BT_MIN_TRADES ? ' ⚠' : ''}
      </span>
    </td>
  )
}

function Backtest({ bt }) {
  if (!bt) return null
  const orden = [
    { k: 'v2', t: 'confluencia + tendencia superior', destacar: true },
    { k: 'piso', t: 'piso · sólo tendencia, sin filtros' },
    { k: 'v1', t: 'score aditivo (regla de la v1)' },
  ]
  return (
    <div className="mb-4 overflow-x-auto rounded-lg border border-terminal-border">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
            <th className="px-2 py-2">Backtest sobre datos de BingX</th>
            <th className="px-2 py-2" title="Parte vieja de la ventana, donde se eligieron los parámetros.">
              Train
            </th>
            <th className="px-2 py-2" title="Parte reciente que la elección de parámetros no vio.">
              Test (fuera de muestra)
            </th>
          </tr>
        </thead>
        <tbody>
          {orden.map((o) => (
            <tr key={o.k} className="border-t border-terminal-border">
              <td className={`px-2 py-1.5 text-xs ${o.destacar ? 'font-semibold text-terminal-text' : 'text-terminal-dim'}`}>
                {o.t}
              </td>
              <Celda st={bt[o.k]?.train} />
              <Celda st={bt[o.k]?.test} resaltar={o.destacar} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function CryptoScreenerV3() {
  const { data, cargando, error } = useJson('bingx_screener.json')
  const [filtro, setFiltro] = useState('OPERABLES')
  const [tendenciaFiltro, setTendenciaFiltro] = useState('all')
  const [busqueda, setBusqueda] = useState('')
  const [sortKey, setSortKey] = useState('conviccion')
  const [sortAsc, setSortAsc] = useState(false)
  const [verBacktest, setVerBacktest] = useState(false)

  const filas = data?.filas ?? []

  const conteos = useMemo(() => {
    const c = { total: filas.length, OPERABLES: 0 }
    for (const v of VEREDICTOS) c[v] = 0
    for (const r of filas) {
      c[r.veredicto] = (c[r.veredicto] ?? 0) + 1
      if (r.veredicto === 'COMPRA' || r.veredicto === 'VENTA') c.OPERABLES++
    }
    return c
  }, [filas])

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    const r = filas.filter((row) => {
      if (q && !row.symbol.toLowerCase().includes(q)) return false
      if (tendenciaFiltro !== 'all' && row.tendencia !== tendenciaFiltro) return false
      if (filtro === 'all') return true
      if (filtro === 'OPERABLES') return row.veredicto === 'COMPRA' || row.veredicto === 'VENTA'
      return row.veredicto === filtro
    })
    return [...r].sort((a, b) => {
      const va = a[sortKey] ?? -Infinity
      const vb = b[sortKey] ?? -Infinity
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va)
      return sortAsc ? va - vb : vb - va
    })
  }, [filas, filtro, tendenciaFiltro, busqueda, sortKey, sortAsc])

  const ordenar = (clave) => {
    if (sortKey === clave) setSortAsc((a) => !a)
    else {
      setSortKey(clave)
      setSortAsc(false)
    }
  }

  const cfg = data?.config
  const columnas = [
    { key: 'symbol', label: 'Símbolo' },
    { key: 'turnover', label: 'Vol 24h' },
    { key: 'price', label: 'Precio' },
    { key: 'chg24h', label: '24h %' },
    { key: 'tendencia', label: `Tend. ${cfg?.tendencia ?? '4h'}` },
    { key: 'veredicto', label: 'Veredicto' },
    { key: 'conviccion', label: 'Conv.' },
    { key: 'cumplidas', label: 'Cond.' },
    { key: 'distClave', label: 'vs EMA50' },
    { key: 'distAsl', label: 'vs ASL' },
    { key: 'rsi', label: 'RSI' },
    { key: 'srsi', label: 'StochRSI' },
    { key: 'fundingPct', label: 'Funding' },
    { key: 'costoTotalPct', label: 'Costo' },
    { key: 'slNetoPct', label: 'SL neto' },
    { key: 'tpNetoPct', label: 'TP neto' },
    { key: 'rrNeto', label: 'R:R neto' },
  ]

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Screener Cripto v3 · BingX</h1>
        <p className="text-xs leading-relaxed text-terminal-dim">
          El mismo motor del v2 sobre los perpetuos de <b>BingX</b>, que lista{' '}
          <b>{data?.universo?.totalDisponible ?? '~929'} pares USDT</b> contra los ~526 de Binance.
          <br />
          <b className="text-terminal-warn">Por qué no tiene botón de escanear:</b> BingX no manda el header CORS{' '}
          <code>Access-Control-Allow-Origin</code>, así que el navegador bloquea el pedido (verificado: desde el mismo
          origen Binance responde y BingX falla). Igual que la API de IOL. Entonces los datos los genera un pipeline en
          GitHub Actions y esta pestaña sólo los lee — como el resto de las pestañas de acciones.
        </p>
      </div>

      {cargando ? (
        <TablaSkeleton filas={12} columnas={8} />
      ) : error ? (
        <Vacio texto={`Todavía no hay datos de BingX: ${error.message}. Corré el workflow "Screener BingX" en Actions.`} />
      ) : !filas.length ? (
        <Vacio texto="El pipeline de BingX no dejó filas en su última corrida." />
      ) : (
        <>
          <div className="mb-3 rounded border border-terminal-border bg-terminal-panel/50 px-3 py-2 text-[11px] text-terminal-dim">
            <b className="text-terminal-text">{data.universo.analizados}</b> analizados de{' '}
            {data.universo.totalDisponible} perpetuos · {data.universo.descartadosPorLiquidez} bajo el piso de{' '}
            {fmtCompacto(cfg.pisoLiquidez)}
            {data.universo.recortadosPorTecho > 0 && (
              <> · {data.universo.recortadosPorTecho} recortados por el techo de la corrida</>
            )}
            {data.universo.fallosDeRed > 0 && <> · {data.universo.fallosDeRed} fallos de red</>} · entrada {cfg.entrada}{' '}
            / tendencia {cfg.tendencia} · SL {cfg.slAtr}×ATR · TP {cfg.tpR}R · actualizado{' '}
            {new Date(data.actualizado).toLocaleString('es-AR')}
            <button
              type="button"
              onClick={() => setVerBacktest((v) => !v)}
              className="ml-2 underline hover:text-terminal-accent"
            >
              {verBacktest ? 'ocultar backtest' : '🧪 ver backtest'}
            </button>
          </div>

          {verBacktest && (
            <>
              <Backtest bt={data.backtest} />
              <div className="mb-4 rounded border border-terminal-warn/40 bg-terminal-warn/10 p-3 text-[11px] leading-relaxed text-terminal-text">
                <b>Leé la columna de test.</b> En la última corrida la confluencia tampoco tiene expectativa positiva
                fuera de muestra sobre datos de BingX, igual que sobre Binance. Los símbolos de BingX son en promedio
                más finos (el exchange mueve ~10× menos volumen), así que si algo cambia, es para peor.
              </div>
            </>
          )}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            {[
              { k: 'OPERABLES', l: `OPERABLES: ${conteos.OPERABLES}`, cls: 'bg-terminal-accent/20 text-terminal-accent' },
              { k: 'all', l: `TODOS: ${conteos.total}`, cls: 'bg-terminal-panel2 text-terminal-text' },
              { k: 'COMPRA', l: `COMPRA: ${conteos.COMPRA}`, cls: 'bg-terminal-up/20 text-terminal-up' },
              { k: 'VENTA', l: `VENTA: ${conteos.VENTA}`, cls: 'bg-terminal-down/20 text-terminal-down' },
              { k: 'CERCA', l: `CERCA: ${conteos.CERCA}`, cls: 'bg-terminal-warn/20 text-terminal-warn' },
              { k: 'NEUTRAL', l: `NEUTRAL: ${conteos.NEUTRAL}`, cls: 'bg-terminal-border text-terminal-dim' },
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
            <select value={tendenciaFiltro} onChange={(e) => setTendenciaFiltro(e.target.value)} className={selectCls}>
              <option value="all">Toda tendencia</option>
              <option value="ALCISTA">Sólo alcistas</option>
              <option value="BAJISTA">Sólo bajistas</option>
              <option value="RANGO">Sólo rango</option>
            </select>
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar símbolo…"
              className="w-40 rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
            />
            <span className="ml-auto text-xs text-terminal-dim">{filtrados.length} resultado(s)</span>
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
                  const c = COLOR_SENAL[r.cls] ?? COLOR_SENAL.n
                  return (
                    <tr
                      key={r.symbolRaw}
                      className="border-t border-terminal-border"
                      style={{ backgroundColor: c.bg, color: c.text }}
                    >
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold">
                        {r.symbol}
                        <a
                          href={r.link}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-1 opacity-60 hover:opacity-100"
                          style={{ color: 'inherit' }}
                          title="Abrir en BingX"
                        >
                          ↗
                        </a>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular text-xs">{fmtCompacto(r.turnover)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">{fmtPrecio(r.price)}</td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 tabular"
                        style={{ color: r.chg24h >= 0 ? '#4ade80' : '#f87171' }}
                      >
                        {r.chg24h >= 0 ? '+' : ''}
                        {r.chg24h?.toFixed(2)}%
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 text-xs font-semibold"
                        style={{ color: colorTendencia[r.tendencia] }}
                      >
                        {r.tendencia === 'ALCISTA' ? '↑ ' : r.tendencia === 'BAJISTA' ? '↓ ' : ''}
                        {r.tendencia}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <Insignia cls={r.cls}>
                          {r.veredicto}
                          {r.dir && (r.veredicto === 'CERCA' || r.veredicto === 'EXTENDIDO') ? ` ${r.dir}` : ''}
                        </Insignia>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-bold tabular">{r.conviccion}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular text-xs">
                        {r.cumplidas}/{r.totalCond}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.distClave > 0 ? '+' : ''}
                        {r.distClave}%
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.distAsl > 0 ? '+' : ''}
                        {r.distAsl}%
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.rsi}
                        <BarraRSI valor={r.rsi} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.srsi}
                        <BarraRSI valor={r.srsi} />
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 tabular text-xs"
                        style={{ color: r.fundingEnContra ? '#fbbf24' : undefined }}
                      >
                        {r.fundingPct == null ? '—' : `${r.fundingPct > 0 ? '+' : ''}${r.fundingPct.toFixed(4)}%`}
                        {r.fundingEnContra ? ' ⚠' : ''}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular text-xs">{r.costoTotalPct}%</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold tabular" style={{ color: '#f87171' }}>
                        {r.slNetoPct == null ? '—' : `${r.slNetoPct}%`}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold tabular" style={{ color: '#4ade80' }}>
                        {r.tpNetoPct == null ? '—' : `${r.tpNetoPct}%`}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-bold tabular">
                        {r.rrNeto == null ? '—' : `${r.rrNeto}:1`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
