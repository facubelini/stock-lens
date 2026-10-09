import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { entradaDesde, resumenClave, useCompraDesde } from '../lib/compraDesde'
import { fmtFecha, fmtFechaCorta, fmtNum, fmtPct } from '../lib/formato'
import { compararValores } from '../lib/ordenar'
import { inputCls, selectCls } from '../lib/estilos'
import TickerLink from '../components/TickerLink'
import EncabezadoOrdenable from '../components/EncabezadoOrdenable'
import DesdeCompra from '../components/DesdeCompra'
import ComoSeCalcula, { Formula } from '../components/ComoSeCalcula'
import { TablaEvidenciaMultiple } from '../components/BadgeEvidencia'
import { Banderas, MiniBarra, colorScore } from '../components/WarrenScoreVisual'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'

// Warren Score 2: variante que premia al LÍDER QUE RETROCEDIÓ en vez de al que
// está en máximos. Corre al lado del Warren Score original (que no se toca).
// El cálculo vive en scripts/pipeline/warren2.py — si se toca un umbral allá,
// tocarlo en el texto de "¿Cómo se calcula?" de acá.

const PILARES_WS2 = [
  { key: 'liderazgo', corto: 'Lider.', max: 44, ayuda: 'RS vs el universo USD (0-33) + aceleración del RS en el último mes (0-11)' },
  { key: 'tendencia', corto: 'Tend.', max: 17, ayuda: 'Pendiente de la EMA200 (0 → 0,15 %/día = 0 → 17)' },
  { key: 'timing', corto: 'Timing', max: 39, ayuda: 'Profundidad bajo el máximo de 52s (22) + RSI (11) + extensión sobre la SMA50 (6)' },
]
const BUCKETS = ['<40', '40-60', '60-70', '70-80', '≥80']
const OPCIONES_SCORE = [0, 80, 70, 60, 50].map((v) => ({ valor: v, etiqueta: v === 0 ? 'Todos' : `${v}+` }))
const OPCIONES_TOP = [
  { valor: 20, etiqueta: 'Top 20' },
  { valor: 50, etiqueta: 'Top 50' },
  { valor: 100, etiqueta: 'Top 100' },
  { valor: 0, etiqueta: 'Todos' },
]
const TEXTO_CAP = {
  gate_ema200: 'precio ≤ EMA200 (o sin 52s): tope 44',
  extendido: 'extensión > 8 ATR sobre la SMA50 o RSI > 80: tope 66',
}

function valorOrden(r, campo) {
  if (campo === 'score') return r.total_score
  if (campo === 'orig') return r.score_original
  if (campo === 'ticker') return r.ticker
  if (campo === 'rs') return r.rs_score
  if (campo === 'max52') return r.dist_max52_pct
  if (campo === 'pen') return r.penalizacion?.pts
  if (PILARES_WS2.some((p) => p.key === campo)) return r.pilares?.[campo]?.pts
  return null
}

