import { useState } from 'react'
import { useClasificacion } from '../lib/clasificacion'
import { getPat, quitarTickerRemoto } from '../lib/githubApi'

const inputCls =
  'mt-1 w-full rounded border border-terminal-border bg-terminal-bg px-2 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

const OTRA = '__otra__'

// <select> con las categorias que ya existen en los datos + opcion para
// escribir una nueva. `valor`/`onValor` manejan el string final a guardar;
// `esOtra`/`setEsOtra` controlan si se esta escribiendo una nueva o no.
function SelectCategoria({ valor, onValor, esOtra, setEsOtra, opciones, placeholder }) {
  return (
    <>
      <select
        value={esOtra ? OTRA : valor}
        onChange={(e) => {
          if (e.target.value === OTRA) {
            setEsOtra(true)
            onValor('')
          } else {
            setEsOtra(false)
            onValor(e.target.value)
          }
        }}
        className={inputCls}
      >
        <option value="">— Sin clasificar —</option>
        {opciones.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
        <option value={OTRA}>➕ Otra (escribir)</option>
      </select>
      {esOtra && (
        <input
          value={valor}
          onChange={(e) => onValor(e.target.value)}
          placeholder={placeholder || 'Escribí la nueva categoría'}
          className={inputCls}
          autoFocus
        />
      )}
    </>
  )
}

// Boton (lapiz) que abre un modal para editar a mano la categoria/subcategoria
// (sector/industria) de un ticker. Util para ETFs (no vienen clasificados) o
// empresas que yfinance no categoriza bien. Se guarda en localStorage y pisa
// el dato automatico en todas las pestañas.
export default function EditorClasificacion({
  ticker,
  industria,
  sector,
  industrias = [],
  sectores = [],
}) {
  const { overrides, setOverride } = useClasificacion()
  const [abierto, setAbierto] = useState(false)
  const o = overrides[ticker] ?? {}
  const [ind, setInd] = useState('')
  const [sec, setSec] = useState('')
  const [indEsOtra, setIndEsOtra] = useState(false)
  const [secEsOtra, setSecEsOtra] = useState(false)
  const [confirmarBaja, setConfirmarBaja] = useState(false)
  const [estadoBaja, setEstadoBaja] = useState(null) // { tipo: 'cargando'|'ok'|'error', texto? }

  const abrir = () => {
    const indActual = o.industria ?? industria ?? ''
    const secActual = o.sector ?? sector ?? ''
    setInd(indActual)
    setSec(secActual)
    setIndEsOtra(Boolean(indActual) && !industrias.includes(indActual))
    setSecEsOtra(Boolean(secActual) && !sectores.includes(secActual))
    setConfirmarBaja(false)
    setEstadoBaja(null)
    setAbierto(true)
  }

  const eliminarDelRepo = async () => {
    if (!confirmarBaja) {
      setConfirmarBaja(true)
      return
    }
    setEstadoBaja({ tipo: 'cargando' })
    try {
      const r = await quitarTickerRemoto(ticker)
      setEstadoBaja({
        tipo: 'ok',
        texto: r.eliminado
          ? 'sacado de tickers.xlsx, la actualización de datos ya arrancó.'
          : 'ya no estaba en tickers.xlsx.',
      })
    } catch (err) {
      setConfirmarBaja(false)
      setEstadoBaja({ tipo: 'error', texto: err.message })
    }
  }

  const guardar = () => {
    setOverride(ticker, { industria: ind, sector: sec })
    setAbierto(false)
  }

  const restaurar = () => {
    setOverride(ticker, { industria: '', sector: '' })
    setIndEsOtra(false)
    setSecEsOtra(false)
    setAbierto(false)
  }

  const editado = Boolean(o.industria || o.sector)

  return (
    <>
      <button
        type="button"
        onClick={abrir}
        title={editado ? 'Clasificacion editada a mano' : 'Editar categoría/subcategoría de este ticker'}
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
              Categoría (sector, general — ej. Technology)
              <SelectCategoria
                valor={sec}
                onValor={setSec}
                esOtra={secEsOtra}
                setEsOtra={setSecEsOtra}
                opciones={sectores}
                placeholder={sector || 'Escribí el sector'}
              />
            </label>

            <label className="mb-3 block text-xs text-terminal-dim">
              Subcategoría (industria, específica — ej. Semiconductors)
              <SelectCategoria
                valor={ind}
                onValor={setInd}
                esOtra={indEsOtra}
                setEsOtra={setIndEsOtra}
                opciones={industrias}
                placeholder={industria || 'Escribí la industria'}
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

            <div className="mt-3 border-t border-terminal-border pt-3">
              {getPat() ? (
                estadoBaja?.tipo === 'ok' ? (
                  <p className="text-xs text-terminal-accent">✓ {ticker}: {estadoBaja.texto}</p>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={eliminarDelRepo}
                      disabled={estadoBaja?.tipo === 'cargando'}
                      className={`rounded border px-2.5 py-1.5 text-xs disabled:opacity-50 ${
                        confirmarBaja
                          ? 'border-terminal-down bg-terminal-down/20 text-terminal-down'
                          : 'border-terminal-border text-terminal-dim hover:border-terminal-down hover:text-terminal-down'
                      }`}
                    >
                      {estadoBaja?.tipo === 'cargando'
                        ? 'Eliminando…'
                        : confirmarBaja
                          ? `¿Seguro? Confirmar baja de ${ticker}`
                          : '🗑️ Eliminar de tickers.xlsx'}
                    </button>
                    {estadoBaja?.tipo === 'error' && (
                      <p className="mt-1.5 text-[11px] text-terminal-down">{estadoBaja.texto}</p>
                    )}
                    <p className="mt-1.5 text-[11px] text-terminal-dim">
                      Lo saca del universo del pipeline para siempre (no solo de tu lista) — útil si
                      se deslistó o ya no te interesa seguirlo.
                    </p>
                  </>
                )
              ) : (
                <p className="text-[11px] text-terminal-dim">
                  Para eliminar tickers del pipeline sin pasos manuales, activá el alta/baja
                  automática con el botón 🔑 de la barra de arriba.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
