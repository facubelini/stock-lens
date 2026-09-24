import { useCallback, useMemo, useState } from 'react'
import { useJson } from './useJson'

// Filtro rápido "clickeable" (KPIs) compartido por Listado y Señales: 5
// tarjetas calculadas en el cliente sobre las filas YA CARGADAS de cada
// página, más rs_score / dist_ema200 / dist_sma50 que salen de
// warren_score.json (el mismo archivo que arma el Warren Score) unido por
// ticker — son los campos reales del pilar "tendencia" y "fuerza" del score,
// no un invento nuevo. Alcance deliberado: el filtro vive en el estado de
// CADA página (useState local a la llamada del hook), no es global a toda
// la app ni sobrevive a la navegación entre pestañas.

// warren_score.json trae { actualizado, tickers: { "0": {...}, "1": {...} } }
// (array serializado como objeto). Se indexa una sola vez por ticker.
function indiceWarren(data) {
  const crudo = Array.isArray(data) ? data : Object.values(data?.tickers ?? {})
  const m = new Map()
  for (const w of crudo) {
    if (!w?.ticker) continue
    m.set(w.ticker, {
      rs_score: w.rs_score ?? null,
      dist_ema200_pct: w.pilares?.tendencia?.dist_ema200_pct ?? null,
      dist_sma50_pct: w.pilares?.tendencia?.dist_sma50_pct ?? null,
    })
  }
  return m
}

// Cada KPI define su criterio "ok" sobre la fila enriquecida (con `_w` =
// datos de warren_score.json, o null si el ticker no tiene Warren Score
// calculado, ej. no cotiza en USD).
export const KPIS_RAPIDOS = [
  {
    clave: 'sobre_ema200',
    label: 'Sobre EMA200',
    ayuda: 'Precio > EMA200 (dist_ema200_pct de warren_score.json, pilar Tendencia)',
    ok: (f) => f._w?.dist_ema200_pct != null && f._w.dist_ema200_pct > 0,
  },
  {
    clave: 'sobre_sma50',
    label: 'Sobre SMA50',
    ayuda: 'Precio > SMA50 (dist_sma50_pct de warren_score.json, pilar Tendencia)',
    ok: (f) => f._w?.dist_sma50_pct != null && f._w.dist_sma50_pct > 0,
  },
  {
    clave: 'rs_alto',
    label: 'RS Score > 70',
    ayuda: 'rs_score de warren_score.json > 70 (percentil de fuerza relativa vs SPY)',
    ok: (f) => f._w?.rs_score != null && f._w.rs_score > 70,
  },
  {
    clave: 'vol_inusual',
    label: 'Volumen inusual',
    ayuda: 'vol_ratio (listado.json) ≥ 1,5 — volumen de hoy ≥ 150% del promedio de 20 ruedas',
    ok: (f) => f.vol_ratio != null && f.vol_ratio >= 1.5,
  },
]

// `filas`: el array ya combinado/filtrado de la página (listado.json solo,
// o el combinado con medias+fundamentales — cualquiera sirve, solo hace
// falta el campo `ticker` y, para el KPI de volumen, `vol_ratio`).
export function useFiltroRapido(filas) {
  const { data } = useJson('warren_score.json')
  const [filtro, setFiltro] = useState(null)

  const indice = useMemo(() => indiceWarren(data), [data])

  const enriquecidas = useMemo(
    () => (filas ?? []).map((f) => (f._w !== undefined ? f : { ...f, _w: indice.get(f.ticker) ?? null })),
    [filas, indice],
  )

  const kpis = useMemo(
    () => [
      { clave: 'total', label: 'Tickers activos', ayuda: 'Total con los filtros de arriba aplicados (país/industria/búsqueda)', n: enriquecidas.length },
      ...KPIS_RAPIDOS.map((k) => ({ ...k, n: enriquecidas.filter(k.ok).length })),
    ],
    [enriquecidas],
  )

  // Un segundo click en el mismo KPI (o click en "Tickers activos") limpia
  // el filtro.
  const toggle = useCallback((clave) => {
    setFiltro((actual) => (clave === 'total' || actual === clave ? null : clave))
  }, [])

  const filasFiltradas = useMemo(() => {
    if (!filtro) return enriquecidas
    const kpi = KPIS_RAPIDOS.find((k) => k.clave === filtro)
    return kpi ? enriquecidas.filter(kpi.ok) : enriquecidas
  }, [enriquecidas, filtro])

  return { filtro, toggle, kpis, filas: filasFiltradas }
}
