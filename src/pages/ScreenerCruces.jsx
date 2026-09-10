import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getUniversoV2, getKlinesV2, sleep, ErrorRateLimit, segundosBloqueado } from '../lib/crypto/v2/datos'
import { armarSeries } from '../lib/crypto/v3/series'
import { INDICADORES, estadoDeTodos } from '../lib/crypto/v3/proximidad'
import { fmtPrice } from '../lib/crypto/formato'
import PanelApalancamiento from '../components/crypto/PanelApalancamiento'

// Screener de CRUCES. Reemplazó al "Screener Cripto v2".
//
// Diferencia de fondo con las otras dos pestañas: acá todo se calcula con la
// VELA EN CURSO incluida, o sea con el precio de ahora. Es lo que hace falta
// para ver un cruce que está por pasar — con la vela cerrada te enterás
// tarde. El precio de esa decisión es que un cruce en curso puede deshacerse
// antes de que la vela cierre, así que los estados están separados y
// etiquetados: CONFIRMADO no cambia más, EN CURSO todavía puede volverse
// atrás.

const VELAS = 500
const TAMANO_LOTE = 12
const MIN_TURNOVER = 5e6

const TEMPORALIDADES = [
  { valor: '15m', etiqueta: '15 minutos' },
  { valor: '1h', etiqueta: '1 hora' },
  { valor: '4h', etiqueta: '4 horas' },
  { valor: '1d', etiqueta: 'Diario' },
]

// Efecto medido del filtro de volumen sobre cada cruce, para no repetirlo de
// memoria: 93.549 cruces en 4h sobre 120 perpetuos, 250 días, neto de costos.
// Sólo dos merecen el filtro; en el resto empeora.
const VOLUMEN_AYUDA = {
  rsi: 'Medido: con volumen ≥1,5× este cruce pasa de +0,267% a +0,718% (n=1.274). Es el único caso donde el filtro ayuda claramente.',
  macd: 'Medido: con volumen ≥1,5× pasa de +0,409% a +0,493% (n=1.225). Mejora leve.',
  estoc: 'Medido: con volumen ≥1,5× EMPEORA (de +0,170% a −0,105%).',
  srsi: 'Medido: con volumen ≥1,5× EMPEORA (de +0,210% a +0,118%).',
  smi: 'Sin medir todavía: el SMI se agregó después del backtest de volumen.',
}

// Peso de cada estado al contar la dirección. Un cruce ya confirmado es un
// hecho; uno en curso puede deshacerse; uno cerca todavía no pasó. Los tres
// pesan distinto y los números están a la vista en el tooltip de cada fila
// para que se pueda rehacer la cuenta a mano.
const PESO_ESTADO = { confirmado: 2, 'en-curso': 1, cerca: 0.5 }

const COLOR_ESTADO = {
  confirmado: { bg: 'rgba(34,197,94,0.22)', text: '#bbf7d0', icono: '●' },
  'en-curso': { bg: 'rgba(234,179,8,0.20)', text: '#fde68a', icono: '◐' },
  cerca: { bg: 'rgba(96,165,250,0.18)', text: '#bfdbfe', icono: '○' },
  revertido: { bg: 'rgba(148,163,184,0.18)', text: '#cbd5e1', icono: '⟲' },
  lejos: { bg: 'transparent', text: '#6b7280', icono: '·' },
  'sin-datos': { bg: 'transparent', text: '#4b5563', icono: '—' },
}

const ETIQUETA_ESTADO = {
  confirmado: 'Cruzó (confirmado)',
  'en-curso': 'Cruzando ahora (sin confirmar)',
  cerca: 'Cerca de cruzar',
  revertido: 'Cruzó pero ya volvió (no suma)',
  lejos: 'Lejos',
  'sin-datos': 'Sin datos',
}

