// Backtest EN VIVO (en el navegador) de las 4 figuras chartistas sobre
// cripto, mismo espiritu que scripts/backtest_senales.py (sin look-ahead,
// entrada a la apertura de la vela siguiente, exceso vs. un benchmark, base =
// una muestra cada N velas del mismo universo) pero:
//   - SIEMPRE sobre velas DIARIAS (interval='1d'), sea cual sea la
//     temporalidad que el usuario tenga elegida en el escaner en vivo (Task 2
//     de FigurasChartistasCripto.jsx) — para que sea comparable entre
//     simbolos y con la version stock.
//   - Benchmark = BTCUSDT (no hay "SPY" para cripto).
//   - Universo acotado (top N perpetuos USDT por volumen 24h) y ventana
//     acotada (limit de velas por pedido), porque TODO esto corre en el
//     navegador del usuario: no hay pipeline server-side posible (Binance
//     geo-bloquea los runners de GitHub Actions, ver README).
//   - Corre solo cuando el usuario lo pide explicitamente (ver
//     useBacktestFiguras.js): nunca en el load de la pagina.
//
// No comparte cache/objetos con figuras.js/useEscaneo.js del escaner en vivo
// (Task 2) mas alla de las funciones de fetch/rate-limit, para que un
// usuario que nunca toca el backtest nunca dispare esta descarga pesada.

import { getUniverso } from './binanceApi.js'
import { escanearLotes } from './useEscaneo.js'
import { TIPOS, BAJISTA, FG_MIN_RUEDAS, fgCiclo, atrPctSerie, num } from './figuras.js'
import { ESTADOS_FIGURAS } from '../figuras.js'

export const BT_UNIVERSO_N = 40 // top N perpetuos USDT por volumen 24h (+ BTCUSDT como benchmark, fuera del top si hiciera falta)
export const BT_VELAS = 1000 // velas DIARIAS por símbolo (limit de Binance; ~2,7 años — menos si el símbolo es más nuevo)
export const BT_STRIDE = 30 // muestras cada 30 velas diarias (~6 semanas, mismo criterio STRIDE_PESADO del backtest stock)
const HORIZONTES = [5, 10, 20] // velas (sesiones) hacia adelante, igual que HORIZ_D del backtest stock
const MIN_MUESTRA_BOOT = 30
const N_BOOT = 200
const ESTADOS = ESTADOS_FIGURAS.map((e) => e.estado)

function fechaUTC(openTimeMs) {
  return new Date(openTimeMs).toISOString().slice(0, 10)
}

// Klines crudas de Binance ([openTime,open,high,low,close,volume,...]) ->
// serie {dates, open, high, low, close, volume}, SOLO velas cerradas (se
// descarta la última: puede seguir en curso si se corre a mitad del día UTC).
function serieDesdeKlines(klinesRaw) {
  const cerradas = klinesRaw.slice(0, -1)
  return {
    dates: cerradas.map((k) => fechaUTC(+k[0])),
    open: cerradas.map((k) => +k[1]),
    high: cerradas.map((k) => +k[2]),
    low: cerradas.map((k) => +k[3]),
    close: cerradas.map((k) => +k[4]),
    volume: cerradas.map((k) => +k[5]),
  }
}

function prefijo(serie, hasta) {
  return {
    high: serie.high.slice(0, hasta),
    low: serie.low.slice(0, hasta),
    close: serie.close.slice(0, hasta),
    volume: serie.volume.slice(0, hasta),
  }
}

