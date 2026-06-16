// Estados de carga, error y vacio para las tablas.

export function TablaSkeleton({ filas = 10, columnas = 6 }) {
  return (
    <div className="overflow-hidden rounded-lg border border-terminal-border">
      <div className="flex gap-3 border-b border-terminal-border bg-terminal-panel2 px-3 py-2.5">
        {Array.from({ length: columnas }).map((_, i) => (
          <div key={i} className="skeleton h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: filas }).map((_, r) => (
        <div key={r} className="flex gap-3 border-b border-terminal-border px-3 py-2.5">
          {Array.from({ length: columnas }).map((_, c) => (
            <div key={c} className="skeleton h-3 flex-1" style={{ opacity: 0.6 }} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function MensajeError({ mensaje }) {
  return (
    <div className="rounded-lg border border-terminal-down/40 bg-terminal-down/10 p-6 text-center">
      <p className="mb-1 font-semibold text-terminal-down">No se pudieron cargar los datos</p>
      <p className="text-sm text-terminal-dim">{mensaje}</p>
      <p className="mt-3 text-xs text-terminal-dim">
        Verificá que el pipeline haya generado los archivos en <code>public/data/</code>.
      </p>
    </div>
  )
}

export function Vacio({ texto = 'No hay resultados con los filtros actuales.' }) {
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-8 text-center text-sm text-terminal-dim">
      {texto}
    </div>
  )
}