// Recuento de dirección de un símbolo: suma los cinco indicadores con el peso
// de su estado. NO es una predicción ni un veredicto de calidad — es un
// resumen de lo que dicen los indicadores, que es distinto. En el v3 está
// medido qué rinde históricamente cada cruce, y ahí ninguno califica como
// respaldado.
function direccionDe(est) {
  let puntos = 0
  let alcistas = 0
  let bajistas = 0
  const detalle = []
  for (const ind of INDICADORES) {
    const e = est[ind.id]
    if (!e || !e.dir || !PESO_ESTADO[e.estado]) continue
    const p = PESO_ESTADO[e.estado] * e.dir
    puntos += p
    if (e.dir > 0) alcistas++
    else bajistas++
    detalle.push(`${ind.nombre} ${e.dir > 0 ? '↑' : '↓'} ${ETIQUETA_ESTADO[e.estado].toLowerCase()} (${p > 0 ? '+' : ''}${p})`)
  }
  const conDireccion = alcistas + bajistas
  return {
    puntos: +puntos.toFixed(1),
    alcistas,
    bajistas,
    conDireccion,
    lado: conDireccion === 0 ? null : puntos > 0 ? 'LONG' : puntos < 0 ? 'SHORT' : 'MIXTO',
    detalle,
  }
}

// Traduce la suma de dirección a la clase que usa la calculadora para saber
// si es long o short y con cuánta fuerza pintar la insignia.
function clsDeDireccion(dir) {
  if (!dir?.lado || dir.puntos === 0) return 'n'
  const f = Math.abs(dir.puntos)
  if (dir.puntos > 0) return f >= 6 ? 'lf' : f >= 3 ? 'lo' : 'lw'
  return f >= 6 ? 'sf' : f >= 3 ? 'sh' : 'sw'
}

const selectCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

