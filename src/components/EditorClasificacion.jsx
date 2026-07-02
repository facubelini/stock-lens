import { useState } from 'react'
import { useClasificacion } from '../lib/clasificacion'

const inputCls =
  'mt-1 w-full rounded border border-terminal-border bg-terminal-bg px-2 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

// Boton (lapiz) que abre un modal para editar a mano la industria/sector de
// un ticker. Util para ETFs (no vienen clasificados) o empresas que yfinance
// no categoriza bien. Se guarda en localStorage y pisa el dato automatico en
// todas las pestañas.
export default function EditorClasificacion({ ticker, industria, sector }) {
  const { overrides, setOverride } = useClasificacion()
  const [abierto, setAbierto] = useState(false)
  const o = overrides[ticker] ?? {}
  const [ind, setInd] = useState('')
  const [sec, setSec] = useState('')

  const abrir = () => {
    setInd(o.industria ?? industria ?? '')
    setSec(o.sector ?? sector ?? '')
    setAbierto(true)
  }

  const guardar = () => {
    setOverride(ticker, { industria: ind, sector: sec })
    setAbierto(false)
  }

  const restaurar = () => {
    setOverride(ticker, { industria: '', sector: '' })
    setAbierto(false)
  }

  const editado = Boolean(o.industria || o.sector)

  return (
    <>
      <button
        type="button"
        onClick={abrir}
        title={editado ? 'Clasificacion editada a mano' : 'Editar industria/sector de este ticker'}
        className={`shrink-0 text-xs ${editado ? 'text-terminal-accent' : 'text-terminal-dim'} hover:text-terminal-text`}
      >
        ✏️
      </button>

      {abierto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => setAbierto(false)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-terminal-border bg-terminal-panel p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-sm font-semibold text-terminal-text">
              Clasificación de <span className="text-terminal-accent">{ticker}</span>
            </h3>

            <label className="mb-2 block text-xs text-terminal-dim">
              Industria (específica, ej. Semiconductors)
              <input
                value={ind}
                onChange={(e) => setInd(e.target.value)}
                placeholder={industria || 'Sin clasificar'}
                className={inputCls}
              />
            </label>

            <label className="mb-3 block text-xs text-terminal-dim">
              Sector (general, ej. Technology)
              <input
                value={sec}
                onChange={(e) => setSec(e.target.value)}
                placeholder={sector || 'Sin clasificar'}
                className={inputCls}
              />
            </label>

            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={restaurar}
                className="rounded border border-terminal-border px-2.5 py-1.5 text-xs text-terminal-dim hover:border-terminal-accent hover:text-terminal-text"
              >
                Restaurar automático
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setAbierto(false)}
                  className="rounded border border-terminal-border px-2.5 py-1.5 text-xs text-terminal-dim hover:text-terminal-text"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={guardar}
                  className="rounded bg-terminal-accent px-2.5 py-1.5 text-xs font-semibold text-black hover:opacity-90"
                >
                  Guardar
                </button>
              </div>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-terminal-dim">
              Se guarda en tu navegador y reemplaza la clasificación de yfinance para este ticker
              en Listado, Medias y Fundamentales.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
