import { useMemo, useState } from 'react'
import { calcTPSL, calcLeverage } from '../../lib/crypto/indicadores'
import { fmtPrice } from '../../lib/crypto/formato'
import { APALANCAMIENTOS } from '../../lib/crypto/constantes'
import Insignia from './Insignia'

// Cuerpo de la calculadora de apalancamiento/liquidacion (margen + leverage +
// tipo de margen -> precio de liquidacion, PnL y ROE en SL/TP1/TP2/TP3).
// Se usa tanto en el panel lateral de Crypto Screener como en la vista de
// detalle de un símbolo — es la misma info, solo cambia el contenedor.
export default function CalculadoraApalancamiento({ fila, klines, atrMult }) {
  const [margen, setMargen] = useState(20)
  const [apalancamiento, setApalancamiento] = useState(10)
  const [tipoMargen, setTipoMargen] = useState('isolated')

  const tpsl = useMemo(() => calcTPSL(fila, klines, atrMult), [fila, klines, atrMult])
  const lev = useMemo(
    () => (tpsl ? calcLeverage(tpsl, margen, apalancamiento, tipoMargen) : null),
    [tpsl, margen, apalancamiento, tipoMargen],
  )

  const f$ = (v) => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2)
  const fROE = (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'

  return (
    <div className="p-4">
      <div className="mb-3">
        <div className="mb-1 text-sm text-terminal-text">
          {fmtPrice(fila.price)}{' '}
          <span className={fila.chg24h >= 0 ? 'text-terminal-up' : 'text-terminal-down'}>
            {fila.chg24h >= 0 ? '+' : ''}
            {fila.chg24h}% 24h
          </span>
        </div>
        <Insignia cls={fila.cls}>{fila.signal}</Insignia>{' '}
        <span className="text-xs text-terminal-dim">
          Score: {fila.score > 0 ? '+' : ''}
          {fila.score}
        </span>
      </div>
      <hr className="mb-3 border-terminal-border" />

      {!tpsl ? (
        <p className="text-sm text-terminal-dim">Señal NEUTRAL — sin niveles sugeridos.</p>
      ) : (
        <>
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
            Apalancamiento y margen
          </div>
          <div className="mb-3 grid grid-cols-3 gap-2">
            <div>
              <label className="mb-1 block text-[11px] text-terminal-dim">Margen (USD)</label>
              <input
                type="number"
                min={1}
                value={margen}
                onChange={(e) => setMargen(Number(e.target.value) || 0)}
                className="w-full rounded border border-terminal-border bg-terminal-bg px-2 py-1.5 text-sm font-semibold text-terminal-text focus:border-terminal-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-terminal-dim">Apalancamiento</label>
              <select
                value={apalancamiento}
                onChange={(e) => setApalancamiento(Number(e.target.value))}
                className="w-full rounded border border-terminal-border bg-terminal-bg px-2 py-1.5 text-sm font-semibold text-terminal-text focus:border-terminal-accent focus:outline-none"
              >
                {APALANCAMIENTOS.map((l) => (
                  <option key={l} value={l}>
                    {l}×
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-terminal-dim">Tipo margen</label>
              <div className="flex overflow-hidden rounded border border-terminal-border">
                <button
                  type="button"
                  onClick={() => setTipoMargen('isolated')}
                  className={`flex-1 py-1.5 text-[11px] font-semibold ${
                    tipoMargen === 'isolated' ? 'bg-terminal-accent text-black' : 'text-terminal-dim'
                  }`}
                >
                  🔒 Aislado
                </button>
                <button
                  type="button"
                  onClick={() => setTipoMargen('cross')}
                  className={`flex-1 py-1.5 text-[11px] font-semibold ${
                    tipoMargen === 'cross' ? 'bg-terminal-accent text-black' : 'text-terminal-dim'
                  }`}
                >
                  🔄 Cruzado
                </button>
              </div>
            </div>
          </div>

          {lev && (
            <>
              <div className="mb-3 grid grid-cols-2 gap-1.5 rounded bg-terminal-bg p-3">
                <div className="text-xs">
                  <span className="mb-0.5 block text-[10px] uppercase text-terminal-dim">Posición</span>
                  <span className="font-bold text-terminal-text">
                    ${lev.posSize.toLocaleString('es-AR', { maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="text-xs">
                  <span className="mb-0.5 block text-[10px] uppercase text-terminal-dim">Entrada</span>
                  <span className="font-bold text-terminal-text">{fmtPrice(tpsl.entry)}</span>
                </div>
                <div className="text-xs">
                  <span className="mb-0.5 block text-[10px] uppercase text-terminal-dim">Cantidad</span>
                  <span className="font-bold text-terminal-text">{lev.qty.toFixed(5)}</span>
                </div>
                <div className="text-xs">
                  <span className="mb-0.5 block text-[10px] uppercase text-terminal-dim">Mant. margen</span>
                  <span className="font-bold text-terminal-text">{(lev.mmr * 100).toFixed(2)}%</span>
                </div>
              </div>

              <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
                Resultados con apalancamiento
              </div>
              <table className="mb-2 w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-terminal-bg text-[10px] uppercase text-terminal-dim">
                    <td className="px-2 py-1.5">Nivel</td>
                    <td className="px-2 py-1.5 text-right">Precio</td>
                    <td className="px-2 py-1.5 text-right">G/P</td>
                    <td className="px-2 py-1.5 text-right">ROE</td>
                  </tr>
                </thead>
                <tbody>
                  {!lev.slSafe && (
                    <tr>
                      <td colSpan={4} className="bg-terminal-down/20 px-2 py-1.5 text-center text-[11px] text-terminal-down">
                        ⚠️ SL está más lejos que la liquidación — no se activará
                      </td>
                    </tr>
                  )}
                  <tr className="border-t border-terminal-border" style={{ backgroundColor: 'rgba(124,58,237,.12)' }}>
                    <td className="px-2 py-1.5 font-semibold" style={{ color: '#c084fc' }}>⚡ Liquidación</td>
                    <td className="px-2 py-1.5 text-right font-bold" style={{ color: '#c084fc' }}>{fmtPrice(lev.liqPrice)}</td>
                    <td className="px-2 py-1.5 text-right font-bold text-terminal-down">−${margen.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-right text-terminal-down">−100%</td>
                  </tr>
                  <tr className="border-t border-terminal-border" style={{ backgroundColor: 'rgba(248,113,113,.07)' }}>
                    <td className="px-2 py-1.5 font-semibold text-terminal-down">🛑 Stop Loss</td>
                    <td className="px-2 py-1.5 text-right font-bold text-terminal-down">{fmtPrice(tpsl.sl)}</td>
                    <td className="px-2 py-1.5 text-right font-bold text-terminal-down">{f$(lev.slPnL)}</td>
                    <td className="px-2 py-1.5 text-right text-terminal-down">{fROE(lev.slROE)}</td>
                  </tr>
                  <tr className="border-t border-terminal-border bg-terminal-bg">
                    <td className="px-2 py-1.5 font-semibold" style={{ color: '#60a5fa' }}>🎯 Entrada</td>
                    <td className="px-2 py-1.5 text-right font-bold" style={{ color: '#60a5fa' }}>{fmtPrice(tpsl.entry)}</td>
                    <td className="px-2 py-1.5 text-right text-terminal-dim">$0.00</td>
                    <td className="px-2 py-1.5 text-right text-terminal-dim">0%</td>
                  </tr>
                  <tr className="border-t border-terminal-border" style={{ backgroundColor: 'rgba(134,239,172,.04)' }}>
                    <td className="px-2 py-1.5 font-semibold text-terminal-up">✅ TP1 · 1:1</td>
                    <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{fmtPrice(tpsl.tp1)}</td>
                    <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{f$(lev.tp1PnL)}</td>
                    <td className="px-2 py-1.5 text-right text-terminal-up">{fROE(lev.tp1ROE)}</td>
                  </tr>
                  <tr className="border-t border-terminal-border" style={{ backgroundColor: 'rgba(74,222,128,.07)' }}>
                    <td className="px-2 py-1.5 font-semibold text-terminal-up">✅ TP2 · 1:2</td>
                    <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{fmtPrice(tpsl.tp2)}</td>
                    <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{f$(lev.tp2PnL)}</td>
                    <td className="px-2 py-1.5 text-right text-terminal-up">{fROE(lev.tp2ROE)}</td>
                  </tr>
                  <tr className="border-t border-terminal-border" style={{ backgroundColor: 'rgba(34,197,94,.10)' }}>
                    <td className="px-2 py-1.5 font-semibold text-terminal-up">✅ TP3 · 1:3</td>
                    <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{fmtPrice(tpsl.tp3)}</td>
                    <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{f$(lev.tp3PnL)}</td>
                    <td className="px-2 py-1.5 text-right text-terminal-up">{fROE(lev.tp3ROE)}</td>
                  </tr>
                </tbody>
              </table>

              {tipoMargen === 'isolated' ? (
                <div className="rounded border border-terminal-info/30 bg-terminal-info/10 p-2.5 text-xs leading-relaxed text-terminal-info">
                  🔒 <b>Margen aislado:</b> tu pérdida máxima es exactamente ${margen.toFixed(2)}. La posición se
                  liquida sin afectar el resto de tu cuenta.
                </div>
              ) : (
                <div className="rounded border border-terminal-warn/30 bg-terminal-warn/10 p-2.5 text-xs leading-relaxed text-terminal-warn">
                  🔄 <b>Margen cruzado:</b> Binance puede usar todo tu balance para evitar la liquidación. Podés
                  perder más que el margen depositado. El precio de liquidación es estimado.
                </div>
              )}
              {!lev.slSafe && (
                <div className="mt-2 rounded border border-terminal-down/30 bg-terminal-down/10 p-2.5 text-xs leading-relaxed text-terminal-down">
                  ⚠️ <b>Peligro:</b> con {apalancamiento}× el precio de liquidación ({fmtPrice(lev.liqPrice)}) está
                  más cerca que el Stop Loss. Reducí el apalancamiento o ajustá el SL.
                </div>
              )}
            </>
          )}

          <p className="mt-3 text-[11px] text-terminal-dim">
            ATR(14): {fmtPrice(tpsl.atr)} · SL swing ref: {fmtPrice(tpsl.slSwing)} ({tpsl.slSwingPct > 0 ? '+' : ''}
            {tpsl.slSwingPct}%)
          </p>
        </>
      )}

      <hr className="my-3 border-terminal-border" />
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">Indicadores</div>
      <div className="text-xs leading-relaxed text-terminal-text">
        {fila.details.split(' · ').map((s) => (
          <div key={s}>• {s}</div>
        ))}
      </div>

      <a
        href={fila.link}
        target="_blank"
        rel="noreferrer"
        className="mt-4 block rounded bg-terminal-accent px-3 py-2 text-center text-sm font-bold text-black hover:opacity-90"
      >
        Abrir en Binance Futures →
      </a>
    </div>
  )
}
