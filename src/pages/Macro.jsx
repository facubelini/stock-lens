import { useJson } from '../lib/useJson'
import { fmtFecha } from '../lib/formato'

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

function fmtMes(fechaIso) {
  if (!fechaIso) return '—'
  const [anio, mes] = fechaIso.split('-')
  return `${MESES[Number(mes) - 1]} ${anio}`
}

function colorFearGreed(v) {
  if (v == null) return '#7d8b9c'
  if (v < 25) return '#ef4444'
  if (v < 45) return '#f97316'
  if (v < 55) return '#f5a524'
  if (v < 75) return '#84cc16'
  return '#22c55e'
}

function GaugeFearGreed({ titulo, valor, clasificacion, historial, nota }) {
  const color = colorFearGreed(valor)
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-terminal-text">{titulo}</h3>
        {valor != null && (
          <span className="text-2xl font-bold tabular" style={{ color }}>
            {valor}
          </span>
        )}
      </div>
      {valor != null ? (
        <>
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-gradient-to-r from-terminal-down via-terminal-accent to-terminal-up">
            <div className="absolute top-0 h-full w-0.5 bg-white" style={{ left: `${valor}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] text-terminal-dim">
            <span>Miedo extremo</span>
            <span>Codicia extrema</span>
          </div>
          <p className="mt-2 text-xs font-semibold" style={{ color }}>
            {clasificacion}
          </p>
          {historial && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-terminal-dim">
              {historial.map(([label, v]) => (
                <span key={label}>
                  {label}: <span className="text-terminal-text">{v ?? '—'}</span>
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-terminal-dim">Sin datos disponibles.</p>
      )}
      {nota && <p className="mt-2.5 text-[11px] text-terminal-dim">{nota}</p>}
    </div>
  )
}

function TarjetaVix({ vix }) {
  const v = vix?.valor
  const { nivel, color } =
    v == null
      ? { nivel: null, color: '#7d8b9c' }
      : v < 15
        ? { nivel: 'Complacencia', color: '#22c55e' }
        : v < 20
          ? { nivel: 'Normal', color: '#f5a524' }
          : v < 30
            ? { nivel: 'Nerviosismo', color: '#f97316' }
            : { nivel: 'Pánico', color: '#ef4444' }

  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-4">
      <h3 className="mb-3 text-sm font-semibold text-terminal-text">VIX</h3>
      {v != null ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular" style={{ color }}>
              {v.toFixed(2)}
            </span>
            {vix.cambio_pct != null && (
              <span className={`text-xs font-medium ${vix.cambio_pct >= 0 ? 'text-terminal-down' : 'text-terminal-up'}`}>
                {vix.cambio_pct >= 0 ? '+' : ''}
                {vix.cambio_pct.toFixed(2)}%
              </span>
            )}
          </div>
          <p className="mt-2 text-xs font-semibold" style={{ color }}>
            {nivel}
          </p>
        </>
      ) : (
        <p className="text-xs text-terminal-dim">Sin datos disponibles.</p>
      )}
      <p className="mt-2.5 text-[11px] text-terminal-dim">
        Volatilidad implícita del S&P 500. Sube cuando el mercado espera turbulencia — por debajo
        de ~15 suele reflejar calma (o complacencia), por encima de ~30, pánico.
      </p>
    </div>
  )
}

function TarjetaYieldCurve({ yc }) {
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-4">
      <h3 className="mb-3 text-sm font-semibold text-terminal-text">Curva de rendimientos (10a vs. 3m)</h3>
      {yc ? (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-[10px] uppercase text-terminal-dim">10 años</div>
              <div className="tabular font-semibold text-terminal-text">{yc.diez_anios.toFixed(2)}%</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-terminal-dim">3 meses</div>
              <div className="tabular font-semibold text-terminal-text">{yc.tres_meses.toFixed(2)}%</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-terminal-dim">Spread</div>
              <div
                className="tabular font-semibold"
                style={{ color: yc.invertida ? '#ef4444' : '#22c55e' }}
              >
                {yc.spread >= 0 ? '+' : ''}
                {yc.spread.toFixed(2)}
              </div>
            </div>
          </div>
          {yc.invertida ? (
            <p className="mt-2.5 text-xs font-semibold text-terminal-down">
              ⚠️ Curva invertida — históricamente uno de los indicadores de recesión más seguidos
              (aunque con retrasos largos e inciertos).
            </p>
          ) : (
            <p className="mt-2.5 text-[11px] text-terminal-dim">
              Curva normal (10 años rinde más que 3 meses). Cuando se invierte (spread negativo) es
              una señal de alerta de recesión que el mercado observa de cerca.
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-terminal-dim">Sin datos disponibles.</p>
      )}
    </div>
  )
}

function TarjetaIndicador({ titulo, valor, unidad, actualizado, nota }) {
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-4 text-center">
      <div className="text-[10px] uppercase text-terminal-dim">{titulo}</div>
      <div className="mt-1 tabular text-xl font-bold text-terminal-text">
        {valor != null ? `${valor}${unidad}` : 'N/D'}
      </div>
      <div className="mt-0.5 text-[11px] text-terminal-dim">{fmtMes(actualizado)}</div>
      {nota && <p className="mt-2 text-[11px] leading-relaxed text-terminal-dim">{nota}</p>}
    </div>
  )
}

export default function Macro() {
  const { data, cargando, error } = useJson('mercado_macro.json')

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Mercado &amp; Macro</h1>
        <p className="text-xs text-terminal-dim">
          Contexto general del mercado y de la economía de EEUU — no es sobre un ticker en
          particular, es el clima en el que están operando todos.{' '}
          {data?.actualizado && (
            <>
              Actualizado: <span className="text-terminal-text">{fmtFecha(data.actualizado)}</span>
            </>
          )}
        </p>
      </div>

      {cargando ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-32 rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-terminal-down/40 bg-terminal-down/10 p-6 text-center">
          <p className="font-semibold text-terminal-down">No se pudieron cargar los datos</p>
          <p className="text-sm text-terminal-dim">{error}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-terminal-dim">
              Fear &amp; Greed
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <GaugeFearGreed
                titulo="Acciones (CNN)"
                valor={data?.fear_greed_acciones?.valor}
                clasificacion={data?.fear_greed_acciones?.clasificacion}
                historial={
                  data?.fear_greed_acciones && [
                    ['Ayer', data.fear_greed_acciones.prev_cierre],
                    ['Semana pasada', data.fear_greed_acciones.prev_semana],
                    ['Mes pasado', data.fear_greed_acciones.prev_mes],
                    ['Año pasado', data.fear_greed_acciones.prev_anio],
                  ]
                }
                nota="Fuente no oficial (CNN no publica una API documentada) — puede fallar temporalmente."
              />
              <GaugeFearGreed
                titulo="Cripto (alternative.me)"
                valor={data?.fear_greed_cripto?.valor}
                clasificacion={data?.fear_greed_cripto?.clasificacion}
              />
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-terminal-dim">
              Volatilidad y tasas
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TarjetaVix vix={data?.vix} />
              <TarjetaYieldCurve yc={data?.yield_curve} />
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-terminal-dim">
              Indicadores clave de EEUU
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <TarjetaIndicador
                titulo="Inflación (CPI, interanual)"
                valor={data?.indicadores_usa?.cpi_yoy}
                unidad="%"
                actualizado={data?.indicadores_usa?.cpi_actualizado}
                nota="Variación del índice de precios al consumidor vs. el mismo mes del año pasado."
              />
              <TarjetaIndicador
                titulo="Desempleo"
                valor={data?.indicadores_usa?.desempleo}
                unidad="%"
                actualizado={data?.indicadores_usa?.desempleo_actualizado}
                nota="Tasa de desempleo (BLS) — más de un aumento sostenido suele preceder recortes de tasas."
              />
              <TarjetaIndicador
                titulo="Tasa de la Fed"
                valor={data?.indicadores_usa?.fed_funds}
                unidad="%"
                actualizado={data?.indicadores_usa?.fed_funds_actualizado}
                nota="Fed Funds Rate efectiva — referencia para todo el costo del crédito en dólares."
              />
            </div>
            <p className="mt-2 text-[11px] text-terminal-dim">
              Fuente: FRED (Reserva Federal de St. Louis) — datos oficiales, con la demora habitual
              de publicación de cada organismo (mensual).
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
