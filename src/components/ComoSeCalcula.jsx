// Bloque desplegable "¿Cómo se calcula?": cada número de la app tiene que
// poder mostrar su fórmula y su criterio, no solo el resultado. Mismo estilo
// que los <details> de Glosario/Backtest.
export default function ComoSeCalcula({ titulo = '¿Cómo se calcula?', children, className = 'mb-4' }) {
  return (
    <details className={`${className} rounded-lg border border-terminal-border bg-terminal-panel`}>
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-terminal-text hover:text-terminal-accent">
        🧮 {titulo}
      </summary>
      <div className="flex flex-col gap-1.5 border-t border-terminal-border px-3 py-2.5 text-[11px] leading-relaxed text-terminal-dim">
        {children}
      </div>
    </details>
  )
}

// Fórmula en monoespaciado resaltado.
export function Formula({ children }) {
  return <code className="rounded bg-terminal-bg px-1 py-0.5 text-terminal-text">{children}</code>
}
