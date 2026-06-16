import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { useWatchlist, aplicarWatchlist } from '../lib/watchlist'
import { exportarCSV } from '../lib/csv'
import Controles from '../components/Controles'
import Tabla from '../components/Tabla'
import BotonPin from '../components/BotonPin'
import Leyenda from '../components/Leyenda'
import Pendientes from '../components/Pendientes'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { fmtPct, fmtPrecio, estiloValor, promedio } from '../lib/formato'

const CAMPOS = ['ticker', 'nombre']
const ESCALA_DIST = 25 // % que se considera distancia "fuerte" para la intensidad

const distCol = (key, label) => ({
  key,
  label,
  align: 'right',
  valor: (r) => r[key],
  estilo: (r) => estiloValor(r[key], ESCALA_DIST),
  render: (r) => fmtPct(r[key], { signo: true }),
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
      <span className="block max-w-[220px] truncate text-terminal-dim" title={r.nombre}>
        {r.nombre || '—'}
      </span>
    ),
  },
  {
    key: 'precio',
    label: 'Precio',
    align: 'right',
    valor: (r) => r.precio,
    render: (r) => fmtPrecio(r.precio),
  },
  distCol('dist_ema21', 'Dist. EMA21'),
  distCol('dist_ema50', 'Dist. EMA50'),
  distCol('dist_ema150', 'Dist. EMA150'),
  distCol('dist_sma200', 'Dist. SMA200'),
]

const CLAVES_DIST = ['dist_ema21', 'dist_ema50', 'dist_ema150', 'dist_sma200']

function resumenGrupo(industria, fs, cols) {
  return (
    <tr className="border-t-2 border-terminal-border bg-terminal-panel2">
      <td colSpan={cols.length - CLAVES_DIST.length} className="px-3 py-2 font-semibold text-terminal-accent">
        {industria} <span className="font-normal text-terminal-dim">· {fs.length}</span>
      </td>
      {CLAVES_DIST.map((k) => {
        const prom = promedio(fs, (f) => f[k])
        return (
          <td
            key={k}
            className="px-3 py-2 text-right font-semibold tabular"
            style={estiloValor(prom, ESCALA_DIST)}
          >
            {fmtPct(prom, { signo: true })}
          </td>
        )
      })}
    </tr>
  )
}

export default function Medias() {
  const { data, cargando, error } = useJson('medias.json')
  const raw = useMemo(() => (Array.isArray(data) ? data : (data?.acciones ?? [])), [data])
  const { watchlist } = useWatchlist()
  const { filas, pendientes } = useMemo(
    () => aplicarWatchlist(raw, watchlist),
    [raw, watchlist],
  )
  const { pins, isPinned, toggle } = usePins()
  const [agrupar, setAgrupar] = useState(false)
  const t = useTabla(filas, {
    camposBusqueda: CAMPOS,
    ordenInicial: { key: 'dist_sma200', dir: 'desc' },
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
        <h1 className="text-lg font-bold text-terminal-text">Medias móviles</h1>
        <p className="text-xs text-terminal-dim">
          Distancia % del precio a cada media (diario). Verde = precio por encima de la media,
          rojo = por debajo. Intensidad según magnitud.
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
        onExportCSV={() => exportarCSV('stock-lens-medias.csv', columnas, t.filtradas)}
        total={filas.length}
        mostrados={t.filtradas.length}
      />

      <Leyenda />
      <Pendientes pendientes={pendientes} watchlist={watchlist} />

      {cargando ? (
        <TablaSkeleton columnas={8} />
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
          resumenGrupo={agrupar ? resumenGrupo : undefined}
          pins={pins}
        />
      )}
    </div>
  )
}
