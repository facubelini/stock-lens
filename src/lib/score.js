// Score compuesto 0-100 (ORIENTATIVO, no es recomendación de inversión).
// Combina tres dimensiones cuando hay datos:
//   - Tendencia (40%): precio respecto a sus medias largas (sobre la media = alcista).
//   - Momentum (30%): RSI; mejor en zona sana (~55), penaliza extremos.
//   - Valuación (30%): PER y PEG bajos suman.
// Si falta alguna dimensión, se reparte el peso entre las disponibles.
// Cada parte trae `calculo` (texto con los números reales) para mostrar en la
// UI la fórmula aplicada, no solo el resultado.

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x))
}

const f1 = (v) => (Math.round(v * 10) / 10).toLocaleString('es-AR')

export const CORTES_SCORE = { favorable: 66, neutral: 40 }

export function calcularScore(d) {
  const partes = []

  if (d.dist_sma200 != null || d.dist_ema50 != null) {
    const s200 = d.dist_sma200 ?? 0
    const e50 = d.dist_ema50 ?? 0
    const c200 = clamp(s200, -30, 30)
    const c50 = clamp(e50, -20, 20)
    const bruto = c200 + c50 // rango -50..50
    const v = clamp(((bruto + 50) / 100) * 100, 0, 100)
    partes.push({
      k: 'Tendencia',
      v,
      w: 0.4,
      calculo:
        `dist. SMA200 ${f1(s200)}% (tope ±30 → ${f1(c200)}) + dist. EMA50 ${f1(e50)}% (tope ±20 → ${f1(c50)})` +
        ` = ${f1(bruto)}; (${f1(bruto)} + 50) → ${f1(v)}/100` +
        (d.dist_sma200 == null || d.dist_ema50 == null ? ' (la media faltante cuenta como 0)' : ''),
    })
  }

  if (d.rsi != null) {
    // Centro saludable levemente alcista en ~55; penaliza alejarse.
    const v = clamp(100 - Math.abs(d.rsi - 55) * 2.2, 0, 100)
    partes.push({
      k: 'Momentum',
      v,
      w: 0.3,
      calculo: `100 − |RSI ${f1(d.rsi)} − 55| × 2,2 = ${f1(v)}`,
    })
  }

  const vals = []
  const textos = []
  if (d.per_trailing != null && d.per_trailing > 0) {
    const v = clamp(100 - (d.per_trailing - 10) * 3, 0, 100)
    vals.push(v)
    textos.push(`PER: 100 − (${f1(d.per_trailing)} − 10) × 3 = ${f1(v)}`)
  }
  if (d.peg != null && d.peg > 0) {
    const v = clamp(100 - (d.peg - 1) * 50, 0, 100)
    vals.push(v)
    textos.push(`PEG: 100 − (${f1(d.peg)} − 1) × 50 = ${f1(v)}`)
  }
  if (vals.length) {
    const v = vals.reduce((a, b) => a + b, 0) / vals.length
    partes.push({
      k: 'Valuación',
      v,
      w: 0.3,
      calculo: `${textos.join(' · ')}${vals.length > 1 ? ` → promedio ${f1(v)}` : ''} (PER/PEG ≤ 0 no cuentan)`,
    })
  }

  if (!partes.length) return null
  const wsum = partes.reduce((a, p) => a + p.w, 0)
  const score = Math.round(partes.reduce((a, p) => a + p.v * p.w, 0) / wsum)
  return {
    score,
    // peso efectivo = peso nominal re-normalizado entre las partes disponibles
    partes: partes.map((p) => ({ ...p, v: Math.round(p.v), wEfectivo: p.w / wsum })),
  }
}

export function nivelScore(score) {
  if (score == null) return { txt: 'N/D', color: '#7d8b9c' }
  if (score >= CORTES_SCORE.favorable) return { txt: 'Favorable', color: '#22c55e' }
  if (score >= CORTES_SCORE.neutral) return { txt: 'Neutral', color: '#f5a524' }
  return { txt: 'Flojo', color: '#ef4444' }
}
