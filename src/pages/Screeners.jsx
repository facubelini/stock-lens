import { useMemo, useState } from 'react'
import { useFilasCombinadas } from '../lib/useFilas'
import { useTabla } from '../lib/useTabla'
import { inputCls } from '../lib/estilos'
import Tabla from '../components/Tabla'
import TickerLink from '../components/TickerLink'
import { MensajeError, Vacio } from '../components/Estados'
import { fmtPct, fmtNum, fmtPrecio, fmtMarketCap, fmtFechaCorta, estiloValor, hoyAR } from '../lib/formato'

// "Radar de eventos" (ruta /screeners): 5 scans rápidos del universo —
// volumen inusual, gaps de apertura, cerca de 52 semanas, compras de
// insiders y próximos resultados — como tablas ordenables (Tabla+useTabla).
// Antes vivían en Herramientas.jsx; se mudaron acá y ya no están allá.
// No confundir con el Screener técnico (/screener), que da veredictos
// COMPRA/CERCA/VENTA por temporalidad.

const colTicker = {
  key: 'ticker',
  label: 'Ticker',
  align: 'left',
  valor: (r) => r.ticker,
  render: (r) => <TickerLink ticker={r.ticker} className="font-semibold" />,
}

const colEmpresa = {
  key: 'nombre',
  label: 'Empresa',
  align: 'left',
  valor: (r) => r.nombre,
  render: (r) => (
    <span className="block max-w-[180px] truncate text-terminal-dim" title={r.nombre}>
      {r.nombre}
    </span>
  ),
}

const UMBRALES_GAP = [1, 2, 3, 5]
const UMBRALES_VOLUMEN = [1.5, 2, 3, 5]
const UMBRALES_52S = [2, 5, 10]

function VistaVolumen({ filas }) {
  const [umbral, setUmbral] = useState(2)
  const destacados = useMemo(
    () =>
      filas
        .filter((f) => f.vol_ratio != null && f.vol_ratio >= umbral)
        .sort((a, b) => b.vol_ratio - a.vol_ratio)
        .slice(0, 40),
    [filas, umbral],
  )
  const t = useTabla(destacados, { ordenInicial: { key: 'vol_ratio', dir: 'desc' } })

  const columnas = [
    colTicker,
    colEmpresa,
    { key: 'precio', label: 'Precio', align: 'right', valor: (r) => r.precio, render: (r) => fmtPrecio(r.precio) },
    {
      key: 'var_pct',
      label: 'Var. hoy',
      align: 'right',
      valor: (r) => r.var_pct,
      estilo: (r) => estiloValor(r.var_pct, 6),
      render: (r) => <span className="font-semibold">{fmtPct(r.var_pct, { signo: true })}</span>,
    },
    {
      key: 'vol_hoy',
      label: 'Volumen hoy',
      align: 'right',
      valor: (r) => r.vol_hoy,
      render: (r) => <span className="text-terminal-dim">{fmtMarketCap(r.vol_hoy)}</span>,
    },
    {
      key: 'vol_prom20',
      label: 'Prom. 20d',
      align: 'right',
      valor: (r) => r.vol_prom20,
      render: (r) => <span className="text-terminal-dim">{fmtMarketCap(r.vol_prom20)}</span>,
    },
    {
      key: 'vol_ratio',
      label: 'Ratio',
      align: 'right',
      valor: (r) => r.vol_ratio,
      render: (r) => <span className="font-bold text-terminal-accent">×{fmtNum(r.vol_ratio, 1)}</span>,
    },
  ]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-terminal-dim">Mostrar con volumen ≥</label>
        <select aria-label="Umbral" value={umbral} onChange={(e) => setUmbral(Number(e.target.value))} className={inputCls}>
          {UMBRALES_VOLUMEN.map((u) => (
            <option key={u} value={u}>
              {u}×
            </option>
          ))}
        </select>
        <span className="text-xs text-terminal-dim">el promedio de los últimos 20 días (máx. 40 resultados)</span>
      </div>
      {!t.filtradas.length ? (
        <Vacio texto="Ningún ticker de tu universo tiene hoy un volumen tan por encima de su promedio." />
      ) : (
        <Tabla columnas={columnas} filas={t.filtradas} sortKey={t.sortKey} sortDir={t.sortDir} onSort={t.ordenar} />
      )}
    </div>
  )
}

