import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { useWatchlist } from '../lib/watchlist'
import { fmtFecha, fmtNum, fmtPct } from '../lib/formato'
import TickerLink from '../components/TickerLink'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'

// Warren Score: screener tecnico/cuantitativo 0-100 (NO fundamental — no mira
// PER/ingresos/deuda/ROE). Los 4 pilares y sus topes exactos:
const PILARES = [
  { key: 'trend', letra: 'A', nombre: 'Tendencia', max: 25 },
  { key: 'relative_strength', letra: 'B', nombre: 'Fuerza relativa', max: 30 },
  { key: 'momentum', letra: 'C', nombre: 'Momentum', max: 30 },
  { key: 'volatility', letra: 'D', nombre: 'Volatilidad', max: 15 },
]

const GATE_DEFS = [
  { key: 'rs80', label: 'RS >80', tooltip: 'La fuerza relativa (RS) está en el percentil 80 o superior de todo el universo analizado.' },
  { key: 'ema200', label: 'EMA200', tooltip: 'El precio actual está por encima de la EMA de 200 ruedas.' },
  { key: 'sma50', label: 'SMA50', tooltip: 'El precio actual está por encima de la SMA de 50 ruedas.' },
  { key: 'above25_from_low', label: '+25% MIN', tooltip: 'El precio está al menos 25% por encima de su mínimo de 52 semanas.' },
  { key: 'vol_below_08', label: 'VOL <0.8', tooltip: 'La volatilidad actual (20 ruedas) es menos del 80% de su propia volatilidad histórica (mediana del último año).' },
  { key: 'sma50_rising', label: 'SMA50 ↑', tooltip: 'La SMA50 es mayor que su valor de hace 20 ruedas (pendiente positiva).' },
  { key: 'ema200_rising', label: 'EMA200 ↑', tooltip: 'La EMA200 es mayor que su valor de hace 20 ruedas (pendiente positiva).' },
]

const OPCIONES_SCORE = [0, 90, 85, 80, 75, 70, 60].map((v) => ({ valor: v, etiqueta: v === 0 ? 'Todos' : `${v}+` }))
const OPCIONES_GATES = [0, 2, 3, 4, 5, 6, 7].map((v) => ({ valor: v, etiqueta: v === 0 ? 'Todos' : v === 7 ? '7' : `${v}+` }))
const OPCIONES_TOP = [
  { valor: 10, etiqueta: 'Top 10' },
  { valor: 20, etiqueta: 'Top 20' },
  { valor: 50, etiqueta: 'Top 50' },
  { valor: 0, etiqueta: 'Todos' },
]

const selectCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

function colorWarrenScore(score) {
  if (score == null) return '#7d8b9c'
  if (score >= 85) return '#16a34a'
  if (score >= 75) return '#22c55e'
  if (score >= 65) return '#f5a524'
  if (score >= 50) return '#f97316'
  return '#ef4444'
}

function valorOrden(r, campo) {
  if (campo === 'score') return r.total_score
  if (campo === 'rs') return r.relative_strength?.rs
  if (campo === 'volRatio') return r.volatility?.volatility_ratio
  if (campo === 'a') return r.trend?.score
  if (campo === 'b') return r.relative_strength?.score
  if (campo === 'c') return r.momentum?.score
  if (campo === 'd') return r.volatility?.score
  return null
}

// Interpretacion determinista (NO IA): combina frases fijas segun el score
// total y las condiciones de cada pilar. Misma logica siempre para los
// mismos numeros — se puede auditar leyendo esta funcion.
function interpretarWarrenScore(r) {
  let base
  const s = r.total_score
  if (s >= 85) base = 'Configuración técnica excepcional'
  else if (s >= 75) base = 'Configuración técnica fuerte'
  else if (s >= 65) base = 'Configuración técnica moderada'
  else if (s >= 50) base = 'Configuración técnica débil'
  else base = 'Configuración técnica desfavorable'

  const detalles = []
  const rs = r.relative_strength?.rs
  if (rs != null) {
    if (rs >= 80) detalles.push('alta fuerza relativa')
    else if (rs < 50) detalles.push('fuerza relativa por debajo del mercado')
  }
  if (r.trend) {
    if (r.trend.price_above_ema200 && r.trend.ema200_rising) detalles.push('tendencia de largo plazo positiva')
    else if (!r.trend.price_above_ema200) detalles.push('tendencia de largo plazo negativa')
  }
  if (r.momentum) {
    if (r.momentum.distance_from_52w_high >= -5) detalles.push('precio bien posicionado dentro de su rango anual')
    else if (r.momentum.percentage_above_52w_low != null && r.momentum.percentage_above_52w_low < 15)
      detalles.push('cerca de sus mínimos de 52 semanas')
  }
  if (r.volatility) {
    if (r.volatility.volatility_ratio <= 0.8) detalles.push('volatilidad contenida vs. su propia historia')
    else if (r.volatility.volatility_ratio > 1.2) detalles.push('volatilidad elevada vs. su propia historia')
  }

  return detalles.length ? `${base}: ${detalles.join(', ')}.` : `${base}.`
}

