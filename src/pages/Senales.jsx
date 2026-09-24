import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useJson, useMeta } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { fmtFecha, fmtNum, fmtPct, fmtPrecio } from '../lib/formato'
import { compararValores } from '../lib/ordenar'
import { selectCls } from '../lib/estilos'
import { PANELES, ESTADOS_VCP, COLOR_ESTADO_VCP, fmtHace, fmtUltimaVez } from '../lib/senales'
import Tabla from '../components/Tabla'
import TickerLink from '../components/TickerLink'
import ComoSeCalcula, { Formula } from '../components/ComoSeCalcula'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'

// Señales: paneles tipo "Warren Bife" armados por el pipeline en
// public/data/senales.json (EMA200 rebote/cruce, bases VCP, RSI semanal) mas
// la Cartelera del día, que sale de listado.json en el navegador. Los
// umbrales de las explicaciones son los de scripts/generar_datos.py
// (SEN_* / VCP_*): si se toca uno alla, tocarlo aca.

const COLOR = { rojo: '239, 68, 68', ambar: '245, 165, 36', verde: '34, 197, 94', azul: '56, 189, 248' }

function Pastilla({ children, color, title }) {
  return (
    <span
      className="inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-semibold tabular"
      style={{ backgroundColor: `rgba(${COLOR[color]}, 0.18)`, color: `rgb(${COLOR[color]})` }}
      title={title}
    >
      {children}
    </span>
  )
}

function Panel({ panel, subtitulo, acciones, children }) {
  return (
    <section id={panel.id} className="mb-5 min-w-0 scroll-mt-20 rounded-lg border border-terminal-border bg-terminal-panel p-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-terminal-text">{panel.titulo}</h2>
          {subtitulo && <p className="text-[11px] text-terminal-dim">{subtitulo}</p>}
        </div>
        {acciones}
      </div>
      {children}
    </section>
  )
}

function Pestanas({ opciones, valor, onChange }) {
  return (
    <div role="tablist" className="mb-2 flex flex-wrap gap-1">
      {opciones.map((o) => (
        <button
          key={o.valor}
          type="button"
          role="tab"
          aria-selected={valor === o.valor}
          onClick={() => onChange(o.valor)}
          className={`rounded border px-2.5 py-1 text-xs ${
            valor === o.valor
              ? 'border-terminal-accent bg-terminal-accent/10 font-semibold text-terminal-accent'
              : 'border-terminal-border text-terminal-dim hover:text-terminal-text'
          }`}
        >
          {o.label} <span className="tabular text-terminal-dim">({o.n})</span>
        </button>
      ))}
    </div>
  )
}

// Pestaña inicial: la de la URL si el link apunta a este panel.
function usePestana(panelId, opciones, defecto) {
  const [params] = useSearchParams()
  const pedida = params.get('panel') === panelId ? params.get('tab') : null
  const [tab, setTab] = useState(opciones.includes(pedida) ? pedida : defecto)
  useEffect(() => {
    if (opciones.includes(pedida)) setTab(pedida)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pedida])
  return [tab, setTab]
}

const fmtRS = (v) => (v == null ? '—' : fmtNum(v, 0))

