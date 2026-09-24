import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { cargarJson, useJson } from '../lib/useJson'
import {
  GRUPOS,
  METRICAS,
  RANGOS,
  estadisticas,
  fmtFechaMs,
  lecturaPercentil,
  recortarRango,
  serieMetrica,
} from '../lib/historicoDerivados'
import { fmtFecha } from '../lib/formato'
import { exportarCSV } from '../lib/csv'
import GraficoHistorico from '../components/GraficoHistorico'
import BuscadorTicker from '../components/BuscadorTicker'
import ComoSeCalcula, { Formula } from '../components/ComoSeCalcula'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { btnCls } from '../lib/estilos'

const MAX_TICKERS = 5
const COLORES = ['#f5a524', '#38bdf8', '#a855f7', '#22c55e', '#f472b6']
const SUGERIDOS = ['NVDA', 'AAPL', 'MSFT', 'KO', 'MELI', 'TSM']
const METRICA_DEFECTO = 'pe'
const RANGO_DEFECTO = '5y'
// Grupos donde tiene sentido "caro/barato vs. su historia" con bandas de
// promedio ±1σ. Precio y absolutos tienen tendencia: el promedio no es ancla.
const GRUPOS_CON_BANDAS = new Set(['valuacion', 'crecimiento', 'margenes'])

const TONOS = { bueno: '#22c55e', malo: '#ef4444', neutro: '#f5a524' }

function leerTickers(params) {
  return (params.get('t') ?? '')
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, MAX_TICKERS)
}

// Carga en paralelo fundamental/<T>.json de cada ticker elegido (via el
// cache compartido de useJson: volver a un ticker ya visto no lo re-baja).
function useFundamentales(tickers, indicePorTicker) {
  const [estado, setEstado] = useState({}) // ticker -> { data, error }
  const clave = tickers.join(',')
  useEffect(() => {
    let activo = true
    for (const t of clave ? clave.split(',') : []) {
      const info = indicePorTicker.get(t)
      if (!info?.disponible) continue
      cargarJson(`fundamental/${encodeURIComponent(t)}.json`).then(
        (data) => activo && setEstado((s) => (s[t]?.data === data ? s : { ...s, [t]: { data } })),
        (err) => activo && setEstado((s) => ({ ...s, [t]: { error: err.message } })),
      )
    }
    return () => {
      activo = false
    }
  }, [clave, indicePorTicker])
  return estado
}

function BotonSegmento({ activo, onClick, children, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={activo}
      className={`rounded border px-2 py-1 text-xs transition-colors ${
        activo
          ? 'border-terminal-accent bg-terminal-accent/15 text-terminal-text'
          : 'border-terminal-border bg-terminal-panel text-terminal-dim hover:border-terminal-accent hover:text-terminal-text'
      }`}
    >
      {children}
    </button>
  )
}

function fmtZ(z) {
  if (z == null) return '—'
  return `${z > 0 ? '+' : ''}${z.toFixed(1)}σ`
}