function BarraProgreso({ score }) {
  const color = colorWarrenScore(score)
  return (
    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-terminal-border">
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, score ?? 0))}%`, backgroundColor: color }} />
    </div>
  )
}

function CirculoGate({ ok, titulo }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ backgroundColor: ok ? '#22c55e' : 'rgba(148,163,184,0.35)' }}
      title={titulo}
    />
  )
}

function ExplicacionModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-terminal-border bg-terminal-panel p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 text-sm font-semibold text-terminal-text">¿Cómo funciona el Warren Score?</h3>
        <p className="mb-3 text-xs leading-relaxed text-terminal-dim">
          El Warren Score es un ranking técnico de 0 a 100 diseñado para identificar activos con una
          combinación favorable de tendencia, fuerza relativa, momentum y volatilidad. No analiza
          nada fundamental (PER, ingresos, deuda, ROE, flujo de caja) — es exclusivamente un sistema
          técnico/cuantitativo.
        </p>
        <div className="mb-3 flex flex-col gap-1.5 text-xs">
          <div className="flex items-center justify-between rounded border border-terminal-border px-2.5 py-1.5">
            <span className="text-terminal-text">Tendencia</span>
            <span className="tabular text-terminal-dim">25 puntos</span>
          </div>
          <div className="flex items-center justify-between rounded border border-terminal-border px-2.5 py-1.5">
            <span className="text-terminal-text">Fuerza relativa vs. SPY</span>
            <span className="tabular text-terminal-dim">30 puntos</span>
          </div>
          <div className="flex items-center justify-between rounded border border-terminal-border px-2.5 py-1.5">
            <span className="text-terminal-text">Momentum / estructura 52 semanas</span>
            <span className="tabular text-terminal-dim">30 puntos</span>
          </div>
          <div className="flex items-center justify-between rounded border border-terminal-border px-2.5 py-1.5">
            <span className="text-terminal-text">Volatilidad vs. histórico propio</span>
            <span className="tabular text-terminal-dim">15 puntos</span>
          </div>
          <div className="flex items-center justify-between rounded border border-terminal-accent/50 bg-terminal-accent/10 px-2.5 py-1.5 font-semibold">
            <span className="text-terminal-text">Total</span>
            <span className="tabular text-terminal-accent">100 puntos</span>
          </div>
        </div>
        <p className="text-[11px] text-terminal-dim">
          El score es una herramienta cuantitativa de screening y no constituye por sí sola una
          señal de compra o venta.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full rounded border border-terminal-border px-2.5 py-1.5 text-xs text-terminal-dim hover:text-terminal-text"
        >
          Cerrar
        </button>
      </div>
    </div>
  )
}

function FilaPilar({ pilar, datos }) {
  const score = datos?.score
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-terminal-text">
          {pilar.letra} — {pilar.nombre}
        </span>
        <span className="tabular font-bold" style={{ color: colorWarrenScore(((score ?? 0) / pilar.max) * 100) }}>
          {score != null ? fmtNum(score, 1) : 'N/A'} /{pilar.max}
        </span>
      </div>
      {pilar.key === 'trend' && datos && (
        <ul className="flex flex-col gap-1 text-xs text-terminal-dim">
          <li>Precio &gt; EMA200 {datos.price_above_ema200 ? '✓' : '✕'}</li>
          <li>Precio &gt; SMA50 {datos.price_above_sma50 ? '✓' : '✕'}</li>
          <li>SMA50 &gt; EMA200 {datos.sma50_above_ema200 ? '✓' : '✕'}</li>
          <li>SMA50 ascendente {datos.sma50_rising ? '✓' : '✕'}</li>
          <li>EMA200 ascendente {datos.ema200_rising ? '✓' : '✕'}</li>
        </ul>
      )}
      {pilar.key === 'relative_strength' && datos && (
        <ul className="flex flex-col gap-1 text-xs text-terminal-dim">
          <li>RS: <span className="text-terminal-text">{fmtNum(datos.rs, 1)}</span></li>
          <li>
            Performance relativa vs. SPY (~6m):{' '}
            <span className="text-terminal-text">{fmtPct(datos.relative_performance, { signo: true })}</span>
          </li>
        </ul>
      )}
      {pilar.key === 'momentum' && datos && (
        <ul className="flex flex-col gap-1 text-xs text-terminal-dim">
          <li>
            Distancia al máximo 52w:{' '}
            <span className="text-terminal-text">{fmtPct(datos.distance_from_52w_high, { signo: true })}</span>
          </li>
          <li>
            Distancia desde el mínimo 52w:{' '}
            <span className="text-terminal-text">{fmtPct(datos.percentage_above_52w_low, { signo: true })}</span>
          </li>
          <li>Nuevo máximo reciente (20 ruedas): {datos.recent_52w_high ? 'Sí' : 'No'}</li>
        </ul>
      )}
      {pilar.key === 'volatility' && datos && (
        <ul className="flex flex-col gap-1 text-xs text-terminal-dim">
          <li>Volatilidad actual (20r, anualizada): <span className="text-terminal-text">{fmtNum(datos.current_volatility, 1)}%</span></li>
          <li>Volatilidad histórica (mediana 1a): <span className="text-terminal-text">{fmtNum(datos.historical_volatility, 1)}%</span></li>
          <li>Volatility Ratio: <span className="text-terminal-text">{fmtNum(datos.volatility_ratio, 2)}</span></li>
        </ul>
      )}
      {!datos && <p className="text-xs text-terminal-dim">Datos insuficientes para este pilar.</p>}
    </div>
  )
}

function PanelDetalle({ fila, onCerrar }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onCerrar}>
      <div
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l-2 border-terminal-border bg-terminal-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-terminal-border bg-terminal-panel px-4 py-3">
          <TickerLink ticker={fila.ticker} className="flex-1 font-semibold text-terminal-text" />
          <button type="button" onClick={onCerrar} className="rounded border border-terminal-border px-2 py-1 text-xs text-terminal-dim hover:text-terminal-text">
            ✕
          </button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div className="rounded-lg border border-terminal-border bg-terminal-panel2 px-3 py-3 text-center">
            <div className="text-[10px] uppercase text-terminal-dim">Warren Score</div>
            <div className="text-3xl font-bold tabular" style={{ color: colorWarrenScore(fila.total_score) }}>
              {fila.total_score != null ? fmtNum(fila.total_score, 1) : 'N/A'} <span className="text-base text-terminal-dim">/ 100</span>
            </div>
            {!fila.datos_suficientes && (
              <p className="mt-1 text-[11px] text-terminal-warn">Datos insuficientes para alguno de los pilares.</p>
            )}
          </div>

          {PILARES.map((p) => (
            <FilaPilar key={p.key} pilar={p} datos={fila[p.key]} />
          ))}

          <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-3">
            <div className="mb-1.5 text-[10px] uppercase text-terminal-dim">Criterios (gates)</div>
            <div className="flex flex-wrap gap-2">
              {GATE_DEFS.map((g) => (
                <span key={g.key} className="flex items-center gap-1.5 rounded border border-terminal-border px-2 py-1 text-xs" title={g.tooltip}>
                  <CirculoGate ok={fila.gates[g.key]} titulo={g.tooltip} />
                  {g.label}
                </span>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-terminal-dim">
              {fila.gates.count} / 7 criterios cumplidos · principales (RS/EMA200/SMA50/+25% MIN):{' '}
              {fila.gates.all_main_gates_passed ? 'todos cumplidos' : 'no todos cumplidos'}
            </p>
          </div>

          {fila.datos_suficientes && (
            <div className="rounded-lg border border-terminal-accent/40 bg-terminal-accent/10 px-3 py-3">
              <div className="mb-1 text-[10px] uppercase text-terminal-dim">Interpretación</div>
              <p className="text-sm text-terminal-text">{interpretarWarrenScore(fila)}</p>
            </div>
          )}
          <p className="text-[11px] text-terminal-dim">
            Screener técnico/cuantitativo — no es recomendación de inversión ni analiza fundamentales.
          </p>
        </div>
      </div>
    </div>
  )
}

export default function WarrenScore() {
  const { data, cargando, error } = useJson('warren_score.json')
  const { watchlist } = useWatchlist()
  const [filtroScore, setFiltroScore] = useState(0)
  const [filtroGates, setFiltroGates] = useState(0)
  const [topN, setTopN] = useState(20)
  const [universo, setUniverso] = useState('todos')
  const [orden, setOrden] = useState({ campo: 'score', dir: 'desc' })
  const [seleccionado, setSeleccionado] = useState(null)
  const [mostrarExplicacion, setMostrarExplicacion] = useState(false)

  const tickers = useMemo(() => (Array.isArray(data?.tickers) ? data.tickers : []), [data])
  const conDatos = useMemo(() => tickers.filter((r) => r.datos_suficientes), [tickers])
  const excluidos = tickers.length - conDatos.length

  const comparar = useMemo(() => {
    const { campo, dir } = orden
    return (a, b) => {
      const va = valorOrden(a, campo)
      const vb = valorOrden(b, campo)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      return dir === 'asc' ? va - vb : vb - va
    }
  }, [orden])

  const filtrados = useMemo(() => {
    let base = conDatos
    if (universo === 'watchlist') {
      const set = new Set((watchlist ?? []).map((w) => w.ticker))
      base = base.filter((r) => set.has(r.ticker))
    }
    base = base.filter((r) => r.total_score >= filtroScore && r.gates.count >= filtroGates)
    base = [...base].sort(comparar)
    return topN > 0 ? base.slice(0, topN) : base
  }, [conDatos, universo, watchlist, filtroScore, filtroGates, topN, comparar])

  const ordenarPor = (campo) =>
    setOrden((prev) => (prev.campo === campo ? { campo, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { campo, dir: 'desc' }))

  const th = (campo, label, align = 'right') => {
    const activo = orden.campo === campo
    return (
      <th
        onClick={() => ordenarPor(campo)}
        className={`cursor-pointer whitespace-nowrap px-2 py-2.5 font-semibold hover:text-terminal-text ${
          align === 'right' ? 'text-right' : 'text-left'
        } ${activo ? 'text-terminal-accent' : ''}`}
      >
        {label}
        {activo ? (orden.dir === 'desc' ? ' ▼' : ' ▲') : ''}
      </th>
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-terminal-text">Warren Score</h1>
          <p className="text-xs text-terminal-dim">
            Score técnico compuesto 0–100 basado en tendencia, fuerza relativa, momentum y
            volatilidad.
          </p>
          {data?.actualizado && (
            <p className="mt-1 text-[11px] text-terminal-dim">Actualizado: {fmtFecha(data.actualizado)}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setMostrarExplicacion(true)}
          className="whitespace-nowrap rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-xs text-terminal-dim hover:border-terminal-accent hover:text-terminal-text"
        >
          ¿Cómo funciona?
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="text-xs text-terminal-dim">Score</label>
        <select className={selectCls} value={filtroScore} onChange={(e) => setFiltroScore(Number(e.target.value))}>
          {OPCIONES_SCORE.map((o) => (
            <option key={o.valor} value={o.valor}>
              {o.etiqueta}
            </option>
          ))}
        </select>
        <label className="text-xs text-terminal-dim">Mín. criterios</label>
        <select className={selectCls} value={filtroGates} onChange={(e) => setFiltroGates(Number(e.target.value))}>
          {OPCIONES_GATES.map((o) => (
            <option key={o.valor} value={o.valor}>
              {o.etiqueta}
            </option>
          ))}
        </select>
        <label className="text-xs text-terminal-dim">Mostrar</label>
        <select className={selectCls} value={topN} onChange={(e) => setTopN(Number(e.target.value))}>
          {OPCIONES_TOP.map((o) => (
            <option key={o.valor} value={o.valor}>
              {o.etiqueta}
            </option>
          ))}
        </select>
        {watchlist && watchlist.length > 0 && (
          <>
            <label className="text-xs text-terminal-dim">Universo</label>
            <select className={selectCls} value={universo} onChange={(e) => setUniverso(e.target.value)}>
              <option value="todos">Todos</option>
              <option value="watchlist">Mi lista</option>
            </select>
          </>
        )}
        <span className="ml-auto text-xs text-terminal-dim">
          {filtrados.length} de {conDatos.length} ticker(s)
          {excluidos > 0 && ` · ${excluidos} excluido(s) por datos insuficientes`}
        </span>
      </div>

      {cargando ? (
        <TablaSkeleton columnas={8} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : filtrados.length === 0 ? (
        <Vacio texto="Ningún ticker cumple los filtros elegidos." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-terminal-border">
          <table className="min-w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                <th className="whitespace-nowrap px-2 py-2.5 font-semibold">Ticker</th>
                {th('score', 'Warren Score')}
                <th className="px-2 py-2.5 font-semibold">Progreso</th>
                <th className="px-2 py-2.5 text-center font-semibold">Gates</th>
                {th('rs', 'RS')}
                {th('volRatio', 'Vol Ratio')}
                <th className="px-2 py-2.5 text-center font-semibold">EMA200</th>
                <th className="px-2 py-2.5 text-center font-semibold">SMA50</th>
                <th className="px-2 py-2.5 text-center font-semibold">+25% MIN</th>
                <th className="px-2 py-2.5 text-center font-semibold">SMA50 ↑</th>
                <th className="px-2 py-2.5 text-center font-semibold">EMA200 ↑</th>
                <th className="px-2 py-2.5 text-right font-semibold">52W HIGH</th>
                {th('a', 'A /25')}
                {th('b', 'B /30')}
                {th('c', 'C /30')}
                {th('d', 'D /15')}
              </tr>
            </thead>
            <tbody>
              {filtrados.map((r) => (
                <tr
                  key={r.ticker}
                  onClick={() => setSeleccionado(r)}
                  className="cursor-pointer border-t border-terminal-border transition-colors hover:bg-terminal-panel2/60"
                >
                  <td className="whitespace-nowrap px-2 py-1.5 font-semibold">
                    <TickerLink ticker={r.ticker} />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular font-bold" style={{ color: colorWarrenScore(r.total_score) }}>
                    {fmtNum(r.total_score, 1)}
                  </td>
                  <td className="px-2 py-1.5">
                    <BarraProgreso score={r.total_score} />
                  </td>
                  <td className="px-2 py-1.5 text-center tabular" title={`${r.gates.count} / 7 criterios`}>
                    {r.gates.all_main_gates_passed ? '✓' : `${r.gates.count}/7`}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular">{fmtNum(r.relative_strength?.rs, 1)}</td>
                  <td className="px-2 py-1.5 text-right tabular">{fmtNum(r.volatility?.volatility_ratio, 2)}</td>
                  <td className="px-2 py-1.5 text-center">
                    <CirculoGate ok={r.gates.ema200} titulo={GATE_DEFS[1].tooltip} />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <CirculoGate ok={r.gates.sma50} titulo={GATE_DEFS[2].tooltip} />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <CirculoGate ok={r.gates.above25_from_low} titulo={GATE_DEFS[3].tooltip} />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <CirculoGate ok={r.gates.sma50_rising} titulo={GATE_DEFS[5].tooltip} />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <CirculoGate ok={r.gates.ema200_rising} titulo={GATE_DEFS[6].tooltip} />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular text-terminal-dim">
                    {fmtPct(r.momentum?.distance_from_52w_high, { signo: true })}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{fmtNum(r.trend?.score, 1)}</td>
                  <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{fmtNum(r.relative_strength?.score, 1)}</td>
                  <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{fmtNum(r.momentum?.score, 1)}</td>
                  <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{fmtNum(r.volatility?.score, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-[11px] text-terminal-dim">
        Screener puramente técnico/cuantitativo (tendencia, fuerza relativa vs. SPY, momentum y
        volatilidad) — no analiza PER, ingresos, deuda, ROE ni flujo de caja. Orientativo, no es
        recomendación de inversión.
      </p>

      {seleccionado && <PanelDetalle fila={seleccionado} onCerrar={() => setSeleccionado(null)} />}
      {mostrarExplicacion && <ExplicacionModal onClose={() => setMostrarExplicacion(false)} />}
    </div>
  )
}
