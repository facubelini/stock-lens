import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useFilas } from '../lib/useFilas'
import { useCryptoScan } from '../lib/cryptoScan'
import {
  TIMEFRAMES,
  prioridadScreener,
  tieneSenalAlcista,
  tieneSenalVenta,
} from '../lib/screenerEstilos'
import TickerLink from '../components/TickerLink'
import { ExplicacionConviccion } from '../components/Explicaciones'
import ComoSeCalcula, { Formula } from '../components/ComoSeCalcula'
import { TablaSkeleton, MensajeError, Vacio } from '../components/Estados'

const N_POR_LADO = 15

function mejorMotivo(fila) {
  // el timeframe con verdict mas fuerte (COMPRA > CERCA > VENTA), para el detalle.
  const orden = { COMPRA: 3, VENTA: 3, CERCA: 2, EXTENDIDO: 1, NEUTRAL: 0 }
  let mejor = null
  for (const { key, label } of TIMEFRAMES) {
    const d = fila[key]
    if (!d) continue
    if (!mejor || (orden[d.verdict] ?? 0) > (orden[mejor.d.verdict] ?? 0)) mejor = { label, d }
  }
  return mejor ? `${mejor.label}: ${mejor.d.verdict}` : ''
}

// Resumen de los 3 veredictos (D/S/M) para ver de un vistazo de donde sale
// la convicción.
function resumenVeredictos(fila) {
  return TIMEFRAMES.map(({ key, label }) => `${label[0]}:${fila[key]?.verdict ?? '—'}`).join(' ')
}

function Fila({ item }) {
  const positivo = item.valor >= 0
  return (
    <tr className="border-t border-terminal-border">
      <td className="whitespace-nowrap px-2 py-1.5">
        {item.tipo === 'crypto' ? (
          <Link
            to={`/cripto/${encodeURIComponent(item.ticker.replace('/USDT', 'USDT'))}`}
            className="font-semibold text-terminal-text hover:text-terminal-accent hover:underline"
          >
            {item.ticker}
          </Link>
        ) : (
          <TickerLink ticker={item.ticker} className="font-semibold text-terminal-text" />
        )}
      </td>
      {item.tipo !== 'crypto' && (
        <td className="max-w-[200px] truncate px-2 py-1.5 text-terminal-dim" title={item.nombre}>
          {item.nombre || '—'}
        </td>
      )}
      <td className="px-2 py-1.5 text-terminal-dim" title={item.titulo}>
        {item.detalle}
      </td>
      <td
        className="whitespace-nowrap px-2 py-1.5 text-right font-bold tabular"
        style={{ color: positivo ? '#7ee2a8' : '#ff9d9d' }}
      >
        {item.valor > 0 ? '+' : ''}
        {item.valor.toFixed(1)}
      </td>
    </tr>
  )
}

