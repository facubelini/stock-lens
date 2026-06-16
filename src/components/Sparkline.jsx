// Mini-gráfico de línea (sparkline) a partir de un array de cierres.
export default function Sparkline({ datos, ancho = 60, alto = 18 }) {
  if (!datos || datos.length < 2) return <span className="text-terminal-border">—</span>

  const min = Math.min(...datos)
  const max = Math.max(...datos)
  const rango = max - min || 1
  const puntos = datos
    .map((v, i) => {
      const x = (i / (datos.length - 1)) * (ancho - 2) + 1
      const y = alto - 1 - ((v - min) / rango) * (alto - 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const sube = datos[datos.length - 1] >= datos[0]
  const color = sube ? '#22c55e' : '#ef4444'

  return (
    <svg
      width={ancho}
      height={alto}
      viewBox={`0 0 ${ancho} ${alto}`}
      className="block"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={puntos}
        fill="none"
        stroke={color}
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
