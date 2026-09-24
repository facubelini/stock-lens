import { useEffect, useState } from 'react'
import { useMeta } from '../lib/useJson'
import { chequearFrescura } from '../lib/frescura'

const KEY_DESCARTADO = 'stocklens_banner_stale_descartado'

// Recuerda el timestamp de meta.json que el usuario ya descartó: si el
// pipeline corre de nuevo (ultima_actualizacion cambia) el banner vuelve a
// aparecer aunque siga desactualizado, pero no reaparece en cada recarga de
// la misma corrida vieja ya descartada.
function yaDescartado(ts) {
  try {
    return sessionStorage.getItem(KEY_DESCARTADO) === ts
  } catch {
    return false
  }
}

function descartar(ts) {
  try {
    sessionStorage.setItem(KEY_DESCARTADO, ts)
  } catch {
    /* almacenamiento no disponible: el banner vuelve a aparecer al recargar, sin romper nada */
  }
}

export default function BannerDatosDesactualizados() {
  const meta = useMeta()
  const [, forzarRender] = useState(0)

  // Re-evalua cada 5 min (la pagina puede quedar abierta horas): sin esto,
  // "hace X h" del texto y el pasaje del umbral no se actualizan solos.
  useEffect(() => {
    const id = setInterval(() => forzarRender((n) => n + 1), 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  const ts = meta?.ultima_actualizacion
  if (!ts) return null

  const { desactualizado, horas } = chequearFrescura(ts)
  if (!desactualizado || yaDescartado(ts)) return null

  const horasRedondeadas = Math.floor(horas)

  return (
    <div className="flex items-center justify-between gap-3 border-b border-terminal-warn/40 bg-terminal-warn/10 px-4 py-2 text-sm text-terminal-warn">
      <span>
        ⚠️ Datos desactualizados: última actualización hace {horasRedondeadas} h.
      </span>
      <button
        type="button"
        onClick={() => descartar(ts)}
        className="shrink-0 rounded px-2 py-0.5 text-xs text-terminal-warn hover:bg-terminal-warn/20"
        aria-label="Cerrar aviso"
      >
        ✕
      </button>
    </div>
  )
}
