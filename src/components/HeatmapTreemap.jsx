import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { fmtPct, fmtMarketCap, estiloValor } from '../lib/formato'
import ComoSeCalcula, { Formula } from './ComoSeCalcula'

// Heatmap "treemap" por ticker (no por promedio de industria): cada
// recuadro es UN ticker, agrupado por industria en bloques (no un algoritmo
// real de binary-space-partition — un simple flex-wrap "packed" por sección
// alcanza para ~350-400 tickers y es liviano). El tamaño va con
// sqrt(market_cap_usd) recortado a un rango legible (percentiles 5-95, para
// que una sola mega-cap no aplaste al resto), el color con la misma escala
// verde/rojo de estiloValor (formato.js) que ya usa toda la app.
const MIN_PX = 46
const MAX_PX = 132

function tamanosPorRaizDeCap(filas) {
  const raiz = (f) => Math.sqrt(Math.max(f.market_cap_usd ?? 0, 0))
  const raices = filas.map(raiz)
  const validas = raices.filter((r) => r > 0).sort((a, b) => a - b)
  if (!validas.length) return filas.map(() => (MIN_PX + MAX_PX) / 2)
  const pct = (p) => validas[Math.min(validas.length - 1, Math.floor(p * (validas.length - 1)))]
  const lo = pct(0.05)
  const hi = pct(0.95)
  return raices.map((r) => {
    if (!r) return MIN_PX
    const t = hi > lo ? Math.min(1, Math.max(0, (r - lo) / (hi - lo))) : 0.5
    return Math.round(MIN_PX + t * (MAX_PX - MIN_PX))
  })
}

function Recuadro({ f, lado }) {
  return (
    <Link
      to={`/ticker/${encodeURIComponent(f.ticker)}`}
      title={`${f.ticker} · ${f.nombre}\nVar. hoy: ${fmtPct(f.var_pct, { signo: true })}\nMarket cap: ${fmtMarketCap(f.market_cap_usd)}`}
      style={{ ...estiloValor(f.var_pct, 6), width: lado, height: Math.round(lado * 0.62) }}
      className="flex shrink-0 flex-col items-center justify-center overflow-hidden rounded border border-black/20 px-1 text-center leading-tight hover:z-10 hover:scale-[1.06] hover:border-terminal-accent"
    >
      <span className="truncate text-[10px] font-bold">{f.ticker}</span>
      {lado >= 64 && <span className="text-[9px] tabular opacity-90">{fmtPct(f.var_pct, { signo: true })}</span>}
    </Link>
  )
}

export default function HeatmapTreemap({ filas }) {
  const conCap = useMemo(() => (filas ?? []).filter((f) => f.var_pct != null), [filas])

  const tamanos = useMemo(() => tamanosPorRaizDeCap(conCap), [conCap])

  const grupos = useMemo(() => {
    const g = new Map()
    conCap.forEach((f, i) => {
      const k = f.industria || '—'
      if (!g.has(k)) g.set(k, [])
      g.get(k).push({ f, lado: tamanos[i] })
    })
    return [...g.entries()]
      .map(([industria, items]) => ({
        industria,
        // Bloques más grandes primero (más "peso" visual arriba).
        capTotal: items.reduce((s, it) => s + (it.f.market_cap_usd ?? 0), 0),
        items: items.sort((a, b) => (b.f.market_cap_usd ?? 0) - (a.f.market_cap_usd ?? 0)),
      }))
      .sort((a, b) => b.capTotal - a.capTotal)
  }, [conCap, tamanos])

  if (conCap.length === 0) return null

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-terminal-dim">
        <span className="font-semibold text-terminal-text">Referencias:</span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: 'rgba(34,197,94,.7)' }} /> sube
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: 'rgba(239,68,68,.7)' }} /> baja
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-3 w-3 rounded-sm border border-terminal-border" style={{ backgroundColor: 'rgba(120,120,120,.15)' }} /> ~sin cambios
        </span>
        <span>tamaño del recuadro ∝ √(market cap)</span>
      </div>

      {/* Sin scroll horizontal de página: cada bloque de industria envuelve
          sus propios recuadros con flex-wrap, así que en 375px los tickers
          grandes bajan de línea solos en vez de forzar el ancho de la página. */}
      <div className="flex flex-col gap-3">
        {grupos.map((g) => (
          <div key={g.industria} className="rounded-lg border border-terminal-border bg-terminal-panel p-2">
            <div className="mb-1.5 truncate text-xs font-semibold text-terminal-accent">
              {g.industria} <span className="font-normal text-terminal-dim">· {g.items.length}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {g.items.map(({ f, lado }) => (
                <Recuadro key={f.ticker} f={f} lado={lado} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <ComoSeCalcula className="mt-2">
        <p>
          Un recuadro por ticker (no por promedio de industria), agrupados en bloques por{' '}
          <Formula>industria</Formula> (con tus reclasificaciones manuales aplicadas, igual que en la vista
          "Por industria"). <b className="text-terminal-text">Tamaño</b>:{' '}
          <Formula>√(market_cap_usd)</Formula>, normalizado entre el percentil 5 y 95 de esa raíz a un rango
          de {MIN_PX}-{MAX_PX}px (así una sola mega-cap no aplasta al resto del mapa; sin market cap, tamaño
          mínimo). <b className="text-terminal-text">Color</b>: la misma escala verde/rojo de{' '}
          <Formula>estiloValor(var_pct)</Formula> que usa el resto de la app (más intenso = mayor variación
          del día). Click en un recuadro va a la ficha del ticker.
        </p>
        <p>
          No es un treemap real (sin subdivisión binaria del espacio): es un empaquetado simple con
          flex-wrap por bloque de industria, más liviano para ~350-400 tickers y que en pantallas angostas
          reduce recuadros por fila solo, sin scroll horizontal de página.
        </p>
      </ComoSeCalcula>
    </div>
  )
}
