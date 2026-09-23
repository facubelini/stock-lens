import { useMemo, useState } from 'react'
import { useFilas } from '../lib/useFilas'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { exportarCSV } from '../lib/csv'
import { selectCls } from '../lib/estilos'
import {
  ESTILO_STATUS,
  ESTILO_GLOBAL,
  esSetupConfirmado,
  esCerca,
  prioridadScanner,
} from '../lib/scannerEstilos'
import Controles from '../components/Controles'
import Tabla from '../components/Tabla'
import BotonActualizar from '../components/BotonActualizar'
import ComoSeCalcula, { Formula } from '../components/ComoSeCalcula'
import { columnaPin, columnaTicker } from '../components/columnas'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { fmtNum } from '../lib/formato'

const CAMPOS = ['ticker', 'nombre']
const RSI_OPCIONES = ['Todos', ...Array.from({ length: 21 }, (_, i) => String(i * 5))]

function Badge({ estilo }) {
  if (!estilo) return <span className="text-terminal-dim">—</span>
  return (
    <span
      className="inline-block w-fit whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold"
      style={{ backgroundColor: estilo.bg, color: estilo.color }}
    >
      {estilo.label}
    </span>
  )
}

function CeldaPerfil({ perfil }) {
  if (!perfil || perfil.status === 'NO_DATA') {
    return <Badge estilo={ESTILO_STATUS.NO_DATA} />
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <Badge estilo={ESTILO_STATUS[perfil.status]} />
        <span className="text-[11px] text-terminal-dim">RSI {fmtNum(perfil.rsi, 0)}</span>
        {perfil.score != null && (
          <span
            className="cursor-help text-[11px] font-semibold text-terminal-text"
            title="Criterios cumplidos de 6: distancia al ASL · distancia a la SMA30 · precio ≥ EMA200 · MACD > señal · SMI > señal · RSI > 50"
          >
            {perfil.score}/6
          </span>
        )}
      </div>
      {perfil.motivo && (
        <span
          className="block max-w-[220px] truncate text-[11px] leading-snug text-terminal-dim"
          title={perfil.motivo}
        >
          {perfil.motivo}
        </span>
      )}
    </div>
  )
}

