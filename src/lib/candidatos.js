// Embudo "Candidatos de compra": combina Rotación (RRG), Warren Score,
// Señales (VCP / EMA200 / RSI semanal), Screener técnico y una revisión
// fundamental básica (trampa de valor + percentil histórico), todo ya
// publicado por el pipeline — no agrega ningún cálculo nuevo, solo cruza y
// filtra lo que cada pantalla ya muestra por separado.
//
// Cada etapa es un filtro EXPLÍCITO (se puede leer qué saca a quién) y el
// resultado final trae, por ticker, los positivos y negativos armados a
// partir de números reales (nunca un texto inventado): si un dato no está
// disponible, esa línea simplemente no aparece.
//
// OJO — esto no es un modelo nuevo con evidencia propia: es una combinación
// de reglas sobre señales que YA se midieron por separado (ver los badges de
// evidencia en Señales y Warren Score). Pasar el embudo entero no garantiza
// nada — reduce el universo a los que alinean varias cosas a la vez, que es
// lo que la propia evidencia sugiere que conviene exigir.

import { fmtNum } from './formato'
import { TIMEFRAMES, tieneSenal } from './screenerEstilos'
import { calcularDescuento, evaluarCalidad, señalesTrampaValor } from './valuacion'

export const VCP_ESTADOS_GATILLO = new Set(['Armado', 'Recién rompió', 'Rompió y confirmó'])
// 🩸 y ⛔ siempre se sacan del todo (son las dos banderas mas graves); en modo
// estricto se suman las de agotamiento/sobreextension.
export const FLAGS_EXCLUYENTES_BASE = new Set(['distribucion', 'breakout_fallido'])
export const FLAGS_EXCLUYENTES_ESTRICTO = new Set(['sobreextension', 'reversion_volumen', 'churning', 'divergencia_rsi', 'divergencia_obv'])
export const RATIOS_CAROS = { pe: 'P/E', ps: 'P/S', ev_sales: 'EV/Sales', ev_ebitda: 'EV/EBITDA', p_fcf: 'P/FCF', pb: 'P/B' }
export const PERCENTIL_CARO = 80
export const PERCENTIL_BARATO = 25

// "Escenario ideal": los valores con los que se armo y probo el embudo la
// primera vez. Es lo que ve el usuario por defecto en la pantalla; el panel
// de parametros permite aflojar o endurecer cada corte para explorar que
// aparece (o deja de aparecer) al mover cada perilla.
export const FILTROS_DEFAULT = {
  umbralFuerza: 0.6, // fraccion del maximo del pilar Fuerza RS
  umbralContraccion: 0.5, // idem Contraccion (mas ruidoso: umbral mas bajo)
  cuadrante: 'liderando', // 'liderando' | 'liderando_recuperando' | 'cualquiera'
  ema200DiarioMaxHace: 10, // ruedas
  ema200SemanalMaxHace: 4, // semanas
  minTemporalidadesScreener: 2, // 1, 2 o 3
  exigirSinVenta: true, // ninguna temporalidad del Screener en VENTA
  modoEstricto: false, // tambien excluye banderas de agotamiento, no solo 🩸/⛔
}

const CUADRANTES = {
  liderando: 'Liderando',
  debilitando: 'Debilitando',
  recuperando: 'Recuperando',
  rezagando: 'Rezagando',
}

function porTicker(arr, clave = 'ticker') {
  const m = new Map()
  for (const r of arr ?? []) if (r?.[clave]) m.set(r[clave], r)
  return m
}

function comoSet(arr) {
  return new Set((arr ?? []).map((x) => (typeof x === 'string' ? x : x?.ticker)).filter(Boolean))
}

// --- Etapas del embudo, cada una recibe el resultado de la anterior -------

function pasaGateTendencia(w) {
  return !(w.caps ?? []).some((c) => c === 'gate_ema200' || c === 'sin_52w')
}

