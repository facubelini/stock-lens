import { useMemo } from 'react'
import { claseAlineacion } from '../lib/formato'

// Tabla generica, ordenable por columna y opcionalmente agrupada por industria.
//
// columnas: [{ key, label, align, sortable, valor(row), render(row), estilo(row) }]
//   - valor(row): valor usado para ordenar (numero o string)
//   - render(row): contenido de la celda (nodo React)
//   - estilo(row): style en linea para la celda (fondo coloreado, etc.)
// resumenGrupo(industria, filasDelGrupo, columnas): fila <tr> de resumen por grupo.
// pins: Set de tickers favoritos -> se ordenan primero.

function Celda({ col, row }) {
  return (
    <td
      className={`px-3 py-1.5 tabular ${claseAlineacion(col.align)} ${col.tdClass ?? ''}`}
      style={col.estilo ? col.estilo(row) : undefined}
    >
      {col.render ? col.render(row) : (row[col.key] ?? '')}
    </td>
  )
}

function Fila({ row, columnas, fijada }) {
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
}

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
    return (a, b) => {
      // Favoritos siempre primero.
      if (pins) {
        const pa = pins.has(a.ticker)
        const pb = pins.has(b.ticker)
        if (pa !== pb) return pa ? -1 : 1
      }
      if (!sortKey) return 0
      const col = colByKey[sortKey]
      const getter = col?.valor ?? ((r) => r[sortKey])
      const va = getter(a)
      const vb = getter(b)
      const na = va === null || va === undefined || Number.isNaN(va)
      const nb = vb === null || vb === undefined || Number.isNaN(vb)
      if (na && nb) return 0
      if (na) return 1 // nulos siempre al final
      if (nb) return -1
      if (typeof va === 'string' || typeof vb === 'string') {
        const r = String(va).localeCompare(String(vb), 'es')
        return sortDir === 'asc' ? r : -r
      }
      return sortDir === 'asc' ? va - vb : vb - va
    }
  }, [sortKey, sortDir, colByKey, pins])

  const esFijada = (row) => (pins ? pins.has(row.ticker) : false)

  const cabecera = (
    <thead className="sticky top-0 z-10">
      <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
        {columnas.map((col) => {
          const ordenable = col.sortable !== false
          const activa = sortKey === col.key
          return (
            <th
              key={col.key}
              onClick={ordenable ? () => onSort(col.key) : undefined}
              className={`whitespace-nowrap px-3 py-2.5 font-semibold ${claseAlineacion(col.align)} ${
                ordenable ? 'cursor-pointer select-none hover:text-terminal-text' : ''
              } ${activa ? 'text-terminal-accent' : ''}`}
            >
              {col.label}
              {activa ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
            </th>
          )
        })}
      </tr>
    </thead>
  )

  let cuerpo
  if (agrupar) {
    const grupos = {}
    for (const f of filas) {
      const g = f.industria ?? '—'
      ;(grupos[g] ??= []).push(f)
    }
    const nombres = Object.keys(grupos).sort((a, b) => a.localeCompare(b, 'es'))
    cuerpo = nombres.map((g) => {
      const fs = [...grupos[g]].sort(comparar)
      return (
        <tbody key={g}>
          {resumenGrupo ? (
            resumenGrupo(g, fs, columnas)
          ) : (
            <tr className="bg-terminal-panel2/80">
              <td
                colSpan={columnas.length}
                className="px-3 py-1.5 font-semibold text-terminal-accent"
              >
                {g} <span className="font-normal text-terminal-dim">· {fs.length}</span>
              </td>
            </tr>
          )}
          {fs.map((row) => (
            <Fila key={row.ticker} row={row} columnas={columnas} fijada={esFijada(row)} />
          ))}
        </tbody>
      )
    })
  } else {
    const ordenadas = [...filas].sort(comparar)
    cuerpo = (
      <tbody>
        {ordenadas.map((row) => (
          <Fila key={row.ticker} row={row} columnas={columnas} fijada={esFijada(row)} />
        ))}
      </tbody>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-terminal-border">
      <table className="min-w-full border-collapse text-sm">
        {cabecera}
        {cuerpo}
      </table>
    </div>
  )
}
