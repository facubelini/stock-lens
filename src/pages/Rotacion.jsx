import { useEffect, useMemo, useRef, useState } from 'react'
import { useJson } from '../lib/useJson'
import { fmtFecha, fmtMarketCap, fmtNum } from '../lib/formato'
import { btnCls } from '../lib/estilos'
import TickerLink from '../components/TickerLink'
import { TablaSkeleton, Vacio } from '../components/Estados'
import ComoSeCalcula, { Formula } from '../components/ComoSeCalcula'

// Rotación (RRG — Relative Rotation Graph): compara la fuerza relativa de
// cada ticker (eje X, rs_score 0-100) contra su variación semanal (eje Y,
// rs_score − rs_score de la semana anterior) para ver quién está liderando,
// debilitándose, recuperándose o rezagado. Gráfico SVG dibujado a mano (sin
// libreria de charts), igual que el resto de la app.
//
// public/data/rotacion.json: { actualizado, semanas: [...16 fechas],
// acciones: [{ticker, nombre, sector, market_cap_usd, rs_score,
// rs_score_semana_ant, cuadrante, historial:[...16, algunos null]}],
// etfs: [misma forma], recien_a_lideres: [...], aceleracion_inusual: [...] }

const CUADRANTES = [
  {
    id: 'liderando',
    nombre: 'Liderando',
    color: '#22c55e',
    desc: 'RS alto y mejorando — la fuerza relativa ya es alta y sigue subiendo.',
  },
  {
    id: 'debilitando',
    nombre: 'Debilitando',
    color: '#f97316',
    desc: 'RS alto pero perdiendo momentum — todavía fuerte, pero ya no acelera.',
  },
  {
    id: 'recuperando',
    nombre: 'Recuperando',
    color: '#38bdf8',
    desc: 'RS bajo pero mejorando — todavía rezagado, pero ganando terreno.',
  },
  {
    id: 'rezagando',
    nombre: 'Rezagando',
    color: '#ef4444',
    desc: 'RS bajo y empeorando — el peor cuadrante, sigue perdiendo fuerza relativa.',
  },
]

const COLOR_CUADRANTE = Object.fromEntries(CUADRANTES.map((c) => [c.id, c.color]))

// A partir de (x, y) — no del campo `cuadrante` del JSON — para que el color
// tambien tenga sentido al mover el slider a semanas pasadas.
function cuadranteDe(x, y) {
  if (x >= 50 && y >= 0) return 'liderando'
  if (x >= 50 && y < 0) return 'debilitando'
  if (x < 50 && y >= 0) return 'recuperando'
  return 'rezagando'
}

const RADIO_MIN = 4
const RADIO_MAX = 26
const N_ETIQUETAS = 14 // solo se rotulan los N tickers mas grandes por cap. de mercado (evita amontonar labels)
const MS_POR_PASO = 800

function useAncho(ref) {
  const [ancho, setAncho] = useState(760)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const medir = () => setAncho(Math.max(280, Math.round(el.clientWidth)))
    medir()
    const ro = new ResizeObserver(medir)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return ancho
}

// Radio del bubble: sqrt(market cap) escalado y clampeado, para que una mega
// cap no tape a las demas.
function useEscalaRadio(lista) {
  return useMemo(() => {
    const raices = lista.map((t) => Math.sqrt(Math.max(0, t.market_cap_usd ?? 0))).filter((v) => v > 0)
    if (!raices.length) return () => RADIO_MIN
    const lo = Math.min(...raices)
    const hi = Math.max(...raices)
    return (cap) => {
      const r = Math.sqrt(Math.max(0, cap ?? 0))
      if (hi <= lo) return (RADIO_MIN + RADIO_MAX) / 2
      const pct = (r - lo) / (hi - lo)
      return RADIO_MIN + pct * (RADIO_MAX - RADIO_MIN)
    }
  }, [lista])
}

