import { useMemo } from 'react'
import { useFilasCombinadas } from '../lib/useFilas'
import { useMeta } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { exportarCSV } from '../lib/csv'
import Controles from '../components/Controles'
import Tabla from '../components/Tabla'
import TickerLink from '../components/TickerLink'
import { columnaPin } from '../components/columnas'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { fmtPrecio, fmtPct, fmtFecha, fmtAntiguedad, estiloValor, hoyAR, sumarDiasISO } from '../lib/formato'

const CAMPOS = ['ticker', 'nombre']
const DIAS_REPORTE_RECIENTE = 5

// Mismo chequeo que ya usa TickerDetalle para "próximo earnings": Yahoo
// tarda 1-2 dias en correr la fecha a la siguiente despues de un reporte,
// asi que una fecha ya pasada en proximo_earnings es, en la practica, la
// señal de que el ticker reporto resultados muy recientemente — justo lo
// que hace que un movimiento de pre/post-market sea mas interesante que
// cualquier otro dia. Solo cuenta si paso hace ≤5 dias: una fecha vieja que
// Yahoo nunca actualizo no es "reportó hace poco".
function reporteReciente(proximoEarnings, hoy) {
  const f = proximoEarnings?.fecha
  if (!f) return false
  return f < hoy && f >= sumarDiasISO(hoy, -DIAS_REPORTE_RECIENTE)
}

// Sesion del dato: se prefiere el `estado` que manda el pipeline (PRE/POST);
// si no viene, se infiere de que precio esta presente.
function sesionDe(ppm) {
  if (ppm?.estado === 'PRE' && ppm.pre_precio != null) return 'PRE'
  if (ppm?.estado === 'POST' && ppm.post_precio != null) return 'POST'
  if (ppm?.pre_precio != null) return 'PRE'
  if (ppm?.post_precio != null) return 'POST'
  return null
}

