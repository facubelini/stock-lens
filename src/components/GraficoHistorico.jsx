import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtFechaMs } from '../lib/historicoDerivados'

// Grafico de lineas SVG (sin librerias) para Historico fundamental, estilo
// Koyfin: una o varias series sobre un eje de tiempo comun, eje Y a la
// derecha, etiqueta del valor actual por serie, bandas de promedio ±1σ (y
// mediana) para la primera serie y crosshair con tooltip.
//
// series: [{ id, etiqueta, color, puntos: [{t, v}], stats }]
// `robusto`: el eje Y se ajusta al rango 2%-98% de los valores (un P/E de
// 900x en un trimestre de ganancias casi nulas no aplasta todo el grafico);
// lo que queda afuera se recorta, y se avisa.

const MARGEN = { arriba: 10, derecha: 62, abajo: 22, izquierda: 4 }
const DIA = 24 * 3600 * 1000

function ticksLindos(min, max, cantidad = 5) {
  const rango = max - min
  if (!(rango > 0)) return [min]
  const paso0 = rango / cantidad
  const mag = 10 ** Math.floor(Math.log10(paso0))
  const norm = paso0 / mag
  const paso = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const ticks = []
  for (let v = Math.ceil(min / paso) * paso; v <= max + paso * 1e-9; v += paso) ticks.push(Number(v.toFixed(10)))
  return ticks
}

function ticksTiempo(t0, t1, ancho) {
  const anios = (t1 - t0) / (365.25 * DIA)
  const maxEtiquetas = Math.max(2, Math.floor(ancho / 64))
  const inicio = new Date(t0)
  const ticks = []
  if (anios <= 1.6) {
    const pasoMeses = [1, 2, 3, 6].find((p) => (anios * 12) / p <= maxEtiquetas) ?? 6
    const d = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1, 1))
    while (d.getTime() <= t1) {
      if (d.getUTCMonth() % pasoMeses === 0) {
        const mes = d.toLocaleString('es-AR', { month: 'short', timeZone: 'UTC' }).replace('.', '')
        ticks.push({ t: d.getTime(), texto: d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : mes })
      }
      d.setUTCMonth(d.getUTCMonth() + 1)
    }
    return ticks
  }
  const pasoAnios = [1, 2, 3, 5].find((p) => anios / p <= maxEtiquetas) ?? 5
  for (let a = inicio.getUTCFullYear() + 1; Date.UTC(a, 0, 1) <= t1; a++) {
    if (a % pasoAnios === 0) ticks.push({ t: Date.UTC(a, 0, 1), texto: String(a) })
  }
  return ticks
}

// Indice del punto mas cercano a t (puntos ordenados por t).
function masCercano(puntos, t) {
  let lo = 0
  let hi = puntos.length - 1
  if (hi < 0) return -1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (puntos[mid].t < t) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(puntos[lo - 1].t - t) < Math.abs(puntos[lo].t - t)) lo--
  return lo
}

