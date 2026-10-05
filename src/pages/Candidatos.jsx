import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { armarCandidatos, claveEscenario, FILTROS_DEFAULT, FILTROS_LAXO } from '../lib/candidatos'
import { entradaDesde, useCompraDesde } from '../lib/compraDesde'
import { selectCls, inputCls, btnCls } from '../lib/estilos'
import TickerLink from '../components/TickerLink'
import LogoTicker from '../components/LogoTicker'
import ComoSeCalcula, { Formula } from '../components/ComoSeCalcula'
import { Anillo } from '../components/WarrenScoreVisual'
import DesdeCompra from '../components/DesdeCompra'
import { TablaSkeleton, MensajeError } from '../components/Estados'
import { fmtNum, fmtFecha, fmtFechaCorta } from '../lib/formato'

// "Candidatos de compra": corre todo el embudo de la app de una vez (Warren
// Score -> Rotación -> gatillo tecnico -> Screener) y arma, por ticker, los
// positivos y negativos con numeros reales. La logica del embudo vive entera
// en lib/candidatos.js (funciones puras, testeadas aparte, parametrizables
// via `filtros`) — esta pagina trae los datos, guarda los filtros elegidos en
// el estado y renderiza.
//
// El panel de parametros arranca siempre en FILTROS_DEFAULT ("el escenario
// ideal" con el que se probo el embudo la primera vez) — mover una perilla
// solo afecta a esta sesion del navegador, nunca cambia el default de nadie
// mas ni se guarda.
//
// IMPORTANTE (ver charla con el usuario): pasar el embudo NO es una senal de
// compra garantizada. Es una combinacion de reglas sobre señales que ya se
// midieron por separado en el backtest (ver los badges de evidencia en
// Señales y Warren Score) — la mayoria de esas señales, solas, apenas le
// ganan al azar. Juntarlas reduce el universo a los que alinean varias cosas
// a la vez, que es lo unico que en el backtest mostro algo de ventaja real.
// Aflojar los parametros deja ver "que aparecería" con un criterio mas laxo
// — no que esos tickers tengan la misma evidencia detras.

const OPCIONES_CUADRANTE = [
  { valor: 'liderando', etiqueta: 'Liderando (estricto)' },
  { valor: 'liderando_recuperando', etiqueta: 'Liderando o Recuperando' },
  { valor: 'cualquiera', etiqueta: 'Cualquiera (sin filtro)' },
]

