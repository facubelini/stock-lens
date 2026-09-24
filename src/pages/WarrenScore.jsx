import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { useWatchlist } from '../lib/watchlist'
import { fmtFecha, fmtNum, fmtPct } from '../lib/formato'
import { compararValores } from '../lib/ordenar'
import { inputCls, selectCls } from '../lib/estilos'
import TickerLink from '../components/TickerLink'
import Modal from '../components/Modal'
import EncabezadoOrdenable from '../components/EncabezadoOrdenable'
import { Formula } from '../components/ComoSeCalcula'
import { ExplicacionWarrenScore } from '../components/Explicaciones'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'

// Warren Score: screener tecnico/cuantitativo 0-100 (NO fundamental), modelo
// tipo "Warren Bife Dashboard" v4.9. El calculo vive en
// scripts/generar_datos.py (ws_calcular_ticker / calcular_warren_score); aca
// solo se muestra con sus formulas. Topes de cada pilar:
const PILARES = [
  { key: 'tendencia', corto: 'Tend', nombre: 'Tendencia', max: 20 },
  { key: 'fuerza', corto: 'F.Rel', nombre: 'Fuerza relativa', max: 25 },
  { key: 'contraccion', corto: 'Contr', nombre: 'Contracción', max: 35 },
  { key: 'gatillo', corto: 'Gatillo', nombre: 'Gatillo / setup', max: 20 },
]

const OPCIONES_SCORE = [0, 80, 70, 60, 50, 40].map((v) => ({ valor: v, etiqueta: v === 0 ? 'Todos' : `${v}+` }))
const OPCIONES_TOP = [
  { valor: 20, etiqueta: 'Top 20' },
  { valor: 50, etiqueta: 'Top 50' },
  { valor: 100, etiqueta: 'Top 100' },
  { valor: 0, etiqueta: 'Todos' },
]

const COLOR_STAGE = { 1: '#38bdf8', 2: '#22c55e', 3: '#f5a524', 4: '#ef4444' }

function colorScore(score) {
  if (score == null) return '#7d8b9c'
  if (score >= 80) return '#16a34a'
  if (score >= 70) return '#22c55e'
  if (score >= 55) return '#f5a524'
  if (score >= 40) return '#f97316'
  return '#ef4444'
}

// El JSON viejo (pilares trend/momentum/volatility) no tiene "pilares".
function esFormatoViejo(tickers) {
  return tickers.length > 0 && tickers.every((r) => r.pilares === undefined)
}

function valorOrden(r, campo) {
  if (campo === 'score') return r.total_score
  if (campo === 'ticker') return r.ticker
  if (campo === 'stage') return r.stage?.n
  if (campo === 'rs') return r.pilares?.fuerza?.rs
  if (campo === 'pen') return r.penalizacion?.pts
  if (campo === 'max52') return r.dist_max52_pct
  if (PILARES.some((p) => p.key === campo)) return r.pilares?.[campo]?.pts
  return null
}

