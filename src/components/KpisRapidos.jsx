import ComoSeCalcula, { Formula } from './ComoSeCalcula'

// Tira de KPIs clickeables (ver src/lib/filtroGlobal.js): cada tarjeta es un
// filtro de un click sobre la lista de tickers de ESTA página. Un segundo
// click en la misma tarjeta (o en "Tickers activos") lo limpia.
export default function KpisRapidos({ kpis, filtro, toggle }) {
  return (
    <div className="mb-3">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
        {kpis.map((k) => {
          const activo = k.clave === 'total' ? filtro == null : filtro === k.clave
          return (
            <button
              key={k.clave}
              type="button"
              onClick={() => toggle(k.clave)}
              title={k.ayuda}
              aria-pressed={activo}
              className={`rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                activo
                  ? 'border-terminal-accent bg-terminal-accent/10'
                  : 'border-terminal-border bg-terminal-panel hover:border-terminal-accent/50'
              }`}
            >
              <div className="text-[10px] uppercase tracking-wide text-terminal-dim">{k.label}</div>
              <div className={`text-base font-bold tabular ${activo ? 'text-terminal-accent' : 'text-terminal-text'}`}>{k.n}</div>
            </button>
          )
        })}
      </div>
      {filtro && (
        <button
          type="button"
          onClick={() => toggle(filtro)}
          className="mt-1.5 rounded border border-terminal-border px-2 py-0.5 text-[11px] text-terminal-dim hover:text-terminal-text"
        >
          ✕ quitar filtro
        </button>
      )}
      <ComoSeCalcula titulo="¿Cómo se calculan los KPIs?" className="mt-2">
        <p>
          <b className="text-terminal-text">Tickers activos</b>: total de la lista con los filtros de
          arriba (búsqueda/país/industria) ya aplicados. <b className="text-terminal-text">Sobre EMA200</b> /{' '}
          <b className="text-terminal-text">Sobre SMA50</b>: <Formula>dist_ema200_pct</Formula> /{' '}
          <Formula>dist_sma50_pct</Formula> {'>'} 0 en <Formula>warren_score.json</Formula> (pilar Tendencia
          del Warren Score: precio vs EMA200 / SMA50). <b className="text-terminal-text">RS Score {'>'} 70</b>:{' '}
          <Formula>rs_score</Formula> (percentil de fuerza relativa vs SPY) mayor a 70.{' '}
          <b className="text-terminal-text">Volumen inusual</b>: <Formula>vol_ratio ≥ 1,5</Formula> (volumen
          de hoy ≥ 150% del promedio de 20 ruedas), de <Formula>listado.json</Formula>.
        </p>
        <p>
          Solo cuentan los tickers con Warren Score calculado (cotizan en USD y tienen historia
          suficiente): un ticker sin ese dato no entra en esos 3 KPIs, aunque sí en "Tickers activos" y
          "Volumen inusual". Click en una tarjeta filtra la lista de esta página a ese subconjunto; un
          segundo click (o "✕ quitar filtro") lo saca. Es un filtro solo de esta pestaña: no se comparte
          con las demás páginas ni sobrevive a la navegación.
        </p>
      </ComoSeCalcula>
    </div>
  )
}
