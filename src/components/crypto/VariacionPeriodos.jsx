import { useEffect, useState } from 'react'
import { getKlines } from '../../lib/crypto/binanceApi'
import { calcularVariaciones } from '../../lib/crypto/indicadores'

// Cuanto subio/bajo en 1 hora, 4 horas y 1 dia.
//
// Se pide una serie de 15m aparte (97 velas = 24h + la en curso) en vez de
// derivarlo de la temporalidad elegida arriba, por dos razones:
//  1. Con velas de 4h o diarias no habria forma de sacar la ventana de 1 hora.
//  2. Con velas de 15m la ventana queda con error de 15 minutos como maximo,
//     en vez de arrastrar el tamanio de la vela elegida.
// Cuesta 1 solo pedido de peso 1 (limit < 100) y recien cuando abris la ficha.
export default function VariacionPeriodos({ symbolRaw }) {
  const [v, setV] = useState(undefined) // undefined = cargando · null = sin datos

  useEffect(() => {
    if (!symbolRaw) return
    let activo = true
    setV(undefined)
    getKlines(symbolRaw, '15m', 97)
      .then((k) => activo && setV(calcularVariaciones(k)))
      .catch(() => activo && setV(null))
    return () => {
      activo = false
    }
  }, [symbolRaw])

  if (!symbolRaw) return null

  const celda = (etiqueta, val, ayuda) => (
    <div className="text-xs" title={ayuda}>
      <span className="mb-0.5 block text-[10px] uppercase text-terminal-dim">{etiqueta}</span>
      {val == null ? (
        <span className="font-bold text-terminal-dim">{v === undefined ? '…' : '—'}</span>
      ) : (
        <span className={`font-bold ${val >= 0 ? 'text-terminal-up' : 'text-terminal-down'}`}>
          {val >= 0 ? '+' : ''}
          {val}%
        </span>
      )}
    </div>
  )

  return (
    <div>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
        Variación
      </div>
      <div className="grid grid-cols-3 gap-1.5 rounded bg-terminal-bg p-3">
        {celda('1 hora', v?.h1, 'Precio de ahora contra el cierre de 4 velas de 15m atrás')}
        {celda('4 horas', v?.h4, 'Precio de ahora contra el cierre de 16 velas de 15m atrás')}
        {celda('1 día', v?.d1, 'Precio de ahora contra el cierre de 96 velas de 15m atrás (24h)')}
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-terminal-dim">
        Ventanas fijas, calculadas con velas de 15m (precisión ±15 min). No dependen de la
        temporalidad elegida arriba.
      </p>
    </div>
  )
}
