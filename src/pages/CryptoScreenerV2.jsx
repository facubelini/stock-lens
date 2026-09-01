import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getUniversoV2, getKlinesV2, sleep } from '../lib/crypto/v2/datos'
import { velasCerradas, calcularSeries } from '../lib/crypto/v2/indicadores'
import { armarFila } from '../lib/crypto/v2/senal'
import { backtestSimbolo, estadisticas } from '../lib/crypto/v2/backtest'
import {
  VELAS,
  PARES_TEMPORALIDAD,
  PISOS_LIQUIDEZ,
  FEE_TAKER_PCT,
  SL_ATR_DEFAULT,
  TP_R_DEFAULT,
  MULTIPLOS_ATR_V2,
  MULTIPLOS_TP_R,
  FRACCION_TRAIN,
  BT_MIN_TRADES,
} from '../lib/crypto/v2/config'
import { COLOR_SENAL } from '../lib/crypto/constantes'
import Insignia from '../components/crypto/Insignia'
import BarraRSI from '../components/crypto/BarraRSI'
import PanelApalancamiento from '../components/crypto/PanelApalancamiento'

const TAMANO_LOTE = 8 // cada simbolo son 2 llamadas de klines

const selectCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

const VEREDICTOS = ['COMPRA', 'VENTA', 'CERCA', 'EXTENDIDO', 'NEUTRAL', 'SIN DATOS']

function fmtCompacto(n) {
  if (n == null) return '—'
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(0) + 'M'
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K'
  return '$' + n.toFixed(0)
}

function fmtPrecio(p) {
  if (p == null) return '—'
  if (p >= 1000) return '$' + p.toLocaleString('es-AR', { maximumFractionDigits: 2 })
  if (p >= 1) return '$' + p.toFixed(3)
  if (p >= 0.001) return '$' + p.toFixed(5)
  return '$' + p.toFixed(8)
}

const colorTendencia = { ALCISTA: '#4ade80', BAJISTA: '#f87171', RANGO: '#9ca3af', 'N/D': '#6b7280' }

// ── Panel de resultados del backtest ───────────────────────────────────────
function Celda({ st, resaltar }) {
  if (!st || st.trades === 0) return <td className="px-2 py-1.5 text-terminal-dim">sin trades</td>
  const pocos = st.trades < BT_MIN_TRADES
  const color = st.expectativa > 0 ? '#4ade80' : st.expectativa < 0 ? '#f87171' : undefined
  return (
    <td className={`whitespace-nowrap px-2 py-1.5 tabular ${resaltar ? 'bg-terminal-accent/10' : ''}`}>
      <span className="font-bold" style={{ color }} title="R por trade (expectativa)">
        {st.expectativa > 0 ? '+' : ''}
        {st.expectativa}
      </span>
      <span className="ml-1 text-[11px] text-terminal-dim">
        R · {st.tasaAcierto}% · n={st.trades}
        {pocos ? ' ⚠' : ''}
      </span>
    </td>
  )
}

