import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useJson } from '../lib/useJson'
import { useDatosCombinados } from '../lib/useDatosCombinados'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { useWatchlist } from '../lib/watchlist'
import { usePins } from '../lib/usePins'
import { GLOSARIO_POR_CLAVE } from '../lib/glosario'
import { obtenerNoticias, clasificarSentimiento } from '../lib/noticias'
import { calcularScore, nivelScore } from '../lib/score'
import { TIMEFRAMES, ESTILO_VERDICT, prioridadScreener } from '../lib/screenerEstilos'
import {
  fmtPct,
  fmtNum,
  fmtPrecio,
  fmtMarketCap,
  fmtFecha,
  estiloValor,
  estiloRSI,
  estiloPER,
  estiloPEG,
} from '../lib/formato'
import Sparkline from '../components/Sparkline'
import BotonPin from '../components/BotonPin'
import EditorClasificacion from '../components/EditorClasificacion'
import TickerLink from '../components/TickerLink'
import GraficoEstacionalidad from '../components/GraficoEstacionalidad'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'

const RATIOS = [
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
  { key: 'target_mean_price', label: 'Precio objetivo', dec: 2 },
  { key: 'upside_pct', label: 'Upside', esPct: true },
]

const RECOMENDACION_LABEL = {
  strong_buy: 'Compra fuerte',
  buy: 'Compra',
  hold: 'Mantener',
  underperform: 'Bajo rendimiento',
  sell: 'Venta',
  strong_sell: 'Venta fuerte',
}

const DIST_MEDIAS = [
  { key: 'dist_ema21', label: 'EMA21' },
  { key: 'dist_ema50', label: 'EMA50' },
  { key: 'dist_ema150', label: 'EMA150' },
  { key: 'dist_sma200', label: 'SMA200' },
]

const N_PEERS = 2

function renderRatio(r, valor) {
  if (r.esCap) return fmtMarketCap(valor)
  if (r.esPct) return fmtPct(valor)
  return fmtNum(valor, r.dec ?? 2)
}

function esETF(datos) {
  return /etf/i.test(datos?.sector ?? '') || /etf/i.test(datos?.industria ?? '')
}

// El proximo_earnings del pipeline a veces queda un dia o dos atras (Yahoo
// tarda en correr la fecha siguiente apenas paso el reporte) — solo tiene
// sentido mostrarlo si todavia no paso.
function esFuturo(fechaISO) {
  if (!fechaISO) return false
  const hoy = new Date().toISOString().slice(0, 10)
  return fechaISO >= hoy
}

function fmtFechaCorta(fechaISO) {
  if (!fechaISO) return '—'
  const [anio, mes, dia] = fechaISO.split('-')
  return `${dia}/${mes}/${anio}`
}

const EXPLICACION_PARTE = {
  Tendencia: 'Precio vs. EMA50/SMA200 — más arriba de esas medias, más puntos.',
  Momentum: 'RSI — mejor cerca de 55 (ni sobrecomprado ni sobrevendido), penaliza los extremos.',
  Valuación: 'PER y PEG bajos suman — más barata, mejor.',
}

