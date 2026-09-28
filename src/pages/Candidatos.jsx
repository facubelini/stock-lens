import { useMemo } from 'react'
import { useJson } from '../lib/useJson'
import { armarCandidatos, UMBRAL_FUERZA, UMBRAL_CONTRACCION, EMA200_DIARIO_MAX_HACE, EMA200_SEMANAL_MAX_HACE } from '../lib/candidatos'
import TickerLink from '../components/TickerLink'
import LogoTicker from '../components/LogoTicker'
import ComoSeCalcula, { Formula } from '../components/ComoSeCalcula'
import { Anillo, colorScore } from '../components/WarrenScoreVisual'
import { TablaSkeleton, MensajeError } from '../components/Estados'
import { fmtNum, fmtFecha } from '../lib/formato'

// "Candidatos de compra": corre todo el embudo de una vez (Rotación -> Warren
// Score -> gatillo tecnico -> Screener) y arma, por ticker, los positivos y
// negativos con numeros reales. La logica del embudo vive entera en
// lib/candidatos.js (funciones puras, testeadas aparte) — esta pagina solo
// trae los datos y renderiza.
//
// IMPORTANTE (ver charla con el usuario): pasar el embudo NO es una senal de
// compra garantizada. Es una combinacion de reglas sobre señales que ya se
// midieron por separado en el backtest (ver los badges de evidencia en
// Señales y Warren Score) — la mayoria de esas señales, solas, apenas le
// ganan al azar. Juntarlas reduce el universo a los que alinean varias cosas
// a la vez, que es lo unico que en el backtest mostro algo de ventaja real.