function pasaPilares(w, filtros, flagsExcluyentes) {
  const f = w.pilares?.fuerza
  const c = w.pilares?.contraccion
  if (!f || !c || !f.max || !c.max) return false
  const tieneFlagExcluyente = (w.penalizacion?.flags ?? []).some((fl) => flagsExcluyentes.has(fl.clave))
  if (tieneFlagExcluyente) return false
  return f.pts / f.max >= filtros.umbralFuerza && c.pts / c.max >= filtros.umbralContraccion
}

function pasaRotacion(ticker, rotacionPorTicker, recienALideres, aceleracionInusual, filtros) {
  if (filtros.cuadrante === 'cualquiera') return true
  if (recienALideres.has(ticker) || aceleracionInusual.has(ticker)) return true
  const cuadrante = rotacionPorTicker.get(ticker)?.cuadrante
  if (filtros.cuadrante === 'liderando_recuperando') return cuadrante === 'liderando' || cuadrante === 'recuperando'
  return cuadrante === 'liderando'
}

function gatillos(ticker, ctx, filtros) {
  const salida = []
  const vcp = ctx.vcpPorTicker.get(ticker)
  if (vcp && VCP_ESTADOS_GATILLO.has(vcp.estado)) salida.push('vcp')
  const ed = ctx.senales.ema200?.diario ?? {}
  const es = ctx.senales.ema200?.semanal ?? {}
  const rebDiario = (ed.rebote ?? []).find((r) => r.ticker === ticker && r.hace <= filtros.ema200DiarioMaxHace)
  const cruceDiario = (ed.cruce ?? []).find((r) => r.ticker === ticker && r.hace <= filtros.ema200DiarioMaxHace)
  const rebSemanal = (es.rebote ?? []).find((r) => r.ticker === ticker && r.hace <= filtros.ema200SemanalMaxHace)
  const cruceSemanal = (es.cruce ?? []).find((r) => r.ticker === ticker && r.hace <= filtros.ema200SemanalMaxHace)
  if (rebDiario || cruceDiario || rebSemanal || cruceSemanal) salida.push('ema200')
  const rsiAlcista = (ctx.senales.rsi_semanal?.alcista ?? []).find((r) => r.ticker === ticker)
  if (rsiAlcista) salida.push('rsi_semanal')
  return salida
}

function pasaScreener(fila, filtros) {
  if (!fila) return false
  const conSenal = TIMEFRAMES.filter(({ key }) => tieneSenal(fila[key])).length
  const conVenta = TIMEFRAMES.some(({ key }) => fila[key]?.verdict === 'VENTA')
  return conSenal >= filtros.minTemporalidadesScreener && (!filtros.exigirSinVenta || !conVenta)
}

// --- Positivos / negativos, texto armado con los numeros reales -----------

function etiquetaCuadrante(c) {
  return CUADRANTES[c] ?? c ?? '—'
}

function textosVcp(vcp) {
  if (!vcp) return { pos: null, neg: null }
  if (VCP_ESTADOS_GATILLO.has(vcp.estado)) {
    const vol = vcp.vol_decreciente ? ', con volumen decreciente en la última contracción' : ''
    return {
      pos: `Base VCP "${vcp.estado}": ${vcp.contracciones} contracción(es), a ${fmtNum(vcp.dist_pivote_pct, 1)}% del techo ($${fmtNum(vcp.pivote, 2)})${vol}.`,
      neg: null,
    }
  }
  return { pos: null, neg: `Base VCP en estado "${vcp.estado}": todavía no confirma un setup listo.` }
}