function VistaGaps({ filas }) {
  const [umbral, setUmbral] = useState(2)
  const destacados = useMemo(
    () =>
      filas
        .filter((f) => f.gap_pct != null && Math.abs(f.gap_pct) >= umbral)
        .sort((a, b) => Math.abs(b.gap_pct) - Math.abs(a.gap_pct))
        .slice(0, 40),
    [filas, umbral],
  )
  const t = useTabla(destacados, { ordenInicial: { key: 'gap_pct', dir: 'desc' } })

  const columnas = [
    colTicker,
    colEmpresa,
    {
      key: 'gap_pct',
      label: 'Gap apertura',
      align: 'right',
      valor: (r) => Math.abs(r.gap_pct),
      estilo: (r) => estiloValor(r.gap_pct, 6),
      render: (r) => <span className="font-bold">{fmtPct(r.gap_pct, { signo: true })}</span>,
    },
    {
      key: 'var_pct',
      label: 'Var. hoy',
      align: 'right',
      valor: (r) => r.var_pct,
      estilo: (r) => estiloValor(r.var_pct, 6),
      render: (r) => fmtPct(r.var_pct, { signo: true }),
    },
  ]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-terminal-dim">Mostrar con gap ≥</label>
        <select aria-label="Umbral" value={umbral} onChange={(e) => setUmbral(Number(e.target.value))} className={inputCls}>
          {UMBRALES_GAP.map((u) => (
            <option key={u} value={u}>
              {u}%
            </option>
          ))}
        </select>
        <span className="text-xs text-terminal-dim">
          entre el cierre de ayer y la apertura de hoy (máx. 40 resultados)
        </span>
      </div>
      {!t.filtradas.length ? (
        <Vacio texto="Ningún ticker de tu universo abrió hoy con un hueco tan grande respecto al cierre de ayer." />
      ) : (
        <Tabla columnas={columnas} filas={t.filtradas} sortKey={t.sortKey} sortDir={t.sortDir} onSort={t.ordenar} />
      )}
    </div>
  )
}

function Vista52Semanas({ filas }) {
  const [umbral, setUmbral] = useState(5)
  const destacados = useMemo(() => {
    const out = []
    for (const f of filas) {
      if (f.precio == null || f.high_52w == null || f.low_52w == null) continue
      if (f.high_52w <= f.low_52w * 1.001) continue
      const distMax = (f.precio / f.high_52w - 1) * 100
      const distMin = (f.precio / f.low_52w - 1) * 100
      const cercaMax = Math.abs(distMax) <= umbral
      const cercaMin = Math.abs(distMin) <= umbral
      if (!cercaMax && !cercaMin) continue
      const tipo = cercaMax && cercaMin ? (Math.abs(distMax) <= Math.abs(distMin) ? 'max' : 'min') : cercaMax ? 'max' : 'min'
      out.push({ ...f, _tipo: tipo, _dist: tipo === 'max' ? distMax : distMin })
    }
    return out.sort((a, b) => Math.abs(a._dist) - Math.abs(b._dist)).slice(0, 40)
  }, [filas, umbral])
  const t = useTabla(destacados, { ordenInicial: { key: '_dist', dir: 'asc' } })

  const columnas = [
    colTicker,
    colEmpresa,
    { key: 'precio', label: 'Precio', align: 'right', valor: (r) => r.precio, render: (r) => fmtPrecio(r.precio) },
    {
      key: '_tipo',
      label: 'Zona',
      align: 'right',
      valor: (r) => r._tipo,
      render: (r) => (
        <span className={r._tipo === 'max' ? 'font-semibold text-terminal-up' : 'font-semibold text-terminal-down'}>
          {r._tipo === 'max' ? '📈 Máximo' : '📉 Mínimo'}
        </span>
      ),
    },
    {
      key: '_dist',
      label: 'Distancia',
      align: 'right',
      valor: (r) => Math.abs(r._dist),
      render: (r) => <span className="font-bold">{fmtPct(r._dist, { signo: true })}</span>,
    },
    {
      key: 'high_52w',
      label: 'Máx. 52s',
      align: 'right',
      valor: (r) => r.high_52w,
      render: (r) => <span className="text-terminal-dim">{fmtPrecio(r.high_52w)}</span>,
    },
    {
      key: 'low_52w',
      label: 'Mín. 52s',
      align: 'right',
      valor: (r) => r.low_52w,
      render: (r) => <span className="text-terminal-dim">{fmtPrecio(r.low_52w)}</span>,
    },
  ]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-terminal-dim">Mostrar a menos de</label>
        <select aria-label="Umbral" value={umbral} onChange={(e) => setUmbral(Number(e.target.value))} className={inputCls}>
          {UMBRALES_52S.map((u) => (
            <option key={u} value={u}>
              {u}%
            </option>
          ))}
        </select>
        <span className="text-xs text-terminal-dim">de su máximo o mínimo de 52 semanas (máx. 40 resultados)</span>
      </div>
      {!t.filtradas.length ? (
        <Vacio texto="Ningún ticker de tu universo está cerca de su máximo o mínimo de 52 semanas ahora mismo." />
      ) : (
        <Tabla columnas={columnas} filas={t.filtradas} sortKey={t.sortKey} sortDir={t.sortDir} onSort={t.ordenar} />
      )}
    </div>
  )
}