export default function Candidatos() {
  const { data: warrenData, cargando: c1, error: e1 } = useJson('warren_score.json')
  const { data: senalesData, cargando: c2, error: e2 } = useJson('senales.json')
  const { data: screenerData, cargando: c3, error: e3 } = useJson('screener.json')
  const { data: rotacionData, cargando: c4, error: e4 } = useJson('rotacion.json')
  const { data: comparablesData, cargando: c5, error: e5 } = useJson('comparables.json')
  const { data: fundamentalesData, cargando: c6, error: e6 } = useJson('fundamentales.json')
  const { data: indiceData } = useJson('fundamental/indice.json') // opcional: puede no estar aun
  const { data: macroData } = useJson('mercado_macro.json')

  const cargando = c1 || c2 || c3 || c4 || c5 || c6
  const error = e1 || e2 || e3 || e4 || e6 // comparables (e5) y el indice fundamental son opcionales

  const { embudo, candidatos } = useMemo(
    () =>
      armarCandidatos({
        warrenRows: warrenData?.tickers ?? [],
        senales: senalesData ?? {},
        screenerRows: Array.isArray(screenerData) ? screenerData : [],
        rotacion: rotacionData ?? {},
        comparablesRows: Array.isArray(comparablesData) ? comparablesData : [],
        fundamentalesRows: Array.isArray(fundamentalesData) ? fundamentalesData : (fundamentalesData?.acciones ?? []),
        fundamentalIndice: Array.isArray(indiceData) ? indiceData : [],
      }),
    [warrenData, senalesData, screenerData, rotacionData, comparablesData, fundamentalesData, indiceData]
  )

  const regimen = macroData?.regimen

  return (
    <div>
      <h1 className="mb-1 text-lg font-semibold text-terminal-text">✅ Candidatos de Compra</h1>
      <p className="mb-1 max-w-3xl text-xs text-terminal-dim">
        Corre todo el embudo de la app de una sola vez — Rotación, Warren Score, VCP/EMA200/RSI semanal y Screener
        técnico — y deja solo los tickers que alinean varias cosas a la vez. Técnico, orientativo, no es recomendación
        de inversión: mirá los positivos y negativos de cada uno antes de cualquier decisión.
      </p>
      {warrenData?.actualizado && (
        <p className="mb-3 text-[11px] text-terminal-dim">Datos actualizados: {fmtFecha(warrenData.actualizado)}</p>
      )}

      {regimen && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-terminal-border bg-terminal-panel p-3">
          <Anillo score={regimen.max ? (regimen.score / regimen.max) * 100 : regimen.score} tam={44} />
          <div className="text-xs text-terminal-dim">
            <span className="font-semibold text-terminal-text">
              Régimen de mercado: {fmtNum(regimen.score, 1)}/{regimen.max}
            </span>{' '}
            — {regimen.criterio_exposicion}{' '}
            <a href="#/macro" className="text-terminal-accent hover:underline">
              ver detalle →
            </a>
          </div>
        </div>
      )}

      {cargando && <TablaSkeleton filas={4} columnas={4} />}
      {!cargando && error && <MensajeError mensaje={String(error)} />}

      {!cargando && !error && (
        <>
          <div className="mb-4 flex flex-wrap gap-2 text-[11px]">
            {embudo.map((e, i) => (
              <div key={e.clave} className="flex items-center gap-2">
                {i > 0 && <span className="text-terminal-dim">→</span>}
                <div className="rounded border border-terminal-border bg-terminal-panel px-2 py-1" title={e.titulo}>
                  <span className="font-semibold text-terminal-text">{e.cantidad}</span>{' '}
                  <span className="text-terminal-dim">{e.titulo}</span>
                </div>
              </div>
            ))}
          </div>

          {candidatos.length === 0 ? (
            <div className="rounded-lg border border-terminal-border bg-terminal-panel p-8 text-center text-sm text-terminal-dim">
              Ningún ticker pasa hoy los 5 filtros del embudo completo. Es un resultado válido — no siempre tiene que
              haber candidatos, sobre todo con el mercado en un régimen bajo.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {candidatos.map((c) => (
                <div key={c.ticker} className="rounded-lg border border-terminal-border bg-terminal-panel p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Anillo score={c.warrenScore} tam={40} />
                      <div>
                        <div className="flex items-center gap-1.5">
                          <LogoTicker ticker={c.ticker} tam={22} />
                          <TickerLink ticker={c.ticker} conLogo={false} className="text-base font-semibold" />
                          <span className="text-xs text-terminal-dim">#{c.rank} de {c.total}</span>
                        </div>
                        <div className="text-xs text-terminal-dim">
                          {c.nombre} · {c.sector}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-terminal-dim">
                      {c.stage && (
                        <span title={c.stage.tip}>
                          Stage {c.stage.n}: <span className="text-terminal-text">{c.stage.label}</span>
                        </span>
                      )}
                      {c.cuadrante && <span className="rounded bg-terminal-border px-1.5 py-0.5">Rotación: {c.cuadrante}</span>}
                      <span className="rounded bg-terminal-border px-1.5 py-0.5">{c.nGatillos} gatillo(s) técnico(s)</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-terminal-up">
                        ✅ A favor
                      </div>
                      <ul className="flex flex-col gap-1 text-[11px] text-terminal-dim">
                        {c.positivos.map((p, i) => (
                          <li key={i}>• {p}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-terminal-warn">
                        ⚠️ A vigilar
                      </div>
                      {c.negativos.length ? (
                        <ul className="flex flex-col gap-1 text-[11px] text-terminal-dim">
                          {c.negativos.map((n, i) => (
                            <li key={i}>• {n}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[11px] text-terminal-dim">Sin banderas de alerta detectadas.</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <ComoSeCalcula titulo="¿Cómo se arma este listado?" className="mt-4">
        <p>
          Cinco filtros en cadena, cada uno sobre el resultado del anterior. Un ticker que llega al final pasó los
          cinco a la vez:
        </p>
        <p>
          <b className="text-terminal-text">1. Gate de tendencia</b>: mismo gate del Warren Score — precio sobre la
          EMA200 (si no, ya quedó afuera del ranking con score topeado en 40).
        </p>
        <p>
          <b className="text-terminal-text">2. Pilares sólidos</b>:{' '}
          <Formula>Fuerza RS ≥ {Math.round(UMBRAL_FUERZA * 100)}%</Formula> y{' '}
          <Formula>Contracción ≥ {Math.round(UMBRAL_CONTRACCION * 100)}%</Formula> de su propio máximo, y sin las dos
          banderas más graves del Warren Score (🩸 distribución, ⛔ breakout fallido).
        </p>
        <p>
          <b className="text-terminal-text">3. Rotación</b>: cuadrante Liderando (o recién entrando ahí — "Recién a
          Líderes"/"Aceleración inusual" de la pantalla Rotación).
        </p>
        <p>
          <b className="text-terminal-text">4. Gatillo técnico</b>: al menos una de estas tres, que son las que
          mostraron ventaja real en el backtest de 5 años — base VCP en estado Armado/Recién rompió/Rompió y
          confirmó, rebote o cruce de la EMA200 (diario ≤{EMA200_DIARIO_MAX_HACE} ruedas, semanal ≤
          {EMA200_SEMANAL_MAX_HACE} semanas), o cruce alcista del RSI semanal sobre su propia media.
        </p>
        <p>
          <b className="text-terminal-text">5. Screener técnico alineado</b>: COMPRA o CERCA en al menos 2 de las 3
          temporalidades (diario/semanal/mensual), y ninguna en VENTA.
        </p>
        <p>
          Los <b className="text-terminal-text">positivos y negativos</b> de cada candidato no son un texto genérico:
          cada línea sale de un campo real (el propio VCP, el propio Screener, el percentil histórico del múltiplo,
          las banderas del Warren Score, insiders vendiendo, etc.) — si un dato no aplica, esa línea directamente no
          aparece.
        </p>
        <p>
          <b className="text-terminal-warn">Ojo</b>: esto combina reglas sobre señales que ya midió el backtest por
          separado — la mayoría, solas, apenas superan al azar. Pasar los 5 filtros reduce el universo a los que
          alinean varias cosas, que es lo único que mostró algo de ventaja real; no es una garantía de resultado.
        </p>
      </ComoSeCalcula>
    </div>
  )
}
