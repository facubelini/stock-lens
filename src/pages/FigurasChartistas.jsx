import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { fmtFecha, fmtNum, fmtPct, fmtPrecio } from '../lib/formato'
import { TIPOS_FIGURAS, NOMBRE_TIPO, ESTADOS_FIGURAS, COLOR_ESTADO_FIGURA, fmtHace } from '../lib/figuras'
import Tabla from '../components/Tabla'
import TickerLink from '../components/TickerLink'
import ComoSeCalcula, { Formula } from '../components/ComoSeCalcula'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { TablaEvidenciaMultiple } from '../components/BadgeEvidencia'

// Figuras Chartistas: doble techo/piso y Hombro-Cabeza-Hombro (HCH) / HCH
// invertido, detectados por scripts/pipeline/figuras.py sobre la MISMA
// secuencia de swings (ws_zigzag) que usa el VCP de la pagina Señales — pero
// es una feature INDEPENDIENTE, no entra al Warren Score. Los umbrales de la
// explicación son los de figuras.py (FG_*): si se toca uno allá, tocarlo acá.

function Pestanas({ opciones, valor, onChange }) {
  return (
    <div role="tablist" className="mb-3 flex flex-wrap gap-1">
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

function EstadoBadge({ estado, hace }) {
  return (
    <span className="whitespace-nowrap text-xs font-semibold" style={{ color: COLOR_ESTADO_FIGURA[estado] }}>
      {estado}
      {hace != null && <span className="font-normal text-terminal-dim"> · {fmtHace(hace)}</span>}
    </span>
  )
}

function detalleNiveles(detalle, tipo) {
  if (!detalle) return null
  if (tipo === 'doble_techo' || tipo === 'doble_piso') {
    return (
      <span title={`Extremo 1: ${fmtPrecio(detalle.extremo_1?.precio)} (hace ${detalle.extremo_1?.hace} r.) · Extremo 2: ${fmtPrecio(detalle.extremo_2?.precio)} (hace ${detalle.extremo_2?.hace} r.)`}>
        {fmtPrecio(detalle.extremo_1?.precio)} / {fmtPrecio(detalle.extremo_2?.precio)}
      </span>
    )
  }
  return (
    <span title={`Hombro izq.: ${fmtPrecio(detalle.hombro_izquierdo?.precio)} (hace ${detalle.hombro_izquierdo?.hace} r.) · Cabeza: ${fmtPrecio(detalle.cabeza?.precio)} (hace ${detalle.cabeza?.hace} r.) · Hombro der.: ${fmtPrecio(detalle.hombro_derecho?.precio)} (hace ${detalle.hombro_derecho?.hace} r.)`}>
      {fmtPrecio(detalle.hombro_izquierdo?.precio)} / {fmtPrecio(detalle.cabeza?.precio)} / {fmtPrecio(detalle.hombro_derecho?.precio)}
    </span>
  )
}

function PanelTipo({ tipo, filas }) {
  const { filtradas, sortKey, sortDir, ordenar } = useTabla(filas, { ordenInicial: { key: 'score', dir: 'desc' } })
  const info = TIPOS_FIGURAS.find((t) => t.tipo === tipo)

  const columnas = useMemo(
    () => [
      { key: 'ticker', label: 'Ticker', valor: (r) => r.ticker, render: (r) => <TickerLink ticker={r.ticker} className="font-semibold" title={r.nombre} /> },
      { key: 'score', label: 'Score', align: 'right', ayuda: 'Score 0-100 de la figura', valor: (r) => r.score, render: (r) => <b className="text-terminal-text">{fmtNum(r.score, 0)}</b> },
      {
        key: 'niveles',
        label: info?.bajista ? 'Techos/Hombros' : 'Pisos/Hombros',
        ayuda: 'Precios de los extremos que forman la figura',
        valor: () => 0,
        render: (r) => detalleNiveles(r.detalle, tipo),
      },
      {
        key: 'neckline',
        label: 'Neckline',
        align: 'right',
        ayuda: 'Precio de la neckline hoy (interpolado si tiene pendiente)',
        valor: (r) => r.detalle?.neckline_precio_hoy,
        render: (r) => fmtPrecio(r.detalle?.neckline_precio_hoy ?? r.detalle?.neckline_precio),
      },
      {
        key: 'dist',
        label: 'Dist. neckline',
        align: 'right',
        ayuda: 'Precio de hoy vs la neckline',
        valor: (r) => r.detalle?.dist_neckline_pct,
        render: (r) => (r.detalle?.dist_neckline_pct == null ? '—' : fmtPct(r.detalle.dist_neckline_pct, { signo: true })),
      },
      {
        key: 'rs',
        label: 'RS',
        align: 'right',
        ayuda: 'RS Score hoy (percentil vs SPY, universo USD); "—" si no cotiza en USD',
        valor: (r) => r.rs_hoy,
        render: (r) => (r.rs_hoy == null ? '—' : fmtNum(r.rs_hoy, 0)),
      },
      {
        key: 'estado',
        label: 'Estado',
        valor: (r) => ESTADOS_FIGURAS.findIndex((e) => e.estado === r.estado),
        render: (r) => <EstadoBadge estado={r.estado} hace={r.detalle?.hace_ruptura ?? r.detalle?.hace_base} />,
      },
    ],
    [tipo, info],
  )

  return (
    <div>
      <TablaEvidenciaMultiple
        ruta={['figuras_chartistas', tipo]}
        etiquetas={ESTADOS_FIGURAS.map((e) => e.estado)}
        horizonte={10}
        titulo={`estado de ${NOMBRE_TIPO[tipo]}`}
      />
      {filtradas.length === 0 ? (
        <Vacio texto={`Ningún ${NOMBRE_TIPO[tipo]} detectado hoy con score ≥ 55.`} />
      ) : (
        <Tabla columnas={columnas} filas={filtradas} sortKey={sortKey} sortDir={sortDir} onSort={ordenar} />
      )}
    </div>
  )
}

export default function FigurasChartistas() {
  const { data, cargando, error, status } = useJson('figuras.json')
  const [tipo, setTipo] = useState('doble_techo')

  const porTipo = useMemo(() => {
    const m = Object.fromEntries(TIPOS_FIGURAS.map((t) => [t.tipo, []]))
    for (const f of Array.isArray(data?.figuras) ? data.figuras : []) {
      if (m[f.tipo]) m[f.tipo].push(f)
    }
    return m
  }, [data])

  return (
    <div className="min-w-0">
      <div className="mb-3">
        <h1 className="text-lg font-bold text-terminal-text">📐 Figuras Chartistas</h1>
        <p className="max-w-3xl text-xs text-terminal-dim">
          Doble Techo, Doble Piso y Hombro-Cabeza-Hombro (HCH / HCH invertido), detectados sobre la misma secuencia
          de swings (ZigZag adaptativo) que usa la base VCP de Señales. Es una feature propia, independiente del
          Warren Score. Técnico, orientativo — no es recomendación de inversión: los badges de evidencia de abajo
          muestran qué tan bien (o mal) le fue históricamente a cada combinación figura+estado en un backtest de 5
          años sin look-ahead; la mayoría de los patrones chartistas, solos, apenas superan (o ni siquiera superan)
          el azar — mirá el badge antes de sacar conclusiones.
        </p>
        {data?.actualizado && <p className="mt-1 text-[11px] text-terminal-dim">Datos actualizados: {fmtFecha(data.actualizado)}</p>}
      </div>

      {cargando ? (
        <TablaSkeleton columnas={6} />
      ) : error ? (
        status === 404 ? (
          <Vacio texto="Todavía no hay figuras.json: se genera en la próxima corrida del pipeline." />
        ) : (
          <MensajeError mensaje={error} />
        )
      ) : (
        <section className="mb-5 min-w-0 rounded-lg border border-terminal-border bg-terminal-panel p-3">
          <Pestanas
            valor={tipo}
            onChange={setTipo}
            opciones={TIPOS_FIGURAS.map((t) => ({ valor: t.tipo, label: `${t.emoji} ${t.nombre}`, n: porTipo[t.tipo]?.length ?? 0 }))}
          />
          <PanelTipo tipo={tipo} filas={porTipo[tipo] ?? []} />
        </section>
      )}

      <ComoSeCalcula titulo="¿Cómo se calcula cada figura?" className="mt-2">
        <p>
          Las 4 figuras se detectan sobre <Formula>ws_zigzag</Formula> (el mismo ZigZag adaptativo del VCP): swings
          de precio con umbral <Formula>max(3%, 1,5 × ATR14%)</Formula> sobre una ventana de ~150 ruedas (más ancha
          que la del VCP: el HCH necesita 5 swings y tarda más en formarse que una base VCP de 3-4).
        </p>
        <p>
          <b className="text-terminal-text">⛰️ Doble Techo</b> (bajista) / <b className="text-terminal-text">🏔️ Doble Piso</b>{' '}
          (alcista): dos swings del mismo signo (dos máximos o dos mínimos) dentro de <Formula>±3%</Formula> entre
          sí, separados por exactamente un swing intermedio (por construcción del ZigZag, que alterna máximo/mínimo)
          que esté al menos <Formula>5%</Formula> más allá de los dos extremos — esa neckline (el valle o el pico
          intermedio) no puede tener más de 40 ruedas de antigüedad en su segundo extremo. Ruptura: cierre del otro
          lado de la neckline (abajo para el techo, arriba para el piso).
        </p>
        <p>
          <b className="text-terminal-text">👤 Hombro-Cabeza-Hombro</b> (bajista) /{' '}
          <b className="text-terminal-text">🙃 HCH Invertido</b> (alcista): 5 swings consecutivos
          hombro-valle-cabeza-valle-hombro con la cabeza al menos <Formula>3%</Formula> más allá (más alta en el HCH,
          más baja en el invertido) que el promedio de los dos hombros, hombros dentro de <Formula>±5%</Formula>{' '}
          entre sí. La neckline conecta los dos valles/picos intermedios (puede tener pendiente, se interpola
          linealmente); si esos dos puntos difieren más de <Formula>8%</Formula> se descarta (sería un canal, no un
          cuello). Ruptura: cierre del otro lado de la neckline interpolada al día de hoy.
        </p>
        <p>
          <b className="text-terminal-text">Score (0-100)</b>: doble techo/piso ={' '}
          <Formula>simetría (35) + profundidad en ATR14% (35) + volumen (30)</Formula>; HCH/invertido ={' '}
          <Formula>simetría de hombros (30) + prominencia de la cabeza en ATR14% (35) + volumen (35)</Formula>.
          Volumen premia la regla clásica de Edwards & Magee: el segundo techo/piso (o la cabeza y el hombro
          derecho) con MENOS volumen promedio que el primero, más un extra si la ruptura ya ocurrida tuvo clímax de
          volumen (≥ 1,5× el promedio de 20 ruedas). Solo se publican figuras con score ≥ 55 (más bajo que el del
          VCP: son patrones más raros).
        </p>
        <p>
          <b className="text-terminal-text">Estado</b> (mismo mecanismo que el ciclo de vida del VCP: para saber si
          ya rompió hay que re-detectar la figura cortando el historial en cada una de las últimas 15 ruedas, porque
          la ruptura crea un swing nuevo y la detección de hoy ya no ve la figura vieja):
        </p>
        <ul className="ml-4 list-disc">
          <li>
            <span style={{ color: COLOR_ESTADO_FIGURA['Formándose'] }}>Formándose</span>: estructura completa (los
            extremos y la neckline ya están), todavía sin romper.
          </li>
          <li>
            <span style={{ color: COLOR_ESTADO_FIGURA['Recién rompió'] }}>Recién rompió</span>: rompió la neckline
            en las últimas 3 ruedas.
          </li>
          <li>
            <span style={{ color: COLOR_ESTADO_FIGURA['Rompió y confirmó'] }}>Rompió y confirmó</span>: rompió hace
            3-15 ruedas, nunca volvió a cruzar la neckline y hubo seguimiento (≥3% del lado de la ruptura, o 2
            cierres seguidos a favor).
          </li>
          <li>
            <span style={{ color: COLOR_ESTADO_FIGURA['Rompió sin confirmar'] }}>Rompió sin confirmar</span>: rompió
            hace 3-15 ruedas, no volvió a cruzar pero tampoco hubo seguimiento todavía.
          </li>
          <li>
            <span style={{ color: COLOR_ESTADO_FIGURA['Falló antes de romper'] }}>Falló antes de romper</span>: el
            precio superó (HCH/doble techo) o perforó (invertido/doble piso) sus propios extremos antes de romper la
            neckline: la figura se invalidó.
          </li>
          <li>
            <span style={{ color: COLOR_ESTADO_FIGURA['Rompió y falló'] }}>Rompió y falló</span>: rompió la neckline
            y después volvió ≥3% para el otro lado (ruptura falsa / trampa).
          </li>
        </ul>
        <p>
          <b className="text-terminal-warn">Ojo</b>: "no hay figuras hoy" y "todavía no se publicó figuras.json" son
          dos cosas distintas — la página lo distingue (mensaje de error 404 vs. lista vacía). Los badges de
          evidencia salen de <Formula>backtest_senales.json.stats.figuras_chartistas</Formula>, con la MISMA
          metodología del resto de Señales (sin look-ahead, entrada a la apertura del día siguiente, exceso vs SPY,
          bootstrap de la mediana) — revisalos antes de operar cualquier figura de esta página.
        </p>
      </ComoSeCalcula>
    </div>
  )
}