function textosEma200(ticker, senales) {
  const positivos = []
  const rebD = (senales.ema200?.diario?.rebote ?? []).find((r) => r.ticker === ticker)
  const cruD = (senales.ema200?.diario?.cruce ?? []).find((r) => r.ticker === ticker)
  const rebS = (senales.ema200?.semanal?.rebote ?? []).find((r) => r.ticker === ticker)
  const cruS = (senales.ema200?.semanal?.cruce ?? []).find((r) => r.ticker === ticker)
  if (rebS) {
    positivos.push(
      `Rebote en la EMA200 semanal hace ${rebS.hace} semana(s)${rebS.climax_ola ? ' con clímax fuerte 🌊' : ''} (×${fmtNum(rebS.climax_ratio, 1)} volumen), RS pasó de ${fmtNum(rebS.rs_contacto, 0)} a ${fmtNum(rebS.rs_hoy, 0)}.`
    )
  }
  if (cruS) {
    positivos.push(`Cruzó al alza su EMA200 semanal hace ${cruS.hace} semana(s), RS hoy ${fmtNum(cruS.rs_hoy, 0)}.`)
  }
  if (rebD) {
    positivos.push(
      `Rebote en la EMA200 diaria hace ${rebD.hace} rueda(s)${rebD.climax_ola ? ' con clímax fuerte 🌊' : ''} (×${fmtNum(rebD.climax_ratio, 1)} volumen).`
    )
  }
  if (cruD) positivos.push(`Cruzó al alza su EMA200 diaria hace ${cruD.hace} rueda(s).`)
  return positivos
}

function textoRsiSemanal(ticker, senales) {
  const r = (senales.rsi_semanal?.alcista ?? []).find((x) => x.ticker === ticker)
  if (!r) return null
  return `RSI semanal cruzó al alza su propia media (${fmtNum(r.rsi, 1)} vs ${fmtNum(r.sma14, 1)}), RS ${fmtNum(r.rs, 0)}.`
}

function textosScreener(fila) {
  const positivos = []
  const negativos = []
  const conSenal = TIMEFRAMES.filter(({ key }) => tieneSenal(fila[key]))
  if (conSenal.length) positivos.push(`Screener técnico alineado: ${conSenal.map((t) => t.label).join(' y ')} en COMPRA/CERCA.`)
  const extendido = TIMEFRAMES.filter(({ key }) => fila[key]?.verdict === 'EXTENDIDO')
  if (extendido.length) {
    negativos.push(`${extendido.map((t) => t.label).join(' y ')} extendido: puede necesitar un retroceso antes de seguir.`)
  }
  const neutral = TIMEFRAMES.filter(({ key }) => fila[key]?.verdict === 'NEUTRAL')
  if (neutral.length) negativos.push(`Sin confirmación en ${neutral.map((t) => t.label.toLowerCase()).join(' y ')} todavía.`)
  const diario = fila.diario
  if (diario?.rsi != null && diario.rsi > 70) negativos.push(`RSI diario en ${fmtNum(diario.rsi, 0)}: cerca de zona de sobrecompra.`)
  return { positivos, negativos }
}

function textosHistorico(indiceRow) {
  const positivos = []
  const negativos = []
  const per = indiceRow?.percentil_5y
  if (!per) return { positivos, negativos }
  const caros = Object.entries(RATIOS_CAROS).filter(([k]) => per[k] != null && per[k] >= PERCENTIL_CARO)
  const baratos = Object.entries(RATIOS_CAROS).filter(([k]) => per[k] != null && per[k] <= PERCENTIL_BARATO)
  if (caros.length) {
    negativos.push(`Cotiza caro vs. su propia historia de 5 años (${caros.map(([k, l]) => `${l} percentil ${per[k]}`).join(', ')}).`)
  }
  if (baratos.length) {
    positivos.push(`Barato vs. su propia historia de 5 años (${baratos.map(([k, l]) => `${l} percentil ${per[k]}`).join(', ')}).`)
  }
  return { positivos, negativos }
}

/**
 * Arma el embudo completo. Devuelve { embudo: [{clave,titulo,cantidad}],
 * candidatos: [...] } con los candidatos ya ordenados por puntaje desc.
 *
 * Args: los datos ya parseados de warren_score.json (.tickers), senales.json
 * (objeto completo), screener.json (array), rotacion.json (objeto completo,
 * puede faltar {}), comparables.json (array [{industria,pares,mediana}]) y
 * fundamentales.json (array) y fundamental/indice.json (array, opcional).
 * `filtros` (opcional): parametros del embudo, ver FILTROS_DEFAULT — lo que
 * no se pasa toma el valor por defecto (el "escenario ideal").
 */