// Mismo calculo que ordena Listado (score.js) — ahi solo se ve un numero
// (o el desglose escondido en el tooltip del semaforo); aca se muestra
// entero, para responder "por que tiene este score" sin tener que ir a
// buscarlo a otra pestaña.
function DesgloseScore({ resultado }) {
  if (!resultado) return null
  const nivel = nivelScore(resultado.score)
  return (
    <div className="mb-5 rounded-lg border border-terminal-border bg-terminal-panel p-4">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-sm font-semibold text-terminal-text">Score</h2>
        <span className="text-2xl font-bold tabular" style={{ color: nivel.color }}>
          {resultado.score}
        </span>
        <span className="text-xs font-semibold" style={{ color: nivel.color }}>
          {nivel.txt}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {resultado.partes.map((p) => (
          <div key={p.k} className="rounded border border-terminal-border px-3 py-2.5">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold text-terminal-text">{p.k}</span>
              <span className="text-sm font-bold tabular text-terminal-text">{p.v}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-terminal-border">
              <div className="h-full rounded-full bg-terminal-accent" style={{ width: `${p.v}%` }} />
            </div>
            <p className="mt-1.5 text-[10px] text-terminal-dim">
              {EXPLICACION_PARTE[p.k]} (peso {Math.round(p.w * 100)}%)
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-terminal-dim">
        Score orientativo 0-100 — no es recomendación de inversión. Si falta algún dato (ej. PEG),
        el peso de esa parte se reparte entre las que sí están disponibles.
      </p>
    </div>
  )
}

function SeccionDividendos({ dividendos }) {
  if (!dividendos?.pagos?.length) return null
  const ultimos = [...dividendos.pagos].reverse().slice(0, 8)
  return (
    <div className="mb-5">
      <h2 className="mb-2 text-sm font-semibold text-terminal-text">Dividendos</h2>
      <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2 text-center">
          <div className="text-[10px] uppercase text-terminal-dim">Últimos 12 meses</div>
          <div className="tabular font-semibold text-terminal-text">
            ${fmtNum(dividendos.total_ultimos_12m, 2)} / acción
          </div>
        </div>
        <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2 text-center">
          <div className="text-[10px] uppercase text-terminal-dim">Crecimiento interanual</div>
          <div className="tabular font-semibold" style={estiloValor(dividendos.crecimiento_yoy, 15)}>
            {dividendos.crecimiento_yoy != null ? fmtPct(dividendos.crecimiento_yoy, { signo: true }) : 'N/D'}
          </div>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-terminal-border">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
              <th className="px-2 py-1.5 font-semibold">Fecha</th>
              <th className="px-2 py-1.5 text-right font-semibold">Monto / acción</th>
            </tr>
          </thead>
          <tbody>
            {ultimos.map((p) => (
              <tr key={p.fecha} className="border-t border-terminal-border">
                <td className="px-2 py-1 text-terminal-dim">{fmtFechaCorta(p.fecha)}</td>
                <td className="px-2 py-1 text-right tabular font-semibold text-terminal-text">${p.monto}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] text-terminal-dim">
        Últimos ~5 años de pagos (yfinance). El crecimiento interanual compara la suma de los
        pagos del último año contra el año anterior (según la frecuencia real de pago).
      </p>
    </div>
  )
}

// Noticias via Google News RSS (rss2json como proxy CORS) — best effort: si
// falla o tarda, no bloquea el resto de la pagina ni muestra un error feo,
// simplemente no aparece la seccion.
const ETIQUETA_SENTIMIENTO = {
  positivo: { icono: '🟢', texto: 'Positiva' },
  negativo: { icono: '🔴', texto: 'Negativa' },
  neutral: { icono: '⚪', texto: 'Neutra' },
}

function NoticiasTicker({ ticker }) {
  const [estado, setEstado] = useState('cargando')
  const [items, setItems] = useState([])

  useEffect(() => {
    let activo = true
    setEstado('cargando')
    obtenerNoticias(`${ticker} stock`)
      .then((its) => {
        if (!activo) return
        setItems(its)
        setEstado('ok')
      })
      .catch(() => activo && setEstado('error'))
    return () => {
      activo = false
    }
  }, [ticker])

  const itemsConSentimiento = useMemo(
    () => items.map((n) => ({ ...n, _sentimiento: clasificarSentimiento(n.title) })),
    [items],
  )
  const conteo = useMemo(() => {
    const c = { positivo: 0, negativo: 0, neutral: 0 }
    for (const n of itemsConSentimiento) c[n._sentimiento]++
    return c
  }, [itemsConSentimiento])

  if (estado === 'error' || (estado === 'ok' && items.length === 0)) return null

  return (
    <div className="mb-5">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold text-terminal-text">Noticias recientes</h2>
        {estado === 'ok' && items.length > 0 && (
          <span className="text-xs text-terminal-dim">
            {ETIQUETA_SENTIMIENTO.positivo.icono} {conteo.positivo} · {ETIQUETA_SENTIMIENTO.negativo.icono}{' '}
            {conteo.negativo} · {ETIQUETA_SENTIMIENTO.neutral.icono} {conteo.neutral}
          </span>
        )}
      </div>
      {estado === 'cargando' ? (
        <div className="skeleton h-20 rounded-lg" />
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-terminal-border bg-terminal-panel p-3">
          {itemsConSentimiento.map((n, i) => {
            const s = ETIQUETA_SENTIMIENTO[n._sentimiento]
            return (
              <a
                key={i}
                href={n.link}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-terminal-text hover:text-terminal-accent hover:underline"
                title={`Sentimiento: ${s.texto} (heurística de palabras clave, no reemplaza leer la noticia)`}
              >
                <span className="mr-1">{s.icono}</span>
                {n.title}
                {n.pubDate && (
                  <span className="ml-1.5 text-[11px] font-normal text-terminal-dim">
                    {new Date(n.pubDate).toLocaleDateString('es-AR')}
                  </span>
                )}
              </a>
            )
          })}
        </div>
      )}
      <p className="mt-1.5 text-[11px] text-terminal-dim">
        Vía Google News. El sentimiento (🟢/🔴/⚪) es una heurística simple de palabras clave en el
        título en inglés, no análisis de lenguaje real — sirve como guía rápida, no reemplaza leer
        la noticia.
      </p>
    </div>
  )
}

function CardVerdict({ tf, dato }) {
  const est = dato ? (ESTILO_VERDICT[dato.verdict] ?? ESTILO_VERDICT.NEUTRAL) : null
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-3">
      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
        {tf.label}
      </div>
      {!dato ? (
        <span className="text-sm text-terminal-dim">N/D</span>
      ) : (
        <>
          <span
            className="mb-1.5 inline-block rounded px-2 py-0.5 text-xs font-semibold"
            style={{ backgroundColor: est.bg, color: est.color }}
          >
            {est.label}
          </span>
          <p className="text-[11px] leading-relaxed text-terminal-dim">{dato.motivo}</p>
        </>
      )}
    </div>
  )
}

// Historial reciente de un timeframe: una franja de cuadraditos, uno por
// fecha con dato, coloreados según el veredicto de ese día.
function FranjaHistorial({ tfKey, entradas }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] text-terminal-dim">
        {TIMEFRAMES.find((t) => t.key === tfKey)?.label}
      </span>
      <div className="flex flex-wrap gap-0.5">
        {entradas.map(({ fecha, verdict }) => {
          const est = verdict ? (ESTILO_VERDICT[verdict] ?? ESTILO_VERDICT.NEUTRAL) : null
          return (
            <span
              key={fecha}
              title={`${fecha}: ${verdict ?? 'N/D'}`}
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: est?.color ?? 'rgba(148,163,184,0.15)' }}
            />
          )
        })}
      </div>
    </div>
  )
}

