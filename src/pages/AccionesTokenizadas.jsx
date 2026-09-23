import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getSymbolsTradfi, getTicker24h } from '../lib/crypto/binanceApi'
import { useEscaneoBinance, parametrosCambiaron } from '../lib/crypto/useEscaneo'
import {
  INTERVALOS,
  MULTIPLOS_ATR,
  CORTO,
  LARGO,
  COLOR_SENAL,
  CATEGORIAS_TRADFI,
  CATEGORIA_DEFAULT,
} from '../lib/crypto/constantes'
import { fmtPrecioAccion } from '../lib/crypto/formato'
import { useJson } from '../lib/useJson'
import Insignia, { TendenciaEma } from '../components/crypto/Insignia'
import BarraRSI from '../components/crypto/BarraRSI'
import PanelApalancamiento from '../components/crypto/PanelApalancamiento'
import BotonEscanear, { AvisoParametros } from '../components/crypto/BotonEscanear'

const selectCls =
  'rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text ' +
  'focus:border-terminal-accent focus:outline-none'

function cat(tipo) {
  return CATEGORIAS_TRADFI[tipo] ?? CATEGORIA_DEFAULT
}

// Fecha / dia / minuto del dia en Nueva York (donde cotiza la accion real).
function enNY(d) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  )
  return { fecha: `${p.year}-${p.month}-${p.day}`, dia: p.weekday, minutos: +p.hour * 60 + +p.minute }
}

// "vs cierre": perp contra el precio de la accion real. Solo tiene sentido
// si el subyacente cotiza en EEUU (es lo que trae el pipeline de yfinance) y
// si ese precio es DE HOY con el mercado ya abierto: contra un cierre de otro
// dia la diferencia mezcla el movimiento de dias distintos (un lunes a la
// mañana comparaba el perp de hoy con el viernes) y no mide ninguna prima.
// Devuelve { dif, motivo }: dif null + motivo cuando no se compara.
function difContraAccion(r, real) {
  if (r.tipo !== 'EQUITY') {
    return { dif: null, motivo: 'El subyacente no cotiza en EEUU: el pipeline solo trae precios de acciones y ETFs de EEUU.' }
  }
  if (!real) return { dif: null, motivo: `${r.base} no está en tu tickers.xlsx, no hay precio de la acción real.` }
  if (real.stale) return { dif: null, motivo: `El precio de ${r.base} está desactualizado en el pipeline (stale).` }
  if (!real.actualizado) return { dif: null, motivo: 'No se sabe de cuándo es el precio de la acción real.' }
  const ahora = enNY(new Date())
  const precio = enNY(new Date(real.actualizado))
  const abierto = precio.minutos >= 9 * 60 + 30 && precio.dia !== 'Sat' && precio.dia !== 'Sun'
  if (precio.fecha !== ahora.fecha || !abierto) {
    return {
      dif: null,
      motivo: `El último precio de ${r.base} es del ${precio.fecha.split('-').reverse().join('/')} (hora NY, ${
        abierto ? 'con mercado abierto' : 'antes de la apertura o en fin de semana'
      }), no de la rueda de hoy: compararlo con el perpetuo de ahora mezclaría días distintos.`,
    }
  }
  return { dif: +(((r.price - real.precio) / real.precio) * 100).toFixed(2), motivo: null }
}

