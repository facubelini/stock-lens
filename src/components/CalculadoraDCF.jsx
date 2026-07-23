import { useMemo, useState } from 'react'
import { calcularDCF, DCF_DEFAULTS } from '../lib/valuacionIntrinseca'
import { fmtPrecio, fmtPct, estiloValor } from '../lib/formato'

const inputCls =
  'w-full rounded border border-terminal-border bg-terminal-bg px-2 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

// Calculadora DCF interactiva y compartida (Valuaciones.jsx + TickerDetalle).
// El resultado depende 100% de los supuestos que ponga quien la usa — por
// eso no hay un "valor DCF" fijo en ningun lado de la app, solo esta
// calculadora. fcfPorAccion pre-carga el dato real (gratis via yfinance),
// pero se puede pisar a mano si se quiere simular otro escenario.
export default function CalculadoraDCF({ ticker, precio, fcfPorAccion }) {
  const [crecimientoAnualPct, setCrecimiento] = useState(DCF_DEFAULTS.crecimientoAnualPct)
  const [aniosProyeccion, setAnios] = useState(DCF_DEFAULTS.aniosProyeccion)
  const [tasaDescuentoPct, setTasa] = useState(DCF_DEFAULTS.tasaDescuentoPct)
  const [crecimientoTerminalPct, setTerminal] = useState(DCF_DEFAULTS.crecimientoTerminalPct)
  const [fcfManual, setFcfManual] = useState('')

  const fcfUsado = fcfManual !== '' ? Number(fcfManual) : fcfPorAccion

  const valor = useMemo(
    () =>
      calcularDCF({
        fcfPorAccion: fcfUsado,
        crecimientoAnualPct,
        aniosProyeccion,
        tasaDescuentoPct,
        crecimientoTerminalPct,
      }),
    [fcfUsado, crecimientoAnualPct, aniosProyeccion, tasaDescuentoPct, crecimientoTerminalPct],
  )

  const margenSeguridad = valor != null && precio ? (valor / precio - 1) * 100 : null

  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-4">
      <h3 className="mb-3 text-sm font-semibold text-terminal-text">
        Calculadora DCF{ticker ? ` · ${ticker}` : ''}
      </h3>

      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div>
          <label className="mb-1 block text-[10px] uppercase text-terminal-dim">FCF/acción (USD)</label>
          <input
            type="number"
            step="0.01"
            value={fcfManual !== '' ? fcfManual : (fcfPorAccion ?? '')}
            onChange={(e) => setFcfManual(e.target.value)}
            placeholder={fcfPorAccion == null ? 'sin dato — ingresá uno' : undefined}
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] uppercase text-terminal-dim">Crecimiento anual %</label>
          <input
            type="number"
            step="0.5"
            value={crecimientoAnualPct}
            onChange={(e) => setCrecimiento(Number(e.target.value))}
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] uppercase text-terminal-dim">Años proyección</label>
          <input
            type="number"
            step="1"
            min="1"
            max="30"
            value={aniosProyeccion}
            onChange={(e) => setAnios(Number(e.target.value))}
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] uppercase text-terminal-dim">Tasa descuento %</label>
          <input
            type="number"
            step="0.5"
            value={tasaDescuentoPct}
            onChange={(e) => setTasa(Number(e.target.value))}
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] uppercase text-terminal-dim">Crec. terminal %</label>
          <input
            type="number"
            step="0.1"
            value={crecimientoTerminalPct}
            onChange={(e) => setTerminal(Number(e.target.value))}
            className={inputCls}
          />
        </div>
      </div>

      {valor == null ? (
        <p className="text-xs text-terminal-dim">
          {fcfUsado == null || Number.isNaN(fcfUsado) || fcfUsado <= 0
            ? 'Sin flujo de caja libre válido para simular — ingresá uno manualmente arriba.'
            : 'La tasa de descuento tiene que ser mayor al crecimiento terminal (si no, el valor terminal diverge).'}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded border border-terminal-border px-3 py-2 text-center">
            <div className="text-[10px] uppercase text-terminal-dim">Valor DCF / acción</div>
            <div className="text-lg font-bold tabular text-terminal-text">${fmtPrecio(valor)}</div>
          </div>
          {precio != null && (
            <>
              <div className="rounded border border-terminal-border px-3 py-2 text-center">
                <div className="text-[10px] uppercase text-terminal-dim">Precio actual</div>
                <div className="text-lg font-bold tabular text-terminal-text">${fmtPrecio(precio)}</div>
              </div>
              <div className="rounded border border-terminal-border px-3 py-2 text-center" style={estiloValor(margenSeguridad, 30)}>
                <div className="text-[10px] uppercase opacity-80">Margen de seguridad</div>
                <div className="text-lg font-bold tabular">{fmtPct(margenSeguridad, { signo: true })}</div>
              </div>
            </>
          )}
        </div>
      )}
      <p className="mt-2 text-[11px] text-terminal-dim">
        Flujo de caja descontado a {aniosProyeccion} años + valor terminal (modelo de Gordon). El
        resultado depende 100% de los supuestos que pongas arriba — no es un dato objetivo, es tu
        propia simulación. Margen de seguridad positivo = el DCF sugiere que cotiza por debajo de
        tu estimación de valor.
      </p>
    </div>
  )
}
