import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useDatosCombinados } from '../lib/useDatosCombinados'
import { useJson } from '../lib/useJson'
import { useWatchlist } from '../lib/watchlist'
import { useAlertas, seCumpleAlerta, CAMPOS_ALERTA } from '../lib/alertas'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import TickerLink from '../components/TickerLink'
import BuscadorTicker from '../components/BuscadorTicker'
import { Vacio } from '../components/Estados'
import { fmtPct, fmtNum, fmtPrecio, fmtMarketCap, estiloValor, estiloPER, estiloPEG } from '../lib/formato'

const inputCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

const COMPARADOR_CAMPOS = [
  { key: 'precio', label: 'Precio', render: (v) => fmtPrecio(v) },
  { key: 'var_pct', label: 'Var. hoy', render: (v) => fmtPct(v, { signo: true }), estilo: (v) => estiloValor(v, 6) },
  { key: 'per_trailing', label: 'PER', render: (v) => fmtNum(v, 1), estilo: estiloPER },
  { key: 'peg', label: 'PEG', render: (v) => fmtNum(v, 2), estilo: estiloPEG },
  { key: 'ev_sales', label: 'EV/Sales', render: (v) => fmtNum(v, 2) },
  { key: 'ps', label: 'P/S', render: (v) => fmtNum(v, 2) },
  { key: 'profit_margin', label: 'Margen', render: (v) => fmtPct(v) },
  { key: 'roe', label: 'ROE', render: (v) => fmtPct(v) },
  { key: 'dividend_yield', label: 'Div. Yield', render: (v) => fmtPct(v) },
  { key: 'beta_realizado', label: 'Beta (1a)', render: (v) => fmtNum(v, 2) },
  { key: 'correlacion_mercado', label: 'Correl. c/ SPY', render: (v) => fmtNum(v, 2) },
  { key: 'sharpe_1y', label: 'Sharpe (1a)', render: (v) => fmtNum(v, 2) },
  { key: 'volatilidad_1y', label: 'Volatilidad anual.', render: (v) => fmtPct(v) },
  { key: 'market_cap', label: 'Market Cap', render: (v) => fmtMarketCap(v) },
]