export default function AccionesTokenizadas() {
  const [intervalo, setIntervalo] = useState('1h')
  const [multiploATR, setMultiploATR] = useState(2.0)
  const [filtro, setFiltro] = useState('all')
  const [categoria, setCategoria] = useState('all')
  const [busqueda, setBusqueda] = useState('')
  const [sortKey, setSortKey] = useState('score')
  const [sortAsc, setSortAsc] = useState(true)
  const [seleccionado, setSeleccionado] = useState(null)

  // Precios de la accion real (pipeline yfinance) para calcular la
  // diferencia contra el perpetuo, que cotiza 24/7. La frescura sale de la
  // fila si la trae (solo las viejas la traen) o del meta.json global.
  const { data: medias } = useJson('medias.json')
  const { data: meta } = useJson('meta.json')
  const precioReal = useMemo(() => {
    const m = new Map()
    for (const f of medias ?? []) {
      if (f.precio == null) continue
      m.set(f.ticker, {
        precio: f.precio,
        actualizado: f.actualizado ?? meta?.ultima_actualizacion ?? null,
        stale: !!f.stale,
      })
    }
    return m
  }, [medias, meta])

  // Igual que en el Crypto Screener: el 24h real viene del ticker, porque el
  // que calcula analyzeKlines son 24 velas de la temporalidad elegida.
  const cargarSimbolos = useCallback(async () => {
    const [simbolos, t24] = await Promise.all([getSymbolsTradfi(), getTicker24h()])
    return simbolos.map((m) => {
      const real = t24.get(m.symbol)
      return real == null ? m : { ...m, chg24h: +real.toFixed(2) }
    })
  }, [])
  const parametros = useMemo(() => ({ intervalo, multiploATR }), [intervalo, multiploATR])
  const escaneo = useEscaneoBinance({ cargarSimbolos, intervalo, multiploATR, parametros })
  const { datos, corriendo, progreso, ultimaActualizacion, errorMsg, omitidos, cacheKlines, parametrosEscaneo } =
    escaneo
  const cambiados = !corriendo && datos.length > 0 && parametrosCambiaron(parametrosEscaneo, parametros)
  const atrEscaneo = parametrosEscaneo?.multiploATR ?? multiploATR

  // Se le pega a cada fila el precio de la accion real y la diferencia %.
  // Solo se compara si la comparacion tiene sentido (ver difContraAccion).
  const filas = useMemo(
    () =>
      datos.map((r) => {
        const real = precioReal.get(r.base)
        const { dif, motivo } = difContraAccion(r, real)
        return {
          ...r,
          en_medias: real != null,
          precio_real: real?.precio ?? null,
          dif_real: dif,
          dif_motivo: motivo,
        }
      }),
    [datos, precioReal],
  )

  const conteos = useMemo(
    () => ({
      total: filas.length,
      short: filas.filter((r) => CORTO.includes(r.cls)).length,
      long: filas.filter((r) => LARGO.includes(r.cls)).length,
      neutral: filas.filter((r) => r.cls === 'n').length,
    }),
    [filas],
  )

  const categorias = useMemo(() => {
    const c = new Map()
    for (const r of filas) c.set(r.tipo, (c.get(r.tipo) ?? 0) + 1)
    return [...c.entries()].sort((a, b) => cat(a[0]).orden - cat(b[0]).orden)
  }, [filas])

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    const r = filas.filter((row) => {
      if (q && !row.symbol.toLowerCase().includes(q)) return false
      if (categoria !== 'all' && row.tipo !== categoria) return false
      if (filtro === 'short') return CORTO.includes(row.cls)
      if (filtro === 'long') return LARGO.includes(row.cls)
      if (filtro === 'neutral') return row.cls === 'n'
      return true
    })
    return r.sort((a, b) => {
      const va = a[sortKey] ?? 0
      const vb = b[sortKey] ?? 0
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va)
      return sortAsc ? va - vb : vb - va
    })
  }, [filas, filtro, categoria, busqueda, sortKey, sortAsc])

  const ordenar = (clave) => {
    if (sortKey === clave) setSortAsc((a) => !a)
    else {
      setSortKey(clave)
      setSortAsc(true)
    }
  }

  const filaSeleccionada = seleccionado ? filas.find((r) => r.symbolRaw === seleccionado) : null

  const columnas = [
    { key: 'symbol', label: 'Símbolo' },
    { key: 'tipo', label: 'Mercado' },
    { key: 'price', label: 'Perp' },
    { key: 'dif_real', label: 'vs acción', titulo: 'Diferencia entre el perpetuo (cotiza 24/7) y el precio de la acción real según el pipeline de yfinance. Solo para subyacentes de EEUU con precio de la rueda de hoy; si no, "—" (pasá el mouse por la celda para ver por qué).' },
    { key: 'chg24h', label: '24h %' },
    { key: 'score', label: 'Score' },
    { key: 'signal', label: 'Señal' },
    { key: 'rsi', label: 'RSI' },
    { key: 'srsi', label: 'StochRSI' },
    { key: 'bb_pct', label: 'BB %' },
    { key: 'ema_trend', label: 'EMA' },
    { key: 'vol_ratio', label: 'Vol×' },
    { key: 'sl_pct', label: 'SL %' },
    { key: 'tp2_pct', label: 'TP2 %' },
  ]

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-bold text-terminal-text">Acciones Tokenizadas</h1>
        <p className="text-xs text-terminal-dim">
          Misma lógica que el Crypto Screener (RSI + StochRSI + MACD + Bollinger + alineación de
          EMAs + volumen, con calculadora de apalancamiento y liquidación), pero sobre los{' '}
          <b>perpetuos de acciones tokenizadas</b> de Binance Futures — así podés operar{' '}
          <b>short</b> en MSTR, TSLA o NVDA sin pedir prestado el papel. Incluye ETFs apalancados
          (SOXL, TQQQ, UVXY), commodities (oro, petróleo) y pre-IPO (OPENAI, ANTHROPIC). Cotizan
          24/7, incluso con el mercado cerrado. Corre 100% en tu navegador. Orientativo, no es
          recomendación de inversión.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="text-xs text-terminal-dim">Temporalidad</label>
        <select value={intervalo} onChange={(e) => setIntervalo(e.target.value)} className={selectCls}>
          {INTERVALOS.map((i) => (
            <option key={i.valor} value={i.valor}>
              {i.etiqueta}
            </option>
          ))}
        </select>
        <label className="text-xs text-terminal-dim">SL (ATR ×)</label>
        <select
          value={multiploATR}
          onChange={(e) => setMultiploATR(Number(e.target.value))}
          className={selectCls}
        >
          {MULTIPLOS_ATR.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <BotonEscanear escaneo={escaneo} hayDatos={filas.length > 0} />
        {ultimaActualizacion && (
          <span className="text-xs text-terminal-dim">
            Actualizado: {ultimaActualizacion}
            {omitidos > 0 && (
              <span title="Símbolos sin suficiente historial en esta temporalidad (recién listados): hacen falta 60 velas mínimo.">
                {' '}
                · {omitidos} sin historial suficiente
              </span>
            )}
          </span>
        )}
      </div>

      <AvisoParametros
        visible={cambiados}
        escaneados={`temporalidad ${parametrosEscaneo?.intervalo} y SL ${parametrosEscaneo?.multiploATR}× ATR`}
      />

      {corriendo && (
        <div className="mb-4 h-1 w-full overflow-hidden rounded bg-terminal-border">
          <div
            className="h-full bg-terminal-accent transition-all"
            style={{ width: `${progreso.total ? (progreso.hecho / progreso.total) * 100 : 0}%` }}
          />
        </div>
      )}

      {errorMsg && (
        <div className="mb-4 rounded border border-terminal-down/40 bg-terminal-down/10 px-3 py-2 text-xs text-terminal-down">
          Error: {errorMsg}
        </div>
      )}

      {!filas.length && !corriendo ? (
        <div className="rounded-lg border border-terminal-border bg-terminal-panel p-10 text-center text-sm text-terminal-dim">
          Presioná <b>Escanear</b> para analizar los perpetuos de acciones tokenizadas de Binance.
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {[
              { k: 'all', l: `TODOS: ${conteos.total}`, cls: 'bg-terminal-panel2 text-terminal-text' },
              { k: 'short', l: `SHORT: ${conteos.short}`, cls: 'bg-terminal-down/20 text-terminal-down' },
              { k: 'long', l: `LONG: ${conteos.long}`, cls: 'bg-terminal-up/20 text-terminal-up' },
              { k: 'neutral', l: `NEUTRAL: ${conteos.neutral}`, cls: 'bg-terminal-border text-terminal-dim' },
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
              value={categoria}
              onChange={(e) => setCategoria(e.target.value)}
              className={selectCls}
              title="Filtrar por mercado del subyacente"
            >
              <option value="all">Todos los mercados</option>
              {categorias.map(([tipo, n]) => (
                <option key={tipo} value={tipo}>
                  {cat(tipo).etiqueta} ({n})
                </option>
              ))}
            </select>
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar símbolo…"
              className="w-44 rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
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
                  const esCorto = CORTO.includes(r.cls)
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
                          to={`/tokenizadas/${encodeURIComponent(r.symbolRaw)}`}
                          onClick={(e) => e.stopPropagation()}
                          className="hover:underline"
                          style={{ color: 'inherit' }}
                          title="Ver en su propia página"
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
                        {r.en_medias && (
                          <Link
                            to={`/ticker/${encodeURIComponent(r.base)}`}
                            onClick={(e) => e.stopPropagation()}
                            className="ml-1 opacity-60 hover:opacity-100"
                            style={{ color: 'inherit' }}
                            title={`Ver el análisis de ${r.base} en Stock Lens`}
                          >
                            🔍
                          </Link>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-xs text-terminal-dim">
                        {cat(r.tipo).corta}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {fmtPrecioAccion(r.price)}
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 tabular"
                        title={
                          r.dif_real != null
                            ? `(Perp ${fmtPrecioAccion(r.price)} − ${r.base} ${fmtPrecioAccion(r.precio_real)}) / ${fmtPrecioAccion(r.precio_real)} × 100`
                            : r.dif_motivo
                        }
                      >
                        {r.dif_real != null ? (
                          <span style={{ color: r.dif_real >= 0 ? '#4ade80' : '#f87171' }}>
                            {r.dif_real >= 0 ? '+' : ''}
                            {r.dif_real}%
                          </span>
                        ) : (
                          <span className="text-terminal-dim">—</span>
                        )}
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 tabular"
                        style={{ color: r.chg24h >= 0 ? '#4ade80' : '#f87171' }}
                      >
                        {r.chg24h >= 0 ? '+' : ''}
                        {r.chg24h.toFixed(2)}%
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-bold tabular">
                        {r.score > 0 ? '+' : ''}
                        {r.score}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <Insignia cls={r.cls}>{r.signal}</Insignia>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.rsi}
                        <BarraRSI valor={r.rsi} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.srsi ?? '—'}
                        {r.srsi != null && <BarraRSI valor={r.srsi} />}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">{r.bb_pct}%</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-semibold">
                        <TendenciaEma valor={r.ema_trend} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular">
                        {r.vol_ratio >= 2 ? <b>×{r.vol_ratio}</b> : `×${r.vol_ratio}`}
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 font-semibold tabular"
                        style={{ color: '#f87171' }}
                      >
                        {r.sl_pct != null ? `${esCorto ? '+' : ''}${r.sl_pct}%` : '—'}
                      </td>
                      <td
                        className="whitespace-nowrap px-2 py-1.5 font-semibold tabular"
                        style={{ color: '#4ade80' }}
                      >
                        {r.tp2_pct != null ? `${r.tp2_pct > 0 ? '+' : ''}${r.tp2_pct}%` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {filaSeleccionada && (
        <PanelApalancamiento
          fila={filaSeleccionada}
          klines={cacheKlines.current.get(filaSeleccionada.symbolRaw)}
          atrMult={atrEscaneo}
          to={`/tokenizadas/${encodeURIComponent(filaSeleccionada.symbolRaw)}`}
          onCerrar={() => setSeleccionado(null)}
        />
      )}
    </div>
  )
}
