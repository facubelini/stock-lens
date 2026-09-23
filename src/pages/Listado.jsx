import { memo, useMemo, useState } from 'react'
import { useFilasCombinadas } from '../lib/useFilas'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { calcularScore } from '../lib/score'
import { exportarCSV } from '../lib/csv'
import { crearComparador } from '../lib/ordenar'
import { selectCls } from '../lib/estilos'
import { estiloValor, estiloRSI, fmtPct, fmtNum, promedio } from '../lib/formato'
import Controles from '../components/Controles'
import TarjetaIndustria from '../components/TarjetaIndustria'
import Leyenda from '../components/Leyenda'
import BotonPin from '../components/BotonPin'
import EditorClasificacion from '../components/EditorClasificacion'
import Semaforo from '../components/Semaforo'
import Backtest from '../components/Backtest'
import Sparkline from '../components/Sparkline'
import TickerLink from '../components/TickerLink'
import MarcaStale from '../components/MarcaStale'
import EncabezadoOrdenable from '../components/EncabezadoOrdenable'
import { ExplicacionScore } from '../components/Explicaciones'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'

function HeatmapIndustrias({ titulo, datos, valorKey, colorFn, formatFn, ayuda }) {
  const ordenado = useMemo(
    () => [...datos].filter((d) => d[valorKey] != null).sort((a, b) => b[valorKey] - a[valorKey]),
    [datos, valorKey],
  )
  if (!ordenado.length) return null
  return (
    <div>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-terminal-dim">{titulo}</h2>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8">
        {ordenado.map((d) => (
          <div
            key={d.industria}
            className="rounded border border-terminal-border px-1.5 py-1.5 text-center"
            style={colorFn(d[valorKey])}
            title={`${d.industria} · ${d.n} ticker(s)`}
          >
            <div className="truncate text-[9px] font-semibold leading-tight">{d.industria}</div>
            <div className="mt-0.5 text-xs font-bold tabular">{formatFn(d[valorKey])}</div>
          </div>
        ))}
      </div>
      {ayuda && <p className="mt-1.5 text-[11px] text-terminal-dim">{ayuda}</p>}
    </div>
  )
}

// Promedio simple por industria (var % y RSI), calculado en el cliente sobre
// las filas YA reclasificadas a mano — antes se usaba promedios_por_industria
// del pipeline, que ignoraba las clasificaciones manuales y no coincidia con
// los recuadros de abajo.
function promediosPorIndustria(filas) {
  const g = new Map()
  for (const f of filas) {
    const k = f.industria || '—'
    if (!g.has(k)) g.set(k, [])
    g.get(k).push(f)
  }
  return [...g.entries()].map(([industria, fs]) => ({
    industria,
    n: fs.length,
    var_pct_promedio: promedio(fs, (f) => f.var_pct),
    rsi_promedio: promedio(fs, (f) => f.rsi),
  }))
}

// Fila memoizada: al tipear en el buscador o cambiar el orden solo se
// re-renderizan las filas que cambiaron.
const FilaLista = memo(function FilaLista({ r, fijada, isPinned, toggle, industrias, sectores }) {
  return (
    <tr
      className={`border-t border-terminal-border transition-colors hover:bg-terminal-panel2/40 ${
        fijada ? 'bg-terminal-accent/5' : ''
      }`}
    >
      <td className="w-6 py-1 pl-2 pr-0 text-center align-middle">
        <BotonPin ticker={r.ticker} isPinned={isPinned} toggle={toggle} />
      </td>
      <td className="whitespace-nowrap py-1 px-2 align-middle">
        <span className="flex items-center gap-1.5">
          <TickerLink ticker={r.ticker} className="font-semibold" title={r.nombre} />
          <MarcaStale fila={r} />
          <EditorClasificacion
            ticker={r.ticker}
            industria={r.industria}
            sector={r.sector}
            industrias={industrias}
            sectores={sectores}
          />
        </span>
      </td>
      <td className="max-w-[160px] truncate px-2 py-1 text-terminal-dim" title={r.industria}>
        {r.industria || '—'}
      </td>
      <td className="whitespace-nowrap px-2 py-1 text-terminal-dim">{r.pais || '—'}</td>
      <td className="px-2 py-1">
        <Sparkline datos={r.spark} />
      </td>
      <td className="px-2 py-1 text-right tabular" style={estiloValor(r.var_pct, 6)}>
        {fmtPct(r.var_pct, { signo: true })}
      </td>
      <td className="px-2 py-1 text-right tabular" style={estiloRSI(r.rsi)}>
        {fmtNum(r.rsi, 1)}
      </td>
      <td className="px-2 py-1 text-right">
        <Semaforo resultado={r._score} />
      </td>
    </tr>
  )
})