// ---------------------------------------------------------------------------
// Cartelera del día (client-side, listado.json)
// ---------------------------------------------------------------------------
function MiniTabla({ titulo, filas, campo, render }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-terminal-border">
      <div className="border-b border-terminal-border bg-terminal-panel2 px-2.5 py-1.5 text-xs font-semibold text-terminal-text">
        {titulo}
      </div>
      {filas.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-terminal-dim">Sin datos.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <tbody>
            {filas.map((f, i) => (
              <tr key={f.ticker} className="border-t border-terminal-border first:border-t-0">
                <td className="w-5 px-2 py-1 text-right tabular text-[11px] text-terminal-dim">{i + 1}</td>
                <td className="max-w-0 px-1 py-1">
                  <TickerLink ticker={f.ticker} className="font-semibold" />
                  <div className="truncate text-[10px] text-terminal-dim">{f.nombre}</div>
                </td>
                <td className="whitespace-nowrap px-2 py-1 text-right" title={`${campo === 'rsi' ? 'RSI14' : 'Var. del día'}: ${fmtNum(f[campo], 2)}`}>
                  {render(f)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function Cartelera() {
  const { data, cargando, error } = useJson('listado.json')
  const meta = useMeta()
  const tops = useMemo(() => {
    // Sin stale ni especies sin operar: sin promedio de volumen de 20 ruedas
    // (CEDEARs ilíquidos con el precio clavado) el RSI da 100 / 0 y la var. 0.
    const filas = (Array.isArray(data?.acciones) ? data.acciones : []).filter((f) => !f.stale && f.vol_prom20 > 0)
    const top = (campo, dir) =>
      filas
        .filter((f) => f[campo] != null)
        .sort((a, b) => compararValores(a[campo], b[campo], dir) || a.ticker.localeCompare(b.ticker))
        .slice(0, 5)
    return {
      ganadores: top('var_pct', 'desc'),
      perdedores: top('var_pct', 'asc'),
      sobrecomprados: top('rsi', 'desc'),
      sobrevendidos: top('rsi', 'asc'),
      n: filas.length,
    }
  }, [data])

  return (
    <Panel
      panel={PANELES.cartelera}
      subtitulo={`Top 5 del universo (${tops.n} tickers con dato fresco y volumen) · foto de la corrida del ${meta ? fmtFecha(meta.ultima_actualizacion) : '—'}`}
    >
      {cargando ? (
        <TablaSkeleton columnas={4} filas={5} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <MiniTabla
            titulo="🟢 Top Ganadores"
            filas={tops.ganadores}
            campo="var_pct"
            render={(f) => <Pastilla color={f.var_pct >= 0 ? 'verde' : 'rojo'}>{fmtPct(f.var_pct, { signo: true })}</Pastilla>}
          />
          <MiniTabla
            titulo="🔴 Top Perdedores"
            filas={tops.perdedores}
            campo="var_pct"
            render={(f) => <Pastilla color={f.var_pct >= 0 ? 'verde' : 'rojo'}>{fmtPct(f.var_pct, { signo: true })}</Pastilla>}
          />
          <MiniTabla
            titulo="🟠 Sobrecomprados"
            filas={tops.sobrecomprados}
            campo="rsi"
            render={(f) => <Pastilla color={f.rsi > 70 ? 'rojo' : 'ambar'}>RSI {fmtNum(f.rsi, 1)}</Pastilla>}
          />
          <MiniTabla
            titulo="🔵 Sobrevendidos"
            filas={tops.sobrevendidos}
            campo="rsi"
            render={(f) => <Pastilla color={f.rsi < 30 ? 'azul' : 'ambar'}>RSI {fmtNum(f.rsi, 1)}</Pastilla>}
          />
        </div>
      )}
      <ComoSeCalcula className="mt-2">
        <p>
          Sale de <Formula>listado.json</Formula> (misma corrida que el Listado), sin las filas
          arrastradas de corridas viejas (stale) y sin las especies que no operaron (sin promedio de volumen de
          20 ruedas: un CEDEAR ilíquido con el precio clavado da RSI 100 o 0 sin significar nada). Ganadores / perdedores: los 5 con mayor / menor{' '}
          <Formula>var % = (cierre hoy / cierre anterior − 1) × 100</Formula>. Sobrecomprados /
          sobrevendidos: los 5 con mayor / menor <Formula>RSI14</Formula> (Wilder, diario).
        </p>
        <p>
          Colores: RSI en rojo si &gt; 70 (sobrecompra clásica), en azul si &lt; 30 (sobreventa), ámbar
          en el medio — el top 5 puede no llegar a esos extremos en un día tranquilo. Si el mercado
          está abierto, el “cierre hoy” es el último precio de la corrida.
        </p>
      </ComoSeCalcula>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// EMA200 rebote / cruce (diaria y semanal)
// ---------------------------------------------------------------------------
function PanelEma({ panel, datos, semanal }) {
  const [tab, setTab] = usePestana(panel.id, ['rebote', 'cruce'], 'rebote')
  const [rsMin, setRsMin] = useState(0)
  const filas = useMemo(() => {
    const base = datos?.[tab] ?? []
    return rsMin > 0 ? base.filter((f) => f.rs_hoy != null && f.rs_hoy >= rsMin) : base
  }, [datos, tab, rsMin])
  const { filtradas, sortKey, sortDir, ordenar } = useTabla(filas, { ordenInicial: { key: 'rs', dir: 'desc' } })
  const vela = semanal ? 'semana' : 'rueda'
  const velas = semanal ? 'semanas' : 'ruedas'
  const tramo = semanal ? 10 : 20
  const reciente = semanal ? 4 : 10

  const columnas = useMemo(
    () => [
      { key: 'ticker', label: 'Ticker', valor: (r) => r.ticker, render: (r) => <TickerLink ticker={r.ticker} className="font-semibold" title={r.nombre} /> },
      {
        key: 'hace',
        label: 'Contacto',
        align: 'right',
        ayuda: `Hace cuánto fue el contacto (0 = la ${vela} actual)`,
        valor: (r) => r.hace,
        render: (r) => (
          <span title={`Contacto del ${r.fecha} · EMA200 ${fmtPrecio(r.ema)} · hoy ${fmtPct(r.dist_ema_pct, { signo: true })} sobre la EMA`}>
            {fmtHace(r.hace, semanal)}
          </span>
        ),
      },
      {
        key: 'climax',
        label: 'Clímax',
        align: 'right',
        ayuda: 'Vela de mayor volumen alrededor del contacto, en veces el volumen promedio de 20 velas',
        valor: (r) => r.climax_ratio,
        render: (r) =>
          r.climax_ratio == null ? (
            '—'
          ) : (
            <span
              className={r.climax_ola ? 'font-semibold text-terminal-info' : ''}
              title={`${r.climax_fecha}: ${fmtNum(r.climax_ratio, 2)}× el volumen promedio, cierre en el ${fmtNum(r.climax_pos_pct, 0)}% de su rango`}
            >
              {r.climax_ola ? '🌊 ' : ''}×{fmtNum(r.climax_ratio, 1)}
            </span>
          ),
      },
      {
        key: 'rs',
        label: 'RS',
        align: 'right',
        ayuda: 'RS Score (percentil vs SPY en el universo USD) a la fecha del contacto → hoy',
        valor: (r) => r.rs_hoy,
        render: (r) => {
          const sube = r.rs_hoy != null && r.rs_contacto != null && r.rs_hoy > r.rs_contacto
          const baja = r.rs_hoy != null && r.rs_contacto != null && r.rs_hoy < r.rs_contacto
          return (
            <span className={`whitespace-nowrap ${sube ? 'text-terminal-up' : baja ? 'text-terminal-down' : 'text-terminal-dim'}`}>
              {fmtRS(r.rs_contacto)} → <b>{fmtRS(r.rs_hoy)}</b>
            </span>
          )
        },
      },
      {
        key: 'ultima',
        label: 'Última vez',
        align: 'right',
        ayuda: 'Tiempo desde el contacto anterior (mismo criterio) antes de este',
        valor: (r) => r.ultima_vez_dias,
        render: (r) => <span className="text-terminal-dim">{fmtUltimaVez(r.ultima_vez_dias)}</span>,
      },
    ],
    [semanal, vela],
  )

  return (
    <Panel
      panel={panel}
      subtitulo={
        semanal
          ? 'Mismo mecanismo que el diario, pero sobre la media de ~4 años: un nivel mucho más raro de tocar.'
          : `Contactos con la EMA200 diaria en las últimas ${reciente} ruedas, con el precio todavía arriba.`
      }
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Pestanas
          valor={tab}
          onChange={setTab}
          opciones={[
            { valor: 'rebote', label: '🔄 Rebote', n: datos?.rebote?.length ?? 0 },
            { valor: 'cruce', label: '🚀 Cruce al alza', n: datos?.cruce?.length ?? 0 },
          ]}
        />
        <label className="flex items-center gap-2 text-xs text-terminal-dim">
          RS mín hoy
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={rsMin}
            onChange={(e) => setRsMin(Number(e.target.value))}
            className="w-28 accent-[#f5a524]"
            aria-label="RS mínimo hoy"
          />
          <span className="w-6 tabular text-terminal-text">{rsMin}</span>
        </label>
      </div>
      {filtradas.length === 0 ? (
        <Vacio texto={rsMin > 0 ? `Ningún ${tab === 'rebote' ? 'rebote' : 'cruce'} con RS ≥ ${rsMin}.` : `Sin ${tab === 'rebote' ? 'rebotes' : 'cruces'} en las últimas ${reciente} ${velas}.`} />
      ) : (
        <Tabla columnas={columnas} filas={filtradas} sortKey={sortKey} sortDir={sortDir} onSort={ordenar} />
      )}
      <p className="mt-2 text-[11px] text-terminal-dim">
        <b className="text-terminal-text">Clímax</b>: la {vela} de mayor volumen entre 2 {velas} antes y 2
        después del contacto, en veces (×) el volumen promedio de las 20 {velas} anteriores a ella.{' '}
        <b className="text-terminal-text">🌊</b> = ese clímax cerró en el 40% superior de su rango (posición ≥
        60%) con volumen ≥ 1,5×: alguien compró fuerte justo en la media.
      </p>
      <ComoSeCalcula className="mt-2">
        {semanal ? (
          <p>
            Velas semanales armadas desde el diario de 5 años (cierre del viernes, <Formula>W-FRI</Formula>:
            apertura del primer día, máximo, mínimo, cierre del último día, volumen sumado). La última vela
            es la semana <b>en curso</b> (parcial). <Formula>EMA200 semanal</Formula> sobre los cierres
            semanales (≈ 4 años); con menos de 200 semanas se calcula con lo disponible si hay ≥ 150
            (promedio exponencial ponderado de lo que hay), con menos se saltea el ticker.
          </p>
        ) : (
          <p>
            <Formula>EMA200</Formula> diaria sobre los cierres de 5 años (la misma del Warren Score).
            Hace falta un mínimo de 250 ruedas.
          </p>
        )}
        <p>
          <b className="text-terminal-text">🔄 Rebote</b> en la {vela} i:{' '}
          <Formula>mínimo(i) ≤ EMA(i) × 1,01</Formula> y <Formula>cierre(i) &gt; EMA(i)</Formula>, con ≥ 80%
          de los cierres de las {tramo} {velas} anteriores arriba de la EMA (venía arriba en forma
          sostenida y bajó a tocarla).
        </p>
        <p>
          <b className="text-terminal-text">🚀 Cruce al alza</b> en la {vela} i:{' '}
          <Formula>cierre(i) &gt; EMA(i)</Formula> y <Formula>cierre(i−1) ≤ EMA(i−1)</Formula>, con ≥ 80% de
          los cierres de las {tramo} {velas} anteriores abajo de la EMA.
        </p>
        <p>
          Solo cuenta el contacto más reciente dentro de las últimas {reciente} {velas} y solo si{' '}
          <b>hoy</b> el cierre sigue arriba de la EMA200.{' '}
          <b className="text-terminal-text">RS</b> = percentil de fuerza relativa vs SPY dentro del
          universo USD (el del Warren Score), a la fecha del contacto (se calcula en cada una de las
          últimas 10 ruedas y cada 5 ruedas hasta ~6 meses, se toma el más cercano) → hoy; “—” si no
          cotiza en USD. <b className="text-terminal-text">Última vez</b> = tiempo desde el contacto
          anterior del mismo tipo (para el rebote, anterior al tramo de {tramo} {velas} que precedió a
          este); “—” si no hubo en la historia disponible (5 años menos {semanal ? '150 semanas' : '200 ruedas'} de
          calentamiento de la media).
        </p>
      </ComoSeCalcula>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Bases VCP
// ---------------------------------------------------------------------------
function PanelVcp({ filasVcp }) {
  const [estado, setEstado] = useState('')
  const filas = useMemo(() => (estado ? filasVcp.filter((f) => f.estado === estado) : filasVcp), [filasVcp, estado])
  const { filtradas, sortKey, sortDir, ordenar } = useTabla(filas, { ordenInicial: { key: 'score', dir: 'desc' } })
  const conteo = useMemo(() => {
    const c = {}
    for (const f of filasVcp) c[f.estado] = (c[f.estado] ?? 0) + 1
    return c
  }, [filasVcp])

  const columnas = useMemo(
    () => [
      { key: 'ticker', label: 'Ticker', valor: (r) => r.ticker, render: (r) => <TickerLink ticker={r.ticker} className="font-semibold" title={r.nombre} /> },
      { key: 'score', label: 'VCP', align: 'right', ayuda: 'VCP Score 0-100', valor: (r) => r.score, render: (r) => <b className="text-terminal-text">{fmtNum(r.score, 0)}</b> },
      {
        key: 'contracciones',
        label: 'Contr.',
        align: 'right',
        ayuda: 'Contracciones decrecientes seguidas',
        valor: (r) => r.contracciones,
        render: (r) => (
          <span title={r.profundidades?.length ? `Profundidades: ${r.profundidades.map((p) => `${fmtNum(p, 1)}%`).join(' → ')}` : undefined}>
            {r.contracciones}
          </span>
        ),
      },
      {
        key: 'dist',
        label: 'Dist. pivote',
        align: 'right',
        ayuda: 'Precio de hoy vs el pivote (techo de la base)',
        valor: (r) => r.dist_pivote_pct,
        render: (r) =>
          r.dist_pivote_pct == null ? '—' : (
            <Pastilla color={Math.abs(r.dist_pivote_pct) <= 3 ? 'verde' : 'azul'}>{fmtPct(r.dist_pivote_pct, { signo: true })}</Pastilla>
          ),
      },
      { key: 'pivote', label: 'Techo', align: 'right', ayuda: 'Pivote: máximo de la base', valor: (r) => r.pivote, render: (r) => fmtPrecio(r.pivote) },
      {
        key: 'vol',
        label: 'Vol↓',
        align: 'center',
        ayuda: 'La última contracción tuvo menos volumen promedio que la anterior',
        valor: (r) => (r.vol_decreciente ? 1 : 0),
        render: (r) => (r.vol_decreciente ? <span className="text-terminal-up">✓</span> : <span className="text-terminal-dim">—</span>),
      },
      {
        key: 'estado',
        label: 'Estado',
        valor: (r) => ESTADOS_VCP.findIndex((e) => e.estado === r.estado),
        render: (r) => (
          <span className="whitespace-nowrap text-xs font-semibold" style={{ color: COLOR_ESTADO_VCP[r.estado] }}>
            {r.estado}
            {r.hace_ruptura != null && <span className="font-normal text-terminal-dim"> · {fmtHace(r.hace_ruptura)}</span>}
            {r.hace_base != null && <span className="font-normal text-terminal-dim"> · base de hace {fmtHace(r.hace_base)}</span>}
          </span>
        ),
      },
    ],
    [],
  )

  return (
    <Panel
      panel={PANELES.vcp}
      subtitulo={`${filasVcp.length} bases con VCP Score ≥60 · independiente del Warren Score`}
      acciones={
        <select className={selectCls} aria-label="Estado de la base" value={estado} onChange={(e) => setEstado(e.target.value)}>
          <option value="">Todos los estados</option>
          {ESTADOS_VCP.filter((e) => conteo[e.estado]).map((e) => (
            <option key={e.estado} value={e.estado}>
              {e.estado} ({conteo[e.estado]})
            </option>
          ))}
        </select>
      }
    >
      {filtradas.length === 0 ? (
        <Vacio texto="Ninguna base VCP con score ≥ 60 en este estado." />
      ) : (
        <Tabla columnas={columnas} filas={filtradas} sortKey={sortKey} sortDir={sortDir} onSort={ordenar} />
      )}
      <ComoSeCalcula className="mt-2">
        <p>
          <b className="text-terminal-text">Detección</b> (la misma del pilar C del Warren Score): ZigZag
          sobre máximos/mínimos de las últimas ~120 ruedas con umbral <Formula>max(3%, 1,5 × ATR14%)</Formula>.
          La base arranca en el máximo más alto (el <b>pivote</b> o techo); cada caída máximo → mínimo
          siguiente es una contracción. Hay VCP si las últimas ≥ 2 contracciones son cada una menos
          profunda que la anterior (10% de tolerancia), la última mide ≤ 12% y el precio está entre −10% y
          +2% del pivote. <Formula>score = 50 (2 contr.) / 70 (3) / 85 (4+) + lineal(última, 12%, 3%, 0, 10) + lineal(dist, −10%, −2%, 0, 5) + 5 si Vol↓</Formula>,
          tope 100. Se listan las de score ≥ 60, tengan o no Warren Score (incluye no-USD e historia corta).
        </p>
        <p>
          <b className="text-terminal-text">Estado</b>: para saber si una base ya rompió hay que mirarla
          como estaba antes (la ruptura hace un máximo nuevo y la base de hoy desaparece), así que se
          re-detecta el VCP cortando los datos en cada una de las últimas 15 ruedas. Ruptura = primera
          rueda con <Formula>cierre(b) &gt; pivote ≥ cierre(b−1)</Formula> de una base detectada al cierre
          de b−1. Con ruptura, en orden:
        </p>
        <ul className="ml-4 list-disc">
          <li>
            <span style={{ color: COLOR_ESTADO_VCP['Rompió y falló'] }}>Rompió y falló</span>: desde la ruptura
            algún cierre <Formula>&lt; pivote × 0,97</Formula>.
          </li>
          <li>
            <span style={{ color: COLOR_ESTADO_VCP['Recién rompió'] }}>Recién rompió</span>: ruptura en las
            últimas 3 ruedas (hoy, hace 1 o 2).
          </li>
          <li>
            <span style={{ color: COLOR_ESTADO_VCP['Rompió y confirmó'] }}>Rompió y confirmó</span>: ruptura de
            hace 3 a 15 ruedas, todos los cierres desde entonces ≥ pivote y seguimiento (máximo cierre ≥
            pivote × 1,03 o 2 cierres más altos que el de la ruptura).
          </li>
          <li>
            <span style={{ color: COLOR_ESTADO_VCP['Rompió sin confirmar'] }}>Rompió sin confirmar</span>:
            rompió hace 3-15 ruedas, no cayó más de 3% bajo el pivote pero tampoco cumple lo anterior.
          </li>
        </ul>
        <p>Sin ruptura:</p>
        <ul className="ml-4 list-disc">
          <li>
            <span style={{ color: COLOR_ESTADO_VCP.Armado }}>Armado</span>: VCP detectado hoy, última contracción
            ≤ 8% y precio entre −5% y 0% del pivote.
          </li>
          <li>
            <span style={{ color: COLOR_ESTADO_VCP['Formándose'] }}>Formándose</span>: VCP detectado hoy que no
            cumple lo de Armado (última contracción todavía ancha o lejos del pivote).
          </li>
          <li>
            <span style={{ color: COLOR_ESTADO_VCP['Falló antes de romper'] }}>Falló antes de romper</span>: hoy
            ya no hay VCP, pero lo había en las últimas 15 ruedas y un cierre posterior perforó el mínimo de
            su última contracción.
          </li>
        </ul>
        <p>
          En los estados que miran una base pasada, VCP / Contr. / Techo / Vol↓ son los de esa base y la
          distancia al pivote es con el precio de hoy.
        </p>
      </ComoSeCalcula>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// RSI semanal vs su SMA14
// ---------------------------------------------------------------------------
function PanelRsiSemanal({ datos }) {
  const [tab, setTab] = usePestana(PANELES.rsiSemanal.id, ['alcista', 'bajista'], 'alcista')
  // Orden por defecto (sortKey null): el del pipeline, cruce mas reciente y
  // despues RS descendente.
  const { filtradas, sortKey, sortDir, ordenar } = useTabla(datos?.[tab] ?? [])
  const columnas = useMemo(
    () => [
      { key: 'ticker', label: 'Ticker', valor: (r) => r.ticker, render: (r) => <TickerLink ticker={r.ticker} className="font-semibold" title={r.nombre} /> },
      { key: 'rsi', label: 'RSI', align: 'right', ayuda: 'RSI(14) semanal actual', valor: (r) => r.rsi, render: (r) => <b className="text-terminal-text">{fmtNum(r.rsi, 1)}</b> },
      { key: 'sma14', label: 'SMA14', align: 'right', ayuda: 'Media simple de 14 semanas del RSI (línea de señal)', valor: (r) => r.sma14, render: (r) => fmtNum(r.sma14, 1) },
      {
        key: 'hace',
        label: 'Cruzó hace',
        align: 'right',
        valor: (r) => r.hace,
        render: (r) => <span title={`Semana que cierra el ${r.fecha}`}>{r.hace === 0 ? 'esta semana' : `hace ${fmtHace(r.hace, true)}`}</span>,
      },
      { key: 'rs', label: 'RS', align: 'right', ayuda: 'RS Score hoy (percentil vs SPY, universo USD)', valor: (r) => r.rs, render: (r) => fmtRS(r.rs) },
    ],
    [],
  )
  return (
    <Panel panel={PANELES.rsiSemanal} subtitulo="Cruces del RSI semanal con su propia media (línea de señal), no con niveles fijos 30/70.">
      <Pestanas
        valor={tab}
        onChange={setTab}
        opciones={[
          { valor: 'alcista', label: '▲ Cruce alcista', n: datos?.alcista?.length ?? 0 },
          { valor: 'bajista', label: '▼ Cruce bajista', n: datos?.bajista?.length ?? 0 },
        ]}
      />
      {filtradas.length === 0 ? (
        <Vacio texto="Sin cruces en las últimas 3 semanas." />
      ) : (
        <Tabla columnas={columnas} filas={filtradas} sortKey={sortKey} sortDir={sortDir} onSort={ordenar} />
      )}
      <ComoSeCalcula className="mt-2">
        <p>
          Velas semanales (cierre del viernes) desde el diario de 5 años.{' '}
          <Formula>RSI(14)</Formula> de Wilder sobre los cierres semanales y{' '}
          <Formula>SMA14 = promedio simple de las últimas 14 lecturas del RSI</Formula>.
        </p>
        <p>
          <b className="text-terminal-text">▲ Cruce alcista</b> en la semana i:{' '}
          <Formula>RSI(i) &gt; SMA14(i)</Formula> y <Formula>RSI(i−1) ≤ SMA14(i−1)</Formula>;{' '}
          <b className="text-terminal-text">▼ bajista</b> al revés. Solo cuenta el cruce más reciente dentro
          de las últimas 3 semanas, así que el RSI de hoy está del lado del cruce.
        </p>
        <p>
          <b className="text-terminal-text">“Esta semana” es la semana en curso</b>: la última vela semanal
          incluye las ruedas de esta semana hasta la corrida, así que un cruce de esta semana todavía
          puede deshacerse antes del viernes. “Hace 1 / 2 semanas” son semanas ya cerradas. RSI y SMA14
          de la tabla son los valores actuales. Orden por defecto: cruce más reciente primero y después
          RS de mayor a menor (“—” = no cotiza en USD).
        </p>
      </ComoSeCalcula>
    </Panel>
  )
}

export default function Senales() {
  const { data, cargando, error, status } = useJson('senales.json')
  const [params] = useSearchParams()
  const panelPedido = params.get('panel')

  // Link desde la ficha del ticker: /senales?panel=<id>&tab=<tab>.
  useEffect(() => {
    if (!panelPedido || cargando) return
    const el = document.getElementById(panelPedido)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [panelPedido, cargando])

  return (
    <div className="min-w-0">
      <div className="mb-3">
        <h1 className="text-lg font-bold text-terminal-text">🎯 Señales</h1>
        <p className="text-xs text-terminal-dim">
          Rebotes y cruces de la EMA200 diaria y semanal, bases VCP y cruces del RSI semanal, más la
          cartelera del día. Técnico, orientativo — no es recomendación de inversión.
        </p>
        {data?.actualizado && <p className="mt-1 text-[11px] text-terminal-dim">Señales actualizadas: {fmtFecha(data.actualizado)}</p>}
      </div>

      <Cartelera />

      {cargando ? (
        <TablaSkeleton columnas={5} />
      ) : error ? (
        status === 404 ? (
          <Vacio texto="Todavía no hay senales.json: se genera en la próxima corrida del pipeline." />
        ) : (
          <MensajeError mensaje={error} />
        )
      ) : (
        <>
          <PanelEma panel={PANELES.emaDiaria} datos={data?.ema200?.diario} semanal={false} />
          <PanelEma panel={PANELES.emaSemanal} datos={data?.ema200?.semanal} semanal />
          <PanelVcp filasVcp={Array.isArray(data?.vcp) ? data.vcp : []} />
          <PanelRsiSemanal datos={data?.rsi_semanal} />
        </>
      )}
    </div>
  )
}
