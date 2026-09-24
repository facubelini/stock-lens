import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useJson } from '../lib/useJson'
import {
  obtenerAltseason,
  leerCacheAltseason,
  guardarCacheAltseason,
  clasificarAltseason,
  N_ALTS,
  DIAS,
  UMBRAL_ALTSEASON,
  UMBRAL_BTC,
  TTL_ALTSEASON_MS,
} from '../lib/crypto/altseason'
import { fmtFecha, hoyAR, sumarDiasISO } from '../lib/formato'
import { calendarioEconomico } from '../lib/calendarioEconomico'
import RegimenMercado from '../components/RegimenMercado'

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

function fmtMes(fechaIso) {
  if (!fechaIso) return '—'
  const [anio, mes] = fechaIso.split('-')
  return `${MESES[Number(mes) - 1]} ${anio}`
}

// Las dos fuentes mandan la clasificacion en ingles ('Greed' en
// alternative.me, 'extreme fear' en minuscula en CNN). Si no viene, se deduce
// del valor con las mismas bandas que usan ellas.
const FEAR_GREED_ES = {
  'extreme fear': 'Miedo extremo',
  fear: 'Miedo',
  neutral: 'Neutral',
  greed: 'Codicia',
  'extreme greed': 'Codicia extrema',
}

function clasificacionFearGreed(clasificacion, valor) {
  const t = FEAR_GREED_ES[String(clasificacion ?? '').trim().toLowerCase()]
  if (t) return t
  if (clasificacion) return clasificacion
  if (valor == null) return null
  if (valor < 25) return 'Miedo extremo'
  if (valor < 45) return 'Miedo'
  if (valor <= 55) return 'Neutral'
  if (valor <= 75) return 'Codicia'
  return 'Codicia extrema'
}

const ESCALA_FEAR_GREED =
  'Escala 0–100: 0–24 miedo extremo · 25–44 miedo · 45–55 neutral · 56–75 codicia · 76–100 codicia extrema.'

function colorFearGreed(v) {
  if (v == null) return '#7d8b9c'
  if (v < 25) return '#ef4444'
  if (v < 45) return '#f97316'
  if (v < 55) return '#f5a524'
  if (v < 75) return '#84cc16'
  return '#22c55e'
}