function PanelBacktest({ resultado, onCerrar }) {
  const { reglas, simbolos, config } = resultado
  const orden = [
    { k: 'v2', t: 'v2 · confluencia + tendencia superior', destacar: true },
    { k: 'piso', t: 'piso · sólo tendencia, sin filtros' },
    { k: 'v1', t: 'v1 · score aditivo' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4" onClick={onCerrar}>
      <div
        className="w-full max-w-3xl rounded-lg border border-terminal-border bg-terminal-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-terminal-text">Backtest con validación fuera de muestra</h2>
            <p className="mt-0.5 text-xs text-terminal-dim">
              {simbolos} símbolos · entrada {config.entrada} · tendencia {config.tendencia} · SL {config.atrMult}×ATR ·
              TP {config.rMultiploTP}R · fee {config.feePct}% por lado · corte train/test en{' '}
              {Math.round(FRACCION_TRAIN * 100)}%
            </p>
          </div>
          <button
            type="button"
            onClick={onCerrar}
            className="rounded border border-terminal-border px-2 py-1 text-xs text-terminal-dim hover:text-terminal-text"
          >
            ✕
          </button>
        </div>

        <div className="overflow-x-auto rounded border border-terminal-border">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                <th className="px-2 py-2">Regla</th>
                <th className="px-2 py-2" title="Parte vieja de la ventana: es donde se eligen los parámetros.">
                  Train
                </th>
                <th className="px-2 py-2" title="Parte reciente que la elección de parámetros no vio. Es el único número que vale.">
                  Test (fuera de muestra)
                </th>
              </tr>
            </thead>
            <tbody>
              {orden.map((o) => (
                <tr key={o.k} className="border-t border-terminal-border">
                  <td className={`px-2 py-1.5 text-xs ${o.destacar ? 'font-semibold text-terminal-text' : 'text-terminal-dim'}`}>
                    {o.t}
                  </td>
                  <Celda st={reglas[o.k]?.train} />
                  <Celda st={reglas[o.k]?.test} resaltar={o.destacar} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 rounded border border-terminal-warn/40 bg-terminal-warn/10 p-3 text-[11px] leading-relaxed text-terminal-text">
          <b>Leé la columna de test, no la de train.</b> Cada celda es la expectativa en R por trade, la tasa de acierto
          y la cantidad de trades. Elegir parámetros mirando train y después mirar test es la única forma de saber si
          algo funciona: en la calibración de esta pestaña, <b>todo lo que mejoraba en train se caía en test</b>. Si el
          v2 no le gana al <b>piso</b> (operar la tendencia sin ningún filtro), entonces los filtros de RSI, MACD y
          StochRSI no están aportando información.
        </div>

        <div className="mt-2 rounded border border-terminal-border bg-terminal-bg/50 p-3 text-[11px] leading-relaxed text-terminal-dim">
          <b className="text-terminal-text">Contra el lookahead:</b> series causales, vela en curso descartada, entrada
          a la apertura de la vela siguiente a la señal, tendencia superior sólo con velas ya cerradas, y si en una vela
          se tocan SL y TP se asume SL.
          <br />
          <b className="text-terminal-text">Límites:</b> el funding histórico no viene en las klines, así que se usa el
          actual como constante; no se modela slippage ni comisiones maker; y con {VELAS} velas la ventana total es
          corta, así que un resultado positivo acá tampoco alcanza para concluir que hay edge. ⚠ marca menos de{' '}
          {BT_MIN_TRADES} trades, donde el número no es interpretable.
        </div>
      </div>
    </div>
  )
}

// ── Pagina ────────────────────────────────────────────────────────────────
export default function CryptoScreenerV2() {
  const [par, setPar] = useState('1h')
  const [pisoLiquidez, setPisoLiquidez] = useState(5_000_000)
  const [multiploATR, setMultiploATR] = useState(SL_ATR_DEFAULT)
  const [rMultiploTP, setRMultiploTP] = useState(TP_R_DEFAULT)
  const [feePct, setFeePct] = useState(FEE_TAKER_PCT)

  const [datos, setDatos] = useState([])
  const [universo, setUniverso] = useState(null)
  const [corriendo, setCorriendo] = useState(false)
  const [progreso, setProgreso] = useState({ hecho: 0, total: 0 })
  const [ultima, setUltima] = useState(null)
  const [error, setError] = useState(null)
  const [omitidos, setOmitidos] = useState(0)

  const [filtro, setFiltro] = useState('OPERABLES')
  const [tendenciaFiltro, setTendenciaFiltro] = useState('all')
  const [busqueda, setBusqueda] = useState('')
  const [sortKey, setSortKey] = useState('conviccion')
  const [sortAsc, setSortAsc] = useState(false)
  const [seleccionado, setSeleccionado] = useState(null)

  const [btCorriendo, setBtCorriendo] = useState(false)
  const [btResultado, setBtResultado] = useState(null)

  // { symbol: {entrada: klines, tendencia: klines, meta} } — lo reusa el backtest
  const cache = useRef(new Map())
  const corriendoRef = useRef(false)

  const parElegido = PARES_TEMPORALIDAD.find((p) => p.entrada === par) ?? PARES_TEMPORALIDAD[1]

  const escanear = async () => {
    if (corriendoRef.current) return
    corriendoRef.current = true
    setCorriendo(true)
    setError(null)
    setBtResultado(null)
    try {
      const uni = await getUniversoV2({ minTurnover: pisoLiquidez })
      setUniverso(uni)
      const lista = uni.simbolos
      setProgreso({ hecho: 0, total: lista.length })
      cache.current = new Map()
      const filas = []

      for (let i = 0; i < lista.length; i += TAMANO_LOTE) {
        const lote = lista.slice(i, Math.min(i + TAMANO_LOTE, lista.length))
        const parciales = await Promise.all(
          lote.map(async (meta) => {
            const [kE, kT] = await Promise.all([
              getKlinesV2(meta.symbol, parElegido.entrada, VELAS),
              getKlinesV2(meta.symbol, parElegido.tendencia, VELAS),
            ])
            const cE = velasCerradas(kE)
            const cT = velasCerradas(kT)
            // Solo la temporalidad de ENTRADA es obligatoria (sus indicadores
            // no se pueden calcular sin ~220 velas). Si la superior no llega a
            // EMA200 el simbolo igual aparece, con tendencia 'N/D' y veredicto
            // SIN DATOS — mejor que desaparecer en silencio. Pasa sobre todo
            // con el par diario/semanal: 200 velas semanales son ~4 anios.
            if (cE.length < 220 || cT.length < 2) return null
            const sE = calcularSeries(cE)
            const sT = calcularSeries(cT)
            cache.current.set(meta.symbol, { sE, sT, meta })
            return armarFila({
              symbol: meta.symbol,
              seriesEntrada: sE,
              seriesTendencia: sT,
              meta,
              intervaloEntrada: parElegido.entrada,
              atrMult: multiploATR,
              feePct,
            })
          }),
        )
        filas.push(...parciales.filter(Boolean))
        setProgreso({ hecho: Math.min(i + TAMANO_LOTE, lista.length), total: lista.length })
        if (i + TAMANO_LOTE < lista.length) await sleep(150)
      }

      filas.sort((a, b) => b.conviccion - a.conviccion)
      setDatos(filas)
      setOmitidos(lista.length - filas.length)
      setUltima(new Date().toLocaleTimeString('es-AR'))
    } catch (e) {
      setError(e.message)
    } finally {
      corriendoRef.current = false
      setCorriendo(false)
    }
  }

  const correrBacktest = async () => {
    if (btCorriendo || !cache.current.size) return
    setBtCorriendo(true)
    // Cede el hilo para que se pinte el estado "calculando" antes del bloqueo.
    await new Promise((r) => setTimeout(r, 30))
    try {
      // Se acumulan los trades de las 3 reglas x (train, test) sobre todos
      // los simbolos, y recien al final se calculan las estadisticas.
      const acum = { v2: { train: [], test: [] }, v1: { train: [], test: [] }, piso: { train: [], test: [] } }
      for (const { sE, sT, meta } of cache.current.values()) {
        const r = backtestSimbolo({
          sE,
          sT,
          intervaloEntrada: parElegido.entrada,
          atrMult: multiploATR,
          feePct,
          fundingPct: meta.fundingPct ?? 0,
          rMultiploTP,
        })
        for (const k of Object.keys(acum)) {
          acum[k].train.push(...r[k].train)
          acum[k].test.push(...r[k].test)
        }
      }
      const reglas = {}
      for (const k of Object.keys(acum)) {
        reglas[k] = { train: estadisticas(acum[k].train), test: estadisticas(acum[k].test) }
      }
      setBtResultado({
        reglas,
        simbolos: cache.current.size,
        config: {
          entrada: parElegido.entrada,
          tendencia: parElegido.tendencia,
          atrMult: multiploATR,
          rMultiploTP,
          feePct,
        },
      })
    } catch (e) {
      setError('Backtest: ' + e.message)
    } finally {
      setBtCorriendo(false)
    }
  }

  const conteos = useMemo(() => {
    const c = { total: datos.length, OPERABLES: 0 }
    for (const v of VEREDICTOS) c[v] = 0
    for (const r of datos) {
      c[r.veredicto] = (c[r.veredicto] ?? 0) + 1
      if (r.veredicto === 'COMPRA' || r.veredicto === 'VENTA') c.OPERABLES++
    }
    return c
  }, [datos])

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    const r = datos.filter((row) => {
      if (q && !row.symbol.toLowerCase().includes(q)) return false
      if (tendenciaFiltro !== 'all' && row.tendencia !== tendenciaFiltro) return false
      if (filtro === 'all') return true
      if (filtro === 'OPERABLES') return row.veredicto === 'COMPRA' || row.veredicto === 'VENTA'
      return row.veredicto === filtro
    })
    return r.sort((a, b) => {
      const va = a[sortKey] ?? -Infinity
      const vb = b[sortKey] ?? -Infinity
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va)
      return sortAsc ? va - vb : vb - va
    })
  }, [datos, filtro, tendenciaFiltro, busqueda, sortKey, sortAsc])

  const ordenar = (clave) => {
    if (sortKey === clave) setSortAsc((a) => !a)
    else {
      setSortKey(clave)
      setSortAsc(false)
    }
  }

  const filaSel = seleccionado ? datos.find((r) => r.symbolRaw === seleccionado) : null
  const klinesSel = filaSel ? cache.current.get(filaSel.symbolRaw) : null

  const columnas = [
    { key: 'symbol', label: 'Símbolo' },
    { key: 'turnover', label: 'Vol 24h', titulo: 'Volumen negociado en 24h. El v2 filtra por acá: la v1 rankeaba los 525 símbolos sin piso y las lecturas más extremas venían de los más finos.' },
    { key: 'price', label: 'Precio' },
    { key: 'chg24h', label: '24h %', titulo: 'Variación real de 24h (ticker/24hr). La v1 mostraba "24h %" pero calculaba 24 velas hacia atrás.' },
    { key: 'tendencia', label: `Tend. ${parElegido.tendencia}`, titulo: 'Tendencia de la temporalidad superior. Es la que decide la dirección: sólo LONG en alcista y SHORT en bajista.' },
    { key: 'veredicto', label: 'Veredicto' },
    { key: 'conviccion', label: 'Conv.', titulo: 'Sólo para ordenar la tabla. La señal es el veredicto, no este número.' },
    { key: 'cumplidas', label: 'Cond.', titulo: 'Condiciones de confluencia cumplidas: precio vs EMA50, MACD, StochRSI y RSI. Tienen que dar todas.' },
    { key: 'distClave', label: 'vs EMA50' },
    { key: 'distAsl', label: 'vs ASL', titulo: 'Distancia a la Adaptive Support Line (promedio de EMA21 y WMA21), igual que en el Screener de acciones.' },
    { key: 'rsi', label: 'RSI' },
    { key: 'srsi', label: 'StochRSI' },
    { key: 'fundingPct', label: 'Funding', titulo: 'Funding del período de 8h. Si está en contra del trade degrada el veredicto: longs apiñados pagando funding alto son combustible de squeeze.' },
    { key: 'costoTotalPct', label: 'Costo', titulo: 'Comisiones ida y vuelta + funding estimado. Es lo que el trade tiene que superar antes de empezar a ganar.' },
    { key: 'slNetoPct', label: 'SL neto' },
    { key: 'tpNetoPct', label: 'TP neto' },
    { key: 'rrNeto', label: 'R:R neto', titulo: 'Relación riesgo/beneficio ya descontados fees y funding. La v1 mostraba 1:1 y 1:2 nominales, sin descontar nada.' },
  ]

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Screener Cripto v2</h1>
        <p className="text-xs leading-relaxed text-terminal-dim">
          Rehace el Crypto Screener con las correcciones que le faltaban, sin tocar el original.{' '}
          <b>Una sola estrategia</b> (pullback dentro de tendencia) resuelta por <b>confluencia</b> en vez de por suma
          de puntos: la dirección la manda la tendencia de la temporalidad superior y las cuatro condiciones de
          momentum tienen que dar todas a la vez. Trabaja sólo con <b>velas cerradas</b>, con <b>EMA200 real</b> (
          {VELAS} velas), <b>filtro de liquidez</b>, <b>funding</b> dentro de la decisión y <b>R:R neto</b> de
          comisiones.
          <br />
          <b className="text-terminal-warn">Honestidad sobre la rentabilidad:</b> los parámetros por defecto (SL{' '}
          {SL_ATR_DEFAULT}×ATR, TP {TP_R_DEFAULT}R) salen de una calibración sobre 1 año de velas de 1h en 57
          perpetuos, eligiendo en train y validando en test. Fueron la mejor combinación de las probadas, pero{' '}
          <b>quedaron en breakeven fuera de muestra, no en ganancia</b>. Ninguna variante mostró expectativa positiva
          en test. Usá el botón de backtest para verlo vos mismo antes de operar nada. Orientativo, no es
          recomendación de inversión.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="text-xs text-terminal-dim">Temporalidad</label>
        <select value={par} onChange={(e) => setPar(e.target.value)} className={selectCls}>
          {PARES_TEMPORALIDAD.map((p) => (
            <option key={p.entrada} value={p.entrada}>
              {p.etiqueta}
            </option>
          ))}
        </select>
        <label className="text-xs text-terminal-dim">Liquidez</label>
        <select
          value={pisoLiquidez}
          onChange={(e) => setPisoLiquidez(Number(e.target.value))}
          className={selectCls}
        >
          {PISOS_LIQUIDEZ.map((p) => (
            <option key={p.valor} value={p.valor}>
              {p.etiqueta}
            </option>
          ))}
        </select>
        <label className="text-xs text-terminal-dim">SL (ATR ×)</label>
        <select value={multiploATR} onChange={(e) => setMultiploATR(Number(e.target.value))} className={selectCls}>
          {MULTIPLOS_ATR_V2.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <label className="text-xs text-terminal-dim">TP</label>
        <select value={rMultiploTP} onChange={(e) => setRMultiploTP(Number(e.target.value))} className={selectCls}>
          {MULTIPLOS_TP_R.map((m) => (
            <option key={m} value={m}>
              {m}R
            </option>
          ))}
        </select>
        <label className="text-xs text-terminal-dim" title="Comisión taker por lado">
          Fee %
        </label>
        <input
          type="number"
          step="0.01"
          min="0"
          value={feePct}
          onChange={(e) => setFeePct(Number(e.target.value))}
          className={`${selectCls} w-20`}
        />
        <button
          type="button"
          onClick={escanear}
          disabled={corriendo}
          className="rounded bg-terminal-accent px-3 py-1.5 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50"
        >
          {corriendo ? '⏳ Escaneando…' : datos.length ? '▶ Re-escanear' : '▶ Escanear'}
        </button>
        {datos.length > 0 && (
          <button
            type="button"
            onClick={correrBacktest}
            disabled={btCorriendo}
            className="rounded border border-terminal-accent px-3 py-1.5 text-sm font-semibold text-terminal-accent hover:bg-terminal-accent/10 disabled:opacity-50"
            title="Corre el backtest sobre las velas que ya trajo el escaneo, sin pedir nada más"
          >
            {btCorriendo ? '⏳ Calculando…' : '🧪 Backtest v1 vs v2'}
          </button>
        )}
      </div>

      {corriendo && (
        <div className="mb-2">
          <div className="h-1 w-full overflow-hidden rounded bg-terminal-border">
            <div
              className="h-full bg-terminal-accent transition-all"
              style={{ width: `${progreso.total ? (progreso.hecho / progreso.total) * 100 : 0}%` }}
            />
          </div>
          <div className="mt-1 text-[11px] text-terminal-dim">
            {progreso.hecho}/{progreso.total} símbolos · 2 temporalidades por símbolo
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded border border-terminal-down/40 bg-terminal-down/10 px-3 py-2 text-xs text-terminal-down">
          Error: {error}
        </div>
      )}

      {universo && !corriendo && (
        <div className="mb-3 rounded border border-terminal-border bg-terminal-panel/50 px-3 py-2 text-[11px] text-terminal-dim">
          Universo: <b className="text-terminal-text">{datos.length}</b> analizados de {universo.totalDisponible}{' '}
          perpetuos · {universo.descartadosPorLiquidez} descartados por liquidez
          {omitidos > 0 && <> · {omitidos} sin historial suficiente (hacen falta ~220 velas cerradas)</>}
          {ultima && <> · actualizado {ultima}</>}
        </div>
      )}

      {!datos.length && !corriendo ? (
        <div className="rounded-lg border border-terminal-border bg-terminal-panel p-10 text-center text-sm text-terminal-dim">
          Presioná <b>Escanear</b>. Con el piso de liquidez en $5M son ~186 símbolos y dos temporalidades por símbolo,
          así que tarda más que la v1 — a cambio no analiza los ~340 símbolos más finos, donde la señal es sobre todo
          ruido.
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {[
              { k: 'OPERABLES', l: `OPERABLES: ${conteos.OPERABLES}`, cls: 'bg-terminal-accent/20 text-terminal-accent' },
              { k: 'all', l: `TODOS: ${conteos.total}`, cls: 'bg-terminal-panel2 text-terminal-text' },
              { k: 'COMPRA', l: `COMPRA: ${conteos.COMPRA}`, cls: 'bg-terminal-up/20 text-terminal-up' },
              { k: 'VENTA', l: `VENTA: ${conteos.VENTA}`, cls: 'bg-terminal-down/20 text-terminal-down' },
              { k: 'CERCA', l: `CERCA: ${conteos.CERCA}`, cls: 'bg-terminal-warn/20 text-terminal-warn' },
              { k: 'EXTENDIDO', l: `EXTENDIDO: ${conteos.EXTENDIDO}`, cls: 'bg-terminal-border text-terminal-dim' },
              { k: 'NEUTRAL', l: `NEUTRAL: ${conteos.NEUTRAL}`, cls: 'bg-terminal-border text-terminal-dim' },
              { k: 'SIN DATOS', l: `SIN DATOS: ${conteos['SIN DATOS']}`, cls: 'bg-terminal-border text-terminal-dim' },
            ].map((p) => (
              <button
                key={p.k}
                type="button"
                onClick={() => setFiltro(p.k)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${p.cls} ${
                  filtro === p.k ? 'ring-2 ring-terminal-accent' : ''
                }`}
              >
                {p.l}
              </button>
            ))}
            <select
              value={tendenciaFiltro}
              onChange={(e) => setTendenciaFiltro(e.target.value)}
              className={selectCls}
            >
              <option value="all">Toda tendencia</option>
              <option value="ALCISTA">Sólo alcistas</option>
              <option value="BAJISTA">Sólo bajistas</option>
              <option value="RANGO">Sólo rango</option>
              <option value="N/D">Sin EMA200</option>
            </select>
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar símbolo…"
              className="w-40 rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
            />
            <span className="ml-auto text-xs text-terminal-dim">
              {filtrados.length} resultado(s) · click en una fila para la calculadora
            </span>
          </div>

          <div className="overflow-x-auto rounded-lg border border-terminal-border">
            <table className="min-w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
                  {columnas.map((c) => (
                    <th
                      key={c.key}
                      onClick={() => ordenar(c.key)}
                      title={c.titulo}
                      className={`cursor-pointer whitespace-nowrap px-2 py-2.5 font-semibold hover:text-terminal-text ${
                        sortKey === c.key ? 'text-terminal-accent' : ''
                      }`}
                    >
                      {c.label}
                      {sortKey === c.key ? (sortAsc ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtrados.map((r) => {
                  const c = COLOR_SENAL[r.cls] ?? COLOR_SENAL.n
                  return (
                    <tr
                      key={r.symbolRaw}
                      onClick={() => setSeleccionado(r.symbolRaw)}
                      className="cursor-pointer border-t border-terminal-border transition-colors hover:brightness-125"
                      style={{ backgroundColor: c.bg, color: c.text }}
                    >
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold">
                        <Link
                          to={`/cripto/${encodeURIComponent(r.symbolRaw)}`}
                          onClick={(e) => e.stopPropagation()}
                          className="hover:underline"
                          style={{ color: 'inherit' }}
                          title="Ver la ficha del símbolo"
                        >
                          {r.symbol}
                        </Link>
                        <a
                          href={r.link}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="ml-1 opacity-60 hover:opacity-100"
                          style={{ color: 'inherit' }}
                          title="Abrir en Binance Futures"
                        >
                          ↗
                        </a>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular text-xs">{fmtCompacto(r.turnover)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">{fmtPrecio(r.price)}</td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 tabular"
                        style={{ color: r.chg24h >= 0 ? '#4ade80' : '#f87171' }}
                      >
                        {r.chg24h >= 0 ? '+' : ''}
                        {r.chg24h.toFixed(2)}%
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 text-xs font-semibold"
                        style={{ color: colorTendencia[r.tendencia] }}
                      >
                        {r.tendencia === 'ALCISTA' ? '↑ ' : r.tendencia === 'BAJISTA' ? '↓ ' : ''}
                        {r.tendencia}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <Insignia cls={r.cls}>
                          {r.veredicto}
                          {r.dir && (r.veredicto === 'CERCA' || r.veredicto === 'EXTENDIDO') ? ` ${r.dir}` : ''}
                        </Insignia>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-bold tabular">{r.conviccion}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular text-xs">
                        {r.cumplidas}/{r.totalCond}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.distClave > 0 ? '+' : ''}
                        {r.distClave}%
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.distAsl > 0 ? '+' : ''}
                        {r.distAsl}%
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.rsi}
                        <BarraRSI valor={r.rsi} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.srsi}
                        <BarraRSI valor={r.srsi} />
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 tabular text-xs"
                        style={{ color: r.fundingEnContra ? '#fbbf24' : undefined }}
                        title={r.fundingEnContra ? 'Funding en contra del trade: degradó el veredicto' : undefined}
                      >
                        {r.fundingPct == null ? '—' : `${r.fundingPct > 0 ? '+' : ''}${r.fundingPct.toFixed(4)}%`}
                        {r.fundingEnContra ? ' ⚠' : ''}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular text-xs">{r.costoTotalPct}%</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold tabular" style={{ color: '#f87171' }}>
                        {r.slNetoPct == null ? '—' : `${r.slNetoPct}%`}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold tabular" style={{ color: '#4ade80' }}>
                        {r.tpNetoPct == null ? '—' : `${r.tpNetoPct}%`}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-bold tabular">
                        {r.rrNeto == null ? '—' : `${r.rrNeto}:1`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {filaSel && klinesSel && (
        <PanelApalancamiento
          fila={filaSel}
          klines={reconstruirKlines(klinesSel.sE)}
          atrMult={multiploATR}
          to={`/cripto/${encodeURIComponent(filaSel.symbolRaw)}`}
          onCerrar={() => setSeleccionado(null)}
        />
      )}

      {btResultado && <PanelBacktest resultado={btResultado} onCerrar={() => setBtResultado(null)} />}
    </div>
  )
}

// La calculadora de apalancamiento espera klines crudas de Binance; el v2
// guarda series ya calculadas, asi que se rearma el minimo que necesita
// (indices 2=alto, 3=bajo, 4=cierre).
function reconstruirKlines(sE) {
  const out = []
  for (let i = 0; i < sE.n; i++) {
    out.push([sE.tsApertura[i], sE.apertura[i], sE.altos[i], sE.bajos[i], sE.cierres[i], sE.volumenes[i], sE.tsCierre[i]])
  }
  return out
}