function TablaRanking({ titulo, color, items, vacio, tipo, etiquetaValor }) {
  return (
    <div>
      <h3 className={`mb-2 text-sm font-semibold ${color}`}>{titulo}</h3>
      {items.length === 0 ? (
        <Vacio texto={vacio} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-terminal-border">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                <th scope="col" className="px-2 py-2 font-semibold">
                  Ticker
                </th>
                {tipo !== 'crypto' && (
                  <th scope="col" className="px-2 py-2 font-semibold">
                    Nombre
                  </th>
                )}
                <th scope="col" className="px-2 py-2 font-semibold">
                  Señal
                </th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">
                  {etiquetaValor}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <Fila key={`${it.tipo}-${it.ticker}`} item={it} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Acciones y cripto se rankean POR SEPARADO: la convicción de acciones (suma
// ponderada de veredictos, rango −9..+12) y el score de cripto (suma de
// aportes de indicadores del Crypto Screener) son escalas distintas, mezclarlos
// en una sola lista no tenía sentido.
export default function TopSenales() {
  const { filas: screenerFilas, cargando, error } = useFilas('screener.json')
  const { ultimoScan } = useCryptoScan()

  const acciones = useMemo(() => {
    const items = screenerFilas.map((f) => ({
      tipo: 'stock',
      ticker: f.ticker,
      nombre: f.nombre,
      valor: prioridadScreener(f),
      detalle: mejorMotivo(f),
      titulo: resumenVeredictos(f),
      _alcista: tieneSenalAlcista(f),
      _venta: tieneSenalVenta(f),
    }))
    return {
      // Del lado alcista hace falta al menos un COMPRA/CERCA: un EXTENDIDO
      // solo (alcista pero sin punto de entrada) sumaba +0,4..+1,5 y
      // aparecia como "oportunidad".
      alcistas: items
        .filter((i) => i.valor > 0 && i._alcista)
        .sort((a, b) => b.valor - a.valor)
        .slice(0, N_POR_LADO),
      bajistas: items
        .filter((i) => i.valor < 0 && i._venta)
        .sort((a, b) => a.valor - b.valor)
        .slice(0, N_POR_LADO),
    }
  }, [screenerFilas])

  const cripto = useMemo(() => {
    const items = (ultimoScan?.resultados ?? []).map((r) => ({
      tipo: 'crypto',
      ticker: r.symbol,
      valor: r.score ?? 0,
      detalle: r.signal,
    }))
    return {
      alcistas: items.filter((i) => i.valor > 0).sort((a, b) => b.valor - a.valor).slice(0, N_POR_LADO),
      bajistas: items.filter((i) => i.valor < 0).sort((a, b) => a.valor - b.valor).slice(0, N_POR_LADO),
    }
  }, [ultimoScan])

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Top Señales</h1>
        <p className="text-xs text-terminal-dim">
          Las señales más fuertes del{' '}
          <Link to="/screener" className="underline hover:text-terminal-accent">
            Screener técnico
          </Link>{' '}
          de acciones y del último escaneo de{' '}
          <Link to="/cripto" className="underline hover:text-terminal-accent">
            Crypto Screener
          </Link>
          , cada una rankeada en su propia escala, para tener en una sola pantalla dónde poner
          atención. Orientativo, no es recomendación de inversión.
        </p>
      </div>

      <ExplicacionConviccion />

      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-terminal-dim">📈 Acciones</h2>
      {cargando ? (
        <TablaSkeleton columnas={4} />
      ) : error ? (
        <MensajeError mensaje={error} />
      ) : (
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <TablaRanking
            titulo="▲ Alcistas (con COMPRA o CERCA en alguna temporalidad)"
            color="text-terminal-up"
            items={acciones.alcistas}
            vacio="Ninguna acción tiene hoy COMPRA o CERCA con convicción neta positiva."
            etiquetaValor="Conv."
          />
          <TablaRanking
            titulo="▼ Bajistas (con VENTA en alguna temporalidad)"
            color="text-terminal-down"
            items={acciones.bajistas}
            vacio="Ninguna acción tiene hoy VENTA con convicción neta negativa."
            etiquetaValor="Conv."
          />
        </div>
      )}

      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-terminal-dim">🪙 Cripto</h2>
      {!ultimoScan ? (
        <p className="text-xs text-terminal-warn">
          Todavía no corriste un escaneo de cripto en esta sesión — corré uno en{' '}
          <Link to="/cripto" className="underline hover:text-terminal-accent">
            Crypto Screener
          </Link>{' '}
          para que sus señales aparezcan acá.
        </p>
      ) : (
        <>
          <p className="mb-2 text-[11px] text-terminal-dim">Escaneo de las {ultimoScan.timestamp}.</p>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TablaRanking
              titulo="▲ LONG"
              color="text-terminal-up"
              tipo="crypto"
              items={cripto.alcistas}
              vacio="El último escaneo no tiene señales LONG."
              etiquetaValor="Score"
            />
            <TablaRanking
              titulo="▼ SHORT"
              color="text-terminal-down"
              tipo="crypto"
              items={cripto.bajistas}
              vacio="El último escaneo no tiene señales SHORT."
              etiquetaValor="Score"
            />
          </div>
          <ComoSeCalcula titulo="¿De dónde sale el score de cripto?" className="mt-3">
            <p>
              Es el score del Crypto Screener: <Formula>score = Σ aportes de cada indicador</Formula>{' '}
              (positivo = LONG, negativo = SHORT), calculado solo sobre velas cerradas. El desglose
              de cada aporte está en el detalle de cada par (click en el símbolo). No es comparable
              con la convicción de acciones — por eso va en un ranking aparte.
            </p>
          </ComoSeCalcula>
        </>
      )}
    </div>
  )
}
