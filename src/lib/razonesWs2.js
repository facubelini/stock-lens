// Por qué un ticker puntúa como puntúa en el Warren Score 2: pros y contras con
// los puntos de cada componente, armados SOLO con números reales de la fila de
// warren_score2.json (si un dato falta, esa línea no aparece). Misma idea que
// ProsContras del Crypto Screener.
//
// Los topes de cada componente y las zonas ideales son los de
// scripts/pipeline/warren2.py — si se toca algo allá, tocarlo acá.

import { fmtNum } from './formato'

const MAX = { rs: 33, aceleracion: 11, tendencia: 17, profundidad: 22, rsi: 11, extension: 6 }
// Un componente se lista como "a vigilar" si dejó sin sumar más de esta
// fracción de su tope.
const FRACCION_PERDIDA = 0.5

const pts = (v) => (v == null ? null : Number(v))
const f1 = (v) => fmtNum(v, 1)
const signo = (v) => `${v > 0 ? '+' : ''}${fmtNum(v, 1)}`

function lineaProfundidad(d52) {
  if (d52 == null) return null
  if (d52 > -3) return `Está en máximos de 52 semanas (${signo(d52)}%): WS2 no premia comprar en el techo.`
  if (d52 > -8) return `Cerca del máximo de 52 semanas (${signo(d52)}%): todavía poco retroceso (la zona ideal es −8% a −25%).`
  if (d52 < -40) return `Muy lejos del máximo de 52 semanas (${signo(d52)}%): retroceso demasiado profundo (zona ideal −8% a −25%).`
  if (d52 < -25) return `Retroceso profundo desde el máximo de 52 semanas (${signo(d52)}%; zona ideal −8% a −25%).`
  return `Retrocedió ${f1(Math.abs(d52))}% desde su máximo de 52 semanas: dentro de la zona ideal (−8% a −25%).`
}

function lineaRsi(rsi) {
  if (rsi == null) return null
  if (rsi > 55) return `RSI ${f1(rsi)}: ya tiene mucho recorrido (la zona sana es 35-55)${rsi > 80 ? ' y está en sobrecompra' : ''}.`
  if (rsi < 35) return `RSI ${f1(rsi)}: muy debilitado (la zona sana es 35-55).`
  return `RSI ${f1(rsi)}: zona sana, sin sobrecompra (35-55).`
}

function lineaExtension(d50) {
  if (d50 == null) return null
  if (d50 > 1.5) return `Extendido: ${f1(d50)} ATR sobre su media de 50 ruedas (zona ideal −2 a +1,5).`
  if (d50 < -2) return `Muy por debajo de su media de 50 ruedas (${f1(d50)} ATR; zona ideal −2 a +1,5).`
  return `Cerca de su media de 50 ruedas (${f1(d50)} ATR): sin extensión.`
}

/**
 * { pros, contras, neutros } — cada ítem { puntos, max, texto }. Los pros son
 * componentes que sumaron más de la mitad de su tope; los contras, los que
 * dejaron sin sumar más de la mitad, más las penalizaciones y los topes
 * aplicados. Ordenados por puntos (pros) y por lo que quedó sin sumar (contras).
 */
export function razonesWs2(fila) {
  const lid = fila?.pilares?.liderazgo
  const ten = fila?.pilares?.tendencia
  const tim = fila?.pilares?.timing
  if (!lid || !ten || !tim) return { pros: [], contras: [], neutros: [] }

  const rs = lid.rs
  const rsMes = lid.rs_mes_ant
  const componentes = [
    {
      clave: 'rs',
      puntos: pts(lid.pts_rs),
      max: MAX.rs,
      chip: rs == null ? null : `RS ${fmtNum(rs, 0)}`,
      texto:
        rs == null
          ? null
          : `Fuerza relativa: RS ${f1(rs)} (percentil vs el universo USD; 50 = 0 puntos, 95 = tope).`,
    },
    {
      clave: 'aceleracion',
      puntos: pts(lid.pts_aceleracion),
      max: MAX.aceleracion,
      chip: rs == null || rsMes == null ? null : `RS ${signo(rs - rsMes)} en 1 mes`,
      texto:
        rs == null || rsMes == null
          ? null
          : rs - rsMes > 0
            ? `Su RS pasó de ${f1(rsMes)} a ${f1(rs)} en el último mes (${signo(rs - rsMes)}).`
            : `Su RS no mejoró en el último mes (${f1(rsMes)} → ${f1(rs)}).`,
    },
    {
      clave: 'tendencia',
      puntos: pts(ten.pts),
      max: MAX.tendencia,
      chip: 'EMA200 subiendo',
      texto:
        ten.pendiente_ema200 == null
          ? null
          : ten.pendiente_ema200 > 0
            ? `Tendencia: la EMA200 sube ${fmtNum(ten.pendiente_ema200, 3)}% por día (0,15% = tope).`
            : `Tendencia: la EMA200 no está subiendo (${fmtNum(ten.pendiente_ema200, 3)}% por día).`,
    },
    { clave: 'profundidad', puntos: pts(tim.pts_profundidad), max: MAX.profundidad, chip: tim.dist_max52_pct == null ? null : `${signo(tim.dist_max52_pct)}% del máx`, texto: lineaProfundidad(tim.dist_max52_pct) },
    { clave: 'rsi', puntos: pts(tim.pts_rsi), max: MAX.rsi, chip: tim.rsi == null ? null : `RSI ${fmtNum(tim.rsi, 0)}`, texto: lineaRsi(tim.rsi) },
    { clave: 'extension', puntos: pts(tim.pts_extension), max: MAX.extension, chip: 'sin extensión', texto: lineaExtension(tim.dist_sma50_atr) },
  ].filter((c) => c.puntos != null && c.texto)

  const pros = componentes
    .filter((c) => c.puntos > c.max * FRACCION_PERDIDA)
    .sort((a, b) => b.puntos - a.puntos)
    .map(({ puntos, max, texto, chip }) => ({ puntos, max, texto, chip }))

  const contras = componentes
    .filter((c) => c.puntos <= c.max * FRACCION_PERDIDA)
    .sort((a, b) => b.max - b.puntos - (a.max - a.puntos))
    .map(({ puntos, max, texto, chip }) => ({ puntos, max, texto, chip }))

  for (const fl of fila.penalizacion?.flags ?? []) {
    contras.push({ puntos: pts(fl.pts) ?? 0, max: null, texto: `${fl.emoji ?? ''} ${fl.detalle ?? fl.clave}`.trim() })
  }
  const TEXTO_CAP = {
    gate_ema200: 'Precio bajo la EMA200 (o sin 52 semanas): el score queda topeado en 44.',
    extendido: 'Extensión > 8 ATR sobre la SMA50 o RSI > 80: el score queda topeado en 66.',
  }
  for (const c of fila.caps ?? []) contras.push({ puntos: null, max: null, texto: TEXTO_CAP[c] ?? c })

  return { pros, contras }
}

/** Chips cortos para la tabla: los 3 componentes que más puntos aportaron. */
export function chipsRazones(fila) {
  const { pros } = razonesWs2(fila)
  return pros.slice(0, 3).map((p) => p.chip).filter(Boolean)
}
