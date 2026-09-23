import { useState } from 'react'
import { getPat, dispararActualizacionDatos } from '../lib/githubApi'

// Boton "🔄 Actualizar ahora" (dispara el workflow "Actualizar datos" fuera
// del cron) + mensaje de resultado. Compartido por Screener técnico y Scanner.
export default function BotonActualizar() {
  const [refresh, setRefresh] = useState(null) // { tipo: 'cargando'|'ok'|'error', texto }

  const onRefrescar = async () => {
    if (!getPat()) {
      setRefresh({
        tipo: 'error',
        texto: 'Configurá tu GitHub token (barra superior, "🔑 Configurar auto") para poder disparar la actualización.',
      })
      return
    }
    setRefresh({ tipo: 'cargando' })
    try {
      await dispararActualizacionDatos()
      setRefresh({
        tipo: 'ok',
        texto:
          'Actualización disparada. El pipeline tarda unos minutos en correr y GitHub Pages cachea los JSON hasta 10 min más.',
      })
    } catch (err) {
      setRefresh({ tipo: 'error', texto: err.message })
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onRefrescar}
        disabled={refresh?.tipo === 'cargando'}
        className="whitespace-nowrap rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-xs text-terminal-dim hover:border-terminal-accent hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-50"
        title="Dispara el pipeline (Actualizar datos) fuera del cron habitual"
      >
        {refresh?.tipo === 'cargando' ? '⏳ Actualizando…' : '🔄 Actualizar ahora'}
      </button>
      {refresh && refresh.tipo !== 'cargando' && (
        <span
          role="status"
          className={`max-w-xs text-right text-[11px] leading-snug ${
            refresh.tipo === 'error' ? 'text-terminal-down' : 'text-terminal-accent'
          }`}
        >
          {refresh.texto}
        </span>
      )}
    </div>
  )
}