export default function Scanner() {
  const { filas, cargando, error } = useFilas('scanner_setups.json')
  const { pins, isPinned, toggle } = usePins()

  const [filtroSetup, setFiltroSetup] = useState('todos') // todos | setup | cerca
  const [soloFavoritos, setSoloFavoritos] = useState(false)
  const [rsiTarget, setRsiTarget] = useState('corto') // corto | largo
  const [rsiMin, setRsiMin] = useState('Todos')
  const [rsiMax, setRsiMax] = useState('Todos')
  const t = useTabla(filas, { camposBusqueda: CAMPOS, ordenInicial: { key: '_prioridad', dir: 'desc' } })

  const filtradas = useMemo(() => {
    let base = t.filtradas
    if (soloFavoritos) base = base.filter((f) => pins.has(f.ticker))
    if (filtroSetup === 'setup') base = base.filter(esSetupConfirmado)
    if (filtroSetup === 'cerca') base = base.filter(esCerca)
    // Cada extremo se aplica por separado: antes solo filtraba si estaban
    // los DOS elegidos, y "RSI ≥ 50" solo no hacia nada.
    const min = rsiMin === 'Todos' ? null : Number(rsiMin)
    const max = rsiMax === 'Todos' ? null : Number(rsiMax)
    if (min != null || max != null) {
      base = base.filter((f) => {
        const rsi = f[rsiTarget]?.rsi
        if (rsi == null) return false
        return (min == null || rsi >= min) && (max == null || rsi <= max)
      })
    }
    return base
  }, [t.filtradas, soloFavoritos, pins, filtroSetup, rsiTarget, rsiMin, rsiMax])

  const tfCorto = filas[0]?.corto?.tf ?? 'Diario'
  const tfLargo = filas[0]?.largo?.tf ?? 'Semanal'
  const columnas = useMemo(() => [
    columnaPin(isPinned, toggle),
    columnaTicker(),
    {
      key: 'nombre',
      label: 'Empresa',
      align: 'left',
      valor: (r) => r.nombre,
      render: (r) => (
        <span className="block max-w-[160px] truncate text-terminal-dim" title={r.nombre}>
          {r.nombre}
        </span>
      ),
    },
    {
      key: '_prioridad',
      label: 'Global',
      align: 'left',
      valor: (r) => prioridadScanner(r),
      render: (r) => <Badge estilo={ESTILO_GLOBAL[r.status_global]} />,
    },
    {
      key: '_corto',
      label: `Corto (${tfCorto})`,
      align: 'left',
      sortable: false,
      csv: false,
      render: (r) => <CeldaPerfil perfil={r.corto} />,
    },
    {
      key: '_largo',
      label: `Largo (${tfLargo})`,
      align: 'left',
      sortable: false,
      csv: false,
      render: (r) => <CeldaPerfil perfil={r.largo} />,
    },
  ], [isPinned, toggle, tfCorto, tfLargo])

  const colsCSV = [
    { key: 'ticker', label: 'Ticker' },
    { key: 'nombre', label: 'Empresa' },
    { key: 'status_global', label: 'Status Global' },
    { key: 'tf_corto', label: 'TF Corto', valorCSV: (r) => r.corto?.tf ?? '' },
    { key: 'status_corto', label: 'Status Corto', valorCSV: (r) => r.corto?.status ?? '' },
    { key: 'rsi_corto', label: 'RSI Corto', valorCSV: (r) => r.corto?.rsi ?? '' },
    { key: 'score_corto', label: 'Score Corto', valorCSV: (r) => r.corto?.score ?? '' },
    { key: 'motivo_corto', label: 'Motivo Corto', valorCSV: (r) => r.corto?.motivo ?? '' },
    { key: 'tf_largo', label: 'TF Largo', valorCSV: (r) => r.largo?.tf ?? '' },
    { key: 'status_largo', label: 'Status Largo', valorCSV: (r) => r.largo?.status ?? '' },
    { key: 'rsi_largo', label: 'RSI Largo', valorCSV: (r) => r.largo?.rsi ?? '' },
    { key: 'score_largo', label: 'Score Largo', valorCSV: (r) => r.largo?.score ?? '' },
    { key: 'motivo_largo', label: 'Motivo Largo', valorCSV: (r) => r.largo?.motivo ?? '' },
  ]

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-terminal-text">🔭 Scanner</h1>
          <p className="text-xs text-terminal-dim">
            Puerto del scanner de escritorio del usuario (CEDEARs + MERVAL): busca zona de pullback
            (ASL de 21 ruedas Y SMA30, las dos a la vez) con confluencia de tendencia completa
            (precio sobre EMA200, MACD y SMI alcistas, RSI &gt; 50). <b>SETUP</b> = las dos
            condiciones confirmadas · <b>CERCA</b> = zona de precio acercándose con la tendencia ya
            confirmada. Perfil <b>Corto</b> en velas diarias y <b>Largo</b> en semanales
            (resampleadas del mismo histórico) — como esto es un sitio estático que se actualiza
            unas pocas veces al día vía GitHub Actions, no cada 15 minutos como el script original,
            no se usan velas intradía reales. Orientativo, no es recomendación de inversión.
          </p>
        </div>
        <BotonActualizar />
      </div>

      <ComoSeCalcula titulo="¿Cómo se calcula el setup y el x/6?">
        <p>
          <b className="text-terminal-text">Zona de pullback</b>: <Formula>|dist. al ASL(21)| ≤ tol_ASL</Formula> Y{' '}
          <Formula>|dist. a la SMA30| ≤ tol_SMA</Formula>, las dos a la vez. Tolerancias: Corto (diario)
          1,5% / 2,5% · Largo (semanal) 3% / 5%. <b className="text-terminal-text">CERCA</b> = misma
          regla con las tolerancias × 1,5.
        </p>
        <p>
          <b className="text-terminal-text">Tendencia confirmada</b>: precio ≥ EMA200 · MACD &gt; su señal ·
          SMI &gt; su señal · RSI(14) &gt; 50 — las 4. <b className="text-terminal-text">SETUP</b> = zona +
          tendencia; <b className="text-terminal-text">CERCA</b> = zona ampliada + tendencia.
        </p>
        <p>
          <b className="text-terminal-text">x/6</b> (solo en SETUP/CERCA): cuántos de estos 6 criterios se
          cumplen — hay distancia al ASL · hay distancia a la SMA30 · precio ≥ EMA200 · MACD alcista · SMI
          alcista · RSI &gt; 50. El motivo lista los que faltan. <b className="text-terminal-text">Global</b>:
          SETUP AMBOS (5) &gt; SETUP CORTO/LARGO (3) &gt; CERCA AMBOS (2) &gt; CERCA CORTO/LARGO (1) &gt; OK (0),
          es el orden de la columna Global.
        </p>
      </ComoSeCalcula>

      <Controles
        busqueda={t.busqueda}
        setBusqueda={t.setBusqueda}
        pais={t.pais}
        setPais={t.setPais}
        paises={t.paises}
        industria={t.industria}
        setIndustria={t.setIndustria}
        industrias={t.industrias}
        extra={
          <div className="flex flex-wrap items-center gap-2 rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-dim">
            <select className={selectCls} aria-label="Filtrar por setup" value={filtroSetup} onChange={(e) => setFiltroSetup(e.target.value)}>
              <option value="todos">Todos</option>
              <option value="setup">Sólo con setup</option>
              <option value="cerca">Sólo cerca</option>
            </select>

            <label className="flex cursor-pointer select-none items-center gap-1.5 hover:text-terminal-text">
              <input
                type="checkbox"
                checked={soloFavoritos}
                onChange={(e) => setSoloFavoritos(e.target.checked)}
                className="accent-terminal-accent"
              />
              Sólo favoritos
            </label>

            <span className="mx-1 h-4 w-px bg-terminal-border" />

            <span className="text-xs">RSI de:</span>
            <select className={selectCls} aria-label="Perfil del RSI" value={rsiTarget} onChange={(e) => setRsiTarget(e.target.value)}>
              <option value="corto">Corto</option>
              <option value="largo">Largo</option>
            </select>
            <span className="text-xs">entre</span>
            <select className={selectCls} aria-label="RSI mínimo" value={rsiMin} onChange={(e) => setRsiMin(e.target.value)}>
              {RSI_OPCIONES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <span className="text-xs">y</span>
            <select className={selectCls} aria-label="RSI máximo" value={rsiMax} onChange={(e) => setRsiMax(e.target.value)}>
              {RSI_OPCIONES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
        }
        onExportCSV={() => exportarCSV('stock-lens-scanner.csv', colsCSV, filtradas)}
        total={filas.length}
        mostrados={filtradas.length}
      />

      {cargando ? (
        <TablaSkeleton columnas={6} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : filtradas.length === 0 ? (
        <Vacio texto="Ningún ticker de tu universo cumple estos filtros ahora mismo." />
      ) : (
        <Tabla
          columnas={columnas}
          filas={filtradas}
          sortKey={t.sortKey}
          sortDir={t.sortDir}
          onSort={t.ordenar}
          pins={pins}
        />
      )}
    </div>
  )
}
