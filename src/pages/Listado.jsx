import { useMemo, useState } from 'react'
import { useDatosCombinados } from '../lib/useDatosCombinados'
import { useJson } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { calcularScore } from '../lib/score'
import { exportarCSV } from '../lib/csv'
import { estiloValor, estiloRSI, fmtPct, fmtNum } from '../lib/formato'
import Controles from '../components/Controles'
import TarjetaIndustria from '../components/TarjetaIndustria'
import Leyenda from '../components/Leyenda'
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
  const { filas: merged, cargando, error } = useDatosCombinados()
  const { data: listadoData } = useJson('listado.json')
  const promediosPorIndustria = useMemo(
    () => (Array.isArray(listadoData?.promedios_por_industria) ? listadoData.promedios_por_industria : []),
    [listadoData],
  )
  const { pins, isPinned, toggle } = usePins()
  const { overrides } = useClasificacion()
  const [orden, setOrden] = useState('score|desc')

  const base = useMemo(
    () => aplicarClasificacion(merged, overrides),
    [merged, overrides],
  )
  const scored = useMemo(() => base.map((r) => ({ ...r, _score: calcularScore(r) })), [base])
  const t = useTabla(scored, { camposBusqueda: CAMPOS })

  const comparar = useMemo(() => {
    const [campo, dir] = orden.split('|')
    const getv = (r) => (campo === 'score' ? r._score?.score : r[campo])
    return (a, b) => {
      const pa = pins.has(a.ticker)
      const pb = pins.has(b.ticker)
      if (pa !== pb) return pa ? -1 : 1
      const va = getv(a)
      const vb = getv(b)
      const na = va == null || Number.isNaN(va)
      const nb = vb == null || Number.isNaN(vb)
      if (na && nb) return 0
      if (na) return 1
      if (nb) return -1
      if (typeof va === 'string' || typeof vb === 'string') {
        const r = String(va).localeCompare(String(vb), 'es')
        return dir === 'asc' ? r : -r
      }
      return dir === 'asc' ? va - vb : vb - va
    }
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

  const ordenSelect = (
    <select
      className="rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
      value={orden}
      onChange={(e) => setOrden(e.target.value)}
      title="Ordenar dentro de cada industria"
    >
      {OPCIONES_ORDEN.map((o) => (
        <option key={o.val} value={o.val}>
          Ordenar: {o.label}
        </option>
      ))}
    </select>
  )

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Listado</h1>
        <p className="text-xs text-terminal-dim">
          Variación % del día, RSI(14) y un <b>score orientativo</b> (tendencia + momentum +
          valuación) por industria. El sparkline muestra las últimas ~30 ruedas.
        </p>
      </div>

      {promediosPorIndustria.length > 0 && (
        <div className="mb-5 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <HeatmapIndustrias
            titulo="Industrias — variación de hoy"
            datos={promediosPorIndustria}
            valorKey="var_pct_promedio"
            colorFn={(v) => estiloValor(v, 3)}
            formatFn={(v) => fmtPct(v, { signo: true })}
            ayuda="Promedio simple de la variación % de hoy, por industria (de tu universo de tickers)."
          />
          <HeatmapIndustrias
            titulo="Industrias — RSI promedio"
            datos={promediosPorIndustria}
            valorKey="rsi_promedio"
            colorFn={(v) => estiloRSI(v)}
            formatFn={(v) => fmtNum(v, 1)}
            ayuda="RSI(14) promedio por industria — >70 sobrecompra, <30 sobreventa."
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
        extra={ordenSelect}
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
    </div>
  )
}