export default function ScreenerCruces() {
  const [temporalidad, setTemporalidad] = useState('4h')
  const [datos, setDatos] = useState([])
  const [corriendo, setCorriendo] = useState(false)
  const [progreso, setProgreso] = useState({ hecho: 0, total: 0 })
  const [error, setError] = useState(null)
  const [ultima, setUltima] = useState(null)
  const [omitidos, setOmitidos] = useState(0)
  const [bloqueo, setBloqueo] = useState(0)

  // Filtros
  const [indicadoresOn, setIndicadoresOn] = useState(() => new Set(INDICADORES.map((i) => i.id)))
  const [estadosOn, setEstadosOn] = useState(() => new Set(['confirmado', 'en-curso', 'cerca']))
  const [direccion, setDireccion] = useState('todas')
  const [volMin, setVolMin] = useState(0)
  const [busqueda, setBusqueda] = useState('')
  const [seleccionado, setSeleccionado] = useState(null)
  // Orden: por defecto la confluencia de mayor a menor. Primer click en una
  // columna = de mayor a menor; segundo click invierte.
  const [orden, setOrden] = useState({ campo: 'hits', asc: false })

  const cache = useRef(new Map())
  const corriendoRef = useRef(false)

  useEffect(() => {
    if (bloqueo <= 0) return
    const t = setInterval(() => setBloqueo(segundosBloqueado()), 1000)
    return () => clearInterval(t)
  }, [bloqueo])

  const toggle = useCallback((set, valor, setter) => {
    const n = new Set(set)
    if (n.has(valor)) n.delete(valor)
    else n.add(valor)
    setter(n)
  }, [])

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
    try {
      const { simbolos } = await getUniversoV2({ minTurnover: MIN_TURNOVER })
      setProgreso({ hecho: 0, total: simbolos.length })
      cache.current = new Map()
      const filas = []
      let sinDatos = 0
      for (let i = 0; i < simbolos.length; i += TAMANO_LOTE) {
        const lote = simbolos.slice(i, i + TAMANO_LOTE)
        const parciales = await Promise.all(
          lote.map(async (meta) => {
            const k = await getKlinesV2(meta.symbol, temporalidad, VELAS)
            if (!k || k.length < 260) return null
            // A propósito NO se descarta la última vela: acá se quiere el
            // precio de ahora. armarSeries acepta cualquier array de velas.
            const s = armarSeries(k)
            const est = estadoDeTodos(s)
            if (!est) return null
            cache.current.set(meta.symbol, k)
            const iv = s.n - 1
            const ultima = k[k.length - 1]
            const abre = +ultima[0]
            const cierra = +ultima[6]
            return {
              symbol: `${meta.symbol.replace(/USDT$/, '')}/USDT`,
              symbolRaw: meta.symbol,
              link: `https://www.binance.com/es/futures/${meta.symbol}`,
              price: s.closes[iv],
              chg24h: meta.chg24hReal ?? 0,
              turnover: meta.turnover ?? null,
              volRatio: isNaN(s.volRatio[iv]) ? null : +s.volRatio[iv].toFixed(2),
              rsi: isNaN(s.rsi[iv]) ? null : +s.rsi[iv].toFixed(1),
              smi: isNaN(s.smi[iv]) ? null : +s.smi[iv].toFixed(1),
              pctVela: cierra > abre ? Math.min(100, ((Date.now() - abre) / (cierra - abre)) * 100) : null,
              est,
              dir: direccionDe(est),
            }
          }),
        )
        for (const p of parciales) {
          if (!p) sinDatos++
          else filas.push(p)
        }
        setProgreso({ hecho: Math.min(i + TAMANO_LOTE, simbolos.length), total: simbolos.length })
        if (i + TAMANO_LOTE < simbolos.length) await sleep(150)
      }
      setDatos(filas)
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

  // Valor numérico (o texto) por el que se ordena cada columna. Tener esto en
  // un solo lugar evita que el encabezado y el orden se desincronicen.
  const COLUMNAS = useMemo(
    () => [
      { campo: 'symbol', label: 'Símbolo', valor: (r) => r.symbol, texto: true },
      { campo: 'price', label: 'Precio', valor: (r) => r.price, align: 'right' },
      { campo: 'chg24h', label: '24h', valor: (r) => r.chg24h, align: 'right' },
      { campo: 'dir', label: 'Dirección', valor: (r) => r.dir.puntos, align: 'center',
        titulo: 'Suma de los 5 indicadores pesando confirmado ×2, en curso ×1 y cerca ×0,5. El número que se ve ES esa suma: va de -10 (los 5 bajistas confirmados) a +10 (los 5 alcistas confirmados). Los que están en "·" no tienen dirección y no suman. NO es una predicción: es un resumen. Lo que rinde cada cruce históricamente está medido en el Screener v3.' },
      ...INDICADORES.map((ind) => ({
        campo: ind.id,
        label: ind.nombre,
        align: 'center',
        titulo: VOLUMEN_AYUDA[ind.id],
        valor: (r) => {
          const e = r.est[ind.id]
          return e && e.dir ? (PESO_ESTADO[e.estado] ?? 0) * e.dir : 0
        },
      })),
      { campo: 'hits', label: 'Coinciden', valor: (r) => r.hits.length, align: 'right' },
      // OJO con los nombres: 'rsi' y 'smi' ya los usan las columnas de CRUCE
      // (vienen de INDICADORES). Si estas dos reusaran ese campo, las dos
      // columnas se marcarían como ordenadas a la vez y el click iría siempre
      // a la primera. Por eso el valor numérico va con su propio campo.
      { campo: 'rsiValor', label: 'RSI val', valor: (r) => r.rsi ?? -1, align: 'right',
        titulo: 'Valor del RSI ahora (con la vela en curso). La columna RSI de la izquierda es el CRUCE contra su media.' },
      { campo: 'smiValor', label: 'SMI val', valor: (r) => r.smi ?? -999, align: 'right',
        titulo: 'Valor del SMI ahora, de -100 a +100. La columna SMI de la izquierda es el CRUCE contra su señal.' },
      { campo: 'volRatio', label: 'Vol×', valor: (r) => r.volRatio ?? -1, align: 'right' },
    ],
    [],
  )

  const ordenarPor = (campo) =>
    setOrden((o) => (o.campo === campo ? { campo, asc: !o.asc } : { campo, asc: false }))

  // Una fila pasa el filtro si ALGUNO de los indicadores elegidos está en
  // alguno de los estados elegidos y en la dirección elegida.
  const filtradas = useMemo(() => {
    const q = busqueda.trim().toUpperCase()
    const conCoincidencias = datos
      .map((r) => {
        const hits = INDICADORES.filter((ind) => {
          if (!indicadoresOn.has(ind.id)) return false
          const e = r.est[ind.id]
          if (!e || !estadosOn.has(e.estado)) return false
          if (direccion === 'alcista' && e.dir !== 1) return false
          if (direccion === 'bajista' && e.dir !== -1) return false
          return true
        }).map((ind) => ind.id)
        return { ...r, hits }
      })
      .filter((r) => r.hits.length > 0)
      .filter((r) => volMin === 0 || (r.volRatio ?? 0) >= volMin)
      .filter((r) => !q || r.symbol.includes(q))
    const col = COLUMNAS.find((c) => c.campo === orden.campo) ?? COLUMNAS.find((c) => c.campo === 'hits')
    const signo = orden.asc ? 1 : -1
    return [...conCoincidencias].sort((a, b) => {
      const va = col.valor(a)
      const vb = col.valor(b)
      if (col.texto) return signo * String(va).localeCompare(String(vb))
      if (va !== vb) return signo * (va - vb)
      // Desempate estable: más confluencia primero, después alfabético.
      if (b.hits.length !== a.hits.length) return b.hits.length - a.hits.length
      return a.symbol.localeCompare(b.symbol)
    })
  }, [datos, indicadoresOn, estadosOn, direccion, volMin, busqueda, orden, COLUMNAS])

  const conteos = useMemo(() => {
    const c = {}
    for (const ind of INDICADORES) {
      c[ind.id] = { confirmado: 0, 'en-curso': 0, cerca: 0 }
      for (const r of datos) {
        const e = r.est[ind.id]
        if (e && c[ind.id][e.estado] != null) c[ind.id][e.estado]++
      }
    }
    return c
  }, [datos])

  const filaSel = seleccionado ? datos.find((r) => r.symbolRaw === seleccionado) : null

  const insignia = (r, ind) => {
    const e = r.est[ind.id]
    if (!e) return null
    const c = COLOR_ESTADO[e.estado]
    const flecha = e.dir === 1 ? '↑' : e.dir === -1 ? '↓' : ''
    const detalle =
      e.estado === 'cerca' && e.velas != null
        ? ` · cruza en ~${e.velas} vela${e.velas === 1 ? '' : 's'} si sigue así`
        : ''
    return (
      <span
        className="whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold"
        style={{ backgroundColor: c.bg, color: c.text }}
        title={`${ind.nombre}: ${ETIQUETA_ESTADO[e.estado]}${flecha ? ` ${flecha === '↑' ? 'alcista' : 'bajista'}` : ''}${detalle}\nGap ${e.gap?.toFixed(4)} (${e.gapRel ?? '—'}× su tamaño habitual)`}
      >
        {c.icono} {flecha || '·'}
      </span>
    )
  }

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">🎯 Screener de Cruces</h1>
        <p className="text-xs leading-relaxed text-terminal-dim">
          Cruces alcistas y bajistas de <b>MACD</b>, <b>RSI</b> (contra su media), <b>Estocástico</b>,{' '}
          <b>StochRSI</b> y <b>SMI</b>, más los que están <b>cerca de cruzar</b>. Todo calculado con la{' '}
          <b>vela en curso</b>, o sea con el precio de ahora — que es lo que hace falta para ver un cruce antes
          de que termine de pasar.
        </p>
        <div className="mt-2 rounded border border-terminal-warn/30 bg-terminal-warn/10 px-3 py-2 text-xs leading-relaxed text-terminal-warn">
          ⚠️ Usar la vela abierta tiene un costo: <b>un cruce en curso puede deshacerse</b> antes de que la vela
          cierre. Por eso están separados: <b>● confirmado</b> pasó en una vela ya cerrada y no cambia más;{' '}
          <b>◐ en curso</b> está pasando ahora y todavía puede volverse atrás; <b>○ cerca</b> todavía no cruzó.
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-terminal-dim">Temporalidad</label>
        <select value={temporalidad} onChange={(e) => setTemporalidad(e.target.value)} className={selectCls}>
          {TEMPORALIDADES.map((t) => (
            <option key={t.valor} value={t.valor}>
              {t.etiqueta}
            </option>
          ))}
        </select>
        <label className="text-xs text-terminal-dim">Volumen mín.</label>
        <select value={volMin} onChange={(e) => setVolMin(Number(e.target.value))} className={selectCls}>
          <option value={0}>sin filtro</option>
          <option value={1.2}>≥ 1,2× el promedio</option>
          <option value={1.5}>≥ 1,5× el promedio</option>
          <option value={2}>≥ 2× el promedio</option>
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
        {datos.length > 0 && datos[0].pctVela != null && (
          <span className="text-xs text-terminal-dim">
            · vela {temporalidad}: {datos[0].pctVela.toFixed(0)}% transcurrida
          </span>
        )}
        {omitidos > 0 && <span className="text-xs text-terminal-dim">· {omitidos} sin datos</span>}
      </div>

      {volMin > 0 && (
        <div className="mb-3 rounded border border-terminal-info/30 bg-terminal-info/10 px-3 py-2 text-xs leading-relaxed text-terminal-info">
          ℹ️ <b>Filtro de volumen activo.</b> Medido sobre 93.549 cruces (4h, 120 perpetuos, 250 días): el
          volumen <b>no confirma la dirección</b>, amplifica lo que ya venía pasando. Mejora en 5 cruces y
          empeora en 11. Los LONG pasan de +0,213% a +0,404% con ≥2×, pero los SHORT empeoran de −0,549% a
          −0,919%. El único caso claro a favor es el RSI cruzando su media al alza.
        </div>
      )}

      {error && (
        <div className="mb-4 rounded border border-terminal-down/40 bg-terminal-down/10 px-3 py-2 text-xs text-terminal-down">
          Error: {error}
        </div>
      )}

      {corriendo && (
        <div className="mb-4 h-1 w-full overflow-hidden rounded bg-terminal-border">
          <div
            className="h-full bg-terminal-accent transition-all"
            style={{ width: `${progreso.total ? (progreso.hecho / progreso.total) * 100 : 0}%` }}
          />
        </div>
      )}

      {datos.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wide text-terminal-dim">Indicador</span>
            {INDICADORES.map((ind) => {
              const on = indicadoresOn.has(ind.id)
              const c = conteos[ind.id]
              return (
                <button
                  key={ind.id}
                  type="button"
                  onClick={() => toggle(indicadoresOn, ind.id, setIndicadoresOn)}
                  title={VOLUMEN_AYUDA[ind.id]}
                  className={`rounded px-2 py-1 text-xs font-semibold transition-opacity ${
                    on ? 'bg-terminal-panel2 text-terminal-text' : 'bg-terminal-panel text-terminal-dim opacity-50'
                  }`}
                >
                  {ind.nombre}{' '}
                  <span className="text-[10px] font-normal">
                    ({c.confirmado}●/{c['en-curso']}◐/{c.cerca}○)
                  </span>
                </button>
              )
            })}
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wide text-terminal-dim">Estado</span>
            {['confirmado', 'en-curso', 'cerca'].map((e) => {
              const on = estadosOn.has(e)
              const c = COLOR_ESTADO[e]
              return (
                <button
                  key={e}
                  type="button"
                  onClick={() => toggle(estadosOn, e, setEstadosOn)}
                  className={`rounded px-2 py-1 text-xs font-semibold transition-opacity ${on ? '' : 'opacity-40'}`}
                  style={{ backgroundColor: c.bg, color: c.text }}
                >
                  {c.icono} {ETIQUETA_ESTADO[e]}
                </button>
              )
            })}
            <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">Dirección</span>
            {[
              ['todas', 'Todas'],
              ['alcista', '↑ Alcistas'],
              ['bajista', '↓ Bajistas'],
            ].map(([k, l]) => (
              <button
                key={k}
                type="button"
                onClick={() => setDireccion(k)}
                className={`rounded px-2 py-1 text-xs font-semibold ${
                  direccion === k ? 'bg-terminal-accent text-black' : 'bg-terminal-panel text-terminal-dim'
                }`}
              >
                {l}
              </button>
            ))}
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar símbolo…"
              className="rounded border border-terminal-border bg-terminal-panel px-2 py-1 text-xs text-terminal-text focus:border-terminal-accent focus:outline-none"
            />
          </div>

          <div className="mb-2 text-xs text-terminal-dim">
            {filtradas.length} de {datos.length} símbolos · click en cualquier encabezado para ordenar
            {' · '}
            <span title="Pasá el mouse por cualquier insignia de Dirección para ver la cuenta indicador por indicador.">
              en <b>Dirección</b>, el número es la <b>suma pesada</b> de los 5 indicadores (confirmado ×2, en
              curso ×1, cerca ×0,5), de −10 a +10 — es un recuento, no una recomendación
            </span>
          </div>
        </>
      )}

      {!datos.length && !corriendo ? (
        <div className="rounded-lg border border-terminal-border bg-terminal-panel p-10 text-center text-sm text-terminal-dim">
          Presioná <b>Escanear</b>. Se analizan los perpetuos con más de $5M de volumen en 24h.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-terminal-border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-terminal-panel2 text-left text-xs text-terminal-dim">
              <tr>
                {COLUMNAS.map((c) => (
                  <th
                    key={c.campo}
                    onClick={() => ordenarPor(c.campo)}
                    title={c.titulo ? `${c.titulo} (click para ordenar)` : 'Click para ordenar'}
                    className={`cursor-pointer whitespace-nowrap px-2 py-2.5 font-semibold hover:text-terminal-text ${
                      c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''
                    } ${orden.campo === c.campo ? 'text-terminal-accent' : ''}`}
                  >
                    {c.label}
                    {orden.campo === c.campo ? (orden.asc ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtradas.map((r) => (
                <tr
                  key={r.symbolRaw}
                  onClick={() => setSeleccionado(r.symbolRaw)}
                  className="cursor-pointer border-t border-terminal-border hover:bg-terminal-panel"
                >
                  <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-terminal-text">
                    {r.symbol}
                    <a
                      href={r.link}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="ml-1 opacity-60 hover:opacity-100"
                    >
                      ↗
                    </a>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular text-terminal-text">
                    {fmtPrice(r.price)}
                  </td>
                  <td
                    className="whitespace-nowrap px-2 py-1.5 text-right tabular"
                    style={{ color: r.chg24h >= 0 ? '#4ade80' : '#f87171' }}
                  >
                    {r.chg24h >= 0 ? '+' : ''}
                    {r.chg24h.toFixed(2)}%
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-center">
                    {r.dir.lado ? (
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px] font-bold"
                        style={{
                          backgroundColor:
                            r.dir.lado === 'LONG'
                              ? 'rgba(34,197,94,0.22)'
                              : r.dir.lado === 'SHORT'
                                ? 'rgba(239,68,68,0.22)'
                                : 'rgba(125,139,156,0.15)',
                          color:
                            r.dir.lado === 'LONG' ? '#86efac' : r.dir.lado === 'SHORT' ? '#fca5a5' : '#9ca3af',
                        }}
                        title={`Suma ${r.dir.puntos > 0 ? "+" : ""}${r.dir.puntos} = ${r.dir.detalle.join(" ")}. Conteo: ${r.dir.alcistas} al alza y ${r.dir.bajistas} a la baja, de 5 indicadores (los que están en "·" no tienen dirección y no cuentan). Pesos: confirmado x2, en curso x1, cerca x0,5. Es un recuento de los indicadores, NO una recomendacion.`}
                      >
                        {r.dir.lado === 'LONG' ? '↑ LONG' : r.dir.lado === 'SHORT' ? '↓ SHORT' : '= MIXTO'}{' '}
                        <span className="font-normal opacity-70">
                          {r.dir.puntos > 0 ? '+' : ''}
                          {r.dir.puntos}
                        </span>
                      </span>
                    ) : (
                      <span className="text-terminal-dim">—</span>
                    )}
                  </td>
                  {INDICADORES.map((ind) => (
                    <td key={ind.id} className="px-2 py-1.5 text-center">
                      {insignia(r, ind)}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right font-bold tabular text-terminal-accent">{r.hits.length}</td>
                  <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{r.rsi ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{r.smi ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular text-terminal-dim">
                    {r.volRatio != null ? `×${r.volRatio}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filaSel && (
        <PanelApalancamiento
          fila={{
            ...filaSel,
            // Antes se pasaba cls:'n' fijo, así que la calculadora decía
            // "señal NEUTRAL, sin niveles" incluso con los 5 indicadores
            // alineados. La clase sale de la suma de dirección: no es un
            // veredicto de calidad, sólo define el LADO para calcular SL/TP
            // por ATR y pintar la insignia.
            cls: clsDeDireccion(filaSel.dir),
            signal: filaSel.dir.lado ?? 'SIN DIRECCIÓN',
            score: filaSel.dir.puntos,
            details: '',
          }}
          klines={cache.current.get(filaSel.symbolRaw)}
          atrMult={2}
          to={`/cripto/${encodeURIComponent(filaSel.symbolRaw)}`}
          onCerrar={() => setSeleccionado(null)}
        />
      )}
    </div>
  )
}
