import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getUniversoV2, getKlinesV2, sleep, ErrorRateLimit, segundosBloqueado } from '../lib/crypto/v2/datos'
import { analizarSimbolo, resumir, veredicto, COSTO_IDA_VUELTA } from '../lib/crypto/v3/evidencia'
import { TIPOS_CRUCE, CRUCE_POR_ID } from '../lib/crypto/v3/cruces'
import { fmtPrice } from '../lib/crypto/formato'
import PanelApalancamiento from '../components/crypto/PanelApalancamiento'

// Cuántas velas se piden. 500 es el máximo sin pagar más rate limit (medido:
// <=500 pesa 2, 501-1000 pesa 5, >1000 pesa 10).
const VELAS = 500
const TAMANO_LOTE = 12
const MIN_TURNOVER = 5e6

const TEMPORALIDADES = [
  { valor: '4h', etiqueta: '4 horas', maxVelas: 12, holdTexto: '2 días' },
  { valor: '1h', etiqueta: '1 hora', maxVelas: 48, holdTexto: '2 días' },
  { valor: '15m', etiqueta: '15 minutos', maxVelas: 96, holdTexto: '1 día' },
  { valor: '1d', etiqueta: 'Diario', maxVelas: 5, holdTexto: '5 días' },
]

const COLOR_VEREDICTO = {
  respaldada: { bg: 'rgba(34,197,94,0.18)', text: '#86efac', icono: '✓' },
  dudosa: { bg: 'rgba(234,179,8,0.15)', text: '#fde047', icono: '?' },
  'sin-respaldo': { bg: 'rgba(239,68,68,0.18)', text: '#fca5a5', icono: '✗' },
  'sin-datos': { bg: 'rgba(125,139,156,0.12)', text: '#9ca3af', icono: '—' },
}

