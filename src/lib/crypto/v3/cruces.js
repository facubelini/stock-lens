// Cruces de indicadores: el momento exacto en que una línea pasa por encima o
// por debajo de otra. Es lo que la mayoría usa como disparador de entrada.
//
// El score del v1 mira ESTADOS ("el RSI está en 85"); un cruce mira EVENTOS
// ("el RSI acaba de pasar su media"). Son cosas distintas y hay que medirlas
// por separado, que es para lo que existe este archivo.
//
// 'corto' es la etiqueta de la tabla: tiene que ser DISTINTA para cada tipo,
// porque varios cruces comparten grupo y dirección (por ejemplo el
// estocástico cruza en general y cruza en sobreventa) y con el nombre del
// grupo se veían dos insignias idénticas, como si fuera un error.
//
// Cada cruce declara su dirección: 1 = dispararía un LONG, -1 = un SHORT.
// Que la dirección sea la convencional NO significa que funcione: eso lo
// contesta la evidencia, no el nombre.

export const TIPOS_CRUCE = [
  { id: 'macd_up', corto: 'MACD↑', etiqueta: 'MACD cruza señal ↑', dir: 1, grupo: 'MACD' },
  { id: 'macd_down', corto: 'MACD↓', etiqueta: 'MACD cruza señal ↓', dir: -1, grupo: 'MACD' },
  { id: 'rsi_sma_up', corto: 'RSI×med↑', etiqueta: 'RSI cruza su media ↑', dir: 1, grupo: 'RSI' },
  { id: 'rsi_sma_down', corto: 'RSI×med↓', etiqueta: 'RSI cruza su media ↓', dir: -1, grupo: 'RSI' },
  { id: 'rsi_30_up', corto: 'RSI>30', etiqueta: 'RSI sale de sobreventa (>30)', dir: 1, grupo: 'RSI' },
  { id: 'rsi_70_down', corto: 'RSI<70', etiqueta: 'RSI sale de sobrecompra (<70)', dir: -1, grupo: 'RSI' },
  { id: 'rsi_50_up', corto: 'RSI×50↑', etiqueta: 'RSI cruza 50 ↑', dir: 1, grupo: 'RSI' },
  { id: 'rsi_50_down', corto: 'RSI×50↓', etiqueta: 'RSI cruza 50 ↓', dir: -1, grupo: 'RSI' },
  { id: 'estoc_up', corto: 'Estoc↑', etiqueta: 'Estocástico %K cruza %D ↑', dir: 1, grupo: 'Estocástico' },
  { id: 'estoc_down', corto: 'Estoc↓', etiqueta: 'Estocástico %K cruza %D ↓', dir: -1, grupo: 'Estocástico' },
  { id: 'estoc_up_sv', corto: 'Estoc↑sv', etiqueta: 'Estocástico ↑ en sobreventa (<20)', dir: 1, grupo: 'Estocástico' },
  { id: 'estoc_down_sc', corto: 'Estoc↓sc', etiqueta: 'Estocástico ↓ en sobrecompra (>80)', dir: -1, grupo: 'Estocástico' },
  { id: 'srsi_up', corto: 'sRSI↑', etiqueta: 'StochRSI %K cruza %D ↑', dir: 1, grupo: 'StochRSI' },
  { id: 'srsi_down', corto: 'sRSI↓', etiqueta: 'StochRSI %K cruza %D ↓', dir: -1, grupo: 'StochRSI' },
  { id: 'srsi_up_sv', corto: 'sRSI↑sv', etiqueta: 'StochRSI ↑ en sobreventa (<20)', dir: 1, grupo: 'StochRSI' },
  { id: 'srsi_down_sc', corto: 'sRSI↓sc', etiqueta: 'StochRSI ↓ en sobrecompra (>80)', dir: -1, grupo: 'StochRSI' },
]

export const CRUCE_POR_ID = new Map(TIPOS_CRUCE.map((c) => [c.id, c]))

// ¿La serie a cruzó a la serie b hacia arriba entre i-1 e i?
const cruzaArriba = (a, b, i) =>
  !isNaN(a[i]) && !isNaN(b[i]) && !isNaN(a[i - 1]) && !isNaN(b[i - 1]) && a[i - 1] <= b[i - 1] && a[i] > b[i]

const cruzaAbajo = (a, b, i) =>
  !isNaN(a[i]) && !isNaN(b[i]) && !isNaN(a[i - 1]) && !isNaN(b[i - 1]) && a[i - 1] >= b[i - 1] && a[i] < b[i]

const cruzaNivel = (a, nivel, i, arriba) =>
  !isNaN(a[i]) && !isNaN(a[i - 1]) && (arriba ? a[i - 1] <= nivel && a[i] > nivel : a[i - 1] >= nivel && a[i] < nivel)

// Devuelve los ids de los cruces que ocurrieron EN la vela i.
export function crucesEn(i, s) {
  if (i < 1) return []
  const out = []

  // MACD: el histograma es (línea MACD - señal), así que el cruce de las dos
  // líneas es exactamente el histograma pasando por cero.
  const h = s.macdCur
  if (!isNaN(h[i]) && !isNaN(h[i - 1])) {
    if (h[i - 1] <= 0 && h[i] > 0) out.push('macd_up')
    if (h[i - 1] >= 0 && h[i] < 0) out.push('macd_down')
  }

  if (cruzaArriba(s.rsi, s.rsiSma, i)) out.push('rsi_sma_up')
  if (cruzaAbajo(s.rsi, s.rsiSma, i)) out.push('rsi_sma_down')
  if (cruzaNivel(s.rsi, 30, i, true)) out.push('rsi_30_up')
  if (cruzaNivel(s.rsi, 70, i, false)) out.push('rsi_70_down')
  if (cruzaNivel(s.rsi, 50, i, true)) out.push('rsi_50_up')
  if (cruzaNivel(s.rsi, 50, i, false)) out.push('rsi_50_down')

  const eUp = cruzaArriba(s.estK, s.estD, i)
  const eDown = cruzaAbajo(s.estK, s.estD, i)
  if (eUp) out.push('estoc_up')
  if (eDown) out.push('estoc_down')
  // La variante "clásica": el cruce vale solo si pasa en zona extrema.
  if (eUp && s.estK[i - 1] < 20) out.push('estoc_up_sv')
  if (eDown && s.estK[i - 1] > 80) out.push('estoc_down_sc')

  const sUp = cruzaArriba(s.srsi, s.srsiD, i)
  const sDown = cruzaAbajo(s.srsi, s.srsiD, i)
  if (sUp) out.push('srsi_up')
  if (sDown) out.push('srsi_down')
  if (sUp && s.srsi[i - 1] < 20) out.push('srsi_up_sv')
  if (sDown && s.srsi[i - 1] > 80) out.push('srsi_down_sc')

  return out
}