// Última posición i tal que dates[i] <= fecha (busqueda binaria; las fechas
// ISO ordenan lexicográfico = cronológico). -1 si 'fecha' es anterior a toda
// la serie (símbolo listado después de esa fecha muestra: se saltea).
function posEnFecha(dates, fecha) {
  let lo = 0
  let hi = dates.length - 1
  let resultado = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (dates[mid] <= fecha) {
      resultado = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return resultado
}

function mediana(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const media = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)

// PRNG determinístico (mulberry32): mismo bootstrap en cada corrida con la
// misma muestra (no hace falta que sea criptográfico, solo reproducible para
// que dos backtests seguidos con los mismos datos den el mismo CI).
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function bootstrapCiMediana(exceso, rng) {
  if (exceso.length < MIN_MUESTRA_BOOT) return null
  const medianas = []
  for (let b = 0; b < N_BOOT; b++) {
    const muestra = new Array(exceso.length)
    for (let k = 0; k < exceso.length; k++) muestra[k] = exceso[Math.floor(rng() * exceso.length)]
    medianas.push(mediana(muestra))
  }
  medianas.sort((a, b) => a - b)
  const p = (q) => medianas[Math.min(medianas.length - 1, Math.max(0, Math.round(q * (medianas.length - 1))))]
  return [num(p(0.025), 2), num(p(0.975), 2)]
}

// stats[etiqueta][h] = {n, hit_rate, retorno_mediana, retorno_prom,
// exceso_mediana_spy, exceso_prom_spy, ci95_exceso_mediana, n_exceso} — MISMA
// forma que scripts/backtest_senales.py (agregar_stats) para que
// BadgeEvidencia/TablaEvidenciaMultiple se puedan reusar tal cual (el nombre
// del campo sigue siendo '..._spy' por compatibilidad con esos componentes;
// acá el benchmark es BTC, no SPY — se aclara con la prop benchmarkLabel).
function agregarStats(filas, bajista) {
  const porEtiqueta = new Map()
  for (const f of filas) {
    if (!porEtiqueta.has(f.valor)) porEtiqueta.set(f.valor, [])
    porEtiqueta.get(f.valor).push(f)
  }
  const rng = mulberry32(12345)
  const resultado = {}
  const etiquetas = ['BASELINE', ...ESTADOS.filter((e) => porEtiqueta.has(e))]
  for (const etiqueta of etiquetas) {
    const grupo = porEtiqueta.get(etiqueta) ?? []
    const porH = {}
    for (const h of HORIZONTES) {
      const sub = grupo.filter((f) => f.h === h)
      if (!sub.length) {
        porH[String(h)] = null
        continue
      }
      const ret = sub.map((f) => f.ret)
      const exceso = sub.filter((f) => f.retB != null).map((f) => f.ret - f.retB)
      // BASELINE nunca cuenta como "bajista" (es generico, no direccional) —
      // mismo criterio que agregar_stats de backtest_senales.py.
      const esBajista = etiqueta !== 'BASELINE' && bajista
      const acierto = ret.filter((r) => (esBajista ? r < 0 : r > 0)).length
      porH[String(h)] = {
        n: sub.length,
        hit_rate: num((acierto / sub.length) * 100, 1),
        retorno_mediana: num(mediana(ret), 2),
        retorno_prom: num(media(ret), 2),
        n_exceso: exceso.length,
        exceso_mediana_spy: exceso.length ? num(mediana(exceso), 2) : null,
        exceso_prom_spy: exceso.length ? num(media(exceso), 2) : null,
        ci95_exceso_mediana: bootstrapCiMediana(exceso, rng),
      }
    }
    resultado[etiqueta] = porH
  }
  return resultado
}

// Primer día de cada racha del mismo estado, por símbolo (ordenado por
// fecha) — mismo criterio que _racha_por_ticker de backtest_senales.py.
function porRacha(muestras) {
  const porSimbolo = new Map()
  for (const m of muestras) {
    if (!porSimbolo.has(m.symbol)) porSimbolo.set(m.symbol, [])
    porSimbolo.get(m.symbol).push(m)
  }
  const salida = []
  for (const lista of porSimbolo.values()) {
    lista.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0))
    let anterior = null
    for (const m of lista) {
      if (m.estado !== anterior) salida.push(m)
      anterior = m.estado
    }
  }
  return salida
}