function GraficoRRG({ lista, semanaIdx, semanaMax }) {
  const contRef = useRef(null)
  const anchoCont = useAncho(contRef)
  const alto = anchoCont < 520 ? 320 : 420
  const margen = { arriba: 14, derecha: 16, abajo: 30, izquierda: 40 }
  const anchoUtil = anchoCont - margen.izquierda - margen.derecha
  const altoUtil = alto - margen.arriba - margen.abajo
  const escalaRadio = useEscalaRadio(lista)

  const puntos = useMemo(() => {
    const enHoy = semanaIdx === semanaMax
    return lista
      .map((t) => {
        let x
        let y
        if (enHoy) {
          x = t.rs_score
          y = t.rs_score_semana_ant != null ? t.rs_score - t.rs_score_semana_ant : null
        } else {
          const actual = t.historial?.[semanaIdx]
          const anterior = t.historial?.[semanaIdx - 1]
          x = actual
          y = actual != null && anterior != null ? actual - anterior : null
        }
        if (x == null || y == null) return null
        return { t, x, y, radio: escalaRadio(t.market_cap_usd), cuadrante: cuadranteDe(x, y) }
      })
      .filter(Boolean)
  }, [lista, semanaIdx, semanaMax, escalaRadio])

  const yMax = useMemo(() => {
    const maxAbs = puntos.reduce((m, p) => Math.max(m, Math.abs(p.y)), 0)
    return Math.max(15, Math.ceil((maxAbs * 1.15) / 5) * 5)
  }, [puntos])

  const px = (x) => margen.izquierda + (Math.max(0, Math.min(100, x)) / 100) * anchoUtil
  const py = (y) => margen.arriba + altoUtil / 2 - (Math.max(-yMax, Math.min(yMax, y)) / yMax) * (altoUtil / 2)

  // Etiquetas solo para los N tickers mas grandes por cap. de mercado.
  const conEtiqueta = useMemo(() => {
    const orden = [...puntos].sort((a, b) => (b.t.market_cap_usd ?? 0) - (a.t.market_cap_usd ?? 0))
    return new Set(orden.slice(0, N_ETIQUETAS).map((p) => p.t.ticker))
  }, [puntos])

  if (anchoCont < 50) return <div ref={contRef} style={{ height: alto }} />

  return (
    <div ref={contRef} className="w-full overflow-hidden">
      <svg width="100%" height={alto} viewBox={`0 0 ${anchoCont} ${alto}`} role="img" aria-label="Gráfico de rotación relativa">
        {/* Fondos de cuadrante */}
        <rect x={px(50)} y={margen.arriba} width={anchoUtil / 2} height={altoUtil / 2} fill={COLOR_CUADRANTE.liderando} opacity="0.08" />
        <rect x={px(50)} y={margen.arriba + altoUtil / 2} width={anchoUtil / 2} height={altoUtil / 2} fill={COLOR_CUADRANTE.debilitando} opacity="0.08" />
        <rect x={margen.izquierda} y={margen.arriba} width={anchoUtil / 2} height={altoUtil / 2} fill={COLOR_CUADRANTE.recuperando} opacity="0.08" />
        <rect x={margen.izquierda} y={margen.arriba + altoUtil / 2} width={anchoUtil / 2} height={altoUtil / 2} fill={COLOR_CUADRANTE.rezagando} opacity="0.08" />

        {/* Ejes centrales */}
        <line x1={px(50)} y1={margen.arriba} x2={px(50)} y2={margen.arriba + altoUtil} stroke="#1d2733" strokeWidth="1" />
        <line x1={margen.izquierda} y1={py(0)} x2={margen.izquierda + anchoUtil} y2={py(0)} stroke="#1d2733" strokeWidth="1" />
        <rect x={margen.izquierda} y={margen.arriba} width={anchoUtil} height={altoUtil} fill="none" stroke="#1d2733" strokeWidth="1" />

        {/* Etiquetas de eje */}
        <text x={margen.izquierda} y={alto - 8} fontSize="10" fill="#7d8b9c">RS bajo</text>
        <text x={margen.izquierda + anchoUtil} y={alto - 8} fontSize="10" fill="#7d8b9c" textAnchor="end">RS alto</text>
        <text x={margen.izquierda - 6} y={margen.arriba + 8} fontSize="10" fill="#7d8b9c" textAnchor="end">+{fmtNum(yMax, 0)}</text>
        <text x={margen.izquierda - 6} y={margen.arriba + altoUtil} fontSize="10" fill="#7d8b9c" textAnchor="end">−{fmtNum(yMax, 0)}</text>

        {/* Burbujas */}
        {puntos.map((p) => (
          <g key={p.t.ticker}>
            <circle
              cx={px(p.x)}
              cy={py(p.y)}
              r={p.radio}
              fill={COLOR_CUADRANTE[p.cuadrante]}
              fillOpacity="0.55"
              stroke={COLOR_CUADRANTE[p.cuadrante]}
              strokeWidth="1.2"
            >
              <title>
                {p.t.ticker} — {p.t.nombre ?? 'sin nombre'}
                {p.t.sector ? ` (${p.t.sector})` : ''}
                {'\n'}RS Score: {fmtNum(p.x, 1)} · Var. semanal: {p.y >= 0 ? '+' : ''}
                {fmtNum(p.y, 1)}
                {p.t.market_cap_usd ? `\nCap. de mercado: ${fmtMarketCap(p.t.market_cap_usd)}` : ''}
              </title>
            </circle>
            {conEtiqueta.has(p.t.ticker) && p.radio > 6 && (
              <text
                x={px(p.x)}
                y={py(p.y) - p.radio - 3}
                fontSize="9"
                textAnchor="middle"
                fill="#c9d4e0"
                className="pointer-events-none select-none"
              >
                {p.t.ticker}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}

function ListaCompacta({ titulo, entradas }) {
  const items = (entradas ?? []).map((e) => (typeof e === 'string' ? { ticker: e } : e)).filter((e) => e?.ticker)
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-3">
      <h3 className="mb-2 text-xs font-semibold text-terminal-text">{titulo}</h3>
      {items.length ? (
        <div className="flex flex-col gap-1">
          {items.map((e) => (
            <div key={e.ticker} className="flex items-center justify-between gap-2 text-xs">
              <span>
                <TickerLink ticker={e.ticker} className="font-semibold" />
                {e.nombre && <span className="ml-1.5 text-terminal-dim">{e.nombre}</span>}
              </span>
              <span className="tabular text-terminal-dim">
                {e.rs_score != null && <>RS {fmtNum(e.rs_score, 1)}</>}
                {e.variacion != null && (
                  <span className="ml-1.5" style={{ color: e.variacion >= 0 ? '#22c55e' : '#ef4444' }}>
                    {e.variacion >= 0 ? '+' : ''}
                    {fmtNum(e.variacion, 1)}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-terminal-dim">Sin tickers en esta categoría por ahora.</p>
      )}
    </div>
  )
}

export default function Rotacion() {
  const { data, cargando, error, status } = useJson('rotacion.json')
  const [universo, setUniverso] = useState('acciones')
  const [semanaIdx, setSemanaIdx] = useState(null) // null hasta saber cuantas semanas hay
  const [reproduciendo, setReproduciendo] = useState(false)
  const intervaloRef = useRef(null)

  const semanas = data?.semanas ?? []
  const semanaMax = Math.max(0, semanas.length - 1)

  useEffect(() => {
    if (semanas.length) setSemanaIdx((i) => (i == null ? semanaMax : Math.min(i, semanaMax)))
  }, [semanas.length, semanaMax])

  useEffect(() => {
    if (!reproduciendo) return undefined
    intervaloRef.current = setInterval(() => {
      setSemanaIdx((i) => {
        const sig = (i ?? 0) + 1
        if (sig > semanaMax) {
          setReproduciendo(false)
          return semanaMax
        }
        return sig
      })
    }, MS_POR_PASO)
    return () => clearInterval(intervaloRef.current)
  }, [reproduciendo, semanaMax])

  const lista = data?.[universo] ?? []

  // El archivo todavia no existe (pipeline en paralelo): no es un error de
  // carga, es "todavia no esta" — mismo patron que MensajeError/Vacio pero
  // con el texto especifico de "proxima corrida".
  const noDisponibleTodavia = status === 404 || (!cargando && !error && !data)

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">🔄 Rotación (RRG)</h1>
        <p className="text-xs text-terminal-dim">
          Relative Rotation Graph — quién está liderando, debilitándose, recuperando o rezagado en
          fuerza relativa (RS Score) semana a semana.{' '}
          {data?.actualizado && (
            <>
              Actualizado: <span className="text-terminal-text">{fmtFecha(data.actualizado)}</span>
            </>
          )}
        </p>
      </div>

      {cargando ? (
        <TablaSkeleton columnas={5} filas={8} />
      ) : noDisponibleTodavia ? (
        <div className="rounded-lg border border-terminal-border bg-terminal-panel p-6 text-center text-sm text-terminal-dim">
          Rotación (RRG) todavía no disponible — se agrega en la próxima corrida del pipeline.
        </div>
      ) : error ? (
        <div className="rounded-lg border border-terminal-down/40 bg-terminal-down/10 p-6 text-center">
          <p className="font-semibold text-terminal-down">No se pudieron cargar los datos</p>
          <p className="text-sm text-terminal-dim">{error}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex overflow-hidden rounded border border-terminal-border">
              <button
                type="button"
                onClick={() => setUniverso('acciones')}
                className={`px-3 py-1.5 text-xs font-semibold ${
                  universo === 'acciones' ? 'bg-terminal-accent text-black' : 'text-terminal-dim hover:text-terminal-text'
                }`}
              >
                Acciones
              </button>
              <button
                type="button"
                onClick={() => setUniverso('etfs')}
                className={`px-3 py-1.5 text-xs font-semibold ${
                  universo === 'etfs' ? 'bg-terminal-accent text-black' : 'text-terminal-dim hover:text-terminal-text'
                }`}
              >
                ETFs sectoriales
              </button>
            </div>
            <span className="text-[11px] text-terminal-dim">{lista.length} tickers</span>
          </div>

          {lista.length ? (
            <>
              <GraficoRRG lista={lista} semanaIdx={semanaIdx ?? semanaMax} semanaMax={semanaMax} />

              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-terminal-border bg-terminal-panel p-3">
                <button
                  type="button"
                  onClick={() =>
                    setReproduciendo((r) => {
                      if (!r && (semanaIdx ?? semanaMax) >= semanaMax) setSemanaIdx(0)
                      return !r
                    })
                  }
                  className={btnCls}
                  disabled={semanaMax === 0}
                >
                  {reproduciendo ? '⏸ Pausar' : '▶ Reproducir'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReproduciendo(false)
                    setSemanaIdx(semanaMax)
                  }}
                  className={btnCls}
                >
                  ↺ Volver a hoy
                </button>
                <input
                  type="range"
                  min={0}
                  max={semanaMax}
                  value={semanaIdx ?? semanaMax}
                  onChange={(e) => {
                    setReproduciendo(false)
                    setSemanaIdx(Number(e.target.value))
                  }}
                  className="min-w-[160px] flex-1 accent-terminal-accent"
                />
                <span className="tabular whitespace-nowrap text-xs text-terminal-text">
                  {semanas[semanaIdx ?? semanaMax] ? fmtFecha(semanas[semanaIdx ?? semanaMax]).split(' ')[0] : `Semana ${(semanaIdx ?? semanaMax) + 1}`}
                  {(semanaIdx ?? semanaMax) === semanaMax && ' (hoy)'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {CUADRANTES.map((c) => (
                  <div key={c.id} className="rounded-lg border border-terminal-border bg-terminal-panel p-2.5">
                    <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: c.color }}>
                      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: c.color }} />
                      {c.nombre}
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-terminal-dim">{c.desc}</p>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ListaCompacta titulo="🏆 Recién a Líderes" entradas={data?.recien_a_lideres} />
                <ListaCompacta titulo="⚡ Aceleración inusual" entradas={data?.aceleracion_inusual} />
              </div>

              <ComoSeCalcula titulo="¿Cómo se calcula la Rotación (RRG)?">
                <p>
                  <b className="text-terminal-text">Eje X — RS Score (0-100)</b>: fuerza relativa del ticker contra su
                  benchmark, ya calculada por el pipeline. Más a la derecha = más fuerte relativamente.
                </p>
                <p>
                  <b className="text-terminal-text">Eje Y — variación semanal</b>:{' '}
                  <Formula>rs_score − rs_score_semana_anterior</Formula>. Arriba del cero = mejorando esta semana,
                  abajo = empeorando, sin importar si el nivel absoluto es alto o bajo.
                </p>
                <p>
                  <b className="text-terminal-text">Tamaño de la burbuja</b>: proporcional a{' '}
                  <Formula>√(cap. de mercado)</Formula>, con un radio mínimo y máximo fijo para que una mega cap no
                  tape al resto del gráfico.
                </p>
                <p>
                  <b className="text-terminal-text">Cuadrantes</b>: se arman cruzando RS Score con 50 (eje vertical) y
                  la variación semanal con 0 (eje horizontal) — <b>Liderando</b> (RS≥50, mejorando),{' '}
                  <b>Debilitando</b> (RS≥50, empeorando), <b>Recuperando</b> (RS&lt;50, mejorando),{' '}
                  <b>Rezagando</b> (RS&lt;50, empeorando).
                </p>
                <p>
                  El slider y "▶ Reproducir" recalculan X e Y con cada semana del historial (
                  <Formula>historial[i]</Formula> vs. <Formula>historial[i] − historial[i−1]</Formula>) en vez del RS
                  Score en vivo, para ver la trayectoria de cada ticker entre cuadrantes a lo largo del tiempo.
                </p>
              </ComoSeCalcula>
            </>
          ) : (
            <Vacio texto={`Sin datos de ${universo === 'acciones' ? 'acciones' : 'ETFs sectoriales'} en esta corrida.`} />
          )}
        </div>
      )}
    </div>
  )
}
