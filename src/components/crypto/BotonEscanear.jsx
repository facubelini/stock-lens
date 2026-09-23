import { fmtCuenta } from '../../lib/crypto/useEscaneo'

// Boton de escaneo compartido por las tres pestanias que escanean Binance.
// Muestra, en este orden de prioridad: bloqueo de Binance (cuenta regresiva),
// escaneo en curso (progreso), enfriamiento entre escaneos, o la accion.
export default function BotonEscanear({ escaneo, hayDatos }) {
  const { corriendo, progreso, bloqueo, enfriamiento, escanear } = escaneo
  const texto =
    bloqueo > 0
      ? `⛔ bloqueado ${fmtCuenta(bloqueo)}`
      : corriendo
        ? `⏳ ${progreso.hecho}/${progreso.total}`
        : enfriamiento > 0
          ? `⏱ esperá ${enfriamiento}s`
          : hayDatos
            ? '▶ Re-escanear'
            : '▶ Escanear'
  const titulo =
    bloqueo > 0
      ? 'Binance bloqueó la IP por exceso de pedidos. Cada pedido durante el bloqueo lo extiende, así que no se reintenta hasta que pase.'
      : enfriamiento > 0
        ? 'Pausa corta entre escaneos: uno completo consume ~1000 de los 2400 de peso por minuto que da Binance.'
        : undefined
  return (
    <button
      type="button"
      onClick={escanear}
      disabled={corriendo || bloqueo > 0 || enfriamiento > 0}
      title={titulo}
      className="rounded bg-terminal-accent px-3 py-1.5 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50"
    >
      {texto}
    </button>
  )
}

// Aviso cuando el usuario cambia temporalidad / ATR despues de escanear: la
// tabla (y la calculadora) siguen mostrando lo escaneado con los parametros
// VIEJOS hasta que se vuelva a escanear.
export function AvisoParametros({ visible, escaneados }) {
  if (!visible) return null
  return (
    <div className="mb-4 rounded border border-terminal-warn/30 bg-terminal-warn/10 px-3 py-2 text-xs leading-relaxed text-terminal-warn">
      ⚠️ <b>Parámetros cambiados, volvé a escanear.</b> La tabla y la calculadora siguen mostrando el escaneo
      hecho con {escaneados}.
    </div>
  )
}