// Corre el backtest completo: descarga velas diarias del universo + BTCUSDT
// (respetando el rate limiter compartido), recalcula las 4 figuras cortando
// el historial en cada fecha de muestra, arma filas de retorno directo +
// exceso vs. BTCUSDT y agrega stats por tipo×estado. 'onProgreso' recibe
// {etapa, hecho, total} en cada paso (descarga y detección son las dos
// etapas largas). Lanza si Binance bloqueó la IP o se canceló (mismos
// errores que el resto de src/lib/crypto).
export async function correrBacktestFiguras({ signal, onProgreso } = {}) {
  onProgreso?.({ etapa: 'universo', hecho: 0, total: 0 })
  const { simbolos } = await getUniverso({ conFunding: false })
  const top = simbolos.slice(0, BT_UNIVERSO_N).map((s) => s.symbol)
  const conjunto = new Set(top)
  conjunto.add('BTCUSDT') // benchmark: siempre incluido aunque no entrara en el top (no debería pasar nunca, BTC es el de mayor volumen)
  const listaSimbolos = [...conjunto].map((symbol) => ({ symbol }))

  const { filas: crudos, omitidos } = await escanearLotes({
    simbolos: listaSimbolos,
    intervalo: '1d',
    velas: BT_VELAS,
    analizar: (symbol, k) => ({ symbol, k }),
    signal,
    onProgreso: (p) => onProgreso?.({ etapa: 'descarga', ...p }),
  })

  const series = new Map()
  for (const { symbol, k } of crudos) series.set(symbol, serieDesdeKlines(k))
  const btc = series.get('BTCUSDT')
  if (!btc || btc.close.length < FG_MIN_RUEDAS) {
    throw new Error('No se pudo descargar suficiente historial de BTCUSDT (benchmark): no se puede correr el backtest.')
  }
  const btcIndice = new Map(btc.dates.map((d, i) => [d, i]))

  const testeables = [...series.entries()].filter(
    ([symbol, serie]) => symbol !== 'BTCUSDT' && serie.close.length >= FG_MIN_RUEDAS,
  )
  const ventanaPorSimbolo = testeables.map(([symbol, serie]) => ({
    symbol,
    desde: serie.dates[0],
    hasta: serie.dates[serie.dates.length - 1],
    velas: serie.close.length,
  }))

  // Fechas de muestra: cada BT_STRIDE velas del calendario de BTC (que tiene
  // el historial mas largo). Para cada símbolo se busca la posición propia
  // mas cercana a esa fecha (los que se listaron despues simplemente tienen
  // menos muestras al principio de su propia historia).
  const fechasMuestra = btc.dates.filter((_, i) => i % BT_STRIDE === 0)

  onProgreso?.({ etapa: 'deteccion', hecho: 0, total: testeables.length * TIPOS.length })
  const muestrasPorTipo = Object.fromEntries(TIPOS.map((t) => [t, []]))
  let hecho = 0
  for (const [symbol, serie] of testeables) {
    const atrPct = atrPctSerie(serie)
    for (const tipo of TIPOS) {
      const cache = {}
      for (const fecha of fechasMuestra) {
        const pos = posEnFecha(serie.dates, fecha)
        if (pos < FG_MIN_RUEDAS - 1 || pos >= serie.close.length - 1) continue
        const sub = prefijo(serie, pos + 1)
        let ciclo
        try {
          ;[, ciclo] = fgCiclo(tipo, sub, atrPct.slice(0, pos + 1), cache)
        } catch {
          continue
        }
        if (ciclo && ciclo.estado) muestrasPorTipo[tipo].push({ symbol, fecha: serie.dates[pos], pos, estado: ciclo.estado })
      }
      hecho++
      onProgreso?.({ etapa: 'deteccion', hecho, total: testeables.length * TIPOS.length })
    }
  }

  function retornoYExceso(serie, tEntrada, tSalida) {
    const entrada = serie.open[tEntrada]
    const salida = serie.close[tSalida]
    if (!entrada || !salida) return null
    const ret = (salida / entrada - 1) * 100
    const iE = btcIndice.get(serie.dates[tEntrada])
    const iS = btcIndice.get(serie.dates[tSalida])
    let retB = null
    if (iE != null && iS != null && btc.open[iE] && btc.close[iS]) retB = (btc.close[iS] / btc.open[iE] - 1) * 100
    return { ret, retB }
  }

  function filasDesdeMuestras(muestras) {
    const filas = []
    for (const m of porRacha(muestras)) {
      const serie = series.get(m.symbol)
      const n = serie.close.length
      for (const h of HORIZONTES) {
        if (m.pos + 1 >= n || m.pos + h >= n) continue
        const r = retornoYExceso(serie, m.pos + 1, m.pos + h)
        if (r) filas.push({ valor: m.estado, h, ...r })
      }
    }
    return filas
  }

  // Base: una muestra cada BT_STRIDE velas por símbolo (mismo universo, NO
  // depende del tipo — se comparte entre los 4 tipos, igual criterio que
  // backtest_senales.py, donde _filas_desde_muestras recalcula la misma base
  // para cada tipo por simplicidad de implementación).
  const filasBaseline = []
  for (const [, serie] of testeables) {
    const n = serie.close.length
    for (const h of HORIZONTES) {
      for (let t = FG_MIN_RUEDAS; t < n - h - 1; t += BT_STRIDE) {
        const r = retornoYExceso(serie, t + 1, t + h)
        if (r) filasBaseline.push({ valor: 'BASELINE', h, ...r })
      }
    }
  }

  const stats = {}
  for (const tipo of TIPOS) {
    stats[tipo] = agregarStats(filasDesdeMuestras(muestrasPorTipo[tipo]).concat(filasBaseline), BAJISTA[tipo])
  }

  const añosVentana = (BT_VELAS / 365).toFixed(1)
  return {
    actualizado: new Date().toISOString(),
    universo_n: testeables.length,
    velas_por_simbolo: BT_VELAS,
    stride: BT_STRIDE,
    horizontes: HORIZONTES,
    ventana_por_simbolo: ventanaPorSimbolo,
    omitidos,
    metodologia:
      'Recalcula cada figura con los datos CORTADOS en cada fecha (sin look-ahead), sobre velas DIARIAS ' +
      `(interval=1d, hasta ${BT_VELAS} por símbolo — menos si el símbolo es más nuevo). Primera vela de cada ` +
      'racha por símbolo; entrada a la apertura de la vela siguiente, salida al cierre N velas después; exceso ' +
      `vs. BTCUSDT en la misma ventana (por fecha calendario); base = una muestra cada ${BT_STRIDE} velas del ` +
      'mismo universo. Corre 100% en tu navegador: es el resultado de ESTA sesión, no se guarda entre visitas.',
    advertencias: [
      `Universo acotado: top ${BT_UNIVERSO_N} perpetuos USDT por volumen de 24h + BTCUSDT (benchmark, excluido ` +
        'del universo evaluado) — no es todo el mercado cripto.',
      `Ventana de hasta ${BT_VELAS} velas diarias (~${añosVentana} años); muchos perpetuos tienen bastante menos ` +
        'historial en Binance Futures (se usa lo que haya disponible; ver la ventana real de cada símbolo).',
      'BTCUSDT se usa como benchmark porque no hay un "SPY" para cripto — no es necesariamente un buen proxy de ' +
        '"el mercado" para altcoins de baja correlación con BTC.',
      'El intervalo de confianza (bootstrap, 95%) es de la MEDIANA del exceso vs. BTCUSDT, no del hit-rate; con ' +
        'menos de 30 observaciones no se calcula.',
      `${omitidos} símbolo(s) omitidos en la descarga (velas fallidas o sin historial suficiente).`,
      'Resultado de ESTA sesión del navegador (sessionStorage): no se persiste entre visitas ni se compara contra ' +
        'corridas anteriores — para repetirlo hay que volver a correrlo.',
    ],
    stats: { figuras_chartistas: stats },
  }
}
