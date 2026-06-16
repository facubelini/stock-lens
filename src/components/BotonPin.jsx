// Estrella para marcar/desmarcar un ticker como favorito.
export default function BotonPin({ ticker, isPinned, toggle }) {
  const activo = isPinned(ticker)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        toggle(ticker)
      }}
      title={activo ? 'Quitar de favoritos' : 'Agregar a favoritos'}
      aria-label={activo ? 'Quitar de favoritos' : 'Agregar a favoritos'}
      className={`text-base leading-none transition-colors ${
        activo ? 'text-terminal-accent' : 'text-terminal-border hover:text-terminal-dim'
      }`}
    >
      {activo ? '★' : '☆'}
    </button>
  )
}