export function armarCandidatos({
  warrenRows = [],
  senales = {},
  screenerRows = [],
  rotacion = {},
  comparablesRows = [],
  fundamentalesRows = [],
  fundamentalIndice = [],
  filtros = {},
} = {}) {
  const f = { ...FILTROS_DEFAULT, ...filtros }
  const flagsExcluyentes = f.modoEstricto ? new Set([...FLAGS_EXCLUYENTES_BASE, ...FLAGS_EXCLUYENTES_ESTRICTO]) : FLAGS_EXCLUYENTES_BASE
  const senalesSeguras = { ema200: {}, vcp: [], rsi_semanal: {}, ...senales }
  const vcpPorTicker = porTicker(senalesSeguras.vcp)
  const rotacionPorTicker = porTicker(rotacion.acciones)
  const recienALideres = comoSet(rotacion.recien_a_lideres)
  const aceleracionInusual = comoSet(rotacion.aceleracion_inusual)
  const screenerPorTicker = porTicker(screenerRows)
  const fundamentalesPorTicker = porTicker(fundamentalesRows)
  const indicePorTicker = porTicker(fundamentalIndice)
  const medianaPorIndustria = new Map((comparablesRows ?? []).map((g) => [g.industria, g.mediana]))

  const embudo = []
  const marcar = (clave, titulo, lista) => {
    embudo.push({ clave, titulo, cantidad: lista.length })
    return lista
  }

  const tituloRotacion =
    f.cuadrante === 'cualquiera'
      ? 'Rotación: sin filtro (cualquier cuadrante)'
      : f.cuadrante === 'liderando_recuperando'
        ? 'En Liderando o Recuperando (o recién llegando a Liderando) de la Rotación'
        : 'En el cuadrante Liderando (o recién llegando ahí) de la Rotación'
  const tituloScreener = `Screener técnico alineado (COMPRA/CERCA en ${f.minTemporalidadesScreener}+ temporalidad(es)${f.exigirSinVenta ? ', sin VENTA' : ''})`

  let etapa = marcar('universo', 'Con Warren Score calculado', warrenRows.filter((w) => w.datos_suficientes && w.total_score != null))
  etapa = marcar('gate', 'Pasan el gate de tendencia (precio sobre la EMA200)', etapa.filter(pasaGateTendencia))
  etapa = marcar(
    'pilares',
    `Fuerza RS y Contracción sólidos (≥${Math.round(f.umbralFuerza * 100)}%/${Math.round(f.umbralContraccion * 100)}% de su máximo)${f.modoEstricto ? ', sin ninguna bandera de alerta' : ', sin 🩸/⛔'}`,
    etapa.filter((w) => pasaPilares(w, f, flagsExcluyentes))
  )
  etapa = marcar('rotacion', tituloRotacion, etapa.filter((w) => pasaRotacion(w.ticker, rotacionPorTicker, recienALideres, aceleracionInusual, f)))
  const ctxGatillos = { vcpPorTicker, senales: senalesSeguras }
  const conGatillos = etapa
    .map((w) => ({ w, g: gatillos(w.ticker, ctxGatillos, f) }))
    .filter((x) => x.g.length > 0)
  etapa = marcar('gatillo', `Con al menos un gatillo técnico (VCP / EMA200 ≤${f.ema200DiarioMaxHace}r-${f.ema200SemanalMaxHace}s / RSI semanal)`, conGatillos.map((x) => x.w))
  etapa = marcar('screener', tituloScreener, etapa.filter((w) => pasaScreener(screenerPorTicker.get(w.ticker), f)))

  const candidatos = etapa.map((w) => {
    const ticker = w.ticker
    const rot = rotacionPorTicker.get(ticker)
    const vcp = vcpPorTicker.get(ticker)
    const screenerRow = screenerPorTicker.get(ticker)
    const fundRow = fundamentalesPorTicker.get(ticker)
    const indiceRow = indicePorTicker.get(ticker)
    const mediana = fundRow ? medianaPorIndustria.get(fundRow.industria) : null

    const positivos = []
    const negativos = []

    const p = w.pilares
    positivos.push(
      `Warren Score ${fmtNum(w.total_score, 1)}/100 (Stage ${w.stage?.n}: ${w.stage?.label}) — Fuerza RS ${fmtNum(p.fuerza.pts, 1)}/${p.fuerza.max}, Contracción ${fmtNum(p.contraccion.pts, 1)}/${p.contraccion.max}.`
    )

    if (rot) {
      if (recienALideres.has(ticker)) positivos.push('Recién entró al cuadrante Liderando esta semana (venía de Recuperando/Rezagando).')
      if (aceleracionInusual.has(ticker)) positivos.push('Aceleración inusual de fuerza relativa: varias semanas rezagado y arrancó a acelerar.')
      if (rot.cuadrante === 'liderando') {
        positivos.push(
          `Rotación: cuadrante Liderando, RS Score ${fmtNum(rot.rs_score, 0)}${rot.rs_score_semana_ant != null ? ` (semana pasada ${fmtNum(rot.rs_score_semana_ant, 0)})` : ''}.`
        )
      } else {
        negativos.push(`Rotación: cuadrante ${etiquetaCuadrante(rot.cuadrante)} — todavía no es de lleno Liderando.`)
      }
    }

    const { pos: vcpPos, neg: vcpNeg } = textosVcp(vcp)
    if (vcpPos) positivos.push(vcpPos)
    if (vcpNeg) negativos.push(vcpNeg)

    positivos.push(...textosEma200(ticker, senalesSeguras))
    const rsiTexto = textoRsiSemanal(ticker, senalesSeguras)
    if (rsiTexto) positivos.push(rsiTexto)

    if (screenerRow) {
      const { positivos: pS, negativos: nS } = textosScreener(screenerRow)
      positivos.push(...pS)
      negativos.push(...nS)
    }

    for (const flag of w.penalizacion?.flags ?? []) {
      if (!flagsExcluyentes.has(flag.clave)) negativos.push(`${flag.emoji} ${flag.detalle}`)
    }
    if (w.caps?.includes('rechazo_confirmado')) negativos.push('Vela de rechazo en máximos confirmada: el score quedó topeado en 70.')

    if (fundRow) {
      negativos.push(...señalesTrampaValor(fundRow))
      if (mediana) {
        const calidad = evaluarCalidad(fundRow, mediana)
        if (calidad?.roeOk && calidad?.margenOk) positivos.push('ROE y margen por encima de la mediana de su industria.')
        const descuento = calcularDescuento(fundRow, mediana)
        if (descuento != null && descuento > 0) positivos.push(`Cotiza ${fmtNum(descuento, 0)}% más barato que la mediana de su industria (PER/EV-Sales/P-S).`)
      }
    }

    if (indiceRow?.disponible) {
      const { positivos: pH, negativos: nH } = textosHistorico(indiceRow)
      positivos.push(...pH)
      negativos.push(...nH)
    }

    const nGatillos = gatillos(ticker, ctxGatillos, f).length
    const puntaje = w.total_score + nGatillos * 4 + (rot?.cuadrante === 'liderando' ? 5 : 0) + (recienALideres.has(ticker) || aceleracionInusual.has(ticker) ? 6 : 0)

    return {
      ticker,
      nombre: w.nombre,
      sector: w.sector,
      warrenScore: w.total_score,
      rank: w.rank,
      total: w.total,
      stage: w.stage,
      cuadrante: rot?.cuadrante ?? null,
      nGatillos,
      puntaje: Math.round(puntaje * 10) / 10,
      positivos,
      negativos,
    }
  })

  candidatos.sort((a, b) => b.puntaje - a.puntaje)
  return { embudo, candidatos }
}
