import { useEffect, useMemo, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useJson, useJsonPrimero, useMeta } from '../lib/useJson'
import { useDatosCombinados } from '../lib/useDatosCombinados'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { useWatchlist } from '../lib/watchlist'
import { usePins } from '../lib/usePins'
import { GLOSARIO_POR_CLAVE } from '../lib/glosario'
import { obtenerNoticias, clasificarSentimiento } from '../lib/noticias'
import { calcularScore, nivelScore } from '../lib/score'
import { calcularDescuento, evaluarCalidad, señalesTrampaValor } from '../lib/valuacion'
import { TIMEFRAMES, ESTILO_VERDICT, prioridadScreener } from '../lib/screenerEstilos'
import {
  fmtPct,
  fmtNum,
  fmtPrecio,
  fmtMarketCap,
  fmtFecha,
  fmtFechaCorta,
  hoyAR,
  estiloValor,
  estiloRSI,
} from '../lib/formato'
import {
  RATIOS as RATIOS_BASE,
  RATIOS_ANALISTAS,
  RECOMENDACION_LABEL,
  renderRatio,
  marketCapUsd,
  monedaNoUsd,
} from '../lib/ratios'
import Sparkline from '../components/Sparkline'
import BotonPin from '../components/BotonPin'
import EditorClasificacion from '../components/EditorClasificacion'
import TickerLink from '../components/TickerLink'
import BuscadorTicker from '../components/BuscadorTicker'
import GraficoEstacionalidad from '../components/GraficoEstacionalidad'
import MarcaStale, { fechaDeFila } from '../components/MarcaStale'
import { ExplicacionConviccion, ExplicacionDescuento } from '../components/Explicaciones'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'

// Ratios fundamentales (definicion compartida) + los de analistas.
const RATIOS = [...RATIOS_BASE, ...RATIOS_ANALISTAS]

const DIST_MEDIAS = [
  { key: 'dist_ema21', label: 'EMA21' },
  { key: 'dist_ema50', label: 'EMA50' },
  { key: 'dist_ema150', label: 'EMA150' },
  { key: 'dist_sma200', label: 'SMA200' },
]

const N_PEERS = 2

function esETF(datos) {
  return /etf/i.test(datos?.sector ?? '') || /etf/i.test(datos?.industria ?? '')
}

// El proximo_earnings del pipeline a veces queda un dia o dos atras (Yahoo
// tarda en correr la fecha siguiente apenas paso el reporte) — solo tiene
// sentido mostrarlo si todavia no paso. "Hoy" en hora de Buenos Aires.
function esFuturo(fechaISO) {
  if (!fechaISO) return false
  return fechaISO >= hoyAR()
}

