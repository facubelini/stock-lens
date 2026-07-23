import { useMemo } from 'react'
import { useDatosCombinados } from '../lib/useDatosCombinados'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { exportarCSV } from '../lib/csv'
import Controles from '../components/Controles'
import Tabla from '../components/Tabla'
import BotonPin from '../components/BotonPin'
import TickerLink from '../components/TickerLink'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { fmtPrecio, fmtPct, fmtFecha, estiloValor } from '../lib/formato'

const CAMPOS = ['ticker', 'nombre']

// Mismo chequeo que ya usa TickerDetalle para "próximo earnings": Yahoo
// tarda 1-2 dias en correr la fecha a la siguiente despues de un reporte,
// asi que una fecha ya pasada en proximo_earnings es, en la practica, la
// señal de que el ticker reporto resultados muy recientemente — justo lo
// que hace que un movimiento de pre/post-market sea mas interesante que
// cualquier otro dia.
function reporteReciente(proximoEarnings) {
  if (!proximoEarnings?.fecha) return false
  const hoy = new Date().toISOString().slice(0, 10)
  return proximoEarnings.fecha < hoy
}

export default function PrePostMarket() {
  const { filas: base, cargando, error } = useDatosCombinados()
  const { overrides } = useClasificacion()
  const conOverrides = useMemo(() => aplicarClasificacion(base, overrides), [base, overrides])
  const { pins, isPinned, toggle } = usePins()

  const conDato = useMemo(() => {
    return conOverrides
      .filter((f) => f.pre_post_market?.pre_precio != null || f.pre_post_market?.post_precio != null)
      .map((f) => {
        const ppm = f.pre_post_market
        const esPre = ppm.pre_precio != null
        const precio = esPre ? ppm.pre_precio : ppm.post_precio
        const cambioPct = esPre ? ppm.pre_cambio_pct : ppm.post_cambio_pct
        return {
          ...f,
          _sesion: esPre ? 'PRE' : 'POST',
          _precioSesion: precio,
          _cambioPct: cambioPct,
          _cambioAbs: Math.abs(cambioPct ?? 0),
          _reporteReciente: reporteReciente(f.proximo_earnings),
        }
      })
  }, [conOverrides])

  const t = useTabla(conDato, { camposBusqueda: CAMPOS, ordenInicial: { key: '_cambioAbs', dir: 'desc' } })

  const columnas = [
    {
      key: '_pin',
      label: '',
      align: 'center',
      sortable: false,
      csv: false,
      tdClass: 'w-6 px-0.5',
      render: (r) => <BotonPin ticker={r.ticker} isPinned={isPinned} toggle={toggle} />,
    },
    {
      key: 'ticker',
      label: 'Ticker',
      align: 'left',
      valor: (r) => r.ticker,
      render: (r) => (
        <span className="inline-flex items-center gap-1">
          <TickerLink ticker={r.ticker} className="font-semibold" />
          {r._reporteReciente && (
            <span className="text-terminal-warn" title="Reportó resultados en las últimas ruedas — el movimiento puede ser reacción a eso">
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
      valor: (r) => r._cambioAbs,
      estilo: (r) => estiloValor(r._cambioPct, 3),
      render: (r) => <span className="font-bold">{fmtPct(r._cambioPct, { signo: true })}</span>,
    },
    {
      key: 'precio',
      label: 'Cierre anterior',
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
  ]

  const colsCSV = [
    { key: 'ticker', label: 'Ticker' },
    { key: 'nombre', label: 'Empresa' },
    { key: 'sesion', label: 'Sesión', valorCSV: (r) => r._sesion },
    { key: 'precio_sesion', label: 'Precio', valorCSV: (r) => r._precioSesion },
    { key: 'var_pct', label: 'Var. %', valorCSV: (r) => r._cambioPct },
    { key: 'precio_cierre', label: 'Cierre anterior', valorCSV: (r) => r.precio },
    { key: 'reporte_reciente', label: 'Reporte reciente', valorCSV: (r) => (r._reporteReciente ? 'Sí' : '') },
  ]

  const ultimaActualizacion = conOverrides[0]?.actualizado

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">🌗 Pre/Post Market</h1>
        <p className="text-xs text-terminal-dim">
          Movimientos de pre-market y post-market de tu universo, ordenados por variación % —
          quiénes se mueven más antes de la apertura o después del cierre. 📣 marca tickers que
          reportaron resultados hace muy poco (probable reacción del mercado a eso). Solo se
          completa durante la corrida de pre-market o post-market del pipeline y se borra en la
          siguiente corrida — si no ves nada acá es porque estás en horario de mercado regular o
          cerrado, no un error.
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
