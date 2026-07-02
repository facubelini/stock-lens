// Barra de controles compartida: buscador + filtro pais + filtro industria
// + (opcional) toggle agrupar + slot 'extra' + boton de exportar CSV.

const selectCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

export default function Controles({
  busqueda,
  setBusqueda,
  pais,
  setPais,
  paises,
  industria,
  setIndustria,
  industrias,
  sector,
  setSector,
  sectores,
  agrupar,
  setAgrupar,
  extra,
  onExportCSV,
  total,
  mostrados,
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <input
        type="search"
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        placeholder="Buscar ticker o empresa…"
        className={`${selectCls} w-full sm:w-52`}
      />

      <select className={selectCls} value={pais} onChange={(e) => setPais(e.target.value)}>
        <option value="">Todos los países</option>
        {paises.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      <select
        className={selectCls}
        value={industria}
        onChange={(e) => setIndustria(e.target.value)}
      >
        <option value="">Todas las industrias</option>
        {industrias.map((i) => (
          <option key={i} value={i}>
            {i}
          </option>
        ))}
      </select>

      {setSector && sectores?.length > 0 && (
        <select className={selectCls} value={sector} onChange={(e) => setSector(e.target.value)}>
          <option value="">Todos los sectores</option>
          {sectores.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}

      {setAgrupar && (
        <label className="flex cursor-pointer select-none items-center gap-1.5 rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-dim hover:text-terminal-text">
          <input
            type="checkbox"
            checked={agrupar}
            onChange={(e) => setAgrupar(e.target.checked)}
            className="accent-terminal-accent"
          />
          Agrupar por industria
        </label>
      )}

      {extra}

      {onExportCSV && (
        <button
          type="button"
          onClick={onExportCSV}
          title="Descargar lo que estás viendo en CSV"
          className="rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-dim hover:border-terminal-accent hover:text-terminal-text"
        >
          ⬇ CSV
        </button>
      )}

      <span className="ml-auto text-xs text-terminal-dim tabular">
        {mostrados} / {total} activos
      </span>
    </div>
  )
}
