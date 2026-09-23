import { claseAlineacion } from '../lib/formato'
import { ariaSort } from '../lib/ordenar'

// <th> accesible: si la columna es ordenable, el click vive en un <button>
// (navegable con teclado) y el <th> informa el orden con aria-sort.
export default function EncabezadoOrdenable({
  label,
  ayuda,
  align = 'left',
  ordenable = true,
  activa = false,
  dir = 'desc',
  onClick,
  className = 'px-2 py-2.5 font-semibold',
}) {
  const flecha = activa ? (dir === 'asc' ? ' ▲' : ' ▼') : ''
  const icono = ayuda ? (
    <span title={ayuda} className="ml-0.5 cursor-help font-normal text-terminal-dim">
      ⓘ
    </span>
  ) : null

  return (
    <th
      scope="col"
      aria-sort={ordenable ? ariaSort(activa, dir) : undefined}
      className={`${className} ${claseAlineacion(align)} ${activa ? 'text-terminal-accent' : ''}`}
    >
      {ordenable ? (
        <button
          type="button"
          onClick={onClick}
          className={`inline font-semibold uppercase tracking-wide hover:text-terminal-text focus:outline-none focus-visible:underline ${
            claseAlineacion(align)
          }`}
        >
          {label}
          {flecha}
        </button>
      ) : (
        label
      )}
      {icono}
    </th>
  )
}
