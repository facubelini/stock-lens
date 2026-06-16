import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { exportarCSV } from '../lib/csv'
import Controles from '../components/Controles'
import Tabla from '../components/Tabla'
import BotonPin from '../components/BotonPin'
import Leyenda from '../components/Leyenda'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { fmtNum, fmtPct, fmtMarketCap, estiloPER, estiloPEG } from '../lib/formato'

const CAMPOS = ['ticker', 'nombre']

const numCol = (key, label, dec = 2) => ({
  key,
  label,
  align: 'right',
  valor: (r) => r[key],
  render: (r) => fmtNum(r[key], dec),
})

const pctCol = (key, label) => ({
  key,
  label,
  align: 'right',
  valor: (r) => r[key],
  render: (r) => fmtPct(r[key]),
})

const columnas = [
  {
    key: 'ticker',
    label: 'Ticker',
    align: 'left',
    valor: (r) => r.ticker,
    render: (r) => (
      <span className="font-semibold text-terminal-text" title={r.nombre || r.ticker}>
        {r.ticker}
      </span>
    ),
  },
  {
    key: 'nombre',
    label: 'Empresa',
    align: 'left',
    valor: (r) => r.nombre,
    render: (r) => (
      <span className="block max-w-[200px] truncate text-terminal-dim" title={r.nombre}>
        {r.nombre || '—'}
      </span>
    ),
  },
  {
    key: 'per_trailing',
    label: 'PER',
    align: 'right',
    valor: (r) => r.per_trailing,
    estilo: (r) => estiloPER(r.per_trailing),
    render: (r) => fmtNum(r.per_trailing, 1),
  },
  {
    key: 'per_forward',
    label: 'PER fwd',
    align: 'right',
    valor: (r) => r.per_forward,
    estilo: (r) => estiloPER(r.per_forward),
    render: (r) => fmtNum(r.per_forward, 1),
  },
  {
    key: 'peg',
    label: 'PEG',
    align: 'right',
    valor: (r) => r.peg,
    estilo: (r) => estiloPEG(r.peg),
    render: (r) => fmtNum(r.peg, 2),
  },
  numCol('ev_sales', 'EV/Sales'),
  numCol('pb', 'P/B'),
  numCol('ps', 'P/S'),
  {
    key: 'market_cap',
    label: 'Market Cap',
    align: 'right',
    valor: (r) => r.market_cap,
    render: (r) => fmtMarketCap(r.market_cap),
  },
  numCol('eps', 'EPS'),
  pctCol('profit_margin', 'Margen'),
  pctCol('roe', 'ROE'),
  pctCol('dividend_yield', 'Div. Yield'),
  numCol('beta', 'Beta'),
]

export default function Fundamentales() {
  const { data, cargando, error } = useJson('fundamentales.json')
  const filas = Array.isArray(data) ? data : (data?.acciones ?? [])
  const { pins, isPinned, toggle } = usePins()
  const [agrupar, setAgrupar] = useState(false)
  const t = useTabla(filas, {
    camposBusqueda: CAMPOS,
    ordenInicial: { key: 'market_cap', dir: 'desc' },
  })

  const columnasConPin = useMemo(
    () => [
      {
        key: '_pin',
        label: '',
        align: 'center',
        sortable: false,
        csv: false,
        tdClass: 'w-7 px-1',
        render: (r) => <BotonPin ticker={r.ticker} isPinned={isPinned} toggle={toggle} />,
      },
      ...columnas,
    ],
    [isPinned, toggle],
  )

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Fundamentales</h1>
        <p className="text-xs text-terminal-dim">
          Múltiplos y métricas clave por empresa. <code className="text-terminal-dim">N/D</code>{' '}
          cuando el dato no está disponible. El color de PER/PEG es sólo una guía visual de
          “barato/caro”, no una recomendación.
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
        agrupar={agrupar}
        setAgrupar={setAgrupar}
        onExportCSV={() => exportarCSV('stock-lens-fundamentales.csv', columnas, t.filtradas)}
        total={filas.length}
        mostrados={t.filtradas.length}
      />

      <Leyenda />

      {cargando ? (
        <TablaSkeleton columnas={10} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : t.filtradas.length === 0 ? (
        <Vacio />
      ) : (
        <Tabla
          columnas={columnasConPin}
          filas={t.filtradas}
          sortKey={t.sortKey}
          sortDir={t.sortDir}
          onSort={t.ordenar}
          agrupar={agrupar}
          pins={pins}
        />
      )}
    </div>
  )
}