// Posición del precio dentro del rango de 52 semanas.
function Rango52Semanas({ precio, min, max }) {
  if (precio == null || min == null || max == null || max <= min) return null
  const pos = Math.min(100, Math.max(0, ((precio - min) / (max - min)) * 100))
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-terminal-dim">
        <span>52 semanas: {fmtPrecio(min)}</span>
        <span>{fmtPrecio(max)}</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-terminal-border">
        <div
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-terminal-accent"
          style={{ left: `${pos}%` }}
        />
      </div>
    </div>
  )
}

const btnExterno =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-xs text-terminal-dim hover:border-terminal-accent hover:text-terminal-text'

export default function TickerDetalle() {
  const { ticker: tickerParam } = useParams()
  const ticker = decodeURIComponent(tickerParam || '').toUpperCase()

  const { filas: base, cargando: cargandoBase, error: errorBase } = useDatosCombinados()
  const { data: screenerData, cargando: cargandoScreener } = useJson('screener.json')
  const { data: comparablesData, cargando: cargandoComparables } = useJson('comparables.json')
  const { data: historialData } = useJson('screener_historial.json')
  const { data: historicoTickersData } = useJson('historico_tickers.json')
  const { overrides } = useClasificacion()
  const { watchlist, agregar, quitar } = useWatchlist()
  const { isPinned, toggle } = usePins()

  const conOverrides = useMemo(() => aplicarClasificacion(base, overrides), [base, overrides])
  const fila = useMemo(
    () => conOverrides.find((f) => f.ticker.toUpperCase() === ticker),
    [conOverrides, ticker],
  )
  const resultadoScore = useMemo(() => (fila ? calcularScore(fila) : null), [fila])

  const industrias = useMemo(
    () => [...new Set(conOverrides.map((f) => f.industria).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')),
    [conOverrides],
  )
  const sectores = useMemo(
    () => [...new Set(conOverrides.map((f) => f.sector).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')),
    [conOverrides],
  )

  const screenerFila = useMemo(() => {
    const lista = Array.isArray(screenerData) ? screenerData : []
    return lista.find((f) => f.ticker.toUpperCase() === ticker)
  }, [screenerData, ticker])

  const grupoComparables = useMemo(() => {
    const grupos = Array.isArray(comparablesData) ? comparablesData : []
    if (fila) return grupos.find((g) => g.industria === fila.industria)
    // sin datos propios: buscar el ticker como peer en cualquier industria.
    return grupos.find((g) => g.pares?.some((p) => p.ticker.toUpperCase() === ticker))
  }, [comparablesData, fila, ticker])

  const parPropio = useMemo(
    () => grupoComparables?.pares?.find((p) => p.ticker.toUpperCase() === ticker),
    [grupoComparables, ticker],
  )

  const peersTop = useMemo(() => {
    if (!grupoComparables) return []
    return [...grupoComparables.pares]
      .filter((p) => p.ticker.toUpperCase() !== ticker)
      .sort((a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0))
      .slice(0, N_PEERS)
  }, [grupoComparables, ticker])

  const historialTicker = useMemo(() => {
    const hist = Array.isArray(historialData) ? historialData : []
    return hist
      .filter((h) => h.tickers?.[ticker])
      .map((h) => ({ fecha: h.fecha, ...h.tickers[ticker] }))
  }, [historialData, ticker])

  const enHistoricoFundamental = Array.isArray(historicoTickersData)
    ? historicoTickersData.includes(ticker)
    : false

  const cargando = cargandoBase || cargandoScreener || cargandoComparables

  // Ni datos propios (pipeline) ni como peer de comparables: no hay nada que mostrar.
  const soloComparable = !fila && parPropio

  if (cargando) {
    return <TablaSkeleton columnas={4} />
  }

  if (!fila && !parPropio) {
    return (
      <div>
        <Link to="/" className="mb-4 inline-block text-sm text-terminal-dim hover:text-terminal-text">
          ← Volver
        </Link>
        <Vacio
          texto={`${ticker} no está en tu universo de tickers ni aparece como comparable de ninguna industria.`}
        />
      </div>
    )
  }

  const datos = fila ?? parPropio
  const enWatchlist = Boolean(watchlist?.some((w) => w.ticker === ticker))
  const esFondo = esETF(datos)

  return (
    <div>
      <Link to="/" className="mb-3 inline-block text-sm text-terminal-dim hover:text-terminal-text">
        ← Volver
      </Link>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-terminal-text">{ticker}</h1>
            {fila && (
              <>
                <BotonPin ticker={ticker} isPinned={isPinned} toggle={toggle} />
                <button
                  type="button"
                  onClick={() => (enWatchlist ? quitar(ticker) : agregar(ticker))}
                  title={enWatchlist ? 'Quitar de "Mi lista"' : 'Agregar a "Mi lista"'}
                  className={`rounded border px-2 py-0.5 text-xs ${
                    enWatchlist
                      ? 'border-terminal-accent text-terminal-accent'
                      : 'border-terminal-border text-terminal-dim hover:border-terminal-accent hover:text-terminal-text'
                  }`}
                >
                  {enWatchlist ? '✓ En mi lista' : '+ Mi lista'}
                </button>
                <EditorClasificacion
                  ticker={ticker}
                  industria={fila.industria}
                  sector={fila.sector}
                  industrias={industrias}
                  sectores={sectores}
                />
              </>
            )}
            {datos.stale && (
              <span
                className="text-sm text-terminal-warn"
                title={`Dato arrastrado de la última corrida exitosa (${datos.actualizado ?? '?'})`}
              >
                🕒 desactualizado
              </span>
            )}
          </div>
          <p className="text-sm text-terminal-dim">{datos.nombre}</p>
          <p className="mt-1 text-xs text-terminal-dim">
            {datos.industria || 'Sin industria'}
            {datos.sector && datos.sector !== datos.industria && <> · {datos.sector}</>}
            {fila?.actualizado && <> · actualizado {fmtFecha(fila.actualizado)}</>}
          </p>
          <div className="mt-2 flex gap-2">
            <a
              href={`https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`}
              target="_blank"
              rel="noreferrer"
              className={btnExterno}
            >
              Yahoo Finance ↗
            </a>
            <a
              href={`https://www.tradingview.com/symbols/${encodeURIComponent(ticker.replace('.', '-'))}/`}
              target="_blank"
              rel="noreferrer"
              className={btnExterno}
            >
              TradingView ↗
            </a>
          </div>
          {soloComparable && (
            <p className="mt-2 max-w-md text-xs text-terminal-warn">
              No está en tu universo de tickers — se muestra solo como comparable de la industria{' '}
              {grupoComparables?.industria}. No hay señal de Screener, medias ni historial.
            </p>
          )}
        </div>

        {fila && (
          <div className="flex items-center gap-3 rounded-lg border border-terminal-border bg-terminal-panel px-4 py-3">
            <div>
              <div className="text-xl font-bold tabular text-terminal-text">
                {fmtPrecio(fila.precio)}
              </div>
              <div className="tabular text-sm" style={estiloValor(fila.var_pct, 6)}>
                {fmtPct(fila.var_pct, { signo: true })} hoy
              </div>
              {fila.pre_post_market?.estado === 'PRE' && fila.pre_post_market.pre_precio != null && (
                <div className="tabular text-xs text-terminal-info" title="Precio de pre-market, fuera del horario regular">
                  Pre-market: {fmtPrecio(fila.pre_post_market.pre_precio)} (
                  {fmtPct(fila.pre_post_market.pre_cambio_pct, { signo: true })})
                </div>
              )}
              {fila.pre_post_market?.estado === 'POST' && fila.pre_post_market.post_precio != null && (
                <div className="tabular text-xs text-terminal-info" title="Precio de post-market, fuera del horario regular">
                  Post-market: {fmtPrecio(fila.pre_post_market.post_precio)} (
                  {fmtPct(fila.pre_post_market.post_cambio_pct, { signo: true })})
                </div>
              )}
            </div>
            <Sparkline datos={fila.spark} ancho={90} alto={30} />
            <div className="rounded px-2 py-1 text-xs tabular" style={estiloRSI(fila.rsi)}>
              RSI {fmtNum(fila.rsi, 1)}
            </div>
          </div>
        )}
      </div>

      {fila?.spark?.length > 1 && (
        <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="overflow-hidden rounded-lg border border-terminal-border bg-terminal-panel p-3 lg:col-span-2">
            <div className="mb-1.5 flex items-center justify-between text-[11px] text-terminal-dim">
              <span>Precio (últimas {fila.spark.length} ruedas)</span>
              <span>
                mín {fmtPrecio(Math.min(...fila.spark))} · máx {fmtPrecio(Math.max(...fila.spark))}
              </span>
            </div>
            <Sparkline datos={fila.spark} ancho={860} alto={140} />
          </div>
          <Rango52Semanas precio={fila.precio} min={fila.low_52w} max={fila.high_52w} />
        </div>
      )}

      <DesgloseScore resultado={resultadoScore} />

      {screenerFila && (
        <div className="mb-5">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-terminal-text">
            Screener
            <span
              className="font-normal text-terminal-dim"
              title="Score de convicción (el mismo que ordena Top Señales): favorece COMPRA/CERCA, penaliza VENTA"
            >
              · conv. {prioridadScreener(screenerFila) > 0 ? '+' : ''}
              {prioridadScreener(screenerFila).toFixed(1)}
            </span>
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {TIMEFRAMES.map((tf) => (
              <CardVerdict key={tf.key} tf={tf} dato={screenerFila[tf.key]} />
            ))}
          </div>
        </div>
      )}

      {screenerFila?.divergencia_rsi && (
        <div
          className="mb-5 rounded-lg border px-3 py-2.5 text-sm"
          style={
            screenerFila.divergencia_rsi.tipo === 'alcista'
              ? { borderColor: 'rgba(34,197,94,0.4)', backgroundColor: 'rgba(34,197,94,0.08)', color: '#22c55e' }
              : { borderColor: 'rgba(239,68,68,0.4)', backgroundColor: 'rgba(239,68,68,0.08)', color: '#ef4444' }
          }
        >
          <span className="font-semibold">
            {screenerFila.divergencia_rsi.tipo === 'alcista' ? '📈 Divergencia alcista' : '📉 Divergencia bajista'}
          </span>{' '}
          en RSI diario (precio vs. RSI en los últimos pivots), detectada hace{' '}
          {screenerFila.divergencia_rsi.hace_ruedas} rueda{screenerFila.divergencia_rsi.hace_ruedas === 1 ? '' : 's'} —
          heurística basada en mínimos/máximos locales, no es una señal infalible.
        </div>
      )}

      {screenerFila?.cruce_medias && (
        <div
          className="mb-5 rounded-lg border px-3 py-2.5 text-sm"
          style={
            screenerFila.cruce_medias.tipo === 'golden'
              ? { borderColor: 'rgba(34,197,94,0.4)', backgroundColor: 'rgba(34,197,94,0.08)', color: '#22c55e' }
              : { borderColor: 'rgba(239,68,68,0.4)', backgroundColor: 'rgba(239,68,68,0.08)', color: '#ef4444' }
          }
        >
          <span className="font-semibold">
            {screenerFila.cruce_medias.tipo === 'golden' ? '🌟 Golden cross' : '💀 Death cross'}
          </span>{' '}
          (EMA50 cruzó {screenerFila.cruce_medias.tipo === 'golden' ? 'sobre' : 'bajo'} SMA200) hace{' '}
          {screenerFila.cruce_medias.hace_ruedas} rueda{screenerFila.cruce_medias.hace_ruedas === 1 ? '' : 's'}.
        </div>
      )}

      {screenerFila?.divergencia_ad && (
        <div
          className="mb-5 rounded-lg border px-3 py-2.5 text-sm"
          style={
            screenerFila.divergencia_ad.tipo === 'acumulacion'
              ? { borderColor: 'rgba(34,197,94,0.4)', backgroundColor: 'rgba(34,197,94,0.08)', color: '#22c55e' }
              : { borderColor: 'rgba(168,85,247,0.4)', backgroundColor: 'rgba(168,85,247,0.08)', color: '#a855f7' }
          }
        >
          <span className="font-semibold">
            {screenerFila.divergencia_ad.tipo === 'acumulacion' ? '🟢 Posible acumulación' : '🟣 Posible distribución'}
          </span>{' '}
          (divergencia precio vs. A/D Line — proxy de Wyckoff, no las fases completas) detectada hace{' '}
          {screenerFila.divergencia_ad.hace_ruedas} rueda{screenerFila.divergencia_ad.hace_ruedas === 1 ? '' : 's'} —
          heurística basada en mínimos/máximos locales, no es una señal infalible.
        </div>
      )}

      {historialTicker.length > 0 && (
        <div className="mb-5 rounded-lg border border-terminal-border bg-terminal-panel p-3">
          <h2 className="mb-2 text-sm font-semibold text-terminal-text">
            Historial de señales{' '}
            <span className="font-normal text-terminal-dim">
              ({historialTicker.length} día{historialTicker.length === 1 ? '' : 's'} registrados)
            </span>
          </h2>
          <div className="flex flex-col gap-1.5">
            {TIMEFRAMES.map((tf) => (
              <FranjaHistorial
                key={tf.key}
                tfKey={tf.key}
                entradas={historialTicker.map((h) => ({ fecha: h.fecha, verdict: h[tf.key] }))}
              />
            ))}
          </div>
          <p className="mt-2 text-[11px] text-terminal-dim">
            Se arma un día a la vez desde que se activó esta función — va a crecer con cada corrida
            del pipeline.
          </p>
        </div>
      )}

      {fila && DIST_MEDIAS.some((d) => fila[d.key] != null) && (
        <div className="mb-5">
          <h2 className="mb-2 text-sm font-semibold text-terminal-text">Distancia a medias</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {DIST_MEDIAS.map((d) => (
              <div
                key={d.key}
                className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2 text-center"
              >
                <div className="text-[10px] uppercase text-terminal-dim">{d.label}</div>
                <div className="tabular font-semibold" style={estiloValor(fila[d.key], 25)}>
                  {fmtPct(fila[d.key], { signo: true })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {fila && (fila.beta_realizado != null || fila.sharpe_1y != null) && (
        <div className="mb-5">
          <h2 className="mb-2 text-sm font-semibold text-terminal-text">Riesgo y retorno (1 año)</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2 text-center">
              <div className="text-[10px] uppercase text-terminal-dim">Beta realizado</div>
              <div className="tabular font-semibold text-terminal-text">{fmtNum(fila.beta_realizado, 2)}</div>
            </div>
            <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2 text-center">
              <div className="text-[10px] uppercase text-terminal-dim">Correlación c/ SPY</div>
              <div className="tabular font-semibold text-terminal-text">{fmtNum(fila.correlacion_mercado, 2)}</div>
            </div>
            <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2 text-center">
              <div className="text-[10px] uppercase text-terminal-dim">Sharpe</div>
              <div
                className="tabular font-semibold"
                style={{
                  color: fila.sharpe_1y == null ? undefined : fila.sharpe_1y > 1 ? '#22c55e' : fila.sharpe_1y < 0 ? '#ef4444' : undefined,
                }}
              >
                {fmtNum(fila.sharpe_1y, 2)}
              </div>
            </div>
            <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2 text-center">
              <div className="text-[10px] uppercase text-terminal-dim">Volatilidad anual.</div>
              <div className="tabular font-semibold text-terminal-text">{fmtPct(fila.volatilidad_1y)}</div>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-terminal-dim">
            Calculado con los últimos ~252 días de cotización (no es el beta estático de Yahoo, que
            puede estar desactualizado) — beta y correlación son contra SPY.
          </p>
        </div>
      )}

      {fila?.estacionalidad?.length > 0 && (
        <div className="mb-5">
          <h2 className="mb-2 text-sm font-semibold text-terminal-text">Estacionalidad</h2>
          <div className="rounded-lg border border-terminal-border bg-terminal-panel p-3">
            <GraficoEstacionalidad datos={fila.estacionalidad} />
          </div>
          <p className="mt-1.5 text-[11px] text-terminal-dim">
            Retorno promedio por mes calendario en los últimos ~5 años (o lo que haya de historial).
            Es un patrón histórico, no una predicción — puede no repetirse.
          </p>
        </div>
      )}

      {fila && !esFondo && (fila.recommendation_key || fila.insider || esFuturo(fila.proximo_earnings?.fecha)) && (
        <div className="mb-5 flex flex-col gap-2 sm:flex-row">
          {fila.recommendation_key && (
            <div className="flex-1 rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2.5">
              <div className="text-[10px] uppercase text-terminal-dim">Consenso de analistas</div>
              <div className="font-semibold text-terminal-text">
                {RECOMENDACION_LABEL[fila.recommendation_key] ?? fila.recommendation_key}
                {fila.n_analistas ? ` · ${fila.n_analistas} analistas` : ''}
              </div>
            </div>
          )}
          {esFuturo(fila.proximo_earnings?.fecha) && (
            <div className="flex-1 rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2.5">
              <div className="text-[10px] uppercase text-terminal-dim">Próximo reporte de resultados</div>
              <div className="font-semibold text-terminal-text">
                {fmtFechaCorta(fila.proximo_earnings.fecha)}
                {fila.proximo_earnings.fecha_fin && ` – ${fmtFechaCorta(fila.proximo_earnings.fecha_fin)}`}
                {fila.proximo_earnings.estimado && (
                  <span className="ml-1.5 text-xs font-normal text-terminal-dim">(estimado)</span>
                )}
              </div>
            </div>
          )}
          {fila.insider && (fila.insider.n_compras > 0 || fila.insider.n_ventas > 0) && (
            <div className="flex-1 rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2.5">
              <div className="text-[10px] uppercase text-terminal-dim">Insiders (últimos 6 meses)</div>
              <div className="flex gap-3 text-sm">
                <span className="font-semibold text-terminal-up">
                  {fila.insider.n_compras} compra{fila.insider.n_compras === 1 ? '' : 's'}
                  {fila.insider.valor_compras > 0 && ` · $${fmtMarketCap(fila.insider.valor_compras)}`}
                </span>
                <span className="font-semibold text-terminal-down">
                  {fila.insider.n_ventas} venta{fila.insider.n_ventas === 1 ? '' : 's'}
                  {fila.insider.valor_ventas > 0 && ` · $${fmtMarketCap(fila.insider.valor_ventas)}`}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      <SeccionDividendos dividendos={fila?.dividendos} />

      <div className="mb-5">
        <h2 className="mb-2 text-sm font-semibold text-terminal-text">Fundamentales</h2>
        {esFondo ? (
          <>
            <p className="mb-3 rounded-lg border border-terminal-border bg-terminal-panel p-4 text-xs text-terminal-dim">
              Los ratios fundamentales tradicionales (PER, PEG, márgenes, etc.) no aplican acá:{' '}
              {ticker} es un fondo (ETF), no una empresa con ganancias propias.
            </p>
            {datos.holdings?.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-terminal-border">
                <div className="border-b border-terminal-border bg-terminal-panel2 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-terminal-dim">
                  Top holdings (composición del fondo)
                </div>
                <table className="min-w-full border-collapse text-sm">
                  <tbody>
                    {datos.holdings.map((h) => (
                      <tr key={h.ticker} className="border-t border-terminal-border">
                        <td className="whitespace-nowrap px-3 py-1.5 font-semibold">
                          <TickerLink ticker={h.ticker} />
                        </td>
                        <td className="w-full px-3 py-1.5 text-terminal-dim">{h.nombre}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right tabular font-semibold text-terminal-text">
                          {h.peso_pct != null ? `${h.peso_pct.toFixed(2)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-terminal-border">
              <table className="min-w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                    <th className="px-2 py-2 font-semibold">Ratio</th>
                    <th className="px-2 py-2 text-right font-semibold">{ticker}</th>
                    {peersTop.map((p) => (
                      <th key={p.ticker} className="px-2 py-2 text-right font-semibold">
                        <TickerLink ticker={p.ticker} />
                      </th>
                    ))}
                    {grupoComparables && (
                      <th className="px-2 py-2 text-right font-semibold">
                        Mediana · {grupoComparables.industria}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {RATIOS.map((r) => (
                    <tr key={r.key} className="border-t border-terminal-border">
                      <td className="px-2 py-1.5 text-terminal-dim" title={GLOSARIO_POR_CLAVE[r.key]?.def}>
                        {r.label}
                      </td>
                      <td
                        className="px-2 py-1.5 text-right tabular font-semibold"
                        style={r.estilo ? r.estilo(datos[r.key]) : undefined}
                      >
                        {renderRatio(r, datos[r.key])}
                      </td>
                      {peersTop.map((p) => (
                        <td key={p.ticker} className="px-2 py-1.5 text-right tabular text-terminal-dim">
                          {renderRatio(r, p[r.key])}
                        </td>
                      ))}
                      {grupoComparables && (
                        <td className="px-2 py-1.5 text-right tabular text-terminal-info">
                          {renderRatio(r, grupoComparables.mediana?.[r.key])}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {grupoComparables && (
              <Link
                to="/comparables"
                className="mt-1.5 inline-block text-xs text-terminal-dim hover:text-terminal-accent"
              >
                Ver todos los comparables de {grupoComparables.industria} →
              </Link>
            )}
          </>
        )}
      </div>

      {fila && <NoticiasTicker ticker={ticker} />}

      {enHistoricoFundamental && (
        <Link
          to="/historico"
          className="inline-block rounded border border-terminal-border bg-terminal-panel px-3 py-2 text-xs text-terminal-dim hover:border-terminal-accent hover:text-terminal-text"
        >
          📈 Ver evolución histórica (EDGAR, 5+ años) en Histórico Fundamental →
        </Link>
      )}
      {errorBase && <MensajeError mensaje={errorBase} />}
    </div>
  )
}