// Tabla plana (sin agrupar por industria), con headers clickeables para
// ordenar de mayor a menor — complementa el select de orden, que en esta
// vista ordena la lista entera en vez de solo dentro de cada grupo.
function ListaGeneral({ filas, orden, setOrden, pins, isPinned, toggle, industrias, sectores }) {
  const [campoActual, dirActual] = orden.split('|')

  const th = (campo, label, align = 'right') => {
    const activo = campoActual === campo
    return (
      <EncabezadoOrdenable
        label={label}
        align={align}
        activa={activo}
        dir={dirActual}
        onClick={() => setOrden(`${campo}|${activo && dirActual === 'desc' ? 'asc' : 'desc'}`)}
        className="whitespace-nowrap px-2 py-2.5 font-semibold"
      />
    )
  }

  // El scroll vive en el contenedor para que el thead sticky funcione.
  return (
    <div className="max-h-[75vh] overflow-auto rounded-lg border border-terminal-border">
      <table className="min-w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10">
          <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
            <th scope="col" className="w-6 px-1 py-2.5">
              <span className="sr-only">Favorito</span>
            </th>
            {th('ticker', 'Ticker', 'left')}
            <th scope="col" className="whitespace-nowrap px-2 py-2.5 font-semibold">Industria</th>
            <th scope="col" className="whitespace-nowrap px-2 py-2.5 font-semibold">País</th>
            <th scope="col" className="px-2 py-2.5 font-semibold">Gráfico</th>
            {th('var_pct', 'Var %')}
            {th('rsi', 'RSI')}
            {th('score', 'Score')}
          </tr>
        </thead>
        <tbody>
          {filas.map((r) => (
            <FilaLista
              key={r.ticker}
              r={r}
              fijada={pins.has(r.ticker)}
              isPinned={isPinned}
              toggle={toggle}
              industrias={industrias}
              sectores={sectores}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

const CAMPOS = ['ticker', 'nombre']

const OPCIONES_ORDEN = [
  { val: 'score|desc', label: 'Score (mejor)' },
  { val: 'var_pct|desc', label: 'Var % (mayor)' },
  { val: 'var_pct|asc', label: 'Var % (menor)' },
  { val: 'rsi|desc', label: 'RSI (mayor)' },
  { val: 'rsi|asc', label: 'RSI (menor)' },
  { val: 'ticker|asc', label: 'Ticker (A-Z)' },
]

const COLS_CSV = [
  { key: 'ticker', label: 'Ticker' },
  { key: 'nombre', label: 'Empresa' },
  { key: 'industria', label: 'Industria' },
  { key: 'pais', label: 'Pais' },
  { key: 'var_pct', label: 'Var %' },
  { key: 'rsi', label: 'RSI' },
  { key: 'score', label: 'Score', valorCSV: (r) => r._score?.score ?? '' },
]

export default function Listado() {
  const { filas: base, cargando, error } = useFilasCombinadas()
  const promedios = useMemo(() => promediosPorIndustria(base), [base])
  const { pins, isPinned, toggle } = usePins()
  const [orden, setOrden] = useState('score|desc')
  const [vista, setVista] = useState('industria') // 'industria' | 'lista'

  // Largo real del sparkline (el pipeline manda N cierres; antes el texto
  // decia "~30 ruedas" fijo aunque vinieran 180).
  const largoSpark = useMemo(
    () => base.reduce((m, r) => Math.max(m, Array.isArray(r.spark) ? r.spark.length : 0), 0),
    [base],
  )

  const scored = useMemo(() => base.map((r) => ({ ...r, _score: calcularScore(r) })), [base])
  const t = useTabla(scored, { camposBusqueda: CAMPOS })

  const comparar = useMemo(() => {
    const [campo, dir] = orden.split('|')
    const getv = (r) => (campo === 'score' ? r._score?.score : r[campo])
    return crearComparador(getv, dir, pins)
  }, [orden, pins])

  const grupos = useMemo(() => {
    const g = {}
    for (const f of t.filtradas) (g[f.industria ?? '—'] ??= []).push(f)
    return Object.keys(g)
      .sort((a, b) => a.localeCompare(b, 'es'))
      .map((nombre) => ({ nombre, filas: [...g[nombre]].sort(comparar) }))
  }, [t.filtradas, comparar])

  const favoritos = useMemo(
    () => t.filtradas.filter((f) => pins.has(f.ticker)).sort(comparar),
    [t.filtradas, pins, comparar],
  )

  const listaGeneral = useMemo(() => [...t.filtradas].sort(comparar), [t.filtradas, comparar])

  const ordenSelect = (
    <select
      className={selectCls}
      aria-label="Ordenar"
      value={orden}
      onChange={(e) => setOrden(e.target.value)}
      title={vista === 'lista' ? 'Ordenar la lista completa' : 'Ordenar dentro de cada industria'}
    >
      {OPCIONES_ORDEN.map((o) => (
        <option key={o.val} value={o.val}>
          Ordenar: {o.label}
        </option>
      ))}
    </select>
  )

  const vistaToggle = (
    <div className="flex overflow-hidden rounded border border-terminal-border text-sm">
      {[
        { val: 'industria', label: 'Por industria' },
        { val: 'lista', label: 'Lista general' },
      ].map((o) => (
        <button
          key={o.val}
          type="button"
          aria-pressed={vista === o.val}
          onClick={() => setVista(o.val)}
          className={`px-2.5 py-1.5 ${
            vista === o.val
              ? 'bg-terminal-accent font-semibold text-black'
              : 'bg-terminal-panel text-terminal-dim hover:text-terminal-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Listado</h1>
        <p className="text-xs text-terminal-dim">
          Variación % del día, RSI(14) y un <b>score orientativo</b> (tendencia + momentum +
          valuación) por industria. El sparkline muestra las últimas{' '}
          {largoSpark > 0 ? largoSpark : 'N'} ruedas.
        </p>
      </div>

      <ExplicacionScore />

      {promedios.length > 0 && (
        <div className="mb-5 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <HeatmapIndustrias
            titulo="Industrias — variación de hoy"
            datos={promedios}
            valorKey="var_pct_promedio"
            colorFn={(v) => estiloValor(v, 3)}
            formatFn={(v) => fmtPct(v, { signo: true })}
            ayuda="Promedio simple (sin ponderar por tamaño) de la variación % de hoy de los tickers de cada industria de tu universo, con tus clasificaciones manuales aplicadas."
          />
          <HeatmapIndustrias
            titulo="Industrias — RSI promedio"
            datos={promedios}
            valorKey="rsi_promedio"
            colorFn={(v) => estiloRSI(v)}
            formatFn={(v) => fmtNum(v, 1)}
            ayuda="Promedio simple del RSI(14) de los tickers de cada industria — >70 sobrecompra, <30 sobreventa."
          />
        </div>
      )}

      <Controles
        busqueda={t.busqueda}
        setBusqueda={t.setBusqueda}
        pais={t.pais}
        setPais={t.setPais}
        paises={t.paises}
        industria={t.industria}
        setIndustria={t.setIndustria}
        industrias={t.industrias}
        sector={t.sector}
        setSector={t.setSector}
        sectores={t.sectores}
        extra={
          <>
            {vistaToggle}
            {ordenSelect}
          </>
        }
        onExportCSV={() => exportarCSV('stock-lens-listado.csv', COLS_CSV, t.filtradas)}
        total={base.length}
        mostrados={t.filtradas.length}
      />

      <Leyenda />

      {cargando ? (
        <TablaSkeleton columnas={4} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : t.filtradas.length === 0 ? (
        <Vacio />
      ) : vista === 'lista' ? (
        <ListaGeneral
          filas={listaGeneral}
          orden={orden}
          setOrden={setOrden}
          pins={pins}
          isPinned={isPinned}
          toggle={toggle}
          industrias={t.industrias}
          sectores={t.sectores}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {favoritos.length > 0 && (
            <TarjetaIndustria
              industria="★ Favoritos"
              filas={favoritos}
              isPinned={isPinned}
              toggle={toggle}
              destacada
              industrias={t.industrias}
              sectores={t.sectores}
            />
          )}
          {grupos.map((g) => (
            <TarjetaIndustria
              key={g.nombre}
              industria={g.nombre}
              filas={g.filas}
              isPinned={isPinned}
              toggle={toggle}
              industrias={t.industrias}
              sectores={t.sectores}
            />
          ))}
        </div>
      )}

      <Backtest tipo="score" />
    </div>
  )
}
