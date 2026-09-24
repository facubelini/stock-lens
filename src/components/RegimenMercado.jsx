import ComoSeCalcula, { Formula } from './ComoSeCalcula'
import { Anillo, colorScore } from './WarrenScoreVisual'

// Panel "Régimen de Mercado": contexto general (no una señal de compra de un
// ticker puntual) armado por el pipeline en 3 capas — índices (SPY/QQQ),
// amplitud del universo y sentimiento (VIX + put/call). Ver
// `regimen` dentro de mercado_macro.json.
//
// El `detalle` de cada capa lo arma el pipeline y puede traer distintas
// claves según la capa; en vez de hardcodear cada campo posible, se itera
// genéricamente sobre sus keys con etiquetas conocidas y un fallback legible
// para las que no se reconocen (así el panel no se rompe si el pipeline
// agrega/saca un campo).
const ETIQUETAS_DETALLE = {
  spy_tendencia: 'Tendencia SPY',
  qqq_tendencia: 'Tendencia QQQ',
  spy_sobre_media: 'SPY sobre su media',
  qqq_sobre_media: 'QQQ sobre su media',
  spy_pts: 'Puntos SPY',
  qqq_pts: 'Puntos QQQ',
  nuevos_maximos: 'Nuevos máximos (52 sem.)',
  nuevos_minimos: 'Nuevos mínimos (52 sem.)',
  avance_declive: 'Avance/declive',
  pct_sobre_media200: '% del universo sobre su media de 200',
  pct_sobre_media50: '% del universo sobre su media de 50',
  vix: 'VIX',
  vix_pts: 'Puntos por VIX',
  put_call: 'Put/Call',
  put_call_pts: 'Puntos por put/call',
  zona_intermedia: 'Zona intermedia (mixta)',
}

function etiquetaDeClave(clave) {
  if (ETIQUETAS_DETALLE[clave]) return ETIQUETAS_DETALLE[clave]
  // Fallback: "algo_asi" -> "Algo asi".
  const texto = clave.replace(/_/g, ' ')
  return texto.charAt(0).toUpperCase() + texto.slice(1)
}

function fmtValorDetalle(v) {
  if (v == null) return '—'
  if (typeof v === 'boolean') return v ? 'Sí' : 'No'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  return String(v)
}

function FilaDetalle({ clave, valor }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{etiquetaDeClave(clave)}</span>
      <span className="tabular text-terminal-text">{fmtValorDetalle(valor)}</span>
    </div>
  )
}

function DetalleCapa({ detalle }) {
  const entradas = Object.entries(detalle ?? {}).filter(([, v]) => v !== undefined)
  if (!entradas.length) return null
  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t border-terminal-border pt-2 text-[11px] text-terminal-dim">
      {entradas.map(([clave, valor]) => {
        // La capa "índices" trae un sub-objeto por cada índice (SPY/QQQ) en
        // vez de un valor plano: se abre en su propio bloque con subtítulo.
        if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
          const sub = Object.entries(valor).filter(([, v]) => v !== undefined)
          if (!sub.length) return null
          return (
            <div key={clave} className="flex flex-col gap-0.5">
              <span className="font-semibold text-terminal-text">{clave}</span>
              {sub.map(([k, v]) => (
                <FilaDetalle key={k} clave={k} valor={v} />
              ))}
            </div>
          )
        }
        return <FilaDetalle key={clave} clave={clave} valor={valor} />
      })}
    </div>
  )
}

function TarjetaCapa({ titulo, capa }) {
  const pts = capa?.pts ?? null
  const max = capa?.max ?? null
  const pct = pts != null && max ? Math.max(0, Math.min(1, pts / max)) * 100 : 0
  const color = colorScore(pct)
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <h3 className="text-xs font-semibold text-terminal-text">{titulo}</h3>
        <span className="tabular text-sm font-bold" style={{ color }}>
          {pts != null ? pts : 'N/D'}
          {max != null && <span className="text-terminal-dim"> / {max}</span>}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-terminal-border">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      {titulo === 'Sentimiento' && capa?.pc_disponible === false && (
        <p className="mt-2 text-[11px] text-terminal-warn">
          ⚠️ Put/call no disponible en esta corrida — el puntaje de sentimiento sale sólo del VIX.
        </p>
      )}
      <DetalleCapa detalle={capa?.detalle} />
    </div>
  )
}