const pct = (v, d = 2) => (v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%')

export default function CryptoScreenerV3() {
  const [temporalidad, setTemporalidad] = useState('4h')
  const [atrMult, setAtrMult] = useState(2)
  const [R, setR] = useState(2)
  const [datos, setDatos] = useState([])
  const [global, setGlobal] = useState(null)
  const [corriendo, setCorriendo] = useState(false)
  const [progreso, setProgreso] = useState({ hecho: 0, total: 0 })
  const [error, setError] = useState(null)
  const [ultima, setUltima] = useState(null)
  const [omitidos, setOmitidos] = useState(0)
  const [soloRespaldadas, setSoloRespaldadas] = useState(false)
  const [seleccionado, setSeleccionado] = useState(null)
  const [bloqueo, setBloqueo] = useState(0)
  const corriendoRef = useRef(false)
  const cache = useRef(new Map())

  const tf = TEMPORALIDADES.find((t) => t.valor === temporalidad) ?? TEMPORALIDADES[0]

  useEffect(() => {
    if (bloqueo <= 0) return
    const t = setInterval(() => setBloqueo(segundosBloqueado()), 1000)
    return () => clearInterval(t)
  }, [bloqueo])

  const escanear = async () => {
    if (corriendoRef.current) return
    const b = segundosBloqueado()
    if (b > 0) {
      setBloqueo(b)
      setError(new ErrorRateLimit(b).message)
      return
    }
    corriendoRef.current = true
    setCorriendo(true)
    setError(null)
    setDatos([])
    setGlobal(null)
    try {
      const cfg = { atrMult, R, maxVelas: tf.maxVelas, minScore: 2 }
      const { simbolos, descartadosPorLiquidez } = await getUniversoV2({ minTurnover: MIN_TURNOVER })
      setProgreso({ hecho: 0, total: simbolos.length })
      cache.current = new Map()
      const filas = []
      const todosLosTrades = []
      const todosLosCruces = []
      let sinDatos = 0
      for (let i = 0; i < simbolos.length; i += TAMANO_LOTE) {
        const lote = simbolos.slice(i, i + TAMANO_LOTE)
        const parciales = await Promise.all(
          lote.map(async (meta) => {
            const k = await getKlinesV2(meta.symbol, temporalidad, VELAS)
            if (!k) return null
            const an = analizarSimbolo(k, cfg)
            if (!an) return null
            cache.current.set(meta.symbol, k)
            return { meta, an }
          }),
        )
        for (const p of parciales) {
          if (!p) {
            sinDatos++
            continue
          }
          filas.push(p)
          todosLosTrades.push(...p.an.trades)
          todosLosCruces.push(...p.an.tradesCruces)
        }
        setProgreso({ hecho: Math.min(i + TAMANO_LOTE, simbolos.length), total: simbolos.length })
        if (i + TAMANO_LOTE < simbolos.length) await sleep(150)
      }

      // Evidencia agregada por tipo de señal, sobre TODOS los símbolos: es la
      // muestra grande. La de cada símbolo por separado casi nunca alcanza.
      const porBucket = new Map()
      for (const t of todosLosTrades) {
        if (!porBucket.has(t.bucket)) porBucket.set(t.bucket, [])
        porBucket.get(t.bucket).push(t)
      }
      const evidencia = new Map()
      for (const [b, trades] of porBucket) {
        const r = resumir(trades)
        evidencia.set(b, { resumen: r, veredicto: veredicto(r) })
      }

      // Lo mismo pero por tipo de CRUCE, que se mide aparte del score.
      const porCruce = new Map()
      for (const t of todosLosCruces) {
        if (!porCruce.has(t.bucket)) porCruce.set(t.bucket, [])
        porCruce.get(t.bucket).push(t)
      }
      const evCruces = new Map()
      for (const [id, trades] of porCruce) {
        const r = resumir(trades)
        evCruces.set(id, { resumen: r, veredicto: veredicto(r) })
      }

      const salida = filas
        .filter((f) => Math.abs(f.an.score) >= 2 || f.an.crucesAhora.length > 0)
        .map((f) => {
          const ev = evidencia.get(f.an.bucket) ?? null
          return {
            symbol: `${f.meta.base}/USDT`,
            symbolRaw: f.meta.symbol,
            base: f.meta.base,
            link: `https://www.binance.com/es/futures/${f.meta.symbol}`,
            price: f.an.precioVivo,
            precioSenal: f.an.precioSenal,
            chg24h: f.meta.chg24hReal ?? 0,
            fundingPct: f.meta.fundingPct,
            turnover: f.meta.turnover,
            score: f.an.score,
            bucket: f.an.bucket,
            cls: f.an.score <= -4 ? 'sf' : f.an.score <= -2 ? 'sh' : f.an.score >= 4 ? 'lf' : 'lo',
            signal: f.an.bucket,
            rsi: +f.an.rsi.toFixed(1),
            atrPct: f.an.atrPct,
            aportes: Object.entries(f.an.aportes)
              .filter(([k]) => k !== 'total')
              .map(([k, v]) => ({ bloque: k, texto: k, puntos: v })),
            sl_pct: f.an.atrPct == null ? null : -Math.sign(f.an.score) * f.an.atrPct * atrMult,
            tp2_pct: f.an.atrPct == null ? null : Math.sign(f.an.score) * f.an.atrPct * atrMult * R,
            ev,
            propia: f.an.propia,
            cruces: f.an.crucesAhora,
          }
        })
      salida.sort((a, b) => (b.ev?.resumen?.expectativa ?? -9) - (a.ev?.resumen?.expectativa ?? -9))

      setDatos(salida)
      setGlobal({
        evidencia,
        evCruces,
        descartadosPorLiquidez,
        analizados: filas.length,
        trades: todosLosTrades.length,
        tradesCruces: todosLosCruces.length,
      })
      setOmitidos(sinDatos)
      setUltima(new Date().toLocaleTimeString('es-AR'))
    } catch (e) {
      setError(e.message)
      if (e instanceof ErrorRateLimit) setBloqueo(segundosBloqueado())
    } finally {
      corriendoRef.current = false
      setCorriendo(false)
    }
  }

  const filtradas = useMemo(
    () => (soloRespaldadas ? datos.filter((d) => d.ev?.veredicto.nivel === 'respaldada') : datos),
    [datos, soloRespaldadas],
  )

  const filaSeleccionada = seleccionado ? datos.find((d) => d.symbolRaw === seleccionado) : null

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">🔬 Screener Cripto v3 · con evidencia</h1>
        <p className="text-xs leading-relaxed text-terminal-dim">
          Las mismas señales del v1, pero <b>cada una viene con su historial medido</b>: cuántas veces se dio esa
          misma señal, qué porcentaje terminó en ganancia con el SL/TP de abajo, y — lo más importante — si eso se
          sostuvo a lo largo del tiempo o solo funcionó en un tramo. Todo neto de costos ({(COSTO_IDA_VUELTA * 100).toFixed(2)}
          % ida y vuelta) y calculado con las velas que el escaneo ya bajó, sin pedidos extra.
        </p>
      </div>

      <div className="mb-3 rounded border border-terminal-warn/30 bg-terminal-warn/10 px-3 py-2 text-xs leading-relaxed text-terminal-warn">
        ⚠️ <b>Leé esto una vez.</b> Cuando calibré estas reglas contra 4 tramos temporales, <b>ninguna</b> dio
        positiva en los 4. Es muy probable que casi todas las filas de abajo aparezcan como <b>sin respaldo</b> o{' '}
        <b>dudosa</b>: eso no es un error de la herramienta, es el resultado. Esta pestaña existe para mostrarte
        cuándo NO hay evidencia, no para fabricar confianza.
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="text-xs text-terminal-dim">Temporalidad</label>
        <select
          value={temporalidad}
          onChange={(e) => setTemporalidad(e.target.value)}
          className="rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
        >
          {TEMPORALIDADES.map((t) => (
            <option key={t.valor} value={t.valor}>
              {t.etiqueta}
            </option>
          ))}
        </select>
        <label className="text-xs text-terminal-dim" title="Distancia del stop, en múltiplos de ATR">
          SL (ATR ×)
        </label>
        <select
          value={atrMult}
          onChange={(e) => setAtrMult(Number(e.target.value))}
          className="rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
        >
          {[1, 1.5, 2, 3].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <label className="text-xs text-terminal-dim" title="El objetivo está a R veces la distancia del stop">
          TP (R)
        </label>
        <select
          value={R}
          onChange={(e) => setR(Number(e.target.value))}
          className="rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
        >
          {[1, 1.5, 2, 3].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={escanear}
          disabled={corriendo || bloqueo > 0}
          className="rounded bg-terminal-accent px-3 py-1.5 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50"
        >
          {bloqueo > 0
            ? `⛔ bloqueado ${Math.floor(bloqueo / 60)}:${String(bloqueo % 60).padStart(2, '0')}`
            : corriendo
              ? `⏳ ${progreso.hecho}/${progreso.total}`
              : datos.length
                ? '▶ Re-escanear'
                : '▶ Escanear'}
        </button>
        {ultima && <span className="text-xs text-terminal-dim">Actualizado: {ultima}</span>}
        <span className="text-[11px] text-terminal-dim">
          · salida a los {tf.maxVelas} velas ({tf.holdTexto}) si no toca SL ni TP
        </span>
      </div>

      {corriendo && (
        <div className="mb-4 h-1 w-full overflow-hidden rounded bg-terminal-border">
          <div
            className="h-full bg-terminal-accent transition-all"
            style={{ width: `${progreso.total ? (progreso.hecho / progreso.total) * 100 : 0}%` }}
          />
        </div>
      )}

      {error && (
        <div className="mb-4 rounded border border-terminal-down/40 bg-terminal-down/10 px-3 py-2 text-xs text-terminal-down">
          Error: {error}
        </div>
      )}

      {global && (
        <div className="mb-4 rounded-lg border border-terminal-border bg-terminal-panel p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
            Evidencia por tipo de señal · {global.trades.toLocaleString('es-AR')} trades históricos sobre{' '}
            {global.analizados} símbolos
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-terminal-bg text-[10px] uppercase text-terminal-dim">
                  <td className="px-2 py-1.5">Señal</td>
                  <td className="px-2 py-1.5 text-right">n</td>
                  <td className="px-2 py-1.5 text-right" title="Porcentaje de trades que cerraron en ganancia, neto de costos">
                    Aciertos
                  </td>
                  <td className="px-2 py-1.5 text-right" title="Retorno medio por trade, neto de costos">
                    Expectativa
                  </td>
                  <td className="px-2 py-1.5 text-right" title="Porcentaje que llegó al objetivo (el resto salió por stop o por tiempo)">
                    Llega al TP
                  </td>
                  <td className="px-2 py-1.5 text-right" title="En cuántos de los 4 tramos temporales la expectativa fue positiva">
                    Tramos +
                  </td>
                  <td className="px-2 py-1.5">Veredicto</td>
                </tr>
              </thead>
              <tbody>
                {['SHORT FUERTE', 'SHORT', 'LONG', 'LONG FUERTE'].map((b) => {
                  const e = global.evidencia.get(b)
                  if (!e?.resumen) return null
                  const r = e.resumen
                  const c = COLOR_VEREDICTO[e.veredicto.nivel]
                  return (
                    <tr key={b} className="border-t border-terminal-border">
                      <td className="px-2 py-1.5 font-semibold text-terminal-text">{b}</td>
                      <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{r.n}</td>
                      <td className="px-2 py-1.5 text-right tabular">{r.aciertos.toFixed(0)}%</td>
                      <td
                        className="px-2 py-1.5 text-right font-bold tabular"
                        style={{ color: r.expectativa > 0 ? '#4ade80' : '#f87171' }}
                      >
                        {pct(r.expectativa, 3)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{r.porObjetivo.toFixed(0)}%</td>
                      <td className="px-2 py-1.5 text-right tabular">
                        {r.tramosPositivos}/{r.tramosConDatos}
                      </td>
                      <td className="px-2 py-1.5">
                        <span
                          className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
                          style={{ backgroundColor: c.bg, color: c.text }}
                        >
                          {c.icono} {e.veredicto.texto}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-terminal-dim">
            <b>Tramos +</b> es la columna que importa. Una señal positiva en 4 de 4 tramos tiene alguna chance de ser
            una ventaja real; una positiva en 1 de 4 funcionó en un régimen y nada más. Descartados por liquidez
            (turnover 24h &lt; ${(MIN_TURNOVER / 1e6).toFixed(0)}M): {global.descartadosPorLiquidez}.
            {omitidos > 0 && ` Sin historial suficiente: ${omitidos}.`}
          </p>
        </div>
      )}

      {global?.evCruces && (
        <div className="mb-4 rounded-lg border border-terminal-border bg-terminal-panel p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
            Evidencia por tipo de CRUCE · {global.tradesCruces.toLocaleString('es-AR')} trades históricos
          </div>
          <p className="mb-2 text-[10px] leading-relaxed text-terminal-dim">
            Un cruce es un <b>evento</b> (la línea acaba de pasar a la otra), no un estado. Cada fila simula entrar
            en el cruce, con el mismo SL/TP de arriba, y salir a las {tf.maxVelas} velas si no toca ninguno. La
            dirección de cada cruce es la convencional; que funcione o no lo dice la columna de la derecha.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-terminal-bg text-[10px] uppercase text-terminal-dim">
                  <td className="px-2 py-1.5">Cruce</td>
                  <td className="px-2 py-1.5">Opera</td>
                  <td className="px-2 py-1.5 text-right">n</td>
                  <td className="px-2 py-1.5 text-right">Aciertos</td>
                  <td className="px-2 py-1.5 text-right">Expectativa</td>
                  <td className="px-2 py-1.5 text-right">Llega al TP</td>
                  <td className="px-2 py-1.5 text-right">Tramos +</td>
                  <td className="px-2 py-1.5">Veredicto</td>
                </tr>
              </thead>
              <tbody>
                {TIPOS_CRUCE.map((tipo) => {
                  const e = global.evCruces.get(tipo.id)
                  if (!e?.resumen) return null
                  const r = e.resumen
                  const c = COLOR_VEREDICTO[e.veredicto.nivel]
                  return (
                    <tr key={tipo.id} className="border-t border-terminal-border">
                      <td className="whitespace-nowrap px-2 py-1.5 text-terminal-text">{tipo.etiqueta}</td>
                      <td className="px-2 py-1.5">
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                          style={{
                            backgroundColor: tipo.dir > 0 ? 'rgba(34,197,94,0.19)' : 'rgba(239,68,68,0.19)',
                            color: tipo.dir > 0 ? '#bbf7d0' : '#fca5a5',
                          }}
                        >
                          {tipo.dir > 0 ? 'LONG' : 'SHORT'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{r.n}</td>
                      <td className="px-2 py-1.5 text-right tabular">{r.aciertos.toFixed(0)}%</td>
                      <td
                        className="px-2 py-1.5 text-right font-bold tabular"
                        style={{ color: r.expectativa > 0 ? '#4ade80' : '#f87171' }}
                      >
                        {pct(r.expectativa, 3)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{r.porObjetivo.toFixed(0)}%</td>
                      <td className="px-2 py-1.5 text-right tabular">
                        {r.tramosPositivos}/{r.tramosConDatos}
                      </td>
                      <td className="px-2 py-1.5">
                        <span
                          className="whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold"
                          style={{ backgroundColor: c.bg, color: c.text }}
                        >
                          {c.icono} {e.veredicto.texto}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {datos.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSoloRespaldadas((v) => !v)}
            className={`rounded px-2.5 py-1 text-xs font-semibold ${
              soloRespaldadas ? 'bg-terminal-up/20 text-terminal-up' : 'bg-terminal-panel2 text-terminal-dim'
            }`}
          >
            {soloRespaldadas ? '✓ Solo señales respaldadas' : 'Mostrar todas'}
          </button>
          <span className="text-xs text-terminal-dim">
            {filtradas.length} de {datos.length} señales · ordenadas por expectativa medida
          </span>
        </div>
      )}

      {!datos.length && !corriendo ? (
        <div className="rounded-lg border border-terminal-border bg-terminal-panel p-10 text-center text-sm text-terminal-dim">
          Presioná <b>Escanear</b>. Con el piso de liquidez en ${(MIN_TURNOVER / 1e6).toFixed(0)}M son ~170 símbolos.
          Además de la señal actual, se recorre la historia de cada uno para medir qué hizo esa misma señal antes.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-terminal-border">
          <table className="w-full border-collapse text-xs">
            <thead className="bg-terminal-panel2 text-left text-[11px] uppercase text-terminal-dim">
              <tr>
                <th className="px-2 py-2.5">Símbolo</th>
                <th className="px-2 py-2.5">Precio</th>
                <th className="px-2 py-2.5">24h</th>
                <th className="px-2 py-2.5">Señal</th>
                <th className="px-2 py-2.5">Score</th>
                <th className="px-2 py-2.5" title="Cruces que ocurrieron en la última vela cerrada. El color es el veredicto medido de ese cruce, no una recomendación.">
                  Cruces ahora
                </th>
                <th className="px-2 py-2.5" title="Funding actual. Medido: funding positivo antecede continuación, no reversión.">
                  Funding
                </th>
                <th className="px-2 py-2.5">SL %</th>
                <th className="px-2 py-2.5">TP %</th>
                <th className="px-2 py-2.5 bg-terminal-bg/40">Aciertos hist.</th>
                <th className="px-2 py-2.5 bg-terminal-bg/40">Expectativa</th>
                <th className="px-2 py-2.5 bg-terminal-bg/40">Tramos +</th>
                <th className="px-2 py-2.5 bg-terminal-bg/40">Veredicto</th>
              </tr>
            </thead>
            <tbody>
              {filtradas.map((r) => {
                const c = COLOR_VEREDICTO[r.ev?.veredicto.nivel ?? 'sin-datos']
                const res = r.ev?.resumen
                return (
                  <tr
                    key={r.symbolRaw}
                    onClick={() => setSeleccionado(r.symbolRaw)}
                    className="cursor-pointer border-t border-terminal-border hover:bg-terminal-panel2"
                  >
                    <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-terminal-text">
                      <Link
                        to={`/cripto/${encodeURIComponent(r.symbolRaw)}`}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:underline"
                      >
                        {r.symbol}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular text-terminal-text">{fmtPrice(r.price)}</td>
                    <td
                      className="whitespace-nowrap px-2 py-1.5 tabular"
                      style={{ color: r.chg24h >= 0 ? '#4ade80' : '#f87171' }}
                    >
                      {r.chg24h >= 0 ? '+' : ''}
                      {r.chg24h.toFixed(2)}%
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
                        style={{
                          backgroundColor: r.score < 0 ? 'rgba(239,68,68,0.19)' : 'rgba(34,197,94,0.19)',
                          color: r.score < 0 ? '#fca5a5' : '#bbf7d0',
                        }}
                      >
                        {r.signal}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-bold tabular text-terminal-text">
                      {r.score > 0 ? '+' : ''}
                      {r.score}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.cruces.length === 0 ? (
                        <span className="text-terminal-dim">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {r.cruces.map((id) => {
                            const tipo = CRUCE_POR_ID.get(id)
                            const e = global?.evCruces?.get(id)
                            const cc = COLOR_VEREDICTO[e?.veredicto.nivel ?? 'sin-datos']
                            return (
                              <span
                                key={id}
                                className="whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-semibold"
                                style={{ backgroundColor: cc.bg, color: cc.text }}
                                title={`${tipo.etiqueta} · ${e?.veredicto.texto ?? 'sin datos'}${
                                  e?.resumen ? ` · expectativa ${(e.resumen.expectativa * 100).toFixed(3)}% en ${e.resumen.n} trades` : ''
                                }`}
                              >
                                {cc.icono} {tipo.corto}
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular text-terminal-dim">
                      {r.fundingPct == null ? '—' : `${r.fundingPct > 0 ? '+' : ''}${r.fundingPct.toFixed(4)}%`}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular text-terminal-down">
                      {r.sl_pct == null ? '—' : `${r.sl_pct.toFixed(2)}%`}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 tabular text-terminal-up">
                      {r.tp2_pct == null ? '—' : `${r.tp2_pct > 0 ? '+' : ''}${r.tp2_pct.toFixed(2)}%`}
                    </td>
                    <td className="whitespace-nowrap bg-terminal-bg/40 px-2 py-1.5 tabular text-terminal-text">
                      {res ? `${res.aciertos.toFixed(0)}%` : '—'}
                      {res && <span className="ml-1.5 text-[10px] text-terminal-dim">(n={res.n})</span>}
                    </td>
                    <td
                      className="whitespace-nowrap bg-terminal-bg/40 px-2 py-1.5 font-bold tabular"
                      style={{ color: res ? (res.expectativa > 0 ? '#4ade80' : '#f87171') : '#9ca3af' }}
                    >
                      {res ? pct(res.expectativa, 3) : '—'}
                    </td>
                    <td className="whitespace-nowrap bg-terminal-bg/40 px-2 py-1.5 tabular text-terminal-text">
                      {res ? `${res.tramosPositivos}/${res.tramosConDatos}` : '—'}
                    </td>
                    <td className="whitespace-nowrap bg-terminal-bg/40 px-2 py-1.5">
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
                        style={{ backgroundColor: c.bg, color: c.text }}
                      >
                        {c.icono} {r.ev?.veredicto.texto ?? 'Sin datos'}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {filaSeleccionada && (
        <PanelApalancamiento
          fila={filaSeleccionada}
          klines={cache.current.get(filaSeleccionada.symbolRaw)}
          atrMult={atrMult}
          to={`/cripto/${encodeURIComponent(filaSeleccionada.symbolRaw)}`}
          onCerrar={() => setSeleccionado(null)}
        />
      )}
    </div>
  )
}
