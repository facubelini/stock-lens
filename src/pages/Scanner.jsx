import { useMemo, useState } from 'react'
import { useJson } from '../lib/useJson'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { useTabla } from '../lib/useTabla'
import { usePins } from '../lib/usePins'
import { exportarCSV } from '../lib/csv'
import { getPat, dispararActualizacionDatos } from '../lib/githubApi'
import {
  ESTILO_STATUS,
  ESTILO_GLOBAL,
  esSetupConfirmado,
  esCerca,
  prioridadScanner,
} from '../lib/scannerEstilos'
import Controles from '../components/Controles'
import Tabla from '../components/Tabla'
import BotonPin from '../components/BotonPin'
import TickerLink from '../components/TickerLink'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'
import { fmtNum } from '../lib/formato'

const CAMPOS = ['ticker', 'nombre']
const selectCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'
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
          <span className="text-[11px] font-semibold text-terminal-text">{perfil.score}/6</span>
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
  const { data, cargando, error } = useJson('scanner_setups.json')
  const raw = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const { overrides } = useClasificacion()
  const filas = useMemo(() => aplicarClasificacion(raw, overrides), [raw, overrides])
  const { pins, isPinned, toggle } = usePins()

  const [filtroSetup, setFiltroSetup] = useState('todos') // todos | setup | cerca
  const [soloFavoritos, setSoloFavoritos] = useState(false)
  const [rsiTarget, setRsiTarget] = useState('corto') // corto | largo
  const [rsiMin, setRsiMin] = useState('Todos')
  const [rsiMax, setRsiMax] = useState('Todos')
  const [refresh, setRefresh] = useState(null) // { tipo: 'cargando'|'ok'|'error', texto }

  const onRefrescar = async () => {
    if (!getPat()) {
      setRefresh({
        tipo: 'error',
        texto: 'Configurá tu GitHub token (barra superior, "🔑 Configurar auto") para poder disparar la actualización.',
      })
      return
    }
    setRefresh({ tipo: 'cargando' })
    try {
      await dispararActualizacionDatos()
      setRefresh({
        tipo: 'ok',
        texto:
          'Actualización disparada. El pipeline tarda unos minutos en correr y GitHub Pages cachea los JSON hasta 10 min más.',
      })
    } catch (err) {
      setRefresh({ tipo: 'error', texto: err.message })
    }
  }

  const t = useTabla(filas, { camposBusqueda: CAMPOS, ordenInicial: { key: '_prioridad', dir: 'desc' } })

  const filtradas = useMemo(() => {
    let base = t.filtradas
    if (soloFavoritos) base = base.filter((f) => pins.has(f.ticker))
    if (filtroSetup === 'setup') base = base.filter(esSetupConfirmado)
    if (filtroSetup === 'cerca') base = base.filter(esCerca)
    if (rsiMin !== 'Todos' && rsiMax !== 'Todos') {
      const min = Number(rsiMin)
      const max = Number(rsiMax)
      base = base.filter((f) => {
        const rsi = f[rsiTarget]?.rsi
        return rsi != null && rsi >= min && rsi <= max
      })
    }
    return base
  }, [t.filtradas, soloFavoritos, pins, filtroSetup, rsiTarget, rsiMin, rsiMax])

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
      render: (r) => <TickerLink ticker={r.ticker} className="font-semibold" />,
    },
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
      label: `Corto (${filas[0]?.corto?.tf ?? 'Diario'})`,
      align: 'left',
      sortable: false,
      csv: false,
      render: (r) => <CeldaPerfil perfil={r.corto} />,
    },
    {
      key: '_largo',
      label: `Largo (${filas[0]?.largo?.tf ?? 'Semanal'})`,
      align: 'left',
      sortable: false,
      csv: false,
      render: (r) => <CeldaPerfil perfil={r.largo} />,
    },
  ]

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
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={onRefrescar}
            disabled={refresh?.tipo === 'cargando'}
            className="whitespace-nowrap rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-xs text-terminal-dim hover:border-terminal-accent hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-50"
            title="Dispara el pipeline (Actualizar datos) fuera del cron habitual"
          >
            {refresh?.tipo === 'cargando' ? '⏳ Actualizando…' : '🔄 Actualizar ahora'}
          </button>
          {refresh && refresh.tipo !== 'cargando' && (
            <span
              className={`max-w-xs text-right text-[11px] leading-snug ${
                refresh.tipo === 'error' ? 'text-terminal-down' : 'text-terminal-accent'
              }`}
            >
              {refresh.texto}
            </span>
          )}
        </div>
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
        extra={
          <div className="flex flex-wrap items-center gap-2 rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-dim">
            <select className={selectCls} value={filtroSetup} onChange={(e) => setFiltroSetup(e.target.value)}>
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
            <select className={selectCls} value={rsiTarget} onChange={(e) => setRsiTarget(e.target.value)}>
              <option value="corto">Corto</option>
              <option value="largo">Largo</option>
            </select>
            <span className="text-xs">entre</span>
            <select className={selectCls} value={rsiMin} onChange={(e) => setRsiMin(e.target.value)}>
              {RSI_OPCIONES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <span className="text-xs">y</span>
            <select className={selectCls} value={rsiMax} onChange={(e) => setRsiMax(e.target.value)}>
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
