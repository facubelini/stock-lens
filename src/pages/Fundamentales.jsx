import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { useWatchlist, aplicarWatchlist } from '../lib/watchlist'
import { exportarCSV } from '../lib/csv'
import { medianaDe } from '../lib/benchmarks'
import { GLOSARIO_POR_CLAVE } from '../lib/glosario'
import Controles from '../components/Controles'
import Tabla from '../components/Tabla'
import BotonPin from '../components/BotonPin'
import Leyenda from '../components/Leyenda'
import Glosario from '../components/Glosario'
import Pendientes from '../components/Pendientes'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { fmtNum, fmtPct, fmtMarketCap, estiloPER, estiloPEG } from '../lib/formato'

const CAMPOS = ['ticker', 'nombre']
const ayudaDe = (key) => GLOSARIO_POR_CLAVE[key]?.def

const numCol = (key, label, dec = 2) => ({
  key,
  label,
  align: 'right',
  valor: (r) => r[key],
  render: (r) => fmtNum(r[key], dec),
  ayuda: ayudaDe(key),
})

const pctCol = (key, label) => ({
  key,
  label,
  align: 'right',
  valor: (r) => r[key],
  render: (r) => fmtPct(r[key]),
  ayuda: ayudaDe(key),
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
      <span className="block max-w-[180px] truncate text-terminal-dim" title={r.nombre}>
        {r.nombre || '—'}
      </span>
    ),
  },
  {
    key: 'sector',
    label: 'Sector',
    align: 'left',
    valor: (r) => r.sector,
    render: (r) => (
      <span className="block max-w-[130px] truncate text-terminal-dim" title={r.sector}>
        {r.sector || '—'}
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
    ayuda: ayudaDe('per_trailing'),
  },
  {
    key: 'per_forward',
    label: 'PER fwd',
    align: 'right',
    valor: (r) => r.per_forward,
    estilo: (r) => estiloPER(r.per_forward),
    render: (r) => fmtNum(r.per_forward, 1),
    ayuda: ayudaDe('per_forward'),
  },
  {
    key: 'peg',
    label: 'PEG',
    align: 'right',
    valor: (r) => r.peg,
    estilo: (r) => estiloPEG(r.peg),
    render: (r) => fmtNum(r.peg, 2),
    ayuda: ayudaDe('peg'),
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
    ayuda: ayudaDe('market_cap'),
  },
  numCol('eps', 'EPS'),
  pctCol('profit_margin', 'Margen'),
  pctCol('roe', 'ROE'),
  pctCol('dividend_yield', 'Div. Yield'),
  numCol('beta', 'Beta'),
  numCol('debt_to_equity', 'Deuda/Eq.'),
  numCol('current_ratio', 'Liquidez'),
]

// Claves numéricas para la fila de mediana por industria (benchmark).
const CLAVES_BENCH = [
  'per_trailing', 'per_forward', 'peg', 'ev_sales', 'pb', 'ps', 'market_cap',
  'eps', 'profit_margin', 'roe', 'dividend_yield', 'beta', 'debt_to_equity', 'current_ratio',
]

// Fila de resumen: mediana de cada ratio dentro de la industria (parámetro real del grupo).
function resumenGrupo(industria, fs, cols) {
  const med = {}
  for (const k of CLAVES_BENCH) med[k] = medianaDe(fs, (f) => f[k])
  return (
    <tr className="border-t-2 border-terminal-border bg-terminal-panel2">
      {cols.map((c) => {
        if (c.key === '_pin') return <td key={c.key} />
        if (c.key === 'ticker')
          return (
            <td key={c.key} className="whitespace-nowrap px-3 py-2 font-semibold text-terminal-accent">
              {industria}
            </td>
          )
        if (c.key === 'nombre')
          return (
            <td key={c.key} className="whitespace-nowrap px-3 py-2 text-terminal-dim">
              mediana · n={fs.length}
            </td>
          )
        if (CLAVES_BENCH.includes(c.key))
          return (
            <td key={c.key} className="px-3 py-2 text-right tabular text-terminal-info">
              {c.render ? c.render(med) : ''}
            </td>
          )
        return <td key={c.key} />
      })}
    </tr>
  )
}

export default function Fundamentales() {
  const { data, cargando, error } = useJson('fundamentales.json')
  const raw = useMemo(() => (Array.isArray(data) ? data : (data?.acciones ?? [])), [data])
  const { watchlist } = useWatchlist()
  const { filas, pendientes } = useMemo(
    () => aplicarWatchlist(raw, watchlist),
    [raw, watchlist],
  )
  const { pins, isPinned, toggle } = usePins()
  const [agrupar, setAgrupar] = useState(true)
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
          Múltiplos y métricas por empresa (<code>N/D</code> si falta el dato). Pasá el mouse por
          el <span className="text-terminal-dim">ⓘ</span> de cada columna para ver qué significa.
          Con <b>Agrupar por industria</b> ves la <b>mediana de cada grupo</b> como referencia.
        </p>
      </div>

      <Glosario />

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
      <Pendientes pendientes={pendientes} watchlist={watchlist} />

      {cargando ? (
        <TablaSkeleton columnas={10} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : t.filtradas.length === 0 ? (
        <Vacio texto={watchlist ? 'Ningún ticker de tu lista tiene datos todavía.' : undefined} />
      ) : (
        <Tabla
          columnas={columnasConPin}
          filas={t.filtradas}
          sortKey={t.sortKey}
          sortDir={t.sortDir}
          onSort={t.ordenar}
          agrupar={agrupar}
          resumenGrupo={agrupar ? resumenGrupo : undefined}
          pins={pins}
        />
      )}
    </div>
  )
}