function Chips({ tickers, onRemove }) {
  if (!tickers.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {tickers.map((t) => (
        <span
          key={t}
          className="flex items-center gap-1.5 rounded-full border border-terminal-border bg-terminal-panel px-2.5 py-1 text-xs"
        >
          <TickerLink ticker={t} />
          <button
            type="button"
            onClick={() => onRemove(t)}
            className="text-terminal-dim hover:text-terminal-down"
            title="Quitar"
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  )
}

function Comparador({ filas, seleccion }) {
  const porTicker = useMemo(() => new Map(filas.map((f) => [f.ticker, f])), [filas])
  const elegidos = seleccion.map((t) => porTicker.get(t)).filter(Boolean)

  if (elegidos.length < 2) {
    return <Vacio texto="Agregá al menos 2 tickers arriba para compararlos lado a lado." />
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-terminal-border">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
            <th className="px-2 py-2 font-semibold">Métrica</th>
            {elegidos.map((f) => (
              <th key={f.ticker} className="px-2 py-2 text-right font-semibold">
                <TickerLink ticker={f.ticker} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARADOR_CAMPOS.map((c) => (
            <tr key={c.key} className="border-t border-terminal-border">
              <td className="px-2 py-1.5 text-terminal-dim">{c.label}</td>
              {elegidos.map((f) => (
                <td
                  key={f.ticker}
                  className="px-2 py-1.5 text-right tabular font-semibold"
                  style={c.estilo ? c.estilo(f[c.key]) : undefined}
                >
                  {c.render(f[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function calcularRetornos(spark) {
  if (!Array.isArray(spark) || spark.length < 2) return []
  const out = []
  for (let i = 1; i < spark.length; i++) {
    if (spark[i - 1]) out.push(spark[i] / spark[i - 1] - 1)
  }
  return out
}

function correlacion(a, b) {
  const n = Math.min(a.length, b.length)
  if (n < 20) return null
  const xa = a.slice(a.length - n)
  const xb = b.slice(b.length - n)
  const ma = xa.reduce((s, v) => s + v, 0) / n
  const mb = xb.reduce((s, v) => s + v, 0) / n
  let cov = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const va = xa[i] - ma
    const vb = xb[i] - mb
    cov += va * vb
    da += va * va
    db += vb * vb
  }
  const den = Math.sqrt(da * db)
  return den ? cov / den : null
}

function colorCorr(v) {
  if (v == null) return 'rgba(125,139,156,0.15)'
  if (v >= 0) return `rgba(34,197,94,${0.1 + Math.min(v, 1) * 0.6})`
  return `rgba(239,68,68,${0.1 + Math.min(-v, 1) * 0.6})`
}

function MatrizCorrelacion({ filas, seleccion }) {
  const porTicker = useMemo(() => new Map(filas.map((f) => [f.ticker, f])), [filas])
  const retornosPorTicker = useMemo(() => {
    const m = new Map()
    for (const t of seleccion) m.set(t, calcularRetornos(porTicker.get(t)?.spark))
    return m
  }, [seleccion, porTicker])

  if (seleccion.length < 2) {
    return <Vacio texto="Agregá al menos 2 tickers arriba para ver la correlación entre ellos." />
  }

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-xs">
        <thead>
          <tr>
            <th className="px-2 py-1" />
            {seleccion.map((t) => (
              <th key={t} className="whitespace-nowrap px-2 py-1 text-center font-semibold text-terminal-dim">
                {t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {seleccion.map((fila) => (
            <tr key={fila}>
              <th className="whitespace-nowrap px-2 py-1 text-right font-semibold text-terminal-dim">{fila}</th>
              {seleccion.map((col) => {
                const v = fila === col ? 1 : correlacion(retornosPorTicker.get(fila) ?? [], retornosPorTicker.get(col) ?? [])
                return (
                  <td
                    key={col}
                    className="min-w-[52px] px-2 py-1.5 text-center tabular"
                    style={{ backgroundColor: colorCorr(v) }}
                  >
                    {v != null ? v.toFixed(2) : '—'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-terminal-dim">
        Correlación de retornos diarios sobre las últimas ~180 ruedas. Cerca de +1: se mueven casi
        igual (diversifican poco entre sí) · cerca de -1: se mueven en contra · cerca de 0: no hay
        relación lineal clara.
      </p>
    </div>
  )
}

function HeatmapSectorial({ filas }) {
  const porSector = useMemo(() => {
    const m = new Map()
    for (const f of filas) {
      if (f.var_pct == null) continue
      const sector = f.sector || 'Sin sector'
      if (!m.has(sector)) m.set(sector, { total: 0, peso: 0, n: 0 })
      const acc = m.get(sector)
      const peso = f.market_cap > 0 ? f.market_cap : 1
      acc.total += f.var_pct * peso
      acc.peso += peso
      acc.n += 1
    }
    return [...m.entries()]
      .map(([sector, acc]) => ({ sector, var_pct: acc.peso ? acc.total / acc.peso : null, n: acc.n }))
      .filter((x) => x.var_pct != null)
      .sort((a, b) => b.var_pct - a.var_pct)
  }, [filas])

  if (!porSector.length) {
    return <Vacio texto="No hay datos de sector/variación diaria todavía." />
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {porSector.map((s) => (
          <div
            key={s.sector}
            className="rounded-lg border border-terminal-border px-3 py-3 text-center"
            style={estiloValor(s.var_pct, 3)}
            title={`${s.n} ticker(s) de tu universo en este sector`}
          >
            <div className="truncate text-[11px] font-semibold" title={s.sector}>
              {s.sector}
            </div>
            <div className="mt-1 text-lg font-bold tabular">{fmtPct(s.var_pct, { signo: true })}</div>
            <div className="text-[10px] opacity-80">
              {s.n} ticker{s.n === 1 ? '' : 's'}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-terminal-dim">
        Variación de hoy promediada por sector (ponderada por market cap) — de tu universo de
        tickers, no del mercado entero.
      </p>
    </div>
  )
}

function AlertasPrecio({ filas }) {
  const { alertas, crear, eliminar, marcarDisparada } = useAlertas()
  const [ticker, setTicker] = useState('')
  const [campo, setCampo] = useState('precio')
  const [operador, setOperador] = useState('mayor')
  const [valor, setValor] = useState('')

  const porTicker = useMemo(() => new Map(filas.map((f) => [f.ticker, f])), [filas])

  const alertasConEstado = useMemo(
    () =>
      alertas.map((a) => {
        const fila = porTicker.get(a.ticker)
        return { ...a, _fila: fila, _cumple: seCumpleAlerta(a, fila) }
      }),
    [alertas, porTicker],
  )

  const onCrear = (e) => {
    e.preventDefault()
    if (!ticker || valor === '') return
    crear({ ticker, campo, operador, valor })
    setTicker('')
    setValor('')
  }

  return (
    <div>
      <form onSubmit={onCrear} className="mb-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-1 block text-[11px] text-terminal-dim">Ticker</label>
          <div className="flex items-center gap-2">
            <BuscadorTicker filas={filas} onAdd={setTicker} placeholder="Buscar ticker…" />
            {ticker && (
              <span className="rounded-full border border-terminal-accent px-2.5 py-1 text-xs font-semibold text-terminal-accent">
                {ticker}
              </span>
            )}
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-terminal-dim">Cuando</label>
          <select value={campo} onChange={(e) => setCampo(e.target.value)} className={inputCls}>
            {Object.entries(CAMPOS_ALERTA).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-terminal-dim">Sea</label>
          <select value={operador} onChange={(e) => setOperador(e.target.value)} className={inputCls}>
            <option value="mayor">≥ mayor o igual a</option>
            <option value="menor">≤ menor o igual a</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-terminal-dim">Valor</label>
          <input
            type="number"
            step="any"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            className={`${inputCls} w-24`}
          />
        </div>
        <button
          type="submit"
          disabled={!ticker || valor === ''}
          className="rounded bg-terminal-accent px-3 py-1.5 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-40"
        >
          + Crear alerta
        </button>
      </form>

      {!alertasConEstado.length ? (
        <Vacio texto="No tenés alertas creadas todavía." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-terminal-border">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                <th className="px-2 py-2 font-semibold">Ticker</th>
                <th className="px-2 py-2 font-semibold">Condición</th>
                <th className="px-2 py-2 text-right font-semibold">Valor actual</th>
                <th className="px-2 py-2 font-semibold">Estado</th>
                <th className="px-2 py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {alertasConEstado.map((a) => (
                <tr key={a.id} className="border-t border-terminal-border">
                  <td className="px-2 py-1.5 font-semibold">
                    <TickerLink ticker={a.ticker} />
                  </td>
                  <td className="px-2 py-1.5 text-terminal-dim">
                    {CAMPOS_ALERTA[a.campo]} {a.operador === 'mayor' ? '≥' : '≤'} {a.valor}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular">
                    {a._fila ? fmtNum(a._fila[a.campo], 2) : 'N/D'}
                  </td>
                  <td className="px-2 py-1.5">
                    {a._cumple ? (
                      <span className="font-semibold text-terminal-up">✅ Cumplida</span>
                    ) : a.disparada ? (
                      <span className="text-terminal-dim">— Ya vista</span>
                    ) : (
                      <span className="text-terminal-dim">⏳ Pendiente</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right">
                    {a._cumple && !a.disparada && (
                      <button
                        type="button"
                        onClick={() => marcarDisparada(a.id)}
                        className="mr-2 text-xs text-terminal-accent hover:underline"
                      >
                        Marcar vista
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => eliminar(a.id)}
                      className="text-xs text-terminal-dim hover:text-terminal-down"
                    >
                      ✕ Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[11px] text-terminal-dim">
        Se guardan en tu navegador — no hay notificación push ni email, se marcan como "Cumplida"
        con los datos más recientes cada vez que entrás a esta pestaña.
      </p>
    </div>
  )
}

const DURACIONES = [1, 2, 3, 5]

function SimuladorDCA({ filas }) {
  const { data: historicoMensual } = useJson('historico_mensual.json')
  const [ticker, setTicker] = useState('')
  const [monto, setMonto] = useState(100)
  const [anios, setAnios] = useState(3)

  const precios = useMemo(() => {
    const lista = Array.isArray(historicoMensual) ? historicoMensual : []
    return lista.find((x) => x.ticker === ticker)?.precios ?? []
  }, [historicoMensual, ticker])

  const resultado = useMemo(() => {
    if (!precios.length || !monto) return null
    const meses = Math.min(precios.length, anios * 12)
    const tramo = precios.slice(precios.length - meses).filter((p) => p.cierre)
    if (tramo.length < 2) return null

    let acciones = 0
    let invertido = 0
    for (const p of tramo) {
      acciones += monto / p.cierre
      invertido += monto
    }
    const precioFinal = tramo[tramo.length - 1].cierre
    const valorActual = acciones * precioFinal

    const precioInicial = tramo[0].cierre
    const accionesLump = precioInicial ? invertido / precioInicial : 0
    const valorLump = accionesLump * precioFinal

    return {
      meses: tramo.length,
      invertido,
      valorActual,
      retornoPct: invertido ? (valorActual / invertido - 1) * 100 : null,
      retornoLumpPct: invertido ? (valorLump / invertido - 1) * 100 : null,
    }
  }, [precios, monto, anios])

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-[11px] text-terminal-dim">Ticker</label>
          <div className="flex items-center gap-2">
            <BuscadorTicker filas={filas} onAdd={setTicker} placeholder="Buscar ticker…" />
            {ticker && (
              <span className="rounded-full border border-terminal-accent px-2.5 py-1 text-xs font-semibold text-terminal-accent">
                {ticker}
              </span>
            )}
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-terminal-dim">Monto mensual (USD)</label>
          <input
            type="number"
            min={1}
            value={monto}
            onChange={(e) => setMonto(Number(e.target.value) || 0)}
            className={`${inputCls} w-28`}
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-terminal-dim">Duración</label>
          <select value={anios} onChange={(e) => setAnios(Number(e.target.value))} className={inputCls}>
            {DURACIONES.map((a) => (
              <option key={a} value={a}>
                {a} año{a === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!ticker ? (
        <Vacio texto="Elegí un ticker para simular la inversión." />
      ) : !resultado ? (
        <Vacio texto="No hay suficiente historial mensual para ese ticker todavía." />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2.5 text-center">
            <div className="text-[10px] uppercase text-terminal-dim">Invertido ({resultado.meses} cuotas)</div>
            <div className="tabular font-semibold text-terminal-text">${fmtNum(resultado.invertido, 0)}</div>
          </div>
          <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2.5 text-center">
            <div className="text-[10px] uppercase text-terminal-dim">Valor hoy (DCA)</div>
            <div className="tabular font-semibold" style={estiloValor(resultado.retornoPct, 30)}>
              ${fmtNum(resultado.valorActual, 0)}
            </div>
          </div>
          <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2.5 text-center">
            <div className="text-[10px] uppercase text-terminal-dim">Retorno DCA</div>
            <div className="tabular font-semibold" style={estiloValor(resultado.retornoPct, 30)}>
              {fmtPct(resultado.retornoPct, { signo: true })}
            </div>
          </div>
          <div
            className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2.5 text-center"
            title="Si hubieras invertido todo el mismo total de una sola vez al principio, en vez de repartirlo mes a mes"
          >
            <div className="text-[10px] uppercase text-terminal-dim">Vs. todo de una (lump sum)</div>
            <div className="tabular font-semibold" style={estiloValor(resultado.retornoLumpPct, 30)}>
              {fmtPct(resultado.retornoLumpPct, { signo: true })}
            </div>
          </div>
        </div>
      )}
      <p className="mt-2 text-[11px] text-terminal-dim">
        Simulación retrospectiva con cierres de fin de mes (ajustados por dividendos/splits). No
        incluye comisiones ni impuestos. Rendimiento pasado, no garantiza nada a futuro.
      </p>
    </div>
  )
}

export default function Herramientas() {
  const { filas: base, cargando, error } = useDatosCombinados()
  const { overrides } = useClasificacion()
  const filas = useMemo(() => aplicarClasificacion(base, overrides), [base, overrides])
  const { watchlist } = useWatchlist()

  const [seleccion, setSeleccion] = useState(() =>
    watchlist ? watchlist.slice(0, 5).map((w) => w.ticker) : [],
  )

  const agregar = (t) => setSeleccion((prev) => (prev.includes(t) ? prev : [...prev, t]))
  const quitar = (t) => setSeleccion((prev) => prev.filter((x) => x !== t))

  if (cargando) return <div className="skeleton h-64 rounded-lg" />
  if (error) {
    return (
      <div className="rounded-lg border border-terminal-down/40 bg-terminal-down/10 p-6 text-center">
        <p className="font-semibold text-terminal-down">No se pudieron cargar los datos</p>
        <p className="text-sm text-terminal-dim">{error}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-bold text-terminal-text">Herramientas de análisis</h1>
        <p className="text-xs text-terminal-dim">
          Instrumentos para comparar y decidir, no más datos sueltos: comparador manual, correlación
          entre activos, heatmap sectorial y un simulador de DCA retrospectivo.{' '}
          <Link to="/screeners" className="text-terminal-dim hover:text-terminal-accent">
            (los scans rápidos — volumen, gaps, 52 semanas, insiders, próximos resultados — se
            mudaron a 📡 Screeners →)
          </Link>
        </p>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-terminal-text">
          Comparador &amp; Correlación
        </h2>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <BuscadorTicker filas={filas} excluir={seleccion} onAdd={agregar} />
          <Chips tickers={seleccion} onRemove={quitar} />
        </div>
        <div className="flex flex-col gap-4">
          <Comparador filas={filas} seleccion={seleccion} />
          <MatrizCorrelacion filas={filas} seleccion={seleccion} />
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-terminal-text">Heatmap sectorial</h2>
        <HeatmapSectorial filas={filas} />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-terminal-text">Alertas de precio</h2>
        <AlertasPrecio filas={filas} />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-terminal-text">Simulador de DCA retrospectivo</h2>
        <SimuladorDCA filas={filas} />
      </div>
    </div>
  )
}