function PanelFiltros({ filtros, setFiltros }) {
  const set = (patch) => setFiltros((f) => ({ ...f, ...patch }))
  const esDefault = claveEscenario(filtros) === 'candidato'

  return (
    <details className="mb-4 rounded-lg border border-terminal-border bg-terminal-panel" open>
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-terminal-text hover:text-terminal-accent">
        🎛️ Parámetros del embudo {!esDefault && <span className="ml-1 text-terminal-accent">(modificados)</span>}
      </summary>
      <div className="grid grid-cols-1 gap-3 border-t border-terminal-border p-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-[11px] text-terminal-dim">
          Fuerza RS mínima: <span className="text-terminal-text">{Math.round(filtros.umbralFuerza * 100)}%</span> de su
          máximo
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(filtros.umbralFuerza * 100)}
            onChange={(e) => set({ umbralFuerza: Number(e.target.value) / 100 })}
            className="mt-1 w-full accent-terminal-accent"
          />
        </label>
        <label className="text-[11px] text-terminal-dim">
          Contracción mínima: <span className="text-terminal-text">{Math.round(filtros.umbralContraccion * 100)}%</span>{' '}
          de su máximo
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(filtros.umbralContraccion * 100)}
            onChange={(e) => set({ umbralContraccion: Number(e.target.value) / 100 })}
            className="mt-1 w-full accent-terminal-accent"
          />
        </label>
        <label className="text-[11px] text-terminal-dim">
          Rotación: cuadrante exigido
          <select value={filtros.cuadrante} onChange={(e) => set({ cuadrante: e.target.value })} className={`mt-1 w-full ${selectCls}`}>
            {OPCIONES_CUADRANTE.map((o) => (
              <option key={o.valor} value={o.valor}>
                {o.etiqueta}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-terminal-dim">
          Ventana del gatillo — EMA200 diaria (ruedas)
          <input
            type="number"
            min={1}
            max={60}
            value={filtros.ema200DiarioMaxHace}
            onChange={(e) => set({ ema200DiarioMaxHace: Math.max(1, Number(e.target.value) || 1) })}
            className={`mt-1 w-full ${inputCls}`}
          />
        </label>
        <label className="text-[11px] text-terminal-dim">
          Ventana del gatillo — EMA200 semanal (semanas)
          <input
            type="number"
            min={1}
            max={26}
            value={filtros.ema200SemanalMaxHace}
            onChange={(e) => set({ ema200SemanalMaxHace: Math.max(1, Number(e.target.value) || 1) })}
            className={`mt-1 w-full ${inputCls}`}
          />
        </label>
        <label className="text-[11px] text-terminal-dim">
          Screener: mínimo de temporalidades en COMPRA/CERCA
          <select
            value={filtros.minTemporalidadesScreener}
            onChange={(e) => set({ minTemporalidadesScreener: Number(e.target.value) })}
            className={`mt-1 w-full ${selectCls}`}
          >
            <option value={1}>1 de 3</option>
            <option value={2}>2 de 3</option>
            <option value={3}>3 de 3</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-terminal-dim">
          <input type="checkbox" checked={filtros.exigirSinVenta} onChange={(e) => set({ exigirSinVenta: e.target.checked })} />
          Descartar si alguna temporalidad del Screener está en VENTA
        </label>
        <label className="flex items-center gap-2 text-[11px] text-terminal-dim">
          <input type="checkbox" checked={filtros.modoEstricto} onChange={(e) => set({ modoEstricto: e.target.checked })} />
          Modo estricto: excluir también banderas de agotamiento/sobreextensión (no solo 🩸/⛔)
        </label>
        <div className="flex items-end">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setFiltros(FILTROS_DEFAULT)} disabled={esDefault} className={`${btnCls} disabled:opacity-40`}>
              ↺ Escenario ideal
            </button>
            <button
              type="button"
              onClick={() => setFiltros(FILTROS_LAXO)}
              disabled={claveEscenario(filtros) === 'candidato_laxo'}
              className={`${btnCls} disabled:opacity-40`}
              title="Aflojado: Liderando o Recuperando, pilares ≥30%/20%, 1 temporalidad del Screener, ventanas más largas y sin exigir 'sin VENTA'"
            >
              Escenario laxo
            </button>
          </div>
        </div>
      </div>
    </details>
  )
}

