// Leyenda compacta de colores y favoritos.
const Swatch = ({ color }) => (
  <i
    className="inline-block h-3 w-3 rounded-sm"
    style={{ backgroundColor: color }}
    aria-hidden="true"
  />
)

export default function Leyenda() {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-terminal-dim">
      <span className="font-semibold text-terminal-text">Referencias:</span>
      <span className="flex items-center gap-1.5">
        <Swatch color="rgba(34,197,94,.55)" /> sube / sobre la media
      </span>
      <span className="flex items-center gap-1.5">
        <Swatch color="rgba(239,68,68,.55)" /> baja / bajo la media
      </span>
      <span className="flex items-center gap-1.5">
        <Swatch color="rgba(56,189,248,.55)" /> RSI &lt;30 (sobreventa)
      </span>
      <span className="flex items-center gap-1.5">
        <Swatch color="rgba(239,68,68,.55)" /> RSI &gt;70 (sobrecompra)
      </span>
      <span>
        <span className="text-terminal-accent">★</span> favoritos (se guardan en tu navegador)
      </span>
    </div>
  )
}
