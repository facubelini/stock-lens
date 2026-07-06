import { useMemo } from 'react'
import { useJson } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { exportarCSV } from '../lib/csv'
import { TIMEFRAMES, ESTILO_VERDICT, tieneSenal, prioridadScreener } from '../lib/screenerEstilos'
import { calcularDescuento } from '../lib/valuacion'
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
  const { overrides } = useClasificacion()
  const { pins, isPinned, toggle } = usePins()

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
        }
      })
      .filter((f) => f._descuento != null && f._descuento > 0 && f._conSeñal)
  }, [fundamentales, medianaPorIndustria, screenerPorTicker])

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
      render: (r) => <TickerLink ticker={r.ticker} className="font-semibold text-terminal-text" />,
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
  ]

  const cargando = cargF || cargC || cargS

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Oportunidades</h1>
        <p className="text-xs text-terminal-dim">
          Cruza <b>valor</b> (cotiza más barato que la mediana de su industria en PER/EV-Sales/P-S)
          con <b>momentum</b> (señal COMPRA o CERCA en alguna temporalidad del Screener) — las dos
          condiciones a la vez, no cada una por separado. Solo cubre industrias con comparables
          curados (ver pestaña Comparables); si tu industria no está ahí, no vas a ver esos tickers
          acá aunque estén baratos o con señal. Orientativo, no es recomendación de inversión.
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
