import { useMemo } from 'react'

// Compartido entre TickerDetalle (acciones) y CryptoDetalle (cripto): barras
// de retorno promedio por mes calendario. `datos` es un array de
// { mes: 1-12, retorno_prom, positivos_pct, n }, ya calculado por quien lo
// use (Python para acciones, indicadores.js para cripto) — este componente
// solo dibuja.
const MESES_CORTO = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

export default function GraficoEstacionalidad({ datos }) {
  const porMes = useMemo(() => new Map(datos.map((d) => [d.mes, d])), [datos])
  const maxAbs = useMemo(() => Math.max(1, ...datos.map((d) => Math.abs(d.retorno_prom ?? 0))), [datos])
  return (
    <div>
      <div className="flex h-24 items-stretch gap-1">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((mes) => {
          const d = porMes.get(mes)
          const positivo = (d?.retorno_prom ?? 0) >= 0
          const alturaPct = d ? (Math.abs(d.retorno_prom) / maxAbs) * 45 : 0
          return (
            <div
              key={mes}
              className="relative flex-1"
              title={
                d
                  ? `${MESES_CORTO[mes - 1]}: ${d.retorno_prom >= 0 ? '+' : ''}${d.retorno_prom}% promedio · ${d.positivos_pct}% de los períodos fue positivo (n=${d.n})`
                  : `${MESES_CORTO[mes - 1]}: sin datos suficientes`
              }
            >
              <div className="absolute inset-x-0 top-1/2 h-px bg-terminal-border" />
              {d && (
                <div
                  className="absolute inset-x-0.5 rounded-sm"
                  style={{
                    backgroundColor: positivo ? '#22c55e' : '#ef4444',
                    height: `${alturaPct}%`,
                    ...(positivo ? { bottom: '50%' } : { top: '50%' }),
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex gap-1 text-center text-[9px] text-terminal-dim">
        {MESES_CORTO.map((m) => (
          <span key={m} className="flex-1">
            {m}
          </span>
        ))}
      </div>
    </div>
  )
}