function useAncho(ref) {
  const [ancho, setAncho] = useState(800)
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

export default function GraficoHistorico({ series, fmt, bandas = false, robusto = false }) {
  const contRef = useRef(null)
  const ancho = useAncho(contRef)
  const alto = ancho < 520 ? 250 : 330
  const [hover, setHover] = useState(null) // t (ms) bajo el cursor

  const geo = useMemo(() => {
    const conDatos = series.filter((s) => s.puntos.some((p) => p.v != null))
    if (!conDatos.length) return null
    let t0 = Infinity
    let t1 = -Infinity
    const valores = []
    for (const s of conDatos) {
      for (const p of s.puntos) {
        if (p.v == null) continue
        if (p.t < t0) t0 = p.t
        if (p.t > t1) t1 = p.t
        valores.push(p.v)
      }
    }
    if (t1 <= t0) t1 = t0 + DIA
    valores.sort((a, b) => a - b)
    const q = (x) => valores[Math.min(valores.length - 1, Math.max(0, Math.round(x * (valores.length - 1))))]
    let lo = robusto && valores.length > 50 ? q(0.02) : valores[0]
    let hi = robusto && valores.length > 50 ? q(0.98) : valores[valores.length - 1]
    const recortado = robusto && (valores[0] < lo || valores[valores.length - 1] > hi)
    const st = bandas ? conDatos[0].stats : null
    if (st) {
      lo = Math.min(lo, st.promedio - st.sd)
      hi = Math.max(hi, st.promedio + st.sd)
    }
    // El valor actual de cada serie siempre entra en el eje.
    for (const s of conDatos) {
      if (s.stats?.actual != null) {
        lo = Math.min(lo, s.stats.actual)
        hi = Math.max(hi, s.stats.actual)
      }
    }
    const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.1 || 1
    lo -= pad
    hi += pad
    const w = ancho - MARGEN.izquierda - MARGEN.derecha
    const h = alto - MARGEN.arriba - MARGEN.abajo
    const x = (t) => MARGEN.izquierda + ((t - t0) / (t1 - t0)) * w
    const y = (v) => MARGEN.arriba + (1 - (v - lo) / (hi - lo)) * h
    const caminos = conDatos.map((s) => {
      let d = ''
      let abierto = false
      for (const p of s.puntos) {
        if (p.v == null) {
          abierto = false
          continue
        }
        d += `${abierto ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`
        abierto = true
      }
      return { ...s, d }
    })
    // Etiquetas del valor actual a la derecha, separadas para que no se pisen.
    const etiquetas = conDatos
      .filter((s) => s.stats?.actual != null)
      .map((s) => ({ id: s.id, color: s.color, texto: fmt(s.stats.actual), y: y(s.stats.actual) }))
      .sort((a, b) => a.y - b.y)
    for (let i = 1; i < etiquetas.length; i++) {
      if (etiquetas[i].y - etiquetas[i - 1].y < 15) etiquetas[i].y = etiquetas[i - 1].y + 15
    }
    return {
      t0, t1, lo, hi, x, y, w, h, caminos, etiquetas, recortado, st,
      ticksY: ticksLindos(lo, hi, alto < 300 ? 4 : 6),
      ticksX: ticksTiempo(t0, t1, w),
    }
  }, [series, ancho, alto, bandas, robusto, fmt])

  if (!geo) {
    return (
      <div ref={contRef} className="flex h-40 items-center justify-center text-xs text-terminal-dim">
        Sin datos para esta métrica en el rango elegido.
      </div>
    )
  }

  const { x, y, st } = geo
  const clipId = 'clip-historico'

  const alMover = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * ancho
    const t = geo.t0 + ((px - MARGEN.izquierda) / geo.w) * (geo.t1 - geo.t0)
    setHover(Math.min(geo.t1, Math.max(geo.t0, t)))
  }

  let tooltip = null
  if (hover != null) {
    const filas = geo.caminos
      .map((s) => {
        const i = masCercano(s.puntos, hover)
        const p = s.puntos[i]
        if (!p || Math.abs(p.t - hover) > 10 * DIA) return null
        return { id: s.id, etiqueta: s.etiqueta, color: s.color, v: p.v, t: p.t }
      })
      .filter(Boolean)
    const tRef = filas[0]?.t ?? hover
    const px = x(tRef)
    tooltip = { filas, px, t: tRef, izquierda: px > ancho / 2 }
  }

  const bandasLineas = st
    ? [
        { v: st.promedio + st.sd, etiqueta: '+1σ', color: '#7d8b9c', dash: '4 4' },
        { v: st.promedio, etiqueta: 'prom', color: '#f5a524', dash: '6 4' },
        { v: st.mediana, etiqueta: 'med', color: '#c9d4e0', dash: '1 4' },
        { v: st.promedio - st.sd, etiqueta: '−1σ', color: '#7d8b9c', dash: '4 4' },
      ]
    : []
  // Etiquetas de las bandas: si dos quedan a menos de 11 px se muestra solo
  // la primera (prom > ±1σ > mediana en importancia), la linea se dibuja igual.
  const ocupados = []
  for (const b of [...bandasLineas].sort((a, c) => (a.etiqueta === 'prom' ? -1 : c.etiqueta === 'prom' ? 1 : a.etiqueta === 'med' ? 1 : -1))) {
    const yy = y(b.v)
    b.conTexto = !ocupados.some((o) => Math.abs(o - yy) < 11)
    if (b.conTexto) ocupados.push(yy)
  }

  return (
    <div ref={contRef} className="relative w-full select-none">
      <svg
        width={ancho}
        height={alto}
        viewBox={`0 0 ${ancho} ${alto}`}
        className="block touch-pan-y"
        onPointerMove={alMover}
        onPointerDown={alMover}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="Gráfico histórico"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={MARGEN.izquierda} y={MARGEN.arriba} width={geo.w} height={geo.h} />
          </clipPath>
        </defs>

        {geo.ticksY.map((v) => (
          <g key={v}>
            <line x1={MARGEN.izquierda} x2={MARGEN.izquierda + geo.w} y1={y(v)} y2={y(v)} stroke="#1d2733" strokeWidth="1" />
            <text x={MARGEN.izquierda + geo.w + 6} y={y(v) + 3.5} fontSize="10" fill="#7d8b9c">
              {fmt(v)}
            </text>
          </g>
        ))}
        {geo.ticksX.map((tk) => (
          <g key={tk.t}>
            <line x1={x(tk.t)} x2={x(tk.t)} y1={MARGEN.arriba} y2={MARGEN.arriba + geo.h} stroke="#141c26" strokeWidth="1" />
            <text x={x(tk.t)} y={alto - 6} fontSize="10" fill="#7d8b9c" textAnchor="middle">
              {tk.texto}
            </text>
          </g>
        ))}

        <g clipPath={`url(#${clipId})`}>
          {st && st.sd > 0 && (
            <rect
              x={MARGEN.izquierda}
              width={geo.w}
              y={y(st.promedio + st.sd)}
              height={Math.max(0, y(st.promedio - st.sd) - y(st.promedio + st.sd))}
              fill="#f5a524"
              opacity="0.05"
            />
          )}
          {bandasLineas.map((b) => (
            <g key={b.etiqueta}>
              <line
                x1={MARGEN.izquierda}
                x2={MARGEN.izquierda + geo.w}
                y1={y(b.v)}
                y2={y(b.v)}
                stroke={b.color}
                strokeWidth="1"
                strokeDasharray={b.dash}
                opacity="0.8"
              />
              {b.conTexto && (
                <text x={MARGEN.izquierda + 4} y={y(b.v) - 3} fontSize="9" fill={b.color} opacity="0.9">
                  {b.etiqueta} {fmt(b.v)}
                </text>
              )}
            </g>
          ))}
          {geo.caminos.map((s, i) => (
            <path
              key={s.id}
              d={s.d}
              fill="none"
              stroke={s.color}
              strokeWidth={i === 0 ? 1.8 : 1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
        </g>

        {geo.etiquetas.map((e) => (
          <g key={e.id}>
            <rect x={MARGEN.izquierda + geo.w + 1} y={e.y - 8} width={MARGEN.derecha - 2} height={15} rx="2" fill={e.color} />
            <text x={MARGEN.izquierda + geo.w + 5} y={e.y + 3.5} fontSize="10" fontWeight="700" fill="#070a0f">
              {e.texto}
            </text>
          </g>
        ))}

        {tooltip && (
          <g pointerEvents="none">
            <line x1={tooltip.px} x2={tooltip.px} y1={MARGEN.arriba} y2={MARGEN.arriba + geo.h} stroke="#c9d4e0" strokeWidth="1" opacity="0.4" />
            {tooltip.filas.map(
              (f) =>
                f.v != null && f.v >= geo.lo && f.v <= geo.hi && (
                  <circle key={f.id} cx={tooltip.px} cy={y(f.v)} r="3.5" fill={f.color} stroke="#070a0f" strokeWidth="1.5" />
                ),
            )}
          </g>
        )}
      </svg>

      {tooltip && tooltip.filas.length > 0 && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[8rem] rounded border border-terminal-border bg-terminal-bg/95 px-2 py-1.5 text-[11px] shadow-lg"
          style={tooltip.izquierda ? { right: ancho - tooltip.px + 10 } : { left: tooltip.px + 10 }}
        >
          <div className="mb-0.5 text-terminal-dim">{fmtFechaMs(tooltip.t)}</div>
          {tooltip.filas.map((f) => (
            <div key={f.id} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: f.color }} />
                <span className="text-terminal-text">{f.etiqueta}</span>
              </span>
              <span className="tabular font-semibold" style={{ color: f.color }}>
                {f.v == null ? '—' : fmt(f.v)}
              </span>
            </div>
          ))}
        </div>
      )}

      {geo.recortado && (
        <p className="mt-1 text-[10px] text-terminal-dim">
          Eje ajustado al rango 2%–98% de los valores: los picos extremos quedan recortados (el tooltip muestra el valor real).
        </p>
      )}
    </div>
  )
}