// Seguimiento en vivo lado a lado: ¿qué hicieron los tickers que cada versión
// marcó en zona alta desde el día que entraron?
function PanelComparacion({ claves }) {
  const filas = [
    { etiqueta: 'Original ≥70', clave: 'warren_70' },
    { etiqueta: 'WS2 ≥70', clave: 'warren2_70' },
    { etiqueta: 'Original ≥80', clave: 'warren_80' },
    { etiqueta: 'WS2 ≥80', clave: 'warren2_80' },
  ].map((f) => ({ ...f, r: resumenClave(claves, f.clave) }))
  if (filas.every((f) => !f.r)) return null
  const inicio = filas.find((f) => f.r?.inicio)?.r.inicio
  return (
    <details className="mb-3 rounded-lg border border-terminal-border bg-terminal-panel" open>
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-terminal-text">
        ⚖️ Seguimiento en vivo: original vs. WS2
        {inicio && <span className="ml-2 font-normal text-terminal-dim">· registro desde el {fmtFechaCorta(inicio)}</span>}
      </summary>
      <div className="border-t border-terminal-border p-2.5">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-left uppercase tracking-wide text-terminal-dim">
              <th className="px-1.5 py-1 font-semibold">Zona</th>
              <th className="px-1.5 py-1 text-right font-semibold">Tickers hoy</th>
              <th className="px-1.5 py-1 text-right font-semibold">Retorno prom. desde la entrada</th>
              <th className="px-1.5 py-1 text-right font-semibold">Mediana</th>
              <th className="px-1.5 py-1 text-right font-semibold">Ganadoras</th>
            </tr>
          </thead>
          <tbody>
            {filas.map(({ etiqueta, r }) => (
              <tr key={etiqueta} className={`border-t border-terminal-border ${etiqueta.startsWith('WS2') ? 'text-terminal-text' : 'text-terminal-dim'}`}>
                <td className="px-1.5 py-1 font-semibold">{etiqueta}</td>
                <td className="px-1.5 py-1 text-right tabular">{r?.n ?? '—'}</td>
                <td className="px-1.5 py-1 text-right tabular">{r?.promedio != null ? fmtPct(r.promedio, { signo: true }) : '—'}</td>
                <td className="px-1.5 py-1 text-right tabular">{r?.mediana != null ? fmtPct(r.mediana, { signo: true }) : '—'}</td>
                <td className="px-1.5 py-1 text-right tabular">{r?.conRetorno ? `${r.positivas} de ${r.conRetorno}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] leading-relaxed text-terminal-dim">
          Retorno = variación del precio desde el cierre del día en que el ticker entró a esa zona (sin cortes) hasta hoy.
          Solo cuenta a los que están en la zona <i>hoy</i>: los que ya salieron no figuran, así que mirá la tendencia con
          unas semanas de datos, no un día suelto. Con pocos tickers (sobre todo en ≥80) un solo caso mueve todo el promedio.
        </p>
      </div>
    </details>
  )
}

function ZonaAlta({ claves, ticker }) {
  const e80 = entradaDesde(claves, 'warren2_80', ticker)
  const e70 = entradaDesde(claves, 'warren2_70', ticker)
  const entrada = e80 ?? e70
  if (!entrada) return <span className="text-terminal-dim">—</span>
  return (
    <span className="inline-flex items-center justify-end gap-1">
      <span className="text-[10px] font-semibold text-terminal-dim">{e80 ? '≥80' : '≥70'}</span>
      <DesdeCompra entrada={entrada} />
    </span>
  )
}

export default function WarrenScore2() {
  const { data, cargando, error } = useJson('warren_score2.json')
  const claves = useCompraDesde()
  const [filtroScore, setFiltroScore] = useState(0)
  const [sector, setSector] = useState('')
  const [busqueda, setBusqueda] = useState('')
  const [topN, setTopN] = useState(50)
  const [orden, setOrden] = useState({ campo: 'score', dir: 'desc' })

  const conDatos = useMemo(
    () => (Array.isArray(data?.tickers) ? data.tickers : []).filter((r) => r.datos_suficientes && r.total_score != null),
    [data],
  )
  const sectores = useMemo(() => [...new Set(conDatos.map((r) => r.sector).filter(Boolean))].sort(), [conDatos])

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    const base = conDatos.filter(
      (r) =>
        r.total_score >= filtroScore &&
        (!sector || r.sector === sector) &&
        (!q || r.ticker.toLowerCase().includes(q) || (r.nombre ?? '').toLowerCase().includes(q)),
    )
    const { campo, dir } = orden
    const ordenado = [...base].sort((a, b) => compararValores(valorOrden(a, campo), valorOrden(b, campo), dir))
    return topN > 0 ? ordenado.slice(0, topN) : ordenado
  }, [conDatos, filtroScore, sector, busqueda, orden, topN])

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
        <h1 className="text-lg font-bold text-terminal-text">Warren Score 2</h1>
        <p className="max-w-3xl text-xs text-terminal-dim">
          Variante del{' '}
          <a href="#/warren-score" className="text-terminal-accent hover:underline">
            Warren Score
          </a>{' '}
          que premia al <b className="text-terminal-text">líder que retrocedió</b> (fuerza relativa alta, tendencia sana, precio
          lejos de máximos y sin sobrecompra) en vez del que ya está en máximos. El original queda tal cual; esta pantalla es
          para compararlos. Técnico, orientativo, no es recomendación de inversión.
        </p>
        {data?.actualizado && <p className="mt-1 text-[11px] text-terminal-dim">Actualizado: {fmtFecha(data.actualizado)}</p>}
      </div>

      <PanelComparacion claves={claves} />

      <ComoSeCalcula titulo="¿Cómo se calcula el Warren Score 2?">
        <p>
          <Formula>score = Liderazgo/44 + Tendencia/17 + Timing/39 + penalizaciones</Formula>, acotado a 0-100 y con topes.
        </p>
        <p>
          <b className="text-terminal-text">Liderazgo (44)</b>: <Formula>RS 50→95 = 0→33</Formula> (percentil de fuerza
          relativa vs SPY en el universo USD) + <Formula>aceleración: RS hoy − máx(RS hace 1 mes, 40), 0→20 = 0→11</Formula>.
        </p>
        <p>
          <b className="text-terminal-text">Tendencia (17)</b>: pendiente diaria promedio de la EMA200 en 20 ruedas,{' '}
          <Formula>0→0,15% = 0→17</Formula>.
        </p>
        <p>
          <b className="text-terminal-text">Timing (39)</b>: <Formula>profundidad</Formula> bajo el máximo de 52 semanas
          (máximo entre −25% y −8%, cae a 0 en −3% y en −40%) = hasta 22 · <Formula>RSI14</Formula> (máximo entre 35 y 55, 0
          en 25 y en 68) = hasta 11 · <Formula>extensión</Formula> sobre la SMA50 en ATR (máximo entre −2 y +1,5, 0 en −5 y
          en +5) = hasta 6.
        </p>
        <p>
          <b className="text-terminal-text">Penalizaciones</b>: las del Warren Score original (🩸 distribución, ⛔ breakout
          fallido, 💥, 🐘, divergencias…) <i>menos</i> la de sobreextensión (ya la cubre el Timing), con piso en −22.{' '}
          <b className="text-terminal-text">Topes</b>: precio ≤ EMA200 → 44; extensión &gt; 8 ATR o RSI &gt; 80 → 66.
        </p>
        <p>
          <b className="text-terminal-text">Por qué existe</b>: en el backtest de 5 años del propio Warren Score, el score
          original casi no se correlacionaba con el retorno posterior y los scores altos (≥80) rendían igual o peor que los
          medios: premiaba lo que ya subió. Lo que sí se repitió en las dos mitades del período: los líderes que retrocedieron
          rinden más que los que están en máximos, y una base VCP ≥60 entre líderes rinde <i>peor</i>. Por eso WS2 no puntúa
          el VCP ni la contracción de volatilidad.
        </p>
        <p>
          <b className="text-terminal-warn">Ojo</b>: esos hallazgos salen del mismo período con el que se diseñó WS2 (en
          muestra) y el universo es tu lista actual (sesgo de supervivencia): es una hipótesis. La prueba real es el
          seguimiento en vivo de arriba y el backtest mensual de abajo, donde WS2 y el original se miden sobre las mismas
          fechas. Ninguno de los dos garantiza nada.
        </p>
      </ComoSeCalcula>

      <TablaEvidenciaMultiple ruta={['warren2_bucket']} etiquetas={BUCKETS} horizonte={20} señalVivo={null} titulo="nivel de Warren Score 2" />
      <TablaEvidenciaMultiple ruta={['warren_bucket']} etiquetas={BUCKETS} horizonte={20} señalVivo={null} titulo="nivel de Warren Score (original)" />

      {cargando ? (
        <TablaSkeleton columnas={8} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : (
        <>
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
            <span className="text-xs text-terminal-dim sm:ml-auto">
              {filtrados.length} de {conDatos.length}
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
                    {th('score', 'WS2', 'right', 'Warren Score 2 (0-100)')}
                    {th('orig', 'Orig.', 'right', 'Warren Score original del mismo ticker, para comparar')}
                    {PILARES_WS2.map((p) => (
                      <EncabezadoOrdenable
                        key={p.key}
                        label={`${p.corto} /${p.max}`}
                        ayuda={p.ayuda}
                        align="left"
                        activa={orden.campo === p.key}
                        dir={orden.dir}
                        onClick={() => ordenarPor(p.key)}
                        className="whitespace-nowrap px-2 py-2.5 font-semibold"
                      />
                    ))}
                    {th('pen', 'Penal.', 'left', 'Penalizaciones del original sin la de sobreextensión; pasá el mouse por cada emoji')}
                    {th('rs', 'RS', 'right', 'Percentil de fuerza relativa vs SPY en el universo USD')}
                    {th('max52', 'vs máx 52s', 'right', 'Distancia al máximo de 52 semanas: WS2 premia −8% a −25%')}
                    <th
                      className="whitespace-nowrap px-2 py-2.5 text-right font-semibold"
                      title="Desde cuándo el WS2 viene en zona alta (≥80, o ≥70 si no llega) sin bajar de ahí, y variación del precio desde ese cierre. “≥” = al menos desde el inicio del registro."
                    >
                      Zona alta desde
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtrados.map((r, i) => (
                    <tr key={r.ticker} className="border-t border-terminal-border hover:bg-terminal-panel2/60">
                      <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{i + 1}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold">
                        <TickerLink ticker={r.ticker} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right tabular font-bold" style={{ color: colorScore(r.total_score) }}>
                        {fmtNum(r.total_score, 1)}
                        {r.caps?.map((c) => (
                          <span key={c} className="ml-1 text-[9px] font-semibold text-terminal-warn" title={TEXTO_CAP[c] ?? c}>
                            CAP
                          </span>
                        ))}
                      </td>
                      <td
                        className="px-2 py-1.5 text-right tabular text-terminal-dim"
                        title={r.rank_original ? `Puesto #${r.rank_original} en el original` : undefined}
                      >
                        {fmtNum(r.score_original, 1)}
                      </td>
                      {PILARES_WS2.map((p) => (
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
                      <td className="px-2 py-1.5 text-right tabular">{fmtNum(r.rs_score, 0)}</td>
                      <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{fmtPct(r.dist_max52_pct, { signo: true })}</td>
                      <td className="px-2 py-1.5 text-right text-xs">
                        <ZonaAlta claves={claves} ticker={r.ticker} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <p className="mt-3 text-[11px] text-terminal-dim">
        Screener técnico/cuantitativo — no analiza fundamentales. Orientativo, no es recomendación de inversión.
      </p>
    </div>
  )
}