function GaugeFearGreed({
  titulo,
  valor,
  clasificacion,
  historial,
  nota,
  etiquetaBaja = 'Miedo extremo',
  etiquetaAlta = 'Codicia extrema',
}) {
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
            <span>{etiquetaBaja}</span>
            <span>{etiquetaAlta}</span>
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

const fmtTasa = (v) => (v == null || isNaN(v) ? '—' : `${(+v).toFixed(2)}%`)

function TarjetaYieldCurve({ yc }) {
  // Con una fuente caida pueden faltar campos sueltos: cada numero se muestra
  // si esta, y el spread se recalcula si no vino.
  const diez = yc?.diez_anios ?? null
  const tres = yc?.tres_meses ?? null
  const spread = yc?.spread ?? (diez != null && tres != null ? diez - tres : null)
  const invertida = yc?.invertida ?? (spread != null ? spread < 0 : null)
  const hayAlgo = diez != null || tres != null || spread != null
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-4">
      <h3 className="mb-3 text-sm font-semibold text-terminal-text">Curva de rendimientos (10a vs. 3m)</h3>
      {hayAlgo ? (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-[10px] uppercase text-terminal-dim">10 años</div>
              <div className="tabular font-semibold text-terminal-text">{fmtTasa(diez)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-terminal-dim">3 meses</div>
              <div className="tabular font-semibold text-terminal-text">{fmtTasa(tres)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-terminal-dim" title="Spread = rendimiento 10 años − rendimiento 3 meses">
                Spread
              </div>
              <div
                className="tabular font-semibold"
                style={{ color: invertida == null ? undefined : invertida ? '#ef4444' : '#22c55e' }}
              >
                {spread == null ? '—' : `${spread >= 0 ? '+' : ''}${(+spread).toFixed(2)}`}
              </div>
            </div>
          </div>
          {invertida == null ? (
            <p className="mt-2.5 text-[11px] text-terminal-dim">Falta uno de los dos plazos para calcular el spread.</p>
          ) : invertida ? (
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

// Altseason Index calculado en el navegador contra Binance (ver
// lib/crypto/altseason.js para la formula). Se cachea ~1h en memoria y en
// sessionStorage: sale de velas diarias cerradas, no cambia en la hora.
function useAltseason() {
  const [estado, setEstado] = useState(() => {
    const c = leerCacheAltseason()
    return c ? { datos: c, cargando: false, error: null } : { datos: null, cargando: true, error: null }
  })
  const ctrl = useRef(null)

  const calcular = useCallback(async ({ forzar = false } = {}) => {
    if (!forzar) {
      const c = leerCacheAltseason()
      if (c) {
        setEstado({ datos: c, cargando: false, error: null })
        return
      }
    }
    ctrl.current?.abort()
    const controller = new AbortController()
    ctrl.current = controller
    setEstado((e) => ({ ...e, cargando: true, error: null }))
    try {
      const d = await obtenerAltseason({ signal: controller.signal })
      guardarCacheAltseason(d)
      if (!controller.signal.aborted) setEstado({ datos: d, cargando: false, error: null })
    } catch (e) {
      if (controller.signal.aborted) return
      setEstado((prev) => ({ ...prev, cargando: false, error: e.message }))
    }
  }, [])

  useEffect(() => {
    calcular()
    return () => ctrl.current?.abort()
  }, [calcular])

  return { ...estado, recalcular: () => calcular({ forzar: true }) }
}

// Sin hourCycle, el CLDR actual de es-AR da reloj de 12 h ("10:30 p. m.").
const fmtHoraCorta = (ms) =>
  new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const fmtDia = (ms) => new Date(ms).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })
const fmtRet = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
const sinUsdt = (s) => s.replace(/USDT$/, '')

function TarjetaAltseason({ alt }) {
  const { datos, cargando, error, recalcular } = alt
  const venceEn = datos ? Math.max(0, Math.round((datos.calculadoEn + TTL_ALTSEASON_MS - Date.now()) / 60000)) : null
  return (
    <div className="flex flex-col gap-2">
      <GaugeFearGreed
        titulo="Altseason Index"
        valor={datos?.pct}
        clasificacion={clasificarAltseason(datos?.pct)}
        etiquetaBaja="Temporada Bitcoin"
        etiquetaAlta="Temporada altcoins"
        nota={
          cargando && !datos
            ? `Calculando: velas diarias de BTC y de los ${N_ALTS} perpetuos con más volumen en Binance…`
            : null
        }
      />
      {error && (
        <div className="rounded border border-terminal-down/40 bg-terminal-down/10 px-3 py-2 text-xs text-terminal-down">
          No se pudo calcular el Altseason Index: {error}
        </div>
      )}
      <div className="rounded-lg border border-terminal-border bg-terminal-panel p-3 text-[11px] leading-relaxed text-terminal-dim">
        {datos && (
          <p className="mb-1.5 text-terminal-text">
            <b>{datos.ganaron}</b> de <b>{datos.n}</b> perpetuos le ganaron a BTC ({fmtRet(datos.retornoBtc)}) entre el{' '}
            {fmtDia(datos.desde)} y el {fmtDia(datos.hasta)} a las 00:00 UTC (cierres diarios) → {datos.ganaron} ÷ {datos.n} ={' '}
            <b>{datos.pct}%</b>.
            {datos.sinHistorial > 0 && ` ${datos.sinHistorial} sin ${DIAS} días de historial, no cuentan.`}
            <br />
            Mejores: {datos.mejores.map((m) => `${sinUsdt(m.symbol)} ${fmtRet(m.ret)}`).join(' · ')} — Peores:{' '}
            {datos.peores.map((m) => `${sinUsdt(m.symbol)} ${fmtRet(m.ret)}`).join(' · ')}
          </p>
        )}
        <p>
          <b>Fórmula:</b> % de los {N_ALTS} perpetuos USDT con más volumen en 24h (sin BTC, stablecoins ni tokens de
          oro) cuyo retorno de {DIAS} días supera al de BTC. Retorno = cierre de ayer ÷ cierre de {DIAS} días antes − 1,
          con velas diarias <b>cerradas</b> de Binance Futures. <b>Criterio:</b> ≥ {UMBRAL_ALTSEASON}% temporada de
          altcoins, ≤ {UMBRAL_BTC}% temporada de Bitcoin, en el medio mixto (umbrales convencionales). Es un proxy:
          el índice «oficial» usa el top 50 por market cap y 90 días, que Binance no da.
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {datos && (
            <span>
              Calculado a las {fmtHoraCorta(datos.calculadoEn)} en {(datos.duracionMs / 1000).toFixed(1)} s · se
              reutiliza {venceEn} min más.
            </span>
          )}
          {cargando && datos && <span>Recalculando…</span>}
          <button
            type="button"
            onClick={recalcular}
            disabled={cargando}
            className="rounded border border-terminal-border px-2 py-0.5 text-[11px] text-terminal-text hover:border-terminal-accent disabled:opacity-50"
          >
            ↻ Recalcular
          </button>
        </div>
      </div>
    </div>
  )
}

const ETIQUETA_EVENTO = {
  FOMC: { icono: '🏛️', color: '#ef4444' },
  NFP: { icono: '👷', color: '#38bdf8' },
  CPI: { icono: '📈', color: '#f5a524' },
}

function fmtFechaCortaCal(fechaISO) {
  const [anio, mes, dia] = fechaISO.split('-')
  return `${dia}/${mes}/${anio}`
}

function TarjetaCalendario({ eventos }) {
  const en7dias = sumarDiasISO(hoyAR(), 7)
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-4">
      <h3 className="mb-3 text-sm font-semibold text-terminal-text">Próximos eventos</h3>
      <div className="flex flex-col gap-1.5">
        {eventos.slice(0, 8).map((e, i) => {
          const et = ETIQUETA_EVENTO[e.tipo]
          const proximo = e.fecha <= en7dias
          return (
            <div
              key={i}
              className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs"
              style={proximo ? { backgroundColor: `${et.color}18` } : undefined}
            >
              <span className="flex items-center gap-1.5">
                <span>{et.icono}</span>
                <span className={proximo ? 'font-semibold text-terminal-text' : 'text-terminal-dim'}>
                  {e.label}
                </span>
                {!e.exacto && <span className="text-terminal-dim">(aprox.)</span>}
              </span>
              <span className="tabular font-semibold" style={{ color: proximo ? et.color : undefined }}>
                {fmtFechaCortaCal(e.fecha)}
              </span>
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-[11px] text-terminal-dim">
        🏛️ FOMC: fechas oficiales de la Fed. 👷 NFP (empleo): aproximado, por regla del primer viernes
        del mes (el BLS a veces lo corre al segundo). 📈 CPI: aproximado (el BLS no publica una fecha fija con
        anticipación) — puede variar unos días.
      </p>
    </div>
  )
}

export default function Macro() {
  const { data, cargando, error } = useJson('mercado_macro.json')
  // Independiente de mercado_macro.json: sale en vivo de Binance.
  const altseason = useAltseason()

  const eventos = useMemo(() => calendarioEconomico(), [])

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
              Régimen de mercado
            </h2>
            <RegimenMercado regimen={data?.regimen} />
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-terminal-dim">
              Fear &amp; Greed
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <GaugeFearGreed
                titulo="Acciones (CNN)"
                valor={data?.fear_greed_acciones?.valor}
                clasificacion={clasificacionFearGreed(
                  data?.fear_greed_acciones?.clasificacion,
                  data?.fear_greed_acciones?.valor,
                )}
                historial={
                  data?.fear_greed_acciones && [
                    ['Ayer', data.fear_greed_acciones.prev_cierre],
                    ['Semana pasada', data.fear_greed_acciones.prev_semana],
                    ['Mes pasado', data.fear_greed_acciones.prev_mes],
                    ['Año pasado', data.fear_greed_acciones.prev_anio],
                  ]
                }
                nota={`${ESCALA_FEAR_GREED} Combina 7 indicadores del mercado de EEUU (momentum del S&P 500, máximos vs. mínimos, amplitud, put/call, bonos basura, VIX y demanda de refugio). Fuente no oficial (CNN no publica una API documentada) — puede fallar temporalmente.`}
              />
              <GaugeFearGreed
                titulo="Cripto (alternative.me)"
                valor={data?.fear_greed_cripto?.valor}
                clasificacion={clasificacionFearGreed(
                  data?.fear_greed_cripto?.clasificacion,
                  data?.fear_greed_cripto?.valor,
                )}
                nota={`${ESCALA_FEAR_GREED} alternative.me lo arma con volatilidad, momentum/volumen, redes sociales, dominancia de BTC y tendencias de búsqueda. Se actualiza una vez por día.`}
              />
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-terminal-dim">
              Rotación cripto
            </h2>
            <TarjetaAltseason alt={altseason} />
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

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-terminal-dim">
              Calendario económico
            </h2>
            <TarjetaCalendario eventos={eventos} />
          </div>
        </div>
      )}
    </div>
  )
}
