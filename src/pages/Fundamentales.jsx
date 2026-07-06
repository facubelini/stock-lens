import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { exportarCSV } from '../lib/csv'
import { medianaDe } from '../lib/benchmarks'
import { GLOSARIO_POR_CLAVE } from '../lib/glosario'
import Controles from '../components/Controles'
import Tabla from '../components/Tabla'
import BotonPin from '../components/BotonPin'
import EditorClasificacion from '../components/EditorClasificacion'
import FiltrosRango, { aplicarFiltrosRango } from '../components/FiltrosRango'
import Leyenda from '../components/Leyenda'
import Glosario from '../components/Glosario'
import TickerLink from '../components/TickerLink'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { fmtNum, fmtPct, fmtMarketCap, estiloPER, estiloPEG, estiloValor } from '../lib/formato'

const RECOMENDACION_LABEL = {
  strong_buy: 'Compra fuerte',
  buy: 'Compra',
  hold: 'Mantener',
  underperform: 'Bajo rendimiento',
  sell: 'Venta',
  strong_sell: 'Venta fuerte',
}

const CAMPOS = ['ticker', 'nombre']
const ayudaDe = (key) => GLOSARIO_POR_CLAVE[key]?.def

// Wrapper con max-width + title: algunos CEDEAR (.BA) traen ratios con
// magnitudes gigantescas (denominados en pesos) que si no, ensanchan toda la
// columna. Se trunca visualmente y se puede ver el valor completo al pasar el mouse.
const valorAcotado = (texto) => (
  <span className="block max-w-[85px] truncate" title={texto}>
    {texto}
  </span>
)

const numCol = (key, label, dec = 2) => ({
  key,
  label,
  align: 'right',
  valor: (r) => r[key],
  render: (r) => valorAcotado(fmtNum(r[key], dec)),
  ayuda: ayudaDe(key),
})

const pctCol = (key, label) => ({
  key,
  label,
  align: 'right',
  valor: (r) => r[key],
  render: (r) => valorAcotado(fmtPct(r[key])),
  ayuda: ayudaDe(key),
})

const columnas = [
  {
    key: 'ticker',
    label: 'Ticker',
    align: 'left',
    valor: (r) => r.ticker,
    render: (r) => (
      <span className="inline-flex items-center gap-1 font-semibold text-terminal-text">
        <TickerLink ticker={r.ticker} title={r.nombre || r.ticker} />
        {r.stale && (
          <span
            className="text-terminal-warn"
            title={`Dato arrastrado de la última corrida exitosa (${r.actualizado ?? '?'})`}
          >
            🕒
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
      <span className="block max-w-[95px] truncate text-terminal-dim" title={r.nombre}>
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
      <span className="block max-w-[64px] truncate text-terminal-dim" title={r.sector}>
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
    render: (r) => valorAcotado(fmtNum(r.per_trailing, 1)),
    ayuda: ayudaDe('per_trailing'),
  },
  {
    key: 'per_forward',
    label: 'PER fwd',
    align: 'right',
    valor: (r) => r.per_forward,
    estilo: (r) => estiloPER(r.per_forward),
    render: (r) => valorAcotado(fmtNum(r.per_forward, 1)),
    ayuda: ayudaDe('per_forward'),
  },
  {
    key: 'peg',
    label: 'PEG',
    align: 'right',
    valor: (r) => r.peg,
    estilo: (r) => estiloPEG(r.peg),
    render: (r) => valorAcotado(fmtNum(r.peg, 2)),
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
  numCol('target_mean_price', 'Precio obj.'),
  {
    key: 'upside_pct',
    label: 'Upside',
    align: 'right',
    valor: (r) => r.upside_pct,
    estilo: (r) => estiloValor(r.upside_pct, 25),
    render: (r) => valorAcotado(fmtPct(r.upside_pct, { signo: true })),
    ayuda: ayudaDe('upside_pct'),
  },
  {
    key: 'recommendation_key',
    label: 'Recom.',
    align: 'left',
    valor: (r) => r.recommendation_key,
    render: (r) => valorAcotado(RECOMENDACION_LABEL[r.recommendation_key] ?? '—'),
    valorCSV: (r) => RECOMENDACION_LABEL[r.recommendation_key] ?? '',
    ayuda: ayudaDe('recommendation_key'),
  },
]

// Claves numéricas para la fila de mediana por industria (benchmark).
const CLAVES_BENCH = [
  'per_trailing', 'per_forward', 'peg', 'ev_sales', 'pb', 'ps', 'market_cap',
  'eps', 'profit_margin', 'roe', 'dividend_yield', 'beta', 'debt_to_equity', 'current_ratio',
  'target_mean_price', 'upside_pct',
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
            <td key={c.key} className="px-1.5 py-2 font-semibold text-terminal-accent">
              <span className="block max-w-[90px] truncate" title={industria}>
                {industria}
              </span>
            </td>
          )
        if (c.key === 'nombre')
          return (
            <td key={c.key} className="whitespace-nowrap px-1.5 py-2 text-terminal-dim">
              mediana · n={fs.length}
            </td>
          )
        if (CLAVES_BENCH.includes(c.key))
          return (
            <td key={c.key} className="px-1.5 py-2 text-right tabular text-terminal-info">
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
  const { overrides } = useClasificacion()
  const filas = useMemo(
    () => aplicarClasificacion(raw, overrides),
    [raw, overrides],
  )
  const { pins, isPinned, toggle } = usePins()
  const [agrupar, setAgrupar] = useState(true)
  const t = useTabla(filas, {
    camposBusqueda: CAMPOS,
    ordenInicial: { key: 'market_cap', dir: 'desc' },
  })

  const [rangos, setRangos] = useState({})
  const setRango = (clave, campo, valor) =>
    setRangos((prev) => ({ ...prev, [clave]: { ...(prev[clave] ?? { min: '', max: '' }), [campo]: valor } }))
  const limpiarRangos = () => setRangos({})
  const filasFinal = useMemo(() => aplicarFiltrosRango(t.filtradas, rangos), [t.filtradas, rangos])

  const columnasConPin = useMemo(
    () => [
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
        key: '_editar',
        label: '',
        align: 'center',
        sortable: false,
        csv: false,
        tdClass: 'w-6 px-0.5',
        render: (r) => (
          <EditorClasificacion
            ticker={r.ticker}
            industria={r.industria}
            sector={r.sector}
            industrias={t.industrias}
            sectores={t.sectores}
          />
        ),
      },
      ...columnas,
    ],
    [isPinned, toggle, t.industrias, t.sectores],
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

      <FiltrosRango rangos={rangos} setRango={setRango} onLimpiar={limpiarRangos} />

      <Controles
        busqueda={t.busqueda}
        setBusqueda={t.setBusqueda}
        pais={t.pais}
        setPais={t.setPais}
        paises={t.paises}
        industria={t.industria}
        setIndustria={t.setIndustria}
        industrias={t.industrias}
        sector={t.sector}
        setSector={t.setSector}
        sectores={t.sectores}
        agrupar={agrupar}
        setAgrupar={setAgrupar}
        onExportCSV={() => exportarCSV('stock-lens-fundamentales.csv', columnas, filasFinal)}
        total={filas.length}
        mostrados={filasFinal.length}
      />

      <Leyenda />

      {cargando ? (
        <TablaSkeleton columnas={11} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : filasFinal.length === 0 ? (
        <Vacio texto="Ninguna acción cumple los filtros de rango actuales." />
      ) : (
        <Tabla
          columnas={columnasConPin}
          filas={filasFinal}
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