export default function HistoricoFundamental() {
  const [params, setParams] = useSearchParams()
  const { data: indice, cargando, error, status } = useJson('fundamental/indice.json')

  const tickersUrl = useMemo(() => leerTickers(params), [params])
  const tickers = useMemo(() => (params.has('t') ? tickersUrl : ['NVDA']), [params, tickersUrl])
  const metricaId = METRICAS[params.get('m')] ? params.get('m') : METRICA_DEFECTO
  const rangoId = RANGOS.some((r) => r.id === params.get('r')) ? params.get('r') : RANGO_DEFECTO
  const metrica = METRICAS[metricaId]
  const grupo = GRUPOS.find((g) => g.id === metrica.grupo)

  const actualizar = useCallback(
    (cambios) => {
      const p = new URLSearchParams(params)
      if (!p.has('t')) p.set('t', tickers.join(','))
      for (const [k, v] of Object.entries(cambios)) {
        if (v == null) p.delete(k)
        else p.set(k, v)
      }
      setParams(p, { replace: true })
    },
    [params, setParams, tickers],
  )

  const filasIndice = useMemo(() => (Array.isArray(indice?.tickers) ? indice.tickers : []), [indice])
  const indicePorTicker = useMemo(() => new Map(filasIndice.map((r) => [r.ticker, r])), [filasIndice])
  const filasBuscador = useMemo(
    () =>
      filasIndice.map((r) => ({
        ticker: r.ticker,
        nombre: r.disponible ? r.nombre : `${r.nombre ?? ''} (sin datos)`,
      })),
    [filasIndice],
  )
  const cargas = useFundamentales(tickers, indicePorTicker)

  const agregarTicker = (t) => {
    if (tickers.includes(t) || tickers.length >= MAX_TICKERS) return
    actualizar({ t: [...tickers, t].join(',') })
  }
  const quitarTicker = (t) => actualizar({ t: tickers.filter((x) => x !== t).join(',') })

  // Serie visible + estadisticas por ticker (en el rango elegido).
  const series = useMemo(
    () =>
      tickers.map((t, i) => {
        const info = indicePorTicker.get(t)
        const carga = cargas[t]
        const datos = carga?.data
        const puntos = datos ? recortarRango(serieMetrica(datos, metricaId), rangoId) : []
        return {
          id: t,
          etiqueta: t,
          color: COLORES[i % COLORES.length],
          info,
          datos,
          error: carga?.error,
          cargando: Boolean(info?.disponible) && !carga,
          puntos,
          stats: puntos.length ? estadisticas(puntos) : null,
        }
      }),
    [tickers, indicePorTicker, cargas, metricaId, rangoId],
  )
  const conDatos = series.filter((s) => s.stats)
  const bandas = conDatos.length > 0 && GRUPOS_CON_BANDAS.has(metrica.grupo)
  const unico = series.length === 1 ? series[0] : null
  const monedas = [...new Set(conDatos.map((s) => s.datos?.moneda).filter(Boolean))]

  const descargarCSV = () => {
    const porFecha = new Map()
    for (const s of conDatos) {
      for (const p of s.puntos) {
        if (!porFecha.has(p.t)) porFecha.set(p.t, { fecha: fmtFechaMs(p.t), t: p.t })
        porFecha.get(p.t)[s.id] = p.v
      }
    }
    const filas = [...porFecha.values()].sort((a, b) => a.t - b.t)
    const cols = [{ key: 'fecha', label: 'Fecha' }, ...conDatos.map((s) => ({ key: s.id, label: `${s.id} ${metrica.etiqueta}` }))]
    exportarCSV(`stock-lens-historico-${metricaId}-${rangoId}.csv`, cols, filas)
  }

  const lecturaUnico = unico?.stats ? lecturaPercentil(metrica, unico.stats.percentil) : null

  return (
    <div className="min-w-0">
      <div className="mb-3">
        <h1 className="text-lg font-bold text-terminal-text">Histórico fundamental</h1>
        <p className="text-xs text-terminal-dim">
          Múltiplos de valuación, crecimiento, márgenes y valores absolutos de los últimos ~15 años para todo el
          universo que reporta a la SEC, con el promedio y el desvío de su propia historia. Datos contables de SEC
          EDGAR (fechados cuando se presentaron, sin look-ahead) + precio semanal de Yahoo Finance.
        </p>
        {indice?.actualizado && (
          <p className="mt-1 text-[11px] text-terminal-dim">
            Última actualización: {fmtFecha(indice.actualizado)} (corre semanalmente) ·{' '}
            {filasIndice.filter((r) => r.disponible).length} tickers con datos
          </p>
        )}
      </div>

      {cargando ? (
        <TablaSkeleton columnas={4} />
      ) : error && status === 404 ? (
        <Vacio texto="Todavía no se generó el histórico fundamental: corré el workflow «Historico fundamental» (semanal) para crear public/data/fundamental/." />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : (
        <>
          {/* Tickers */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {tickers.length < MAX_TICKERS ? (
              <BuscadorTicker
                filas={filasBuscador}
                excluir={tickers}
                onAdd={agregarTicker}
                placeholder={tickers.length ? 'Comparar con…' : 'Buscar ticker…'}
              />
            ) : (
              <span className="text-xs text-terminal-dim">Máximo {MAX_TICKERS} tickers.</span>
            )}
            {series.map((s) => (
              <span
                key={s.id}
                className="flex items-center gap-1.5 rounded border border-terminal-border bg-terminal-panel px-2 py-1 text-xs"
                title={s.info?.nombre ?? ''}
              >
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
                <Link to={`/ticker/${encodeURIComponent(s.id)}`} className="font-semibold text-terminal-text hover:text-terminal-accent">
                  {s.id}
                </Link>
                {s.datos?.moneda && s.datos.moneda !== 'USD' && (
                  <span className="text-[10px] text-terminal-dim" title="Moneda en la que reporta a la SEC">
                    {s.datos.moneda}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => quitarTicker(s.id)}
                  aria-label={`Sacar ${s.id}`}
                  title={`Sacar ${s.id}`}
                  className="ml-0.5 text-terminal-dim hover:text-terminal-down"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>

          {/* Metrica */}
          <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Grupo de métricas">
            {GRUPOS.map((g) => (
              <BotonSegmento
                key={g.id}
                activo={g.id === grupo.id}
                onClick={() => g.id !== grupo.id && actualizar({ m: g.metricas[0].id })}
              >
                {g.etiqueta}
              </BotonSegmento>
            ))}
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Métrica">
            {grupo.metricas.map((m) => (
              <BotonSegmento key={m.id} activo={m.id === metricaId} onClick={() => actualizar({ m: m.id })}>
                {m.etiqueta}
              </BotonSegmento>
            ))}
          </div>

          {/* Grafico */}
          <div className="mb-3 rounded-lg border border-terminal-border bg-terminal-panel p-2 sm:p-3">
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="text-sm font-semibold text-terminal-text">{metrica.etiqueta}</span>
              {metrica.moneda && monedas.length > 0 && (
                <span className="text-[11px] text-terminal-dim">
                  en moneda de reporte ({monedas.join(', ')}){monedas.length > 1 ? ' — no comparables entre sí' : ''}
                </span>
              )}
              {unico?.stats && (
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="tabular font-semibold" style={{ color: unico.color }}>
                    {metrica.fmt(unico.stats.actual)}
                  </span>
                  {lecturaUnico && (
                    <span
                      className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
                      style={{ backgroundColor: `${TONOS[lecturaUnico.tono]}22`, color: TONOS[lecturaUnico.tono] }}
                      title="Percentil del valor actual dentro del rango elegido"
                    >
                      p{unico.stats.percentil} → {lecturaUnico.texto}
                    </span>
                  )}
                </span>
              )}
              <div className="ml-auto flex gap-1" role="group" aria-label="Rango">
                {RANGOS.map((r) => (
                  <BotonSegmento key={r.id} activo={r.id === rangoId} onClick={() => actualizar({ r: r.id })}>
                    {r.etiqueta}
                  </BotonSegmento>
                ))}
              </div>
            </div>

            {tickers.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-xs text-terminal-dim">
                <span>Elegí un ticker para empezar. Sugeridos:</span>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {SUGERIDOS.filter((t) => indicePorTicker.get(t)?.disponible).map((t) => (
                    <BotonSegmento key={t} onClick={() => agregarTicker(t)}>
                      {t}
                    </BotonSegmento>
                  ))}
                </div>
              </div>
            ) : series.some((s) => s.cargando) && conDatos.length === 0 ? (
              <div className="skeleton h-64 w-full" />
            ) : (
              <GraficoHistorico
                series={conDatos}
                fmt={metrica.fmt}
                bandas={bandas}
                robusto={metrica.grupo !== 'precio' && metrica.grupo !== 'absolutos'}
              />
            )}

            {series
              .filter((s) => !s.cargando && !s.stats)
              .map((s) => (
                <p key={s.id} className="mt-1.5 rounded border border-terminal-warn/40 bg-terminal-warn/10 px-2 py-1 text-[11px] text-terminal-text">
                  <b>{s.id}</b>:{' '}
                  {!s.info
                    ? 'no está en el universo de Stock Lens.'
                    : !s.info.disponible
                      ? `sin datos — ${s.info.motivo ?? 'no reporta a la SEC'}`
                      : s.error
                        ? `no se pudo cargar (${s.error}).`
                        : `sin datos de ${metrica.etiqueta} en este rango${metricaId === 'pe' || metricaId === 'eps_yoy' ? ' (EPS ≤ 0 o cambio de signo)' : ''}.`}
                </p>
              ))}
            {series
              .filter((s) => s.datos?.atraso_sec)
              .map((s) => (
                <p key={`atraso-${s.id}`} className="mt-1.5 rounded border border-terminal-warn/40 bg-terminal-warn/10 px-2 py-1 text-[11px] text-terminal-text">
                  <b>{s.id}</b>: datos contables hasta el reporte presentado el {fmtFechaMs(Date.parse(s.datos.atraso_sec.ultimo_dato))}. La
                  SEC ya recibió el {s.datos.atraso_sec.ultimo_form} del {fmtFechaMs(Date.parse(s.datos.atraso_sec.ultimo_filing))} pero
                  todavía no lo publicó en su API XBRL
                  {s.datos.ttm?.corte ? ': como reporta solo anualmente, los múltiplos se cortan en esa fecha.' : '.'}
                </p>
              ))}
            {bandas && conDatos.length > 1 && (
              <p className="mt-1 text-[10px] text-terminal-dim">Bandas (promedio, mediana, ±1σ) de {conDatos[0].id}.</p>
            )}
          </div>

          {/* Tabla de estadisticas */}
          {conDatos.length > 0 && (
            <div className="mb-4 overflow-x-auto rounded-lg border border-terminal-border">
              <table className="w-full min-w-[34rem] text-xs">
                <thead className="bg-terminal-panel2 text-terminal-dim">
                  <tr>
                    {['Ticker', 'Actual', 'Promedio', 'Mediana', 'Mín', 'Máx', 'Percentil', 'Desvío'].map((h, i) => (
                      <th key={h} className={`px-2 py-1.5 font-medium ${i ? 'text-right' : 'text-left'}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {conDatos.map((s) => {
                    const st = s.stats
                    const lect = lecturaPercentil(metrica, st.percentil)
                    return (
                      <tr key={s.id} className="border-t border-terminal-border">
                        <td className="px-2 py-1.5">
                          <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                          <span className="font-semibold text-terminal-text">{s.id}</span>
                          {s.datos?.frecuencia === 'anual' && (
                            <span className="ml-1 text-[10px] text-terminal-dim" title="Reporta solo balances anuales (20-F/40-F)">
                              anual
                            </span>
                          )}
                        </td>
                        <td className="tabular px-2 py-1.5 text-right font-semibold" style={{ color: s.color }}>
                          {metrica.fmt(st.actual)}
                        </td>
                        <td className="tabular px-2 py-1.5 text-right">{metrica.fmt(st.promedio)}</td>
                        <td className="tabular px-2 py-1.5 text-right">{metrica.fmt(st.mediana)}</td>
                        <td className="tabular px-2 py-1.5 text-right">{metrica.fmt(st.min)}</td>
                        <td className="tabular px-2 py-1.5 text-right">{metrica.fmt(st.max)}</td>
                        <td className="tabular px-2 py-1.5 text-right" title={lect?.texto ?? ''}>
                          <span style={lect ? { color: TONOS[lect.tono] } : undefined}>p{st.percentil}</span>
                        </td>
                        <td className="tabular px-2 py-1.5 text-right">{fmtZ(st.z)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-terminal-border px-2 py-1.5 text-[10px] text-terminal-dim">
                <span>
                  Estadísticas sobre el rango elegido ({RANGOS.find((r) => r.id === rangoId)?.etiqueta}), semana a semana.
                  {conDatos[0]?.stats && ` Desde ${fmtFechaMs(conDatos[0].puntos[0].t)}.`}
                </span>
                <button type="button" className={`${btnCls} !px-2 !py-0.5 !text-[11px]`} onClick={descargarCSV}>
                  ⬇ CSV
                </button>
              </div>
            </div>
          )}

          {filasIndice.length === 0 && <Vacio texto="Todavía no se generó el índice de histórico fundamental." />}

          <ComoSeCalcula>
            <p>
              <b>Fuente</b>: estados contables XBRL presentados a la <b>SEC EDGAR</b> (10-K/10-Q de empresas de EEUU,
              20-F/40-F de extranjeras con hechos us-gaap o IFRS) y precio de cierre semanal de <b>Yahoo Finance</b>.
              Los tickers que cotizan solo en Merval/B3, los ETF y los que no tienen estados en EDGAR figuran como sin
              datos, con el motivo.
            </p>
            <p>
              <b>TTM</b> (últimos doce meses) = suma de los últimos 4 trimestres. El 4.º trimestre casi nunca se
              presenta suelto: se deriva como <Formula>anual − 9 meses</Formula> (o anual − T1 − T2 − T3). El flujo de
              fondos de los 10-Q viene acumulado en el año (<Formula>T2 = 6M − 3M</Formula>). Si la empresa reporta solo
              anualmente (20-F) o un concepto aparece solo en el 10-K, el TTM es el valor anual.
            </p>
            <p>
              <b>Datos atrasados</b>: si la última presentación periódica de la empresa (10-K/10-Q/20-F) es más de 45
              días posterior al último dato que publica la API XBRL de la SEC, se avisa. En reportantes anuales
              (20-F) los múltiplos se cortan desde esa presentación, porque el dato disponible ya quedó un ejercicio
              atrás.
            </p>
            <p>
              <b>Sin look-ahead</b>: cada dato se usa recién desde la fecha en que se <b>presentó</b> (<i>filed</i>),
              no desde el cierre del trimestre, y se toma la primera versión presentada (no la re-expresada después).
              Por eso las líneas de márgenes/crecimiento se mueven en escalones en las fechas de presentación.
            </p>
            <p>
              <b>Market cap</b> = <Formula>precio × acciones</Formula> (acciones de la portada del último reporte;
              para ADRs, divididas por el ratio ADR estimado). <b>EV</b> ={' '}
              <Formula>market cap + deuda financiera − caja e inversiones corrientes</Formula>. En empresas que
              reportan en otra moneda los valores contables se pasan a USD con el tipo de cambio de cada semana.
            </p>
            <p>
              <b>Múltiplos</b>: <Formula>P/E = precio / EPS diluido TTM</Formula> ·{' '}
              <Formula>P/S = market cap / revenue TTM</Formula> · <Formula>EV/Sales = EV / revenue TTM</Formula> ·{' '}
              <Formula>EV/EBITDA = EV / (resultado operativo + D&A) TTM</Formula> ·{' '}
              <Formula>P/FCF = market cap / (flujo operativo − capex) TTM</Formula> ·{' '}
              <Formula>P/B = market cap / patrimonio neto</Formula> ·{' '}
              <Formula>FCF yield = FCF TTM / market cap</Formula> ·{' '}
              <Formula>Dividend yield = dividendos pagados en 12 meses / precio</Formula>.
            </p>
            <p>
              <b>Denominador ≤ 0 → sin dato</b>: con EPS, EBITDA, FCF o patrimonio negativos el múltiplo no tiene
              lectura (un P/E de −15 no es "más barato" que uno de 10), así que esas semanas quedan en blanco. Lo mismo con EV ≤ 0 en EV/Sales y EV/EBITDA (bancos o empresas con más caja que deuda + market cap).
            </p>
            <p>
              <b>Márgenes</b> = <Formula>concepto TTM / revenue TTM</Formula>. <b>Crecimiento YoY</b> ={' '}
              <Formula>(TTM actual − TTM de hace un año) / |TTM de hace un año|</Formula>; si cambia de signo
              (pérdida ↔ ganancia) no se calcula.
            </p>
            <p>
              <b>Splits</b>: el precio de Yahoo ya viene ajustado por splits (no por dividendos); el EPS y las acciones
              de cada reporte se llevan a la base de acciones actual multiplicando/dividiendo por los splits
              posteriores a su fecha de presentación (ej. NVDA 4:1 en 2021 y 10:1 en 2024).
            </p>
            <p>
              <b>Promedio, ±1σ y mediana</b> se calculan sobre las semanas del rango elegido (σ = desvío estándar).{' '}
              <b>Percentil</b> = % de semanas del rango con un valor menor al actual (p23: el 23% del tiempo estuvo
              más bajo). En múltiplos, percentil bajo = barato vs. su propia historia; en yields es al revés. El{' '}
              <b>desvío</b> de la tabla es <Formula>(actual − promedio) / σ</Formula>. No es recomendación de
              inversión: un múltiplo puede estar bajo porque el negocio empeoró.
            </p>
          </ComoSeCalcula>
        </>
      )}
    </div>
  )
}
