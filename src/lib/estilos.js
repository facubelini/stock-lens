// Clases Tailwind compartidas para controles de formulario (antes copiadas en
// cada pagina con el mismo string).
export const selectCls =
  'max-w-full rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

export const inputCls = selectCls

// Input de ancho completo dentro de un modal (fondo mas oscuro que el panel).
export const inputModalCls =
  'mt-1 w-full rounded border border-terminal-border bg-terminal-bg px-2 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

export const btnCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-dim ' +
  'hover:border-terminal-accent hover:text-terminal-text'
