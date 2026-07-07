import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getKlines, getFundingRate, getOpenInterest, getLongShortRatio } from '../lib/crypto/binanceApi'
import { analyzeKlines, calcularEstacionalidad } from '../lib/crypto/indicadores'
import { fmtPrice } from '../lib/crypto/formato'
import { INTERVALOS, MULTIPLOS_ATR } from '../lib/crypto/constantes'
import Insignia from '../components/crypto/Insignia'
import BarraRSI from '../components/crypto/BarraRSI'
import CalculadoraApalancamiento from '../components/crypto/CalculadoraApalancamiento'
import Sparkline from '../components/Sparkline'
import GraficoEstacionalidad from '../components/GraficoEstacionalidad'
import { Vacio } from '../components/Estados'

function fmtHora(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
}

function fmtCompacto(n) {
  if (n == null) return '—'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'
  return n.toFixed(2)
}

const selectCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

export default function CryptoDetalle() {
  const { symbol: symbolParam } = useParams()
  const symbol = decodeURIComponent(symbolParam || '').toUpperCase()

  const [intervalo, setIntervalo] = useState('1h')
  const [multiploATR, setMultiploATR] = useState(2.0)
  const [klines, setKlines] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [futuros, setFuturos] = useState(null) // { funding, oi, ls } — independiente de klines/intervalo
  const [estacionalidad, setEstacionalidad] = useState(null) // undefined = todavia no llego, null = sin datos suficientes

  useEffect(() => {
    let activo = true
    setCargando(true)
    setError(null)
    getKlines(symbol, intervalo, 200)
      .then((k) => {
        if (!activo) return
        if (!k) {
          setError('No se pudo traer datos de Binance para este símbolo (¿existe el futuro perpetuo?).')
          setKlines(null)
        } else {
          setKlines(k)
        }
      })
      .catch((e) => activo && setError(e.message))
      .finally(() => activo && setCargando(false))
    return () => {
      activo = false
    }
  }, [symbol, intervalo])

  // Datos "de futuros" (funding/OI/long-short): no dependen de la
  // temporalidad elegida, se piden una sola vez por símbolo.
  useEffect(() => {
    let activo = true
    setFuturos(null)
    Promise.all([getFundingRate(symbol), getOpenInterest(symbol), getLongShortRatio(symbol)]).then(
      ([funding, oi, ls]) => {
        if (activo) setFuturos({ funding, oi, ls })
      },
    )
    return () => {
      activo = false
    }
  }, [symbol])

  // Estacionalidad: velas mensuales, independiente de la temporalidad
  // elegida arriba (esa es para el grafico/señal, esta es para el historial
  // largo). Se pide una sola vez por simbolo.
  useEffect(() => {
    let activo = true
    setEstacionalidad(null)
    getKlines(symbol, '1M', 60).then((k) => {
      if (activo) setEstacionalidad(calcularEstacionalidad(k))
    })
    return () => {
      activo = false
    }
  }, [symbol])

  const fila = useMemo(() => (klines ? analyzeKlines(symbol, klines, multiploATR) : null), [symbol, klines, multiploATR])
  const closes = useMemo(() => (klines ? klines.map((k) => +k[4]) : []), [klines])

  return (
    <div>
      <Link to="/cripto" className="mb-3 inline-block text-sm text-terminal-dim hover:text-terminal-text">
        ← Volver a Crypto Screener
      </Link>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-terminal-text">{symbol.replace('USDT', '/USDT')}</h1>
          <p className="text-sm text-terminal-dim">Futuro perpetuo USDT · Binance</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-terminal-dim">Temporalidad</label>
          <select value={intervalo} onChange={(e) => setIntervalo(e.target.value)} className={selectCls}>
            {INTERVALOS.map((i) => (
              <option key={i.valor} value={i.valor}>
                {i.etiqueta}
              </option>
            ))}
          </select>
          <label className="text-xs text-terminal-dim">SL (ATR ×)</label>
          <select value={multiploATR} onChange={(e) => setMultiploATR(Number(e.target.value))} className={selectCls}>
            {MULTIPLOS_ATR.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>

      {cargando ? (
        <div className="rounded-lg border border-terminal-border bg-terminal-panel p-10 text-center text-sm text-terminal-dim">
          Cargando {symbol} desde Binance…
        </div>
      ) : error ? (
        <Vacio texto={error} />
      ) : !fila ? (
        <Vacio texto="No hay velas suficientes todavía para calcular la señal." />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="flex flex-col gap-4 lg:col-span-2">
            {closes.length > 1 && (
              <div className="overflow-hidden rounded-lg border border-terminal-border bg-terminal-panel p-3">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-terminal-dim">
                  <span>
                    {fmtPrice(fila.price)}{' '}
                    <span className={fila.chg24h >= 0 ? 'text-terminal-up' : 'text-terminal-down'}>
                      {fila.chg24h >= 0 ? '+' : ''}
                      {fila.chg24h}% (24h)
                    </span>{' '}
                    · {closes.length} velas · {intervalo}
                  </span>
                  <span>
                    mín {fmtPrice(Math.min(...closes))} · máx {fmtPrice(Math.max(...closes))}
                  </span>
                </div>
                <Sparkline datos={closes} ancho={640} alto={140} />
              </div>
            )}

            <div className="rounded-lg border border-terminal-border bg-terminal-panel p-4">
              <div className="mb-1 flex items-center gap-2">
                <Insignia cls={fila.cls}>{fila.signal}</Insignia>
                <span className="text-sm text-terminal-dim">
                  Score: {fila.score > 0 ? '+' : ''}
                  {fila.score}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div>
                  <span className="block text-[10px] uppercase text-terminal-dim">RSI</span>
                  <span className="font-semibold text-terminal-text">
                    {fila.rsi}
                    <BarraRSI valor={fila.rsi} />
                  </span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase text-terminal-dim">StochRSI</span>
                  <span className="font-semibold text-terminal-text">
                    {fila.srsi}
                    <BarraRSI valor={fila.srsi} />
                  </span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase text-terminal-dim">BB %</span>
                  <span className="font-semibold text-terminal-text">{fila.bb_pct}%</span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase text-terminal-dim">Tendencia EMA</span>
                  <span className="font-semibold text-terminal-text">
                    {fila.ema_trend === 'ALCISTA' ? '↑ ' : '↓ '}
                    {fila.ema_trend}
                  </span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase text-terminal-dim">Volumen</span>
                  <span className="font-semibold text-terminal-text">×{fila.vol_ratio}</span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase text-terminal-dim">ATR</span>
                  <span className="font-semibold text-terminal-text">{fila.atr_pct}%</span>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-terminal-border bg-terminal-panel p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
                  Datos de futuros
                </span>
                <span
                  className="text-[10px] text-terminal-dim"
                  title="No están disponibles para el escaneo masivo (demasiadas llamadas a Binance), solo acá."
                >
                  ⓘ solo en esta vista
                </span>
              </div>
              {!futuros ? (
                <p className="text-xs text-terminal-dim">Cargando…</p>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <span className="block text-[10px] uppercase text-terminal-dim">Funding rate</span>
                    {futuros.funding ? (
                      <>
                        <span
                          className={`font-semibold ${
                            futuros.funding.tasa >= 0 ? 'text-terminal-down' : 'text-terminal-up'
                          }`}
                          title={
                            futuros.funding.tasa >= 0
                              ? 'Positivo: los long le pagan a los short (mercado sesgado a long)'
                              : 'Negativo: los short le pagan a los long (mercado sesgado a short)'
                          }
                        >
                          {futuros.funding.tasa >= 0 ? '+' : ''}
                          {futuros.funding.tasa.toFixed(4)}%
                        </span>
                        <span className="ml-1.5 text-[10px] text-terminal-dim">
                          próx. {fmtHora(futuros.funding.proximoFunding)}
                        </span>
                      </>
                    ) : (
                      <span className="text-terminal-dim">N/D</span>
                    )}
                  </div>
                  <div>
                    <span className="block text-[10px] uppercase text-terminal-dim">Open Interest</span>
                    {futuros.oi != null ? (
                      <span className="font-semibold text-terminal-text">
                        {fmtCompacto(futuros.oi)} {symbol.replace('USDT', '')} · $
                        {fmtCompacto(futuros.oi * fila.price)}
                      </span>
                    ) : (
                      <span className="text-terminal-dim">N/D</span>
                    )}
                  </div>
                  <div>
                    <span className="block text-[10px] uppercase text-terminal-dim">Long / Short</span>
                    {futuros.ls ? (
                      <>
                        <div className="flex h-3 overflow-hidden rounded-full bg-terminal-border">
                          <div
                            className="h-full bg-terminal-up"
                            style={{ width: `${futuros.ls.largos}%` }}
                            title={`${futuros.ls.largos.toFixed(1)}% en largo`}
                          />
                          <div
                            className="h-full bg-terminal-down"
                            style={{ width: `${futuros.ls.cortos}%` }}
                            title={`${futuros.ls.cortos.toFixed(1)}% en corto`}
                          />
                        </div>
                        <span className="text-[10px] text-terminal-dim">
                          {futuros.ls.largos.toFixed(0)}% largo · {futuros.ls.cortos.toFixed(0)}% corto (ratio{' '}
                          {futuros.ls.ratio.toFixed(2)})
                        </span>
                      </>
                    ) : (
                      <span className="text-terminal-dim">N/D</span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {estacionalidad && (
              <div className="rounded-lg border border-terminal-border bg-terminal-panel p-4">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
                  Estacionalidad
                </div>
                <GraficoEstacionalidad datos={estacionalidad} />
                <p className="mt-2 text-[11px] text-terminal-dim">
                  Retorno promedio por mes calendario, con todo el historial de velas mensuales que
                  tenga este futuro perpetuo en Binance (hasta 5 años). Patrón histórico, no una
                  predicción.
                </p>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-terminal-border bg-terminal-panel">
            <div className="border-b border-terminal-border px-4 py-2.5 text-sm font-semibold text-terminal-text">
              Calculadora de apalancamiento · indicadores · link
            </div>
            <CalculadoraApalancamiento fila={fila} klines={klines} atrMult={multiploATR} />
          </div>
        </div>
      )}
    </div>
  )
}
