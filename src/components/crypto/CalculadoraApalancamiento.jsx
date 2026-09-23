import { useEffect, useMemo, useState } from 'react'
import {
  calcTPSL,
  calcLeverage,
  perfilApalancamiento,
  COMISION_TAKER,
  MULTIPLOS_TP_DEFAULT,
} from '../../lib/crypto/indicadores'
import { fmtPrice } from '../../lib/crypto/formato'
import { APALANCAMIENTOS } from '../../lib/crypto/constantes'
import Insignia from './Insignia'
import ProsContras from './ProsContras'
import DetalleCruces from './DetalleCruces'
import VariacionPeriodos from './VariacionPeriodos'

const inputCls =
  'w-full rounded border border-terminal-border bg-terminal-bg px-2 py-1.5 text-sm font-semibold text-terminal-text focus:border-terminal-accent focus:outline-none'

const pct = (v, d = 2) => `${(v * 100).toFixed(d).replace('.', ',')}%`

// Cuerpo de la calculadora de apalancamiento/liquidacion (margen + leverage +
// tipo de margen -> precio de liquidacion, PnL y ROE en SL y en cada TP).
// Se usa tanto en el panel lateral de los screeners como en la vista de
// detalle de un símbolo — es la misma info, solo cambia el contenedor.
// tradfi: el simbolo es una accion/commodity tokenizada (otro tope de
// apalancamiento). Si no viene, se deduce de que la fila traiga 'tipo'.
export default function CalculadoraApalancamiento({ fila, klines, atrMult, tradfi }) {
  // Las filas de la vista de detalle no pasan por useEscaneo, asi que el
  // simbolo crudo se deriva del de mostrar si no viene.
  const symbolRaw = fila.symbolRaw ?? fila.symbol?.replace('/', '')
  const perfil = useMemo(
    () => perfilApalancamiento(symbolRaw, { tradfi: tradfi ?? fila.tipo != null }),
    [symbolRaw, tradfi, fila.tipo],
  )
  const opcionesLev = APALANCAMIENTOS.filter((l) => l <= perfil.maxLev)

  const [margen, setMargen] = useState(20)
  const [apalancamiento, setApalancamiento] = useState(10)
  const [tipoMargen, setTipoMargen] = useState('isolated')
  const [comisionPct, setComisionPct] = useState(COMISION_TAKER * 100) // % por lado
  const [multiplosTP, setMultiplosTP] = useState(MULTIPLOS_TP_DEFAULT)

  // Si el simbolo no admite el apalancamiento elegido, se baja al tope.
  const levEfectivo = Math.min(apalancamiento, perfil.maxLev)
  useEffect(() => {
    if (apalancamiento > perfil.maxLev) setApalancamiento(perfil.maxLev)
  }, [apalancamiento, perfil.maxLev])

  const tpValidos = useMemo(() => multiplosTP.filter((m) => m > 0), [multiplosTP])
  const tpsl = useMemo(() => calcTPSL(fila, klines, atrMult, tpValidos), [fila, klines, atrMult, tpValidos])
  const comision = Math.max(0, comisionPct) / 100
  const lev = useMemo(
    () => (tpsl ? calcLeverage(tpsl, margen, levEfectivo, tipoMargen, { mmr: perfil.mmr, comision }) : null),
    [tpsl, margen, levEfectivo, tipoMargen, perfil.mmr, comision],
  )

  const f$ = (v) => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2)
  const fROE = (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
  const cruzado = tipoMargen === 'cross'

  return (
    <div className="p-4">
      <div className="mb-3">
        <div className="mb-1 text-sm text-terminal-text">
          {fmtPrice(fila.price)}
          {fila.precioSenal != null && fila.precioSenal !== fila.price && (
            <span
              className="ml-1.5 text-[11px] text-terminal-dim"
              title="El score se calculó con el último cierre; este es el precio de ahora."
            >
              (señal en {fmtPrice(fila.precioSenal)})
            </span>
          )}
        </div>
        <Insignia cls={fila.cls}>{fila.signal}</Insignia>{' '}
        <span className="text-xs text-terminal-dim">
          Score: {fila.score > 0 ? '+' : ''}
          {fila.score}
        </span>
      </div>

      <div className="mb-3">
        <VariacionPeriodos symbolRaw={symbolRaw} />
      </div>

      {fila.rsi_vivo != null && (
        <div className="mb-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
            Vela cerrada vs. en curso
          </div>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-terminal-bg text-[10px] uppercase text-terminal-dim">
                <td className="px-2 py-1">Indicador</td>
                <td className="px-2 py-1 text-right" title="Alimenta el score. No cambia hasta que cierre la vela.">
                  Cerrada
                </td>
                <td className="px-2 py-1 text-right" title="Lo que ves en el gráfico de Binance ahora mismo.">
                  Ahora
                </td>
              </tr>
            </thead>
            <tbody>
              {[
                ['RSI', fila.rsi, fila.rsi_vivo],
                ['StochRSI', fila.srsi, fila.srsi_vivo],
                ['BB %', fila.bb_pct, fila.bb_pct_vivo],
              ].map(([et, cerrada, ahora]) => (
                <tr key={et} className="border-t border-terminal-border">
                  <td className="px-2 py-1 text-terminal-dim">{et}</td>
                  <td className="px-2 py-1 text-right font-semibold text-terminal-text tabular">{cerrada ?? '—'}</td>
                  <td
                    className={`px-2 py-1 text-right font-semibold tabular ${
                      cerrada != null && ahora != null && Math.abs(ahora - cerrada) >= 10
                        ? 'text-terminal-warn'
                        : 'text-terminal-text'
                    }`}
                  >
                    {ahora ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {fila.pct_vela != null && (
            <p className="mt-1 text-[10px] leading-relaxed text-terminal-dim">
              La vela en curso lleva <b>{fila.pct_vela}%</b> transcurrida. El score sale de la columna{' '}
              <b>Cerrada</b> para no repintar; con la vela recién abierta ese dato es prácticamente del período
              anterior entero.
            </p>
          )}
        </div>
      )}
      <hr className="mb-3 border-terminal-border" />

      {!tpsl ? (
        <p className="text-sm text-terminal-dim">Señal NEUTRAL — sin niveles sugeridos.</p>
      ) : (
        <>
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
            Apalancamiento y margen
          </div>
          <div className="mb-2 grid grid-cols-3 gap-2">
            <div>
              <label className="mb-1 block text-[11px] text-terminal-dim">Margen (USD)</label>
              <input
                type="number"
                min={1}
                value={margen}
                onChange={(e) => setMargen(Number(e.target.value) || 0)}
                className={inputCls}
              />
            </div>
            <div>
              <label
                className="mb-1 block text-[11px] text-terminal-dim"
                title={`Tope aproximado para ${perfil.grupo}: ${perfil.maxLev}×`}
              >
                Apalancamiento
              </label>
              <select value={levEfectivo} onChange={(e) => setApalancamiento(Number(e.target.value))} className={inputCls}>
                {opcionesLev.map((l) => (
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
                    !cruzado ? 'bg-terminal-accent text-black' : 'text-terminal-dim'
                  }`}
                >
                  🔒 Aislado
                </button>
                <button
                  type="button"
                  onClick={() => setTipoMargen('cross')}
                  className={`flex-1 py-1.5 text-[11px] font-semibold ${
                    cruzado ? 'bg-terminal-accent text-black' : 'text-terminal-dim'
                  }`}
                >
                  🔄 Cruzado
                </button>
              </div>
            </div>
          </div>
          <div className="mb-3 grid grid-cols-4 gap-2">
            <div title="Comisión taker de Binance USDT-M por lado (0,05% sin descuentos). Se cobra al entrar y al salir.">
              <label className="mb-1 block text-[11px] text-terminal-dim">Comisión %/lado</label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={comisionPct}
                onChange={(e) => setComisionPct(Number(e.target.value) || 0)}
                className={inputCls}
              />
            </div>
            {[0, 1, 2].map((i) => (
              <div key={i} title="Take profit como múltiplo del riesgo: 2 = a dos veces la distancia del SL (1:2). 0 = sin este TP.">
                <label className="mb-1 block text-[11px] text-terminal-dim">TP{i + 1} (1:x)</label>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={multiplosTP[i] ?? 0}
                  onChange={(e) => {
                    const n = [...multiplosTP]
                    n[i] = Math.max(0, Number(e.target.value) || 0)
                    setMultiplosTP(n)
                  }}
                  className={inputCls}
                />
              </div>
            ))}
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
                <div className="text-xs" title="Tasa de margen de mantenimiento del primer tramo, aproximada (ver abajo).">
                  <span className="mb-0.5 block text-[10px] uppercase text-terminal-dim">Mant. margen (aprox.)</span>
                  <span className="font-bold text-terminal-text">{pct(lev.mmr)}</span>
                </div>
              </div>

              {lev.inviable && (
                <div className="mb-2 rounded border border-terminal-down/40 bg-terminal-down/15 p-2.5 text-xs leading-relaxed text-terminal-down">
                  ⛔ <b>Apalancamiento irreal:</b> con {levEfectivo}× el margen inicial (1/L = {pct(lev.imr)}) no cubre
                  ni el de mantenimiento ({pct(lev.mmr)}). La posición se liquidaría apenas abre.
                </div>
              )}

              <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
                Resultados con apalancamiento (netos de comisión)
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
                        ⚠️ La liquidación llega antes que el SL — el SL no se va a activar
                      </td>
                    </tr>
                  )}
                  <tr className="border-t border-terminal-border" style={{ backgroundColor: 'rgba(124,58,237,.12)' }}>
                    <td className="px-2 py-1.5 font-semibold" style={{ color: '#c084fc' }}>
                      ⚡ Liquidación
                      {cruzado && <span className="block text-[9px] font-normal">equivalente aislado</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right font-bold" style={{ color: '#c084fc' }}>
                      {fmtPrice(lev.liqPrice)}
                      <span className="block text-[10px] font-normal">
                        {lev.liqPct > 0 ? '+' : ''}
                        {lev.liqPct}%
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-bold text-terminal-down">{f$(lev.perdidaLiquidacion)}</td>
                    <td className="px-2 py-1.5 text-right text-terminal-down">{fROE((lev.perdidaLiquidacion / margen) * 100)}</td>
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
                    <td className="px-2 py-1.5 text-right text-terminal-dim" title="Comisión de entrada">
                      {f$(-lev.comisionEntrada)}
                    </td>
                    <td className="px-2 py-1.5 text-right text-terminal-dim">{fROE((-lev.comisionEntrada / margen) * 100)}</td>
                  </tr>
                  {lev.tps.map((t, i) => (
                    <tr key={i} className="border-t border-terminal-border" style={{ backgroundColor: `rgba(34,197,94,${0.04 + i * 0.03})` }}>
                      <td className="px-2 py-1.5 font-semibold text-terminal-up">
                        ✅ TP{i + 1} · 1:{String(t.mult).replace('.', ',')}
                      </td>
                      <td className="px-2 py-1.5 text-right font-bold text-terminal-up">{fmtPrice(t.precio)}</td>
                      <td className="px-2 py-1.5 text-right font-bold text-terminal-up" title={`Comisiones: $${t.comision.toFixed(2)}`}>
                        {f$(t.pnl)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-terminal-up">{fROE(t.roe)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {!cruzado ? (
                <div className="rounded border border-terminal-info/30 bg-terminal-info/10 p-2.5 text-xs leading-relaxed text-terminal-info">
                  🔒 <b>Margen aislado:</b>{' '}
                  {lev.slSafe ? (
                    <>
                      si salta el SL perdés <b>{f$(lev.slPnL)}</b> (precio {f$(lev.slBruto)} + comisiones $
                      {lev.comisionSl.toFixed(2)}). La pérdida máxima, si te liquidan, es el margen entero más la
                      comisión de entrada: <b>{f$(lev.perdidaLiquidacion)}</b>.
                    </>
                  ) : (
                    <>
                      la liquidación llega antes que el SL, así que la pérdida es el margen entero más la comisión de
                      entrada: <b>{f$(lev.perdidaLiquidacion)}</b>.
                    </>
                  )}{' '}
                  La posición se liquida sin afectar el resto de tu cuenta.
                </div>
              ) : (
                <div className="rounded border border-terminal-warn/30 bg-terminal-warn/10 p-2.5 text-xs leading-relaxed text-terminal-warn">
                  🔄 <b>Margen cruzado:</b> el precio de liquidación real <b>no se puede calcular sin el balance de tu
                  cuenta</b> (Binance usa todo el saldo libre para sostener la posición, y resta las pérdidas de tus
                  otras posiciones). El que se muestra es el <b>equivalente aislado</b>: sería tu liquidación si la
                  cuenta tuviera solo estos ${margen.toFixed(2)}. Con más saldo, la liquidación queda más lejos — y
                  podés perder más que el margen. G/P en el SL: {f$(lev.slPnL)} (sin tope).
                </div>
              )}
              {!lev.slSafe && !lev.inviable && (
                <div className="mt-2 rounded border border-terminal-down/30 bg-terminal-down/10 p-2.5 text-xs leading-relaxed text-terminal-down">
                  ⚠️ <b>Peligro:</b> con {levEfectivo}× la liquidación ({fmtPrice(lev.liqPrice)}) llega antes que el
                  Stop Loss ({fmtPrice(tpsl.sl)}). Reducí el apalancamiento o acercá el SL.
                </div>
              )}

              {/* La cuenta a la vista: formula + numeros de esta posicion. */}
              <details className="mt-3 rounded border border-terminal-border bg-terminal-bg p-2.5 text-[11px] leading-relaxed text-terminal-dim">
                <summary className="cursor-pointer font-semibold text-terminal-text">Cómo se calcula</summary>
                <div className="mt-1.5 space-y-1 font-mono text-[10.5px]">
                  <div>Posición = margen × L = ${margen} × {levEfectivo} = ${lev.posSize.toFixed(2)}</div>
                  <div>Cantidad = posición ÷ entrada = {lev.qty.toFixed(6)}</div>
                  <div>
                    {tpsl.isShort ? (
                      <>Liq short = E·(1 + 1/L)/(1 + MMR) = {fmtPrice(tpsl.entry)}·(1 + {pct(lev.imr)})/(1 + {pct(lev.mmr)})</>
                    ) : (
                      <>Liq long = E·(1 − 1/L)/(1 − MMR) = {fmtPrice(tpsl.entry)}·(1 − {pct(lev.imr)})/(1 − {pct(lev.mmr)})</>
                    )}{' '}
                    = {fmtPrice(lev.liqCruda)}
                  </div>
                  <div>SL = entrada {tpsl.isShort ? '+' : '−'} ATR(14) × {tpsl.atrMult} = {fmtPrice(tpsl.sl)}</div>
                  <div>TPn = entrada {tpsl.isShort ? '−' : '+'} (ATR × {tpsl.atrMult}) × n</div>
                  <div>
                    G/P = {tpsl.isShort ? '(entrada − salida)' : '(salida − entrada)'} × cantidad − comisiones
                  </div>
                  <div>Comisiones = (entrada + salida) × cantidad × {comisionPct}%</div>
                  <div>ROE = G/P ÷ margen</div>
                </div>
                <p className="mt-1.5">
                  <b>Criterio:</b> el SL es seguro si salta antes que la liquidación (long: SL &gt; liq; short: SL &lt;
                  liq). <b>Supuestos:</b> fórmula de margen aislado de Binance para el primer tramo del bracket
                  (posición chica, sin monto de mantenimiento). El tope de apalancamiento y el MMR son aproximados
                  para <b>{perfil.grupo}</b>: {perfil.maxLev}× y {pct(perfil.mmr)} (BTC 125×/0,40%, ETH 125×/0,50%,
                  cripto mayores 75×/1%, resto 50×/1%, TradFi 20×/1%). Los reales están en /leverageBracket, un
                  endpoint firmado que desde el navegador no se puede leer — el valor exacto lo muestra Binance al
                  armar la orden. No incluye funding ni la tasa de liquidación.
                </p>
              </details>
            </>
          )}

          <p className="mt-3 text-[11px] text-terminal-dim">
            ATR(14): {fmtPrice(tpsl.atr)} · SL swing ref: {fmtPrice(tpsl.slSwing)} ({tpsl.slSwingPct > 0 ? '+' : ''}
            {tpsl.slSwingPct}%)
          </p>
        </>
      )}

      <hr className="my-3 border-terminal-border" />
      {/* Las filas del Screener de Cruces traen 'est' (estado por indicador) en
          vez de los aportes del score del v1, así que llevan su propio panel. */}
      {fila.est ? <DetalleCruces fila={fila} /> : <ProsContras fila={fila} />}

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
