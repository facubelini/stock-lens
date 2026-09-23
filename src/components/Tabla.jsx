import { memo, useMemo } from 'react'
import { claseAlineacion } from '../lib/formato'
import { crearComparador } from '../lib/ordenar'
import EncabezadoOrdenable from './EncabezadoOrdenable'

// Tabla generica, ordenable por columna y opcionalmente agrupada por industria.
//
// columnas: [{ key, label, align, sortable, valor(row), render(row), estilo(row) }]
//   - valor(row): valor usado para ordenar (numero o string)
//   - render(row): contenido de la celda (nodo React)
//   - estilo(row): style en linea para la celda (fondo coloreado, etc.)
// resumenGrupo(industria, filasDelGrupo, columnas): fila <tr> de resumen por grupo.
// pins: Set de tickers favoritos -> se ordenan primero.
//
// Rendimiento: las filas estan memoizadas (React.memo), asi que para que no
// se re-rendericen todas en cada tecla las paginas tienen que memoizar
// `columnas` (useMemo). No se virtualiza: los grupos por industria y las
// alturas variables (motivos del screener) lo complican y con ~400 filas
// memoizadas alcanza.

function Celda({ col, row }) {
  return (
    <td
      className={`px-1.5 py-1.5 tabular ${claseAlineacion(col.align)} ${col.tdClass ?? ''}`}
      style={col.estilo ? col.estilo(row) : undefined}
    >
      {col.render ? col.render(row) : (row[col.key] ?? '')}
    </td>
  )
}

const Fila = memo(function Fila({ row, columnas, fijada }) {
  return (
    <tr
      className={`border-t border-terminal-border transition-colors hover:bg-terminal-panel2/60 ${
        fijada ? 'bg-terminal-accent/5' : ''
      }`}
    >
      {columnas.map((col) => (
        <Celda key={col.key} col={col} row={row} />
      ))}
    </tr>
  )
})

export default function Tabla({
  columnas,
  filas,
  sortKey,
  sortDir,
  onSort,
  agrupar = false,
  resumenGrupo,
  pins,
}) {
  const colByKey = useMemo(
    () => Object.fromEntries(columnas.map((c) => [c.key, c])),
    [columnas],
  )

  const comparar = useMemo(() => {
    const col = sortKey ? colByKey[sortKey] : null
    const getter = sortKey ? (col?.valor ?? ((r) => r[sortKey])) : null
    return crearComparador(getter, sortDir, pins)
  }, [sortKey, sortDir, colByKey, pins])

  const esFijada = (row) => (pins ? pins.has(row.ticker) : false)

  const cabecera = (
    <thead className="sticky top-0 z-10">
      <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
        {columnas.map((col) => (
          <EncabezadoOrdenable
            key={col.key}
            label={col.label}
            ayuda={col.ayuda}
            align={col.align}
            ordenable={col.sortable !== false}
            activa={sortKey === col.key}
            dir={sortDir}
            onClick={() => onSort(col.key)}
            className="px-1.5 py-2.5 font-semibold leading-tight"
          />
        ))}
      </tr>
    </thead>
  )

  const grupos = useMemo(() => {
    if (!agrupar) return null
    const g = {}
    for (const f of filas) (g[f.industria ?? '—'] ??= []).push(f)
    return Object.keys(g)
      .sort((a, b) => a.localeCompare(b, 'es'))
      .map((nombre) => ({ nombre, filas: [...g[nombre]].sort(comparar) }))
  }, [agrupar, filas, comparar])

  const ordenadas = useMemo(() => (agrupar ? null : [...filas].sort(comparar)), [agrupar, filas, comparar])

  let cuerpo
  if (grupos) {
    cuerpo = grupos.map(({ nombre: g, filas: fs }) => (
      <tbody key={g}>
        {resumenGrupo ? (
          resumenGrupo(g, fs, columnas)
        ) : (
          <tr className="bg-terminal-panel2/80">
            <td colSpan={columnas.length} className="px-1.5 py-1.5 font-semibold text-terminal-accent">
              {g} <span className="font-normal text-terminal-dim">· {fs.length}</span>
            </td>
          </tr>
        )}
        {fs.map((row) => (
          <Fila key={row.ticker} row={row} columnas={columnas} fijada={esFijada(row)} />
        ))}
      </tbody>
    ))
  } else {
    cuerpo = (
      <tbody>
        {ordenadas.map((row) => (
          <Fila key={row.ticker} row={row} columnas={columnas} fijada={esFijada(row)} />
        ))}
      </tbody>
    )
  }

  // El scroll vive en el contenedor (alto maximo), asi el thead sticky queda
  // fijo arriba de la tabla en vez de quedar tapado por el header de la app.
  return (
    <div className="max-h-[75vh] overflow-auto rounded-lg border border-terminal-border">
      <table className="min-w-full border-collapse text-sm">
        {cabecera}
        {cuerpo}
      </table>
    </div>
  )
}