export default function Candidatos() {
  const [filtros, setFiltros] = useState(FILTROS_DEFAULT)

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
        filtros,
      }),
    [warrenData, senalesData, screenerData, rotacionData, comparablesData, fundamentalesData, indiceData, filtros]
  )

  const regimen = macroData?.regimen
  const desde = useCompraDesde()
  const claveDesde = claveEscenario(filtros)

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

      <PanelFiltros filtros={filtros} setFiltros={setFiltros} />
      {!claveDesde && (
        <p className="mb-3 text-[11px] text-terminal-dim">
          Con parámetros personalizados no hay fecha de “desde cuándo”: se registra solo para el escenario ideal y el laxo.
        </p>
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
              Ningún ticker pasa hoy estos filtros. Es un resultado válido — no siempre tiene que haber candidatos.
              Probá aflojar algún parámetro de arriba para ver qué aparecería con un criterio menos exigente.
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
                      {claveDesde && (
                        <span className="rounded border border-terminal-border px-1.5 py-0.5" title="Desde cuándo pasa el embudo completo de forma continua, y qué hizo el precio desde ese día">
                          En el embudo: <DesdeCompra entrada={entradaDesde(desde, claveDesde, c.ticker)} vacio="sin registro" />
                        </span>
                      )}
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
          cinco a la vez. El panel <b className="text-terminal-text">🎛️ Parámetros del embudo</b> arranca siempre en
          el escenario que se probó primero (los valores de abajo) — moverlo solo cambia lo que ves en esta sesión.
        </p>
        <p>
          <b className="text-terminal-text">1. Gate de tendencia</b>: mismo gate del Warren Score — precio sobre la
          EMA200 (si no, ya quedó afuera del ranking con score topeado en 40). No es ajustable.
        </p>
        <p>
          <b className="text-terminal-text">2. Pilares sólidos</b>:{' '}
          <Formula>Fuerza RS ≥ {Math.round(FILTROS_DEFAULT.umbralFuerza * 100)}%</Formula> y{' '}
          <Formula>Contracción ≥ {Math.round(FILTROS_DEFAULT.umbralContraccion * 100)}%</Formula> de su propio máximo
          por defecto, y sin las dos banderas más graves del Warren Score (🩸 distribución, ⛔ breakout fallido) — en
          modo estricto también sin 🎈 sobreextensión, 💥 reversión con volumen, 🐘 churning y las divergencias 📉/🪫.
        </p>
        <p>
          <b className="text-terminal-text">3. Rotación</b>: cuadrante Liderando por defecto (o recién entrando ahí —
          "Recién a Líderes"/"Aceleración inusual" de la pantalla Rotación); se puede aflojar a incluir Recuperando, o
          sacar el filtro entero.
        </p>
        <p>
          <b className="text-terminal-text">4. Gatillo técnico</b>: al menos una de estas tres, que son las que
          mostraron ventaja real en el backtest de 5 años — base VCP en estado Armado/Recién rompió/Rompió y
          confirmó, rebote o cruce de la EMA200 (ventana ajustable, por defecto diario ≤{FILTROS_DEFAULT.ema200DiarioMaxHace}{' '}
          ruedas y semanal ≤{FILTROS_DEFAULT.ema200SemanalMaxHace} semanas), o cruce alcista del RSI semanal sobre su
          propia media.
        </p>
        <p>
          <b className="text-terminal-text">5. Screener técnico alineado</b>: COMPRA o CERCA en al menos{' '}
          {FILTROS_DEFAULT.minTemporalidadesScreener} de las 3 temporalidades (diario/semanal/mensual) por defecto, y
          ninguna en VENTA (también ajustable).
        </p>
        <p>
          Los <b className="text-terminal-text">positivos y negativos</b> de cada candidato no son un texto genérico:
          cada línea sale de un campo real (el propio VCP, el propio Screener, el percentil histórico del múltiplo,
          las banderas del Warren Score, insiders vendiendo, etc.) — si un dato no aplica, esa línea directamente no
          aparece.
        </p>
        <p>
          <b className="text-terminal-text">“En el embudo: desde …”</b>: fecha desde la que el ticker pasa los cinco
          filtros <i>sin interrupción</i> (si salió y volvió, cuenta desde la vuelta), los días que lleva y la variación
          del precio desde el cierre de ese día — para chequear si la recomendación funcionó. Se registra en cada
          corrida del pipeline para el escenario ideal y el laxo; el registro empezó {desde?.candidato?.inicio ? `el ${fmtFechaCorta(desde.candidato.inicio)}` : 'recién'}, así que las
          marcadas con “≥” llevan al menos ese tiempo (no se puede reconstruir antes). Con otros parámetros no hay fecha.
        </p>
        <p>
          <b className="text-terminal-warn">Ojo</b>: esto combina reglas sobre señales que ya midió el backtest por
          separado — la mayoría, solas, apenas superan al azar. Aflojar un parámetro deja ver qué aparecería con un
          criterio menos exigente, no que esos tickers tengan la misma evidencia detrás que el escenario por defecto.
        </p>
      </ComoSeCalcula>
    </div>
  )
}