// Solo links http(s): el link de la noticia viene de un feed externo
// (rss2json) y un "javascript:" o "data:" no puede terminar en un href.
function urlSegura(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

// TradingView usa el exchange como prefijo: los .BA son BCBA:XXX y los .SA
// BMFBOVESPA:XXX (antes se armaba "YPFD-BA", que no existe).
function urlTradingView(ticker) {
  const m = /^(.+)\.(BA|SA)$/.exec(ticker)
  if (m) {
    const exchange = m[2] === 'BA' ? 'BCBA' : 'BMFBOVESPA'
    return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${exchange}:${m[1]}`)}`
  }
  return `https://www.tradingview.com/symbols/${encodeURIComponent(ticker.replace('.', '-'))}/`
}

const EXPLICACION_PARTE = {
  Tendencia: 'Precio vs. SMA200/EMA50 — más arriba de esas medias, más puntos.',
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
              {EXPLICACION_PARTE[p.k]} Peso {Math.round(p.w * 100)}%
              {Math.abs((p.wEfectivo ?? p.w) - p.w) > 0.001 && ` (efectivo ${Math.round(p.wEfectivo * 100)}%, falta otra parte)`}.
            </p>
            {p.calculo && (
              <p className="mt-1 rounded bg-terminal-bg px-1.5 py-1 font-mono text-[10px] leading-snug text-terminal-text">
                {p.calculo}
              </p>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-terminal-dim">
        <code>Score = Σ(parte × peso) / Σ(pesos disponibles)</code> ={' '}
        {resultado.partes.map((p) => `${p.v}×${Math.round(p.w * 100)}%`).join(' + ')} →{' '}
        <b className="text-terminal-text">{resultado.score}</b>. Cortes: ≥66 Favorable · ≥40 Neutral · &lt;40
        Flojo. Score orientativo 0-100 — no es recomendación de inversión. Si falta algún dato (ej.
        PEG), el peso de esa parte se reparte entre las que sí están disponibles.
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
            const href = urlSegura(n.link)
            if (!href) return null
            return (
              <a
                key={i}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
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
  const navigate = useNavigate()
  const meta = useMeta()

  const { filas: base, cargando: cargandoBase, error: errorBase } = useDatosCombinados()
  const { data: screenerData, cargando: cargandoScreener, error: errorScreener } = useJson('screener.json')
  const {
    data: comparablesData,
    cargando: cargandoComparables,
    error: errorComparables,
  } = useJson('comparables.json')
  // Historial de señales por ticker (historial/<T>.json, ~KB) en vez del
  // screener_historial.json completo (varios MB). Si el pipeline todavia no
  // publico el layout nuevo, se cae al archivo viejo.
  const { data: historialData, fuente: fuenteHistorial } = useJsonPrimero(
    ticker ? [`historial/${encodeURIComponent(ticker)}.json`, 'screener_historial.json'] : null,
  )
  // historico_tickers.json no se publica: la lista de tickers con histórico
  // sale del propio historico_fundamental.json.
  const { data: historicoFundData } = useJson('historico_fundamental.json')
  const { overrides } = useClasificacion()
  const { watchlist, agregar, quitar } = useWatchlist()
  const { isPinned, toggle } = usePins()
  const [manualPeers, setManualPeers] = useState([])
  // Al pasar de un ticker a otro (link de un peer) los competidores agregados
  // a mano eran del anterior: se limpian.
  useEffect(() => setManualPeers([]), [ticker])

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
      // Por market cap en USD (no se mezclan monedas; sin dato va al final).
      .sort((a, b) => (marketCapUsd(b) ?? -1) - (marketCapUsd(a) ?? -1))
      .slice(0, N_PEERS)
  }, [grupoComparables, ticker])

  // Pool para agregar competidores a mano: tu propio universo (fundamentales.json,
  // vía useDatosCombinados) + todos los peers curados de comparables.json (de
  // cualquier industria, no solo la de este ticker) — es lo único con ratios ya
  // calculados por el pipeline. No hay forma de traer un ticker cualquiera del
  // mercado al vuelo (sitio estático, sin backend ni CORS de Yahoo).
  const poolComparables = useMemo(() => {
    const mapa = new Map()
    for (const f of conOverrides) mapa.set(f.ticker.toUpperCase(), f)
    for (const g of Array.isArray(comparablesData) ? comparablesData : []) {
      for (const p of g.pares ?? []) {
        const t = p.ticker.toUpperCase()
        if (!mapa.has(t)) mapa.set(t, p)
      }
    }
    mapa.delete(ticker)
    return [...mapa.values()]
  }, [conOverrides, comparablesData, ticker])

  const manualPeersResueltos = useMemo(() => {
    const mapa = new Map(poolComparables.map((f) => [f.ticker.toUpperCase(), f]))
    return manualPeers.map((t) => mapa.get(t)).filter(Boolean)
  }, [manualPeers, poolComparables])

  const agregarPeerManual = (t) => setManualPeers((prev) => (prev.includes(t) ? prev : [...prev, t]))
  const quitarPeerManual = (t) => setManualPeers((prev) => prev.filter((x) => x !== t))

  const historialTicker = useMemo(() => {
    const hist = Array.isArray(historialData) ? historialData : []
    // Layout nuevo: [{ fecha, diario, semanal, mensual }] ascendente.
    if (fuenteHistorial && fuenteHistorial !== 'screener_historial.json') {
      return hist.filter((h) => h?.fecha)
    }
    // Layout viejo: [{ fecha, tickers: { TICKER: {...} } }].
    return hist
      .filter((h) => h.tickers?.[ticker])
      .map((h) => ({ fecha: h.fecha, ...h.tickers[ticker] }))
  }, [historialData, fuenteHistorial, ticker])

  const enHistoricoFundamental = useMemo(() => {
    const lista = Array.isArray(historicoFundData?.tickers) ? historicoFundData.tickers : []
    return lista.some((t) => String(t.ticker).toUpperCase() === ticker && t.disponible !== false)
  }, [historicoFundData, ticker])

  // "← Volver": a la pantalla anterior si se llegó navegando dentro de la
  // app; si se abrió el link directo (sin historial propio), al Listado.
  const volver = (e) => {
    e.preventDefault()
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1)
    else navigate('/')
  }
  const linkVolver = (clase) => (
    <Link to="/" onClick={volver} className={clase}>
      ← Volver
    </Link>
  )

  const cargando = cargandoBase || cargandoScreener || cargandoComparables
  const errorCarga = [errorBase, errorScreener, errorComparables].filter(Boolean).join(' · ') || null

  // Ni datos propios (pipeline) ni como peer de comparables: no hay nada que mostrar.
  const soloComparable = !fila && parPropio

  if (cargando) {
    return <TablaSkeleton columnas={4} />
  }

  if (!fila && !parPropio) {
    // Si fallo la carga no se puede afirmar que el ticker "no existe".
    if (errorCarga) {
      return (
        <div>
          {linkVolver('mb-4 inline-block text-sm text-terminal-dim hover:text-terminal-text')}
          <MensajeError mensaje={errorCarga} />
        </div>
      )
    }
    return (
      <div>
        {linkVolver('mb-4 inline-block text-sm text-terminal-dim hover:text-terminal-text')}
        <Vacio
          texto={`${ticker} no está en tu universo de tickers ni aparece como comparable de ninguna industria.`}
        />
      </div>
    )
  }

  const datos = fila ?? parPropio
  const enWatchlist = Boolean(watchlist?.some((w) => w.ticker === ticker))
  const esFondo = esETF(datos)
  // Cara/barata segun fundamentos: mismo calculo que ya usa Oportunidades
  // (descuento vs. mediana de industria en PER/EV-Sales/P-S), no se duplica
  // logica — solo se reusa aca para el perfil individual del ticker.
  const mediana = grupoComparables?.mediana
  const descuentoValuacion = mediana ? calcularDescuento(datos, mediana) : null
  const calidadValuacion = mediana ? evaluarCalidad(datos, mediana) : null
  const trampaValorTicker = señalesTrampaValor(datos)

  return (
    <div>
      {linkVolver('mb-3 inline-block text-sm text-terminal-dim hover:text-terminal-text')}

      {errorCarga && (
        <p className="mb-3 rounded border border-terminal-down/40 bg-terminal-down/10 px-3 py-2 text-xs text-terminal-down">
          Algunos datos no se pudieron cargar ({errorCarga}) — la vista puede estar incompleta.
        </p>
      )}

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
            <MarcaStale fila={datos} className="text-sm" texto="desactualizado" />
            {monedaNoUsd(datos) && (
              <span
                className="rounded bg-terminal-panel2 px-1.5 py-0.5 text-xs text-terminal-dim"
                title={`Cotiza en ${datos.moneda}. Los ratios que mezclan monedas vienen en N/D; el market cap se muestra en USD si el pipeline lo convirtió.`}
              >
                {datos.moneda}
              </span>
            )}
          </div>
          <p className="text-sm text-terminal-dim">{datos.nombre}</p>
          <p className="mt-1 text-xs text-terminal-dim">
            {datos.industria || 'Sin industria'}
            {datos.sector && datos.sector !== datos.industria && <> · {datos.sector}</>}
            {fila && fechaDeFila(fila, meta) && <> · actualizado {fmtFecha(fechaDeFila(fila, meta))}</>}
          </p>
          <div className="mt-2 flex gap-2">
            <a
              href={`https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={btnExterno}
            >
              Yahoo Finance ↗
            </a>
            <a
              href={urlTradingView(ticker)}
              target="_blank"
              rel="noopener noreferrer"
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
              {fila.cedear_ratio != null && (
                <div
                  className="tabular text-xs text-terminal-dim"
                  title={`Ratio ${fila.cedear_ratio}:1 (${fila.cedear_ratio} certificados CEDEAR = 1 acción) — ratios de Banco Comafi + carga manual en data/ratios_cedear_manual.json`}
                >
                  {fila.cedear_precio != null ? (
                    <>
                      CEDEAR ({fila.cedear_ticker}): ${fmtPrecio(fila.cedear_precio)} ARS · ratio{' '}
                      {fila.cedear_ratio}:1
                      {fila.cedear_ccl_implicito != null && (
                        <> · CCL implícito ${fmtNum(fila.cedear_ccl_implicito, 0)}</>
                      )}
                    </>
                  ) : (
                    <>
                      CEDEAR: ratio {fila.cedear_ratio}:1{' '}
                      <span className="text-terminal-dim/70">(sin cotización en BYMA vía Yahoo)</span>
                    </>
                  )}
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
              title="Score de convicción (el mismo que ordena Top Señales): Σ peso(veredicto) × peso(temporalidad)"
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
          <ExplicacionConviccion fila={screenerFila} className="mt-2" />
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

      {screenerFila?.cruce_corto && (
        <div
          className="mb-5 rounded-lg border px-3 py-2.5 text-sm"
          style={
            screenerFila.cruce_corto.tipo === 'golden'
              ? { borderColor: 'rgba(34,197,94,0.4)', backgroundColor: 'rgba(34,197,94,0.08)', color: '#22c55e' }
              : { borderColor: 'rgba(239,68,68,0.4)', backgroundColor: 'rgba(239,68,68,0.08)', color: '#ef4444' }
          }
        >
          <span className="font-semibold">
            {screenerFila.cruce_corto.tipo === 'golden' ? '🔼 Cruce alcista de corto plazo' : '🔽 Cruce bajista de corto plazo'}
          </span>{' '}
          (EMA9 cruzó {screenerFila.cruce_corto.tipo === 'golden' ? 'sobre' : 'bajo'} EMA21) hace{' '}
          {screenerFila.cruce_corto.hace_ruedas} rueda{screenerFila.cruce_corto.hace_ruedas === 1 ? '' : 's'} — más
          sensible que el golden/death cross, útil para timing de corto plazo.
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
            {descuentoValuacion != null && (
              <div
                className="mb-3 rounded-lg border px-3 py-2.5 text-sm"
                style={
                  descuentoValuacion > 0
                    ? { borderColor: 'rgba(34,197,94,0.4)', backgroundColor: 'rgba(34,197,94,0.08)' }
                    : { borderColor: 'rgba(239,68,68,0.4)', backgroundColor: 'rgba(239,68,68,0.08)' }
                }
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold" style={{ color: descuentoValuacion > 0 ? '#22c55e' : '#ef4444' }}>
                    {descuentoValuacion > 0 ? '🟢 Barata' : '🔴 Cara'} vs. industria
                  </span>
                  <span className="text-terminal-dim">
                    {fmtPct(descuentoValuacion, { signo: true })} de {descuentoValuacion > 0 ? 'descuento' : 'prima'} vs.
                    mediana de {grupoComparables.industria} (PER/EV-Sales/P-S)
                  </span>
                  {calidadValuacion && (
                    <span className="text-terminal-dim">
                      · Calidad:{' '}
                      {calidadValuacion.roeOk && calidadValuacion.margenOk
                        ? '✓ ROE y margen sobre mediana'
                        : calidadValuacion.roeOk || calidadValuacion.margenOk
                          ? '~ parcial'
                          : '✕ bajo mediana'}
                    </span>
                  )}
                  {trampaValorTicker.length > 0 && (
                    <span className="font-semibold text-terminal-warn" title={`Posible trampa de valor: ${trampaValorTicker.join(', ')}`}>
                      ⚠️ posible trampa de valor
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-terminal-dim">
                  Mismo cálculo que la pestaña Oportunidades — promedio del descuento/prima en los
                  ratios de valuación disponibles contra la mediana de industria curada, no contra el
                  mercado entero.
                </p>
                <ExplicacionDescuento className="mt-2" />
              </div>
            )}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <BuscadorTicker
                filas={poolComparables}
                excluir={[ticker, ...peersTop.map((p) => p.ticker), ...manualPeers]}
                onAdd={agregarPeerManual}
                placeholder="Agregar competidor a mano…"
              />
              {manualPeersResueltos.map((p) => (
                <span
                  key={p.ticker}
                  className="flex items-center gap-1.5 rounded-full border border-terminal-border bg-terminal-panel px-2.5 py-1 text-xs"
                >
                  <TickerLink ticker={p.ticker} />
                  <button
                    type="button"
                    onClick={() => quitarPeerManual(p.ticker)}
                    title="Quitar de la comparación"
                    aria-label={`Quitar ${p.ticker} de la comparación`}
                    className="text-terminal-dim hover:text-terminal-down"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <p className="mb-2 text-[11px] text-terminal-dim">
              Solo se pueden agregar tickers que ya tengan datos en este sitio (tu lista o peers
              curados de cualquier industria) — no hay forma de traer un ticker cualquiera del
              mercado al vuelo.
            </p>
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
                    {manualPeersResueltos.map((p) => (
                      <th key={p.ticker} className="px-2 py-2 text-right font-semibold">
                        <span className="inline-flex items-center gap-1">
                          <TickerLink ticker={p.ticker} />
                          <button
                            type="button"
                            onClick={() => quitarPeerManual(p.ticker)}
                            title="Quitar de la comparación"
                            aria-label={`Quitar ${p.ticker} de la comparación`}
                            className="font-normal text-terminal-dim hover:text-terminal-down"
                          >
                            ✕
                          </button>
                        </span>
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
                        {renderRatio(r, datos)}
                      </td>
                      {peersTop.map((p) => (
                        <td key={p.ticker} className="px-2 py-1.5 text-right tabular text-terminal-dim">
                          {renderRatio(r, p)}
                        </td>
                      ))}
                      {manualPeersResueltos.map((p) => (
                        <td key={p.ticker} className="px-2 py-1.5 text-right tabular text-terminal-dim">
                          {renderRatio(r, p)}
                        </td>
                      ))}
                      {grupoComparables && (
                        <td className="px-2 py-1.5 text-right tabular text-terminal-info">
                          {renderRatio(r, grupoComparables.mediana)}
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
    </div>
  )
}
