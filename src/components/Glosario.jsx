import { GLOSARIO } from '../lib/glosario'

// Panel desplegable con la definición y guía de cada ratio.
export default function Glosario() {
  return (
    <details className="mb-4 rounded-lg border border-terminal-border bg-terminal-panel">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-semibold text-terminal-text hover:text-terminal-accent">
        📖 ¿Qué significa cada ratio? — glosario y valores de referencia
      </summary>
      <div className="grid gap-3 border-t border-terminal-border p-3 sm:grid-cols-2 lg:grid-cols-3">
        {GLOSARIO.map((g) => (
          <div key={g.clave} className="text-xs leading-relaxed">
            <div className="font-semibold text-terminal-accent">{g.label}</div>
            <div className="text-terminal-text">{g.def}</div>
            <div className="mt-0.5 text-terminal-dim">{g.guia}</div>
          </div>
        ))}
      </div>
      <p className="border-t border-terminal-border px-3 py-2 text-[11px] text-terminal-dim">
        Los múltiplos “normales” dependen mucho de la industria. Activá{' '}
        <b>Agrupar por industria</b> para ver la <b>mediana de cada grupo</b> como parámetro real.
      </p>
    </details>
  )
}
