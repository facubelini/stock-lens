// Score compuesto 0-100 (ORIENTATIVO, no es recomendación de inversión).
// Combina tres dimensiones cuando hay datos:
//   - Tendencia (40%): precio respecto a sus medias largas (sobre la media = alcista).
//   - Momentum (30%): RSI; mejor en zona sana (~55), penaliza extremos.
//   - Valuación (30%): PER y PEG bajos suman.
// Si falta alguna dimensión, se reparte el peso entre las disponibles.

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x))
}

export function calcularScore(d) {
  const partes = []

  if (d.dist_sma200 != null || d.dist_ema50 != null) {
    const s200 = d.dist_sma200 ?? 0
    const e50 = d.dist_ema50 ?? 0
    const bruto = clamp(s200, -30, 30) + clamp(e50, -20, 20) // rango aprox -50..50
    partes.push({ k: 'Tendencia', v: clamp((bruto + 50) / 100 * 100, 0, 100), w: 0.4 })
  }

  if (d.rsi != null) {
    // Centro saludable levemente alcista en ~55; penaliza alejarse.
    partes.push({ k: 'Momentum', v: clamp(100 - Math.abs(d.rsi - 55) * 2.2, 0, 100), w: 0.3 })
  }

  const vals = []
  if (d.per_trailing != null && d.per_trailing > 0) {
    vals.push(clamp(100 - (d.per_trailing - 10) * 3, 0, 100))
  }
  if (d.peg != null && d.peg > 0) {
    vals.push(clamp(100 - (d.peg - 1) * 50, 0, 100))
  }
  if (vals.length) {
    partes.push({ k: 'Valuación', v: vals.reduce((a, b) => a + b, 0) / vals.length, w: 0.3 })
  }

  if (!partes.length) return null
  const wsum = partes.reduce((a, p) => a + p.w, 0)
  const score = Math.round(partes.reduce((a, p) => a + p.v * p.w, 0) / wsum)
  return { score, partes: partes.map((p) => ({ ...p, v: Math.round(p.v) })) }
}

export function nivelScore(score) {
  if (score == null) return { txt: 'N/D', color: '#7d8b9c' }
  if (score >= 66) return { txt: 'Favorable', color: '#22c55e' }
  if (score >= 40) return { txt: 'Neutral', color: '#f5a524' }
  return { txt: 'Flojo', color: '#ef4444' }
}
