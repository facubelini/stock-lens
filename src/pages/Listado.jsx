import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { exportarCSV } from '../lib/csv'
import Controles from '../components/Controles'
import TarjetaIndustria from '../components/TarjetaIndustria'
import Leyenda from '../components/Leyenda'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'

const CAMPOS = ['ticker', 'nombre']

const OPCIONES_ORDEN = [
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
]

export default function Listado() {
  const { data, cargando, error } = useJson('listado.json')
  const filas = data?.acciones ?? []
  const { pins, isPinned, toggle } = usePins()
  const t = useTabla(filas, { camposBusqueda: CAMPOS })
  const [orden, setOrden] = useState('var_pct|desc')

  // Comparador para ordenar dentro de cada recuadro (favoritos primero).
  const comparar = useMemo(() => {
    const [campo, dir] = orden.split('|')
    return (a, b) => {
      const pa = pins.has(a.ticker)
      const pb = pins.has(b.ticker)
      if (pa !== pb) return pa ? -1 : 1
      const va = a[campo]
      const vb = b[campo]
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
          Variación % del día y RSI(14) por industria. Cada recuadro muestra el promedio del grupo.
        </p>
      </div>

      <Controles
        busqueda={t.busqueda}
        setBusqueda={t.setBusqueda}
        pais={t.pais}
        setPais={t.setPais}
        paises={t.paises}
        industria={t.industria}
        setIndustria={t.setIndustria}
        industrias={t.industrias}
        extra={ordenSelect}
        onExportCSV={() => exportarCSV('stock-lens-listado.csv', COLS_CSV, t.filtradas)}
        total={filas.length}
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
            />
          )}
          {grupos.map((g) => (
            <TarjetaIndustria
              key={g.nombre}
              industria={g.nombre}
              filas={g.filas}
              isPinned={isPinned}
              toggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  )
}
