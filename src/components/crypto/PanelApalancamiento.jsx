import { Link } from 'react-router-dom'
import CalculadoraApalancamiento from './CalculadoraApalancamiento'

// Panel lateral con la calculadora de apalancamiento/liquidacion. Compartido
// por "Crypto Screener" y "Acciones Tokenizadas"; 'to' es el link a la ficha
// del simbolo, que cambia segun la pestania (/cripto vs /tokenizadas).
export default function PanelApalancamiento({ fila, klines, atrMult, to, onCerrar }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onCerrar}>
      <div
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l-2 border-terminal-border bg-terminal-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-terminal-border bg-terminal-panel px-4 py-3">
          <Link
            to={to}
            className="flex-1 font-semibold text-terminal-text hover:text-terminal-accent hover:underline"
            onClick={onCerrar}
            title="Ver en su propia página"
          >
            {fila.symbol}
          </Link>
          <button
            type="button"
            onClick={onCerrar}
            className="rounded border border-terminal-border px-2 py-1 text-xs text-terminal-dim hover:text-terminal-text"
          >
            ✕
          </button>
        </div>
        <CalculadoraApalancamiento fila={fila} klines={klines} atrMult={atrMult} />
      </div>
    </div>
  )
}