function Anillo({ score, tam = 64 }) {
  const r = tam / 2 - 5
  const circ = 2 * Math.PI * r
  const frac = Math.max(0, Math.min(100, score ?? 0)) / 100
  const color = colorScore(score)
  return (
    <svg width={tam} height={tam} viewBox={`0 0 ${tam} ${tam}`} role="img" aria-label={`Score ${fmtNum(score, 1)}`}>
      <circle cx={tam / 2} cy={tam / 2} r={r} fill="none" stroke="#1d2733" strokeWidth="5" />
      <circle
        cx={tam / 2}
        cy={tam / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={`${circ * frac} ${circ}`}
        transform={`rotate(-90 ${tam / 2} ${tam / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fill={color} fontSize={tam / 4} fontWeight="700">
        {score != null ? fmtNum(score, 1) : 'N/D'}
      </text>
    </svg>
  )
}

function MiniBarra({ pts, max, ancho = 'w-14' }) {
  const pct = pts != null ? Math.max(0, Math.min(1, pts / max)) * 100 : 0
  return (
    <div className="flex items-center gap-1.5" title={`${fmtNum(pts, 1)} / ${max}`}>
      <div className={`h-1.5 ${ancho} overflow-hidden rounded-full bg-terminal-border`}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: colorScore(pct) }} />
      </div>
      <span className="tabular text-[11px] text-terminal-dim">{pts != null ? fmtNum(pts, 1) : 'N/D'}</span>
    </div>
  )
}

function BadgeStage({ stage }) {
  if (!stage) return null
  const color = COLOR_STAGE[stage.n] ?? '#7d8b9c'
  return (
    <span
      className="inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ color, borderColor: `${color}66` }}
      title={`Stage ${stage.n} (Weinstein): ${stage.tip}`}
    >
      S{stage.n} · {stage.label}
    </span>
  )
}

function BadgeGates({ fila }) {
  const ok = fila.gates?.ok
  return (
    <span
      className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
        ok ? 'border-terminal-up/50 text-terminal-up' : 'border-terminal-down/50 text-terminal-down'
      }`}
      title={ok ? 'Gate Stage 2 cumplido: precio > EMA200' : `Falla: ${(fila.gates?.fallas ?? []).join(', ')} → score topeado en 40`}
    >
      {ok ? 'GATES OK' : 'CAP 40'}
    </span>
  )
}

function Banderas({ flags }) {
  if (!flags?.length) return <span className="text-terminal-dim">—</span>
  return (
    <span className="inline-flex flex-wrap gap-0.5">
      {flags.map((f) => (
        <span key={f.clave} title={`${f.detalle}${f.pts ? ` (${f.pts} pts)` : ''}`} className="cursor-help">
          {f.emoji}
        </span>
      ))}
    </span>
  )
}

function TarjetaPodio({ fila, puesto, onAbrir }) {
  const medalla = ['🥇', '🥈', '🥉'][puesto]
  return (
    <button
      type="button"
      onClick={() => onAbrir(fila)}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-terminal-border bg-terminal-panel p-3 text-left transition-colors hover:border-terminal-accent"
    >
      <div className="flex items-center gap-3">
        <Anillo score={fila.total_score} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span aria-hidden="true">{medalla}</span>
            <span className="font-bold text-terminal-text">{fila.ticker}</span>
            {fila.penalizacion?.flags?.length > 0 && <Banderas flags={fila.penalizacion.flags} />}
          </div>
          <div className="truncate text-[11px] text-terminal-dim">{fila.nombre}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            <BadgeStage stage={fila.stage} />
            <BadgeGates fila={fila} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {PILARES.map((p) => (
          <div key={p.key} className="flex items-center justify-between gap-1 text-[11px]">
            <span className="text-terminal-dim">
              {p.corto} /{p.max}
            </span>
            <MiniBarra pts={fila.pilares?.[p.key]?.pts} max={p.max} ancho="w-10" />
          </div>
        ))}
      </div>
    </button>
  )
}

// --- Detalle: cada pilar con sus numeros y la formula aplicada ---
function Seccion({ titulo, pts, max, children }) {
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-terminal-text">{titulo}</span>
        {max != null && (
          <span className="tabular font-bold" style={{ color: colorScore(((pts ?? 0) / max) * 100) }}>
            {pts != null ? fmtNum(pts, 1) : 'N/D'} /{max}
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-1.5 text-[11px] leading-relaxed text-terminal-dim">{children}</ul>
    </div>
  )
}

function Linea({ children, pts }) {
  return (
    <li className="flex items-start justify-between gap-2">
      <span className="min-w-0">{children}</span>
      {pts != null && <span className="tabular shrink-0 text-terminal-text">{fmtNum(pts, 2)}</span>}
    </li>
  )
}

const V = ({ children }) => <span className="text-terminal-text">{children}</span>

function DetalleTendencia({ t }) {
  const conAtr = t.atr_pct != null
  return (
    <Seccion titulo="A · Tendencia" pts={t.pts} max={20}>
      <Linea pts={t.pts_sma50}>
        Dist. SMA50 <V>{fmtPct(t.dist_sma50_pct, { signo: true })}</V>
        {conAtr ? (
          <>
            {' '}/ ATR14% <V>{fmtNum(t.atr_pct, 2)}</V> = <V>{fmtNum(t.dist_sma50_atr, 2)} ATR</V> →{' '}
            <Formula>tri(v, −5, −2, 4, 8) × 10</Formula>
          </>
        ) : (
          <> (sin ATR: 10 pts entre −5% y +20%)</>
        )}
      </Linea>
      <Linea pts={t.pts_ema200}>
        Dist. EMA200 <V>{fmtPct(t.dist_ema200_pct, { signo: true })}</V>
        {conAtr ? (
          <>
            {' '}= <V>{fmtNum(t.dist_ema200_atr, 2)} ATR</V> → <Formula>tri(v, 0, 0, 8, 14) × 5,83</Formula>
          </>
        ) : (
          <>
            {' '}→ <Formula>tri(%, 0, 10, 50, 70) × 5,83</Formula>
          </>
        )}
      </Linea>
      <Linea pts={t.pts_pendiente}>
        Pendiente EMA200 <V>{fmtNum(t.pendiente_ema200, 3)}%/día</V> (prom. 20 ruedas) →{' '}
        <Formula>lineal(p, 0, 0,15, 0, 4,17)</Formula>
      </Linea>
      <Linea>
        SMA50 <V>{fmtNum(t.sma50, 2)}</V> · EMA200 <V>{fmtNum(t.ema200, 2)}</V> · total{' '}
        <Formula>min(suma, 20)</Formula>
      </Linea>
    </Seccion>
  )
}

function DetalleFuerza({ f }) {
  if (!f) {
    return (
      <Seccion titulo="B · Fuerza relativa" pts={null} max={25}>
        <Linea>No cotiza en USD: no se compara contra SPY y el score total queda en N/D.</Linea>
      </Seccion>
    )
  }
  return (
    <Seccion titulo="B · Fuerza relativa" pts={f.pts} max={25}>
      <Linea>
        Rendimiento relativo ponderado <Formula>0,4·r63 + 0,2·r126 + 0,2·r189 + 0,2·r252</Formula> ={' '}
        <V>{fmtPct(f.rendimiento_relativo_pct, { signo: true })}</V>
      </Linea>
      <Linea>
        RS (percentil en el universo USD) hoy <V>{fmtNum(f.rs, 1)}</V> · hace 5 ruedas{' '}
        <V>{fmtNum(f.rs_semana_ant, 1)}</V> · hace 21 ruedas <V>{fmtNum(f.rs_mes_ant, 1)}</V>
      </Linea>
      <Linea pts={f.via_nivel}>
        Vía nivel <Formula>lineal(RS, 45, 75, 0, 20)</Formula>
      </Linea>
      <Linea pts={f.via_delta}>
        Vía delta <Formula>lineal(RS − max(RS mes, 40), 0, 20, 0, 20)</Formula> (solo si RS − RS semana &gt; −5)
      </Linea>
      <Linea pts={f.fr_pts}>
        Línea FR (precio / SPY) sobre su SMA50: <V>{f.fr_sobre_sma50 == null ? 'N/D' : f.fr_sobre_sma50 ? 'sí' : 'no'}</V> → +5
      </Linea>
      <Linea>
        Total <Formula>min(max(nivel, delta) + FR, 25)</Formula>
      </Linea>
    </Seccion>
  )
}

function DetalleContraccion({ c }) {
  const v = c.vcp ?? {}
  return (
    <Seccion titulo="C · Contracción" pts={c.pts} max={35}>
      <Linea>
        Ratio de volatilidad (20r / mediana 1 año): hoy <V>{fmtNum(c.ratio_hoy, 2)}</V>, mínimo de 7 ruedas{' '}
        <V>{fmtNum(c.ratio_min7, 2)}</V>
      </Linea>
      <Linea>
        Avance neto 5 ruedas <V>{fmtNum(c.avance_neto_atr, 2)} ATR</V> → factor dirección{' '}
        <Formula>1 − 0,5 × clamp((neto − 0,8) / 1,7, 0, 1)</Formula> = <V>{fmtNum(c.factor_direccion, 2)}</V>
      </Linea>
      <Linea pts={c.pts_contraccion}>
        Contracción <Formula>tri(ratio, 0, 0, 0,70, 1,05) × 15,25 × factor</Formula>
      </Linea>
      <Linea pts={c.pts_rsi}>
        RSI14 <V>{fmtNum(c.rsi, 1)}</V> → <Formula>tri(RSI, 30, 45, 60, 70) × 11,25</Formula>
      </Linea>
      <Linea pts={c.pts_vcp}>
        VCP {v.detectado ? <V>detectado</V> : 'no detectado'}: {v.contracciones ?? 0} contracción(es) decrecientes
        {v.profundidades?.length ? <> (últimas: {v.profundidades.map((p) => `${fmtNum(p, 1)}%`).join(' → ')})</> : null}, pivote{' '}
        <V>{fmtNum(v.pivote, 2)}</V> ({fmtPct(v.dist_pivote_pct, { signo: true })}), volumen{' '}
        {v.vol_decreciente ? 'secándose' : 'sin secarse'}, score <V>{fmtNum(v.score, 0)}</V> →{' '}
        <Formula>lineal(score, 40, 100, 0, 6,8) + 1,7 si volumen seco</Formula>
      </Linea>
      <Linea pts={c.resta_verticalidad ? -c.resta_verticalidad : c.resta_verticalidad}>
        Verticalidad: subida desde el mínimo de 15 ruedas <V>{fmtNum(c.velocidad_atr, 2)} ATR</V> →{' '}
        <Formula>− lineal(v, 5, 11, 0, 8)</Formula>
      </Linea>
      <Linea>
        Total <Formula>max(0, min(contr + RSI + VCP, 35) − verticalidad)</Formula>
      </Linea>
    </Seccion>
  )
}

function DetalleGatillo({ g }) {
  return (
    <Seccion titulo="D · Gatillo / calidad del setup" pts={g.pts} max={20}>
      <Linea pts={g.pts_ext}>
        Sobre el mínimo 52s <V>{fmtPct(g.dist_min52_pct, { signo: true })}</V> / volatilidad anual{' '}
        <V>{fmtNum(g.vol_1y, 1)}%</V> = <V>{fmtNum(g.ext, 2)}</V> → <Formula>tri(ext, 0,3, 0,5, 1,8, 3,2) × 5</Formula>
      </Linea>
      <Linea pts={g.pts_semanas}>
        Base de <V>{fmtNum(g.base_semanas, 1)} semanas</V> desde el pivote <V>{fmtNum(g.pivote, 2)}</V>
        {g.base_ruptura ? ' (rompiendo: base que acaba de terminar)' : ''} →{' '}
        <Formula>tri(sem, 1, 7, 26, 55) × 10</Formula>
      </Linea>
      <Linea pts={g.pts_posicion}>
        Posición en la base <V>{fmtNum(g.base_posicion_pct, 1)}%</V> (mínimo {fmtNum(g.base_minimo, 2)}) →{' '}
        <Formula>lineal(pos, 20, 50, 0, 5)</Formula>
      </Linea>
      <Linea>
        Suma <V>{fmtNum(g.suma_bruta, 2)}</V>
        {g.piso_aplicado ? (
          <span className="text-terminal-warn"> — menos de 10: setup inmaduro, vale 0</span>
        ) : (
          <> → <Formula>min(suma, 20)</Formula></>
        )}
      </Linea>
    </Seccion>
  )
}

const TEXTO_CAP = {
  gate_ema200: 'Gate Stage 2: precio ≤ EMA200 → tope 40',
  sin_52w: 'Sin distancia al máximo/mínimo de 52 semanas → tope 40',
  rechazo_confirmado: 'Vela de rechazo confirmada → tope 70',
}

function PanelDetalle({ fila, onCerrar }) {
  const p = fila.pilares ?? {}
  const pen = fila.penalizacion ?? { pts: 0, flags: [] }
  const suma = PILARES.reduce((acc, x) => acc + (p[x.key]?.pts ?? 0), 0) + (pen.pts ?? 0)
  return (
    <Modal
      onClose={onCerrar}
      etiqueta={`Warren Score de ${fila.ticker}`}
      overlayClassName="fixed inset-0 z-50 flex justify-end bg-black/60"
      className="flex h-full w-full max-w-lg flex-col overflow-y-auto border-l-2 border-terminal-border bg-terminal-panel"
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-terminal-border bg-terminal-panel px-4 py-3">
        <div className="min-w-0 flex-1">
          <TickerLink ticker={fila.ticker} className="font-semibold text-terminal-text" />
          <div className="truncate text-[11px] text-terminal-dim">{fila.nombre}</div>
        </div>
        <button
          type="button"
          onClick={onCerrar}
          aria-label="Cerrar detalle"
          className="rounded border border-terminal-border px-2 py-1 text-xs text-terminal-dim hover:text-terminal-text"
        >
          ✕
        </button>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-3 rounded-lg border border-terminal-border bg-terminal-panel2 p-3">
          <Anillo score={fila.total_score} tam={76} />
          <div className="flex min-w-0 flex-col gap-1 text-[11px] text-terminal-dim">
            <div className="flex flex-wrap gap-1">
              <BadgeStage stage={fila.stage} />
              <BadgeGates fila={fila} />
            </div>
            <div>
              <Formula>clamp(A + B + C + D + pen., 0, 100)</Formula> = <V>{fmtNum(Math.max(0, Math.min(100, suma)), 1)}</V>
              {fila.caps?.length ? <> → con topes <V>{fmtNum(fila.total_score, 1)}</V></> : null}
            </div>
            {fila.precio != null && (
              <div>
                Precio <V>{fmtNum(fila.precio, 2)}</V> · vs máx. 52s {fmtPct(fila.dist_max52_pct, { signo: true })}
              </div>
            )}
            {!fila.datos_suficientes && <div className="text-terminal-warn">Sin score total: {fila.motivo}.</div>}
          </div>
        </div>

        {p.tendencia && <DetalleTendencia t={p.tendencia} />}
        <DetalleFuerza f={p.fuerza} />
        {p.contraccion && <DetalleContraccion c={p.contraccion} />}
        {p.gatillo && <DetalleGatillo g={p.gatillo} />}

        <Seccion titulo="Penalizaciones y avisos" pts={null} max={null}>
          {pen.flags?.length ? (
            pen.flags.map((f) => (
              <Linea key={f.clave} pts={f.pts || null}>
                {f.emoji} {f.detalle}
              </Linea>
            ))
          ) : (
            <Linea>Ninguna regla activa.</Linea>
          )}
          <Linea pts={pen.pts}>
            Total (agotamiento 📉🪫🐘 con tope −14)
          </Linea>
        </Seccion>

        <Seccion titulo="Gates y topes" pts={null} max={null}>
          <Linea>
            Stage 2 (precio &gt; EMA200):{' '}
            {fila.gates?.ok ? <span className="text-terminal-up">cumple</span> : <span className="text-terminal-down">falla ({fila.gates?.fallas?.join(', ')})</span>}
          </Linea>
          <Linea>
            Stage {fila.stage?.n} — {fila.stage?.label}: {fila.stage?.tip}.
          </Linea>
          {fila.caps?.length ? (
            fila.caps.map((c) => <Linea key={c}>Tope aplicado: {TEXTO_CAP[c] ?? c}</Linea>)
          ) : (
            <Linea>Sin topes aplicados.</Linea>
          )}
        </Seccion>
        <p className="text-[11px] text-terminal-dim">
          Screener técnico/cuantitativo — no es recomendación de inversión ni analiza fundamentales.
        </p>
      </div>
    </Modal>
  )
}

export default function WarrenScore() {
  const { data, cargando, error } = useJson('warren_score.json')
  const { watchlist } = useWatchlist()
  const [filtroScore, setFiltroScore] = useState(0)
  const [sector, setSector] = useState('')
  const [busqueda, setBusqueda] = useState('')
  const [soloGates, setSoloGates] = useState(false)
  const [topN, setTopN] = useState(50)
  const [universo, setUniverso] = useState('todos')
  const [orden, setOrden] = useState({ campo: 'score', dir: 'desc' })
  const [seleccionado, setSeleccionado] = useState(null)

  const tickers = useMemo(() => (Array.isArray(data?.tickers) ? data.tickers : []), [data])
  const viejo = esFormatoViejo(tickers)
  const conDatos = useMemo(
    () => (viejo ? [] : tickers.filter((r) => r.datos_suficientes && r.total_score != null)),
    [tickers, viejo]
  )
  const excluidos = viejo ? 0 : tickers.length - conDatos.length
  const sectores = useMemo(() => [...new Set(conDatos.map((r) => r.sector).filter(Boolean))].sort(), [conDatos])
  const podio = useMemo(
    () => [...conDatos].sort((a, b) => compararValores(a.total_score, b.total_score, 'desc')).slice(0, 3),
    [conDatos]
  )

  const filtrados = useMemo(() => {
    let base = conDatos
    if (universo === 'watchlist') {
      const set = new Set((watchlist ?? []).map((w) => w.ticker))
      base = base.filter((r) => set.has(r.ticker))
    }
    const q = busqueda.trim().toLowerCase()
    base = base.filter(
      (r) =>
        r.total_score >= filtroScore &&
        (!sector || r.sector === sector) &&
        (!soloGates || r.gates?.ok) &&
        (!q || r.ticker.toLowerCase().includes(q) || (r.nombre ?? '').toLowerCase().includes(q))
    )
    const { campo, dir } = orden
    base = [...base].sort((a, b) => compararValores(valorOrden(a, campo), valorOrden(b, campo), dir))
    return topN > 0 ? base.slice(0, topN) : base
  }, [conDatos, universo, watchlist, busqueda, filtroScore, sector, soloGates, orden, topN])

  const ordenarPor = (campo) =>
    setOrden((prev) => (prev.campo === campo ? { campo, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { campo, dir: 'desc' }))

  const th = (campo, label, align = 'right', ayuda) => (
    <EncabezadoOrdenable
      label={label}
      ayuda={ayuda}
      align={align}
      activa={orden.campo === campo}
      dir={orden.dir}
      onClick={() => ordenarPor(campo)}
      className="whitespace-nowrap px-2 py-2.5 font-semibold"
    />
  )

  return (
    <div className="min-w-0">
      <div className="mb-3">
        <h1 className="text-lg font-bold text-terminal-text">Warren Score</h1>
        <p className="text-xs text-terminal-dim">
          Score técnico 0–100: tendencia, fuerza relativa vs SPY, contracción de volatilidad (VCP) y
          calidad del setup, menos penalizaciones.
        </p>
        {data?.actualizado && <p className="mt-1 text-[11px] text-terminal-dim">Actualizado: {fmtFecha(data.actualizado)}</p>}
      </div>

      <ExplicacionWarrenScore className="mb-4" />

      {cargando ? (
        <TablaSkeleton columnas={8} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : viejo ? (
        <div className="rounded-lg border border-terminal-warn/40 bg-terminal-warn/10 p-6 text-center text-sm text-terminal-text">
          Datos en formato viejo, se actualizan en la próxima corrida del pipeline.
        </div>
      ) : (
        <>
          {podio.length > 0 && (
            <section className="mb-4">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-terminal-dim">🏆 Podio del día</h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {podio.map((r, i) => (
                  <TarjetaPodio key={r.ticker} fila={r} puesto={i} onAbrir={setSeleccionado} />
                ))}
              </div>
            </section>
          )}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              type="search"
              className={`${inputCls} w-full sm:w-44`}
              placeholder="Buscar ticker o nombre"
              aria-label="Buscar ticker o nombre"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
            />
            <select className={selectCls} aria-label="Sector" value={sector} onChange={(e) => setSector(e.target.value)}>
              <option value="">Todos los sectores</option>
              {sectores.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select className={selectCls} aria-label="Score mínimo" value={filtroScore} onChange={(e) => setFiltroScore(Number(e.target.value))}>
              {OPCIONES_SCORE.map((o) => (
                <option key={o.valor} value={o.valor}>
                  Score {o.etiqueta}
                </option>
              ))}
            </select>
            <select className={selectCls} aria-label="Cantidad a mostrar" value={topN} onChange={(e) => setTopN(Number(e.target.value))}>
              {OPCIONES_TOP.map((o) => (
                <option key={o.valor} value={o.valor}>
                  {o.etiqueta}
                </option>
              ))}
            </select>
            {watchlist && watchlist.length > 0 && (
              <select className={selectCls} aria-label="Universo" value={universo} onChange={(e) => setUniverso(e.target.value)}>
                <option value="todos">Todos</option>
                <option value="watchlist">Mi lista</option>
              </select>
            )}
            <label className="flex items-center gap-1.5 text-xs text-terminal-dim">
              <input type="checkbox" checked={soloGates} onChange={(e) => setSoloGates(e.target.checked)} />
              Solo gates OK
            </label>
            <span className="text-xs text-terminal-dim sm:ml-auto">
              {filtrados.length} de {conDatos.length}
              {excluidos > 0 && ` · ${excluidos} sin score (no USD o historia corta)`}
            </span>
          </div>

          {filtrados.length === 0 ? (
            <Vacio texto="Ningún ticker cumple los filtros elegidos." />
          ) : (
            <div className="max-h-[75vh] overflow-auto rounded-lg border border-terminal-border">
              <table className="min-w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                    <th className="px-2 py-2.5 text-right font-semibold">#</th>
                    {th('ticker', 'Ticker', 'left')}
                    {th('score', 'Score')}
                    {th('stage', 'Stage', 'left', 'Stage de Weinstein según precio vs EMA200 y pendiente de la EMA200')}
                    {PILARES.map((p) => (
                      <EncabezadoOrdenable
                        key={p.key}
                        label={`${p.corto} /${p.max}`}
                        align="left"
                        activa={orden.campo === p.key}
                        dir={orden.dir}
                        onClick={() => ordenarPor(p.key)}
                        className="whitespace-nowrap px-2 py-2.5 font-semibold"
                      />
                    ))}
                    {th('pen', 'Penal.', 'left', 'Suma de penalizaciones; pasá el mouse por cada emoji para ver la regla')}
                    {th('rs', 'RS', 'right', 'Percentil de fuerza relativa vs SPY en el universo USD')}
                    {th('max52', 'vs máx 52s')}
                  </tr>
                </thead>
                <tbody>
                  {filtrados.map((r, i) => (
                    <tr
                      key={r.ticker}
                      onClick={() => setSeleccionado(r)}
                      // Accesible con teclado: Tab llega a la fila, Enter/Espacio abre el detalle.
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSeleccionado(r)
                        }
                      }}
                      className="cursor-pointer border-t border-terminal-border transition-colors hover:bg-terminal-panel2/60 focus:bg-terminal-panel2/60 focus:outline-none"
                    >
                      <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{i + 1}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold">
                        <TickerLink ticker={r.ticker} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right tabular font-bold" style={{ color: colorScore(r.total_score) }}>
                        {fmtNum(r.total_score, 1)}
                        {!r.gates?.ok && (
                          <span className="ml-1 text-[9px] font-semibold text-terminal-down" title="Precio ≤ EMA200: score topeado en 40">
                            CAP
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <span
                          className="text-xs font-semibold"
                          style={{ color: COLOR_STAGE[r.stage?.n] }}
                          title={r.stage ? `${r.stage.label}: ${r.stage.tip}` : undefined}
                        >
                          S{r.stage?.n}
                        </span>
                      </td>
                      {PILARES.map((p) => (
                        <td key={p.key} className="px-2 py-1.5">
                          <MiniBarra pts={r.pilares?.[p.key]?.pts} max={p.max} />
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-2 py-1.5 text-xs">
                        <span className={`tabular ${r.penalizacion?.pts < 0 ? 'text-terminal-down' : 'text-terminal-dim'}`}>
                          {r.penalizacion?.pts < 0 ? fmtNum(r.penalizacion.pts, 0) : '0'}
                        </span>{' '}
                        <Banderas flags={r.penalizacion?.flags} />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular">{fmtNum(r.pilares?.fuerza?.rs, 0)}</td>
                      <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{fmtPct(r.dist_max52_pct, { signo: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <p className="mt-3 text-[11px] text-terminal-dim">
        Screener puramente técnico/cuantitativo — no analiza PER, ingresos, deuda ni flujo de caja.
        Orientativo, no es recomendación de inversión.
      </p>

      {seleccionado && <PanelDetalle fila={seleccionado} onCerrar={() => setSeleccionado(null)} />}
    </div>
  )
}
