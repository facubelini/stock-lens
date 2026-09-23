import { Fragment } from 'react'
import { useJson } from '../lib/useJson'
import { fmtFecha } from '../lib/formato'

// Backtest historico (5 años) de una señal de la app, armado por
// scripts/backtest_score.py / backtest_screener.py (corren mensual via
// GitHub Actions, no en cada visita). Un solo componente parametrizado para
// el Score de Listado y el veredicto del Screener técnico (antes eran dos
// archivos casi identicos). Si el JSON todavía no existe, se omite en
// silencio — es un extra, no algo crítico.
const CONFIGS = {
  score: {
    archivo: 'backtest_score.json',
    titulo: '¿Funciona el Score?',
    columna: 'Nivel de score',
    etiquetaN: 'n por nivel',
    orden: ['FAVORABLE', 'NEUTRAL', 'FLOJO', 'BASELINE'],
    label: {
      FAVORABLE: 'Favorable (≥66)',
      NEUTRAL: 'Neutral (40-65)',
      FLOJO: 'Flojo (<40)',
      BASELINE: 'Cualquier día (base)',
    },
    color: { FAVORABLE: '#7ee2a8', NEUTRAL: '#fbbf62', FLOJO: '#ff9d9d', BASELINE: '#c9d4e0' },
    explicacion: (
      <>
        Aproximación técnica del Score (solo Tendencia + Momentum — Valuación no tiene serie
        histórica de PER/PEG para backtestear, mismo mecanismo que ya usa el Score real cuando le
        falta ese dato). Hit-rate = % de veces que el retorno fue positivo en los N días hábiles
        siguientes, sobre todo el historial disponible, sin look-ahead.
      </>
    ),
  },
  screener: {
    archivo: 'backtest_screener.json',
    titulo: '¿Funciona esto?',
    columna: 'Veredicto',
    etiquetaN: 'n por veredicto',
    orden: ['COMPRA', 'CERCA', 'EXTENDIDO', 'NEUTRAL', 'VENTA', 'BASELINE'],
    label: {
      COMPRA: 'COMPRA',
      CERCA: 'CERCA',
      VENTA: 'VENTA',
      EXTENDIDO: 'EXTENDIDO',
      NEUTRAL: 'NEUTRAL',
      BASELINE: 'Cualquier día (base)',
    },
    color: {
      COMPRA: '#7ee2a8',
      CERCA: '#7dd3fc',
      VENTA: '#ff9d9d',
      EXTENDIDO: '#fbbf62',
      NEUTRAL: '#9aa7b5',
      BASELINE: '#c9d4e0',
    },
    explicacion: (
      <>
        Hit-rate = % de veces que el retorno fue a favor (positivo para COMPRA/CERCA/EXTENDIDO,
        negativo para VENTA) en los N días hábiles siguientes a la señal (veredicto diario), sobre
        todo el historial diario disponible — sin look-ahead, cada punto usa solo datos hasta esa
        fecha.
      </>
    ),
  },
}

// Limitaciones que aplican siempre, aunque el JSON no las traiga en
// `advertencias` (versiones viejas del backtest).
const ADVERTENCIAS_FIJAS = [
  'Sesgo de supervivencia: se backtestea el universo de tickers de hoy, así que no incluye empresas que se deslistaron o quebraron en esos 5 años — los resultados tienden a verse mejor de lo que fueron.',
  'Muestras superpuestas: una señal que dura varios días seguidos cuenta una vez por día y sus ventanas de N días se pisan entre sí, así que los "n" no son observaciones independientes (la significancia real es menor de lo que sugiere el tamaño de muestra).',
]

export default function Backtest({ tipo }) {
  const cfg = CONFIGS[tipo]
  const { data, cargando, error } = useJson(cfg.archivo)
  if (cargando || error || !data?.stats || !Object.keys(data.stats).length) return null

  const { stats, horizontes_dias: horizontes = [], n_tickers_evaluados, actualizado } = data
  const filas = cfg.orden.filter((v) => stats[v])
  const advertenciasJson = Array.isArray(data.advertencias) ? data.advertencias.filter(Boolean) : []
  // Cada nota fija se agrega solo si el pipeline no manda ya una sobre ese tema.
  const textoJson = advertenciasJson.join(' ')
  const advertencias = [
    ...advertenciasJson,
    ...ADVERTENCIAS_FIJAS.filter((_, i) =>
      i === 0 ? !/superviv/i.test(textoJson) : !/superpuest|solapad|overlap/i.test(textoJson),
    ),
  ]

  return (
    <details className="mt-6 rounded-lg border border-terminal-border bg-terminal-panel">
      <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-semibold text-terminal-text">
        📊 {cfg.titulo} Backtest histórico ({n_tickers_evaluados} tickers, 5 años)
      </summary>
      <div className="border-t border-terminal-border p-3">
        <p className="mb-3 text-xs text-terminal-dim">
          {cfg.explicacion} <b>"Cualquier día"</b> es la base de comparación: si un nivel no supera
          claramente esa línea, no está aportando ventaja real. Actualizado:{' '}
          {actualizado ? fmtFecha(actualizado) : '—'} · corre una vez por mes.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                <th className="px-2 py-2 font-semibold">{cfg.columna}</th>
                {horizontes.map((h) => (
                  <th key={h} className="px-2 py-2 text-right font-semibold" colSpan={2}>
                    {h}d hábiles
                  </th>
                ))}
              </tr>
              <tr className="bg-terminal-panel2 text-left text-[10px] uppercase text-terminal-dim">
                <th></th>
                {horizontes.map((h) => (
                  <Fragment key={h}>
                    <th className="px-2 py-1 text-right font-normal">Hit-rate</th>
                    <th className="px-2 py-1 text-right font-normal">Retorno prom.</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {filas.map((v) => (
                <tr key={v} className="border-t border-terminal-border">
                  <td className="px-2 py-1.5 font-semibold" style={{ color: cfg.color[v] }}>
                    {cfg.label[v]}
                  </td>
                  {horizontes.map((h) => {
                    const s = stats[v][String(h)]
                    return (
                      <Fragment key={h}>
                        <td className="px-2 py-1.5 text-right tabular">{s ? `${s.hit_rate}%` : '—'}</td>
                        <td className="px-2 py-1.5 text-right tabular">
                          {s ? `${s.retorno_prom >= 0 ? '+' : ''}${s.retorno_prom}%` : '—'}
                        </td>
                      </Fragment>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {horizontes.length > 0 && (
          <p className="mt-2 text-[11px] text-terminal-dim">
            {cfg.etiquetaN} (a {horizontes[0]}d):{' '}
            {filas.map((v) => `${cfg.label[v]} ${stats[v][String(horizontes[0])]?.n ?? 0}`).join(' · ')}
          </p>
        )}
        <div className="mt-2 rounded border border-terminal-warn/40 bg-terminal-warn/10 px-2.5 py-2 text-[11px] leading-relaxed text-terminal-text">
          <b className="text-terminal-warn">⚠️ Limitaciones:</b>
          <ul className="mt-1 list-disc pl-4">
            {advertencias.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  )
}
