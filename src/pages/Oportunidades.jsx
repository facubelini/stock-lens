import { useMemo } from 'react'
import { useJson } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { exportarCSV } from '../lib/csv'
import { TIMEFRAMES, ESTILO_VERDICT, tieneSenal, prioridadScreener } from '../lib/screenerEstilos'
import { calcularDescuento, evaluarCalidad, señalesTrampaValor } from '../lib/valuacion'
import Controles from '../components/Controles'
import Tabla from '../components/Tabla'
import BotonPin from '../components/BotonPin'
import TickerLink from '../components/TickerLink'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { fmtNum, fmtPct, estiloValor } from '../lib/formato'

const CAMPOS = ['ticker', 'nombre']

export default function Oportunidades() {
  const { data: fundData, cargando: cargF, error: errF } = useJson('fundamentales.json')
  const { data: compData, cargando: cargC } = useJson('comparables.json')
  const { data: screenerData, cargando: cargS } = useJson('screener.json')
  const { data: historialData } = useJson('oportunidades_historial.json')
  const { overrides } = useClasificacion()
  const { pins, isPinned, toggle } = usePins()

  // "Hace cuántos días" que cada ticker viene apareciendo en Oportunidades:
  // se cuenta hacia atrás desde hoy mientras el ticker siga presente sin
  // cortes. Se arma un día a la vez desde que se activó esta función.
  const diasEnListaPorTicker = useMemo(() => {
    const hist = Array.isArray(historialData) ? historialData : []
    if (!hist.length) return new Map()
    const ordenado = [...hist].sort((a, b) => b.fecha.localeCompare(a.fecha))
    const tickersHoy = ordenado[0]?.tickers ?? []
    const mapa = new Map()
    for (const ticker of tickersHoy) {
      let dias = 0
      for (const entrada of ordenado) {
        if (entrada.tickers?.includes(ticker)) dias++
        else break
      }
      mapa.set(ticker, dias)
    }
    return mapa
  }, [historialData])

  const fundRaw = useMemo(() => (Array.isArray(fundData) ? fundData : (fundData?.acciones ?? [])), [fundData])
  const fundamentales = useMemo(() => aplicarClasificacion(fundRaw, overrides), [fundRaw, overrides])

  const medianaPorIndustria = useMemo(() => {
    const m = new Map()
    for (const g of Array.isArray(compData) ? compData : []) m.set(g.industria, g.mediana)
    return m
  }, [compData])

  const screenerPorTicker = useMemo(() => {
    const m = new Map()
    for (const f of Array.isArray(screenerData) ? screenerData : []) m.set(f.ticker, f)
    return m
  }, [screenerData])

  const combinadas = useMemo(() => {
    return fundamentales
      .map((f) => {
        const mediana = medianaPorIndustria.get(f.industria)
        const descuento = calcularDescuento(f, mediana)
        const screenerFila = screenerPorTicker.get(f.ticker)
        const conSeñal = screenerFila ? TIMEFRAMES.some((tf) => tieneSenal(screenerFila[tf.key])) : false
        return {
          ...f,
          _descuento: descuento,
          _screenerFila: screenerFila,
          _conSeñal: conSeñal,
          _prioridad: screenerFila ? prioridadScreener(screenerFila) : 0,
          _calidad: evaluarCalidad(f, mediana),
          _trampaValor: señalesTrampaValor(f),
          _diasEnLista: diasEnListaPorTicker.get(f.ticker) ?? 1,
        }
      })
      .filter((f) => f._descuento != null && f._descuento > 0 && f._conSeñal)
  }, [fundamentales, medianaPorIndustria, screenerPorTicker, diasEnListaPorTicker])

  const t = useTabla(combinadas, {
    camposBusqueda: CAMPOS,
    ordenInicial: { key: '_descuento', dir: 'desc' },
  })

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
          <TickerLink ticker={r.ticker} className="font-semibold text-terminal-text" />
          {r._trampaValor.length > 0 && (
            <span className="text-terminal-warn" title={`Posible trampa de valor: ${r._trampaValor.join(', ')}`}>
              ⚠️
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
        <span className="block max-w-[160px] truncate text-terminal-dim" title={r.nombre}>
          {r.nombre || '—'}
        </span>
      ),
    },
    {
      key: 'industria',
      label: 'Industria',
      align: 'left',
      valor: (r) => r.industria,
      render: (r) => (
        <span className="block max-w-[130px] truncate text-terminal-dim" title={r.industria}>
          {r.industria}
        </span>
      ),
    },
    {
      key: '_descuento',
      label: 'Descuento vs. industria',
      align: 'right',
      valor: (r) => r._descuento,
      estilo: (r) => estiloValor(r._descuento, 30),
      render: (r) => <span className="font-semibold">{fmtPct(r._descuento, { signo: true })}</span>,
      ayuda: 'Promedio del descuento % en PER/EV-Sales/P-S contra la mediana de tu industria curada.',
    },
    {
      key: 'per_trailing',
      label: 'PER',
      align: 'right',
      valor: (r) => r.per_trailing,
      render: (r) => fmtNum(r.per_trailing, 1),
    },
    {
      key: 'ev_sales',
      label: 'EV/Sales',
      align: 'right',
      valor: (r) => r.ev_sales,
      render: (r) => fmtNum(r.ev_sales, 2),
    },
    {
      key: '_señal',
      label: 'Señal Screener',
      align: 'left',
      sortable: false,
      csv: false,
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {TIMEFRAMES.map((tf) => {
            const dato = r._screenerFila?.[tf.key]
            if (!dato || !tieneSenal(dato)) return null
            const est = ESTILO_VERDICT[dato.verdict] ?? ESTILO_VERDICT.NEUTRAL
            return (
              <span
                key={tf.key}
                className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold"
                style={{ backgroundColor: est.bg, color: est.color }}
                title={dato.motivo}
              >
                {tf.label}: {est.label}
              </span>
            )
          })}
        </div>
      ),
    },
    {
      key: '_prioridad',
      label: 'Conv.',
      align: 'right',
      valor: (r) => r._prioridad,
      render: (r) => (
        <span className="tabular">
          {r._prioridad > 0 ? '+' : ''}
          {r._prioridad.toFixed(1)}
        </span>
      ),
      ayuda: 'Score de convicción del Screener (el mismo que ordena Top Señales).',
    },
    {
      key: '_calidad',
      label: 'Calidad',
      align: 'left',
      sortable: false,
      csv: false,
      render: (r) => {
        const c = r._calidad
        if (!c) return <span className="text-terminal-dim">N/D</span>
        const ok = c.roeOk && c.margenOk
        const parcial = c.roeOk || c.margenOk
        return (
          <span
            className={ok ? 'text-terminal-up' : parcial ? 'text-terminal-warn' : 'text-terminal-dim'}
            title={`ROE ${c.roeOk ? 'sobre' : 'bajo'} la mediana de industria · Margen ${c.margenOk ? 'sobre' : 'bajo'} la mediana`}
          >
            {ok ? '✓ ROE y margen sobre mediana' : parcial ? '~ parcial' : '✕ bajo mediana'}
          </span>
        )
      },
      ayuda: 'Si además de barata la empresa tiene ROE y margen por encima de su industria — barata Y rentable, no solo barata.',
    },
    {
      key: '_diasEnLista',
      label: 'Hace',
      align: 'right',
      valor: (r) => r._diasEnLista,
      render: (r) => (r._diasEnLista <= 1 ? 'Nuevo hoy' : `${r._diasEnLista} días`),
      ayuda: 'Días consecutivos que este ticker viene cumpliendo las condiciones — se arma con el tiempo desde que se activó esta función.',
    },
  ]

  const cargando = cargF || cargC || cargS

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Oportunidades</h1>
        <p className="text-xs text-terminal-dim">
          Cruza <b>valor</b> (cotiza más barato que la mediana de su industria en PER/EV-Sales/P-S)
          con <b>momentum</b> (señal COMPRA o CERCA en alguna temporalidad del Screener) — las dos
          condiciones a la vez, no cada una por separado. <b>Calidad</b> marca si además tiene ROE y
          margen por encima de su industria (barata y rentable, no solo barata) y{' '}
          <b>⚠️ trampa de valor</b> avisa cuando la rentabilidad es negativa o los insiders solo
          están vendiendo. Solo cubre industrias con comparables curados (ver pestaña Comparables);
          si tu industria no está ahí, no vas a ver esos tickers acá aunque estén baratos o con
          señal. Orientativo, no es recomendación de inversión.
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
        onExportCSV={() => exportarCSV('stock-lens-oportunidades.csv', columnas, t.filtradas)}
        total={combinadas.length}
        mostrados={t.filtradas.length}
      />

      {cargando ? (
        <TablaSkeleton columnas={8} />
      ) : errF ? (
        <MensajeError mensaje={errF} />
      ) : t.filtradas.length === 0 ? (
        <Vacio texto="Ningún ticker cumple hoy las dos condiciones (barato vs. industria + señal técnica) a la vez." />
      ) : (
        <Tabla
          columnas={columnas}
          filas={t.filtradas}
          sortKey={t.sortKey}
          sortDir={t.sortDir}
          onSort={t.ordenar}
          pins={pins}
        />
      )}
    </div>
  )
}