export default function RegimenMercado({ regimen }) {
  if (!regimen) {
    return (
      <div className="rounded-lg border border-terminal-border bg-terminal-panel p-4 text-center text-xs text-terminal-dim">
        Régimen de mercado todavía no disponible, se agrega en la próxima corrida del pipeline.
      </div>
    )
  }

  const { score, max = 100, criterio_exposicion, capas } = regimen
  const scoreNormalizado = max ? (score / max) * 100 : score

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center gap-3 rounded-lg border border-terminal-border bg-terminal-panel p-5 sm:flex-row sm:items-center sm:justify-center sm:gap-6">
        <Anillo score={scoreNormalizado} tam={96} />
        <div className="text-center sm:text-left">
          <div className="text-[10px] uppercase tracking-wide text-terminal-dim">Score de régimen</div>
          <div className="tabular text-2xl font-bold text-terminal-text">
            {score} <span className="text-sm font-normal text-terminal-dim">/ {max}</span>
          </div>
          {criterio_exposicion && (
            <p className="mt-1 max-w-md text-xs font-semibold text-terminal-accent">{criterio_exposicion}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TarjetaCapa titulo="Índices (SPY/QQQ)" capa={capas?.indices} />
        <TarjetaCapa titulo="Amplitud" capa={capas?.amplitud} />
        <TarjetaCapa titulo="Sentimiento" capa={capas?.sentimiento} />
      </div>

      <p className="text-[11px] text-terminal-dim">
        Esto <b className="text-terminal-text">no es una señal de compra de ningún ticker en particular</b> — es el
        contexto general en el que están operando todos. Un score alto no implica comprar cualquier cosa, y uno bajo
        no implica vender todo; ayuda a calibrar cuánta exposición tiene sentido tener en general.
      </p>

      <ComoSeCalcula titulo="¿Cómo se calcula el Régimen de Mercado?">
        <p>
          Suma de 3 capas independientes, cada una con su propio tope de puntos:{' '}
          <Formula>score = índices + amplitud + sentimiento</Formula>.
        </p>
        <p>
          <b className="text-terminal-text">Índices (SPY/QQQ)</b>: tendencia de los dos índices de referencia (S&amp;P
          500 vía SPY y Nasdaq 100 vía QQQ) respecto de sus medias móviles — cuánto suman depende de si están por
          encima o por debajo, y hace cuánto.
        </p>
        <p>
          <b className="text-terminal-text">Amplitud</b>: qué tan sano está el universo completo de tickers, no sólo
          el índice — proporción por encima de sus medias, nuevos máximos vs. mínimos de 52 semanas, avance/declive.
          Un índice arriba sostenido por pocas acciones (amplitud floja) suma menos que una suba generalizada.
        </p>
        <p>
          <b className="text-terminal-text">Sentimiento (VIX + put/call)</b>: el VIX bajo puntúa mejor (calma) y alto
          puntúa peor (miedo/pánico), con una <b>zona intermedia</b> donde ninguno de los dos extremos suma o resta
          fuerte (el mercado "normal" no debería moverse mucho por esto). El put/call ratio (cuántas puts se operan
          por cada call) suma en el mismo sentido cuando está disponible; si no vino en esta corrida, el puntaje sale
          sólo del VIX.
        </p>
        <p>
          <b className="text-terminal-text">Amortiguación de pánico</b>: en un pico de VIX muy extremo (pánico), la
          penalización no sigue creciendo linealmente sin techo — se amortigua, porque en esos extremos el mercado
          suele estar más cerca de un piso que de una caída infinita, y un score que castigue sin límite terminaría
          siendo cero en casi cualquier crash.
        </p>
        <p>
          El resultado no predice el próximo movimiento ni reemplaza el análisis de cada ticker — es una foto del
          clima general para calibrar cuánto riesgo tiene sentido tomar en conjunto.
        </p>
      </ComoSeCalcula>
    </div>
  )
}