export default function PrePostMarket() {
  const { filas: conOverrides, cargando, error } = useFilasCombinadas()
  const meta = useMeta()
  const { pins, isPinned, toggle } = usePins()
  const hoy = hoyAR()

  const conDato = useMemo(() => {
    return conOverrides
      .map((f) => ({ f, sesion: sesionDe(f.pre_post_market) }))
      .filter(({ sesion }) => sesion)
      .map(({ f, sesion }) => {
        const ppm = f.pre_post_market
        const esPre = sesion === 'PRE'
        return {
          ...f,
          _sesion: sesion,
          _precioSesion: esPre ? ppm.pre_precio : ppm.post_precio,
          _cambioPct: esPre ? ppm.pre_cambio_pct : ppm.post_cambio_pct,
          _actualizadoSesion: (esPre ? ppm.pre_actualizado : ppm.post_actualizado) ?? null,
          _reporteReciente: reporteReciente(f.proximo_earnings, hoy),
        }
      })
  }, [conOverrides, hoy])

  const t = useTabla(conDato, { camposBusqueda: CAMPOS, ordenInicial: { key: '_cambioPct', dir: 'desc' } })

  // Referencia del % de cambio: en pre-market es el cierre de AYER; en
  // post-market es el cierre regular de HOY. El nombre de la columna sigue a
  // la sesion que hay en los datos.
  const sesiones = useMemo(() => new Set(conDato.map((f) => f._sesion)), [conDato])
  const labelCierre =
    sesiones.size === 1 ? (sesiones.has('PRE') ? 'Cierre anterior' : 'Cierre regular (hoy)') : 'Cierre de referencia'

  const columnas = useMemo(
    () => [
      columnaPin(isPinned, toggle),
      {
        key: 'ticker',
        label: 'Ticker',
        align: 'left',
        valor: (r) => r.ticker,
        render: (r) => (
          <span className="inline-flex items-center gap-1">
            <TickerLink ticker={r.ticker} className="font-semibold" />
            {r._reporteReciente && (
              <span
                className="text-terminal-warn"
                title={`Reportó resultados el ${r.proximo_earnings.fecha.split('-').reverse().join('/')} (últimos ${DIAS_REPORTE_RECIENTE} días) — el movimiento puede ser reacción a eso`}
              >
                📣
              </span>
            )}
          </span>
        ),
      },
      {
        key: 'nombre',
        label: 'Empresa',
        align: 'left',
        valor: (r) => r.nombre,
        render: (r) => (
          <span className="block max-w-[180px] truncate text-terminal-dim" title={r.nombre}>
            {r.nombre}
          </span>
        ),
      },
      {
        key: '_sesion',
        label: 'Sesión',
        align: 'left',
        valor: (r) => r._sesion,
        render: (r) => (
          <span
            className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${
              r._sesion === 'PRE' ? 'bg-terminal-info/20 text-terminal-info' : 'bg-terminal-accent/20 text-terminal-accent'
            }`}
          >
            {r._sesion === 'PRE' ? 'Pre-market' : 'Post-market'}
          </span>
        ),
      },
      {
        key: '_precioSesion',
        label: 'Precio',
        align: 'right',
        valor: (r) => r._precioSesion,
        render: (r) => fmtPrecio(r._precioSesion),
      },
      {
        key: '_cambioPct',
        label: 'Var. %',
        align: 'right',
        valor: (r) => r._cambioPct,
        estilo: (r) => estiloValor(r._cambioPct, 3),
        render: (r) => <span className="font-bold">{fmtPct(r._cambioPct, { signo: true })}</span>,
        ayuda: 'Precio de la sesión extendida vs. el cierre regular de referencia (columna de al lado).',
      },
      {
        key: '_actualizadoSesion',
        label: 'Dato de',
        align: 'right',
        valor: (r) => (r._actualizadoSesion ? new Date(r._actualizadoSesion).getTime() : null),
        render: (r) =>
          r._actualizadoSesion ? (
            <span className="whitespace-nowrap text-terminal-dim" title={fmtFecha(r._actualizadoSesion)}>
              {fmtAntiguedad(r._actualizadoSesion)}
            </span>
          ) : (
            <span className="text-terminal-dim">—</span>
          ),
        ayuda: 'Hace cuánto se tomó el precio de pre/post-market (Yahoo lo actualiza con demora y fuera del horario regular hay poco volumen).',
      },
      {
        key: 'precio',
        label: labelCierre,
        align: 'right',
        valor: (r) => r.precio,
        render: (r) => <span className="text-terminal-dim">{fmtPrecio(r.precio)}</span>,
      },
      {
        key: 'industria',
        label: 'Industria',
        align: 'left',
        valor: (r) => r.industria,
        render: (r) => (
          <span className="block max-w-[140px] truncate text-terminal-dim" title={r.industria}>
            {r.industria}
          </span>
        ),
      },
    ],
    [isPinned, toggle, labelCierre],
  )

  const colsCSV = [
    { key: 'ticker', label: 'Ticker' },
    { key: 'nombre', label: 'Empresa' },
    { key: 'sesion', label: 'Sesión', valorCSV: (r) => r._sesion },
    { key: 'precio_sesion', label: 'Precio', valorCSV: (r) => r._precioSesion },
    { key: 'var_pct', label: 'Var. %', valorCSV: (r) => r._cambioPct },
    { key: 'actualizado_sesion', label: 'Dato de', valorCSV: (r) => r._actualizadoSesion ?? '' },
    { key: 'precio_cierre', label: labelCierre, valorCSV: (r) => r.precio },
    { key: 'reporte_reciente', label: 'Reporte reciente', valorCSV: (r) => (r._reporteReciente ? 'Sí' : '') },
  ]

  // Hora de la ultima corrida del pipeline (meta.json), no la de una fila
  // cualquiera: las filas solo traen `actualizado` si estan arrastradas.
  const ultimaActualizacion = meta?.ultima_actualizacion

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">🌗 Pre/Post Market</h1>
        <p className="text-xs text-terminal-dim">
          Movimientos de pre-market y post-market de tu universo, ordenados por variación % —
          quiénes se mueven más antes de la apertura o después del cierre. 📣 marca tickers que
          reportaron resultados en los últimos {DIAS_REPORTE_RECIENTE} días (probable reacción del
          mercado a eso). Solo se completa durante la corrida de pre-market o post-market del
          pipeline y se borra en la siguiente corrida — si no ves nada acá es porque estás en
          horario de mercado regular o cerrado, no un error.
          {ultimaActualizacion && (
            <> Último snapshot: <b>{fmtFecha(ultimaActualizacion)}</b>.</>
          )}
        </p>
      </div>

      <Controles
        busqueda={t.busqueda}
        setBusqueda={t.setBusqueda}
        pais={t.pais}
        setPais={t.setPais}
        paises={t.paises}
        industria={t.industria}
        setIndustria={t.setIndustria}
        industrias={t.industrias}
        onExportCSV={() => exportarCSV('stock-lens-pre-post-market.csv', colsCSV, t.filtradas)}
        total={conDato.length}
        mostrados={t.filtradas.length}
      />

      {cargando ? (
        <TablaSkeleton columnas={7} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : t.filtradas.length === 0 ? (
        <Vacio texto="Ningún ticker de tu universo tiene datos de pre/post-market en este momento — solo se completa durante la corrida de pre-market (~pre-apertura) o post-market (~post-cierre) del pipeline, y se sobreescribe en la siguiente corrida." />
      ) : (
        <Tabla columnas={columnas} filas={t.filtradas} sortKey={t.sortKey} sortDir={t.sortDir} onSort={t.ordenar} pins={pins} />
      )}
    </div>
  )
}