function VistaInsiders({ filas }) {
  const destacados = useMemo(
    () =>
      filas
        .filter((f) => f.insider?.n_compras > 0)
        .sort((a, b) => (b.insider.valor_compras ?? 0) - (a.insider.valor_compras ?? 0))
        .slice(0, 40),
    [filas],
  )
  const t = useTabla(destacados, { ordenInicial: { key: '_valorCompras', dir: 'desc' } })

  const columnas = [
    colTicker,
    colEmpresa,
    {
      key: '_nCompras',
      label: 'Compras',
      align: 'right',
      valor: (r) => r.insider.n_compras,
      render: (r) => <span className="font-semibold text-terminal-up">{r.insider.n_compras}</span>,
    },
    {
      key: '_valorCompras',
      label: 'Monto comprado',
      align: 'right',
      valor: (r) => r.insider.valor_compras ?? 0,
      render: (r) => <span className="font-bold text-terminal-up">${fmtMarketCap(r.insider.valor_compras)}</span>,
    },
    {
      key: '_ventas',
      label: 'Ventas (mismo período)',
      align: 'right',
      valor: (r) => r.insider.valor_ventas ?? 0,
      render: (r) => (
        <span className="text-terminal-dim">
          {r.insider.n_ventas > 0 ? `${r.insider.n_ventas} · $${fmtMarketCap(r.insider.valor_ventas)}` : '—'}
        </span>
      ),
    },
  ]

  if (!destacados.length) {
    return <Vacio texto="Ningún ticker de tu universo tiene compras de insiders en los últimos 6 meses." />
  }

  return <Tabla columnas={columnas} filas={t.filtradas} sortKey={t.sortKey} sortDir={t.sortDir} onSort={t.ordenar} />
}

function VistaResultados({ filas }) {
  // 'Hoy' en Buenos Aires (en UTC, desde las 21 hs ya era mañana).
  const hoy = hoyAR()
  const destacados = useMemo(
    () =>
      filas
        .filter((f) => f.proximo_earnings?.fecha && f.proximo_earnings.fecha >= hoy)
        .sort((a, b) => a.proximo_earnings.fecha.localeCompare(b.proximo_earnings.fecha))
        .slice(0, 40),
    [filas, hoy],
  )
  const t = useTabla(destacados, { ordenInicial: { key: '_fecha', dir: 'asc' } })

  const columnas = [
    colTicker,
    colEmpresa,
    {
      key: '_fecha',
      label: 'Fecha',
      align: 'left',
      valor: (r) => r.proximo_earnings.fecha,
      render: (r) => (
        <span className="whitespace-nowrap font-semibold text-terminal-text">
          {fmtFechaCorta(r.proximo_earnings.fecha)}
          {r.proximo_earnings.fecha_fin && ` – ${fmtFechaCorta(r.proximo_earnings.fecha_fin)}`}
        </span>
      ),
    },
    {
      key: '_estado',
      label: 'Estado',
      align: 'left',
      valor: (r) => (r.proximo_earnings.estimado ? 1 : 0),
      render: (r) => <span className="text-terminal-dim">{r.proximo_earnings.estimado ? 'Estimado' : 'Confirmado'}</span>,
    },
  ]

  if (!destacados.length) {
    return <Vacio texto="No hay fechas de resultados próximas cargadas para tu universo." />
  }

  return <Tabla columnas={columnas} filas={t.filtradas} sortKey={t.sortKey} sortDir={t.sortDir} onSort={t.ordenar} />
}

const VISTAS = [
  { key: 'volumen', label: 'Volumen inusual', Componente: VistaVolumen },
  { key: 'gaps', label: 'Gaps de apertura', Componente: VistaGaps },
  { key: '52s', label: 'Cerca de 52 semanas', Componente: Vista52Semanas },
  { key: 'insiders', label: 'Compras de insiders', Componente: VistaInsiders },
  { key: 'resultados', label: 'Próximos resultados', Componente: VistaResultados },
]

export default function Screeners() {
  const { filas, cargando, error } = useFilasCombinadas()
  const [vista, setVista] = useState('volumen')

  if (cargando) return <div className="skeleton h-64 rounded-lg" />
  if (error) return <MensajeError mensaje={error} />

  const { Componente } = VISTAS.find((v) => v.key === vista)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-terminal-text">📡 Radar de eventos</h1>
        <p className="text-xs text-terminal-dim">
          5 scans rápidos de eventos del día en tu universo — volumen inusual, gaps, cerca de
          máximos/mínimos de 52 semanas, compras de insiders y próximos resultados — cada uno como
          tabla ordenable. Para veredictos técnicos de compra/venta está el Screener técnico.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {VISTAS.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => setVista(v.key)}
            aria-pressed={vista === v.key}
            className={`rounded px-3 py-1.5 text-sm transition-colors ${
              vista === v.key
                ? 'bg-terminal-accent font-semibold text-black'
                : 'border border-terminal-border text-terminal-dim hover:bg-terminal-panel2 hover:text-terminal-text'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <Componente filas={filas} />
    </div>
  )
}
