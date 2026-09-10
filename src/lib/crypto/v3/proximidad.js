// Estado de cada indicador respecto de su cruce: ya cruzó, está cruzando
// ahora mismo (sin confirmar), o le falta poco.
//
// DECISIÓN IMPORTANTE: este módulo trabaja con la vela EN CURSO incluida,
// porque para "está por cruzar" no sirve mirar la vela cerrada — el cruce que
// te interesa es el que está pasando ahora. El precio de eso es que un cruce
// en curso PUEDE DESHACERSE antes de que la vela cierre. Por eso se
// distinguen dos estados y nunca se mezclan:
//
//   CONFIRMADO  el cruce ocurrió en una vela ya cerrada. No cambia más.
//   EN CURSO    con la vela abierta las líneas están cruzadas, pero todavía
//               puede volverse atrás. Es una alerta, no un hecho.
//
// Los cinco indicadores se reducen a la misma forma: dos líneas, y el cruce
// es la diferencia entre ellas pasando por cero.

export const INDICADORES = [
  { id: 'macd', nombre: 'MACD', rapida: 'macdLinea', lenta: 'macdSenal', gapDirecto: 'macdCur' },
  { id: 'rsi', nombre: 'RSI', rapida: 'rsi', lenta: 'rsiSma' },
  { id: 'estoc', nombre: 'Estocástico', rapida: 'estK', lenta: 'estD' },
  { id: 'srsi', nombre: 'StochRSI', rapida: 'srsi', lenta: 'srsiD' },
  { id: 'smi', nombre: 'SMI', rapida: 'smi', lenta: 'smiSenal' },
]

// Cuántas velas hacia atrás se promedia |gap| para saber si el gap actual es
// grande o chico PARA ESE indicador. Sin esto no se puede comparar un gap de
// MACD (unidades de precio) con uno de RSI (puntos).
const VENTANA_ESCALA = 50

// Un gap por debajo de esta fracción de su escala típica cuenta como "pegado".
const UMBRAL_PEGADO = 0.15

// Velas estimadas hasta el cruce para que cuente como "cerca".
const VELAS_CERCA = 3

function gapEn(s, ind, i) {
  if (ind.gapDirecto) return s[ind.gapDirecto][i]
  const a = s[ind.rapida][i]
  const b = s[ind.lenta][i]
  return isNaN(a) || isNaN(b) ? NaN : a - b
}

// Estado de un indicador en el índice i (que debe ser la última vela, en
// curso). iCerrada es el índice de la última vela CERRADA.
export function estadoIndicador(s, ind, i, iCerrada) {
  const gap = gapEn(s, ind, i)
  const gapAnt = gapEn(s, ind, i - 1)
  if (isNaN(gap) || isNaN(gapAnt)) return { id: ind.id, estado: 'sin-datos' }

  // Escala típica del gap, para poder decir "está pegado" con sentido.
  let suma = 0
  let n = 0
  for (let j = Math.max(1, i - VENTANA_ESCALA + 1); j <= i; j++) {
    const g = gapEn(s, ind, j)
    if (!isNaN(g)) {
      suma += Math.abs(g)
      n++
    }
  }
  const escala = n ? suma / n : NaN
  const gapRel = escala > 0 ? Math.abs(gap) / escala : NaN

  // ¿Cruzó en la última vela CERRADA? Eso es lo confirmado.
  const gapCerr = gapEn(s, ind, iCerrada)
  const gapCerrAnt = gapEn(s, ind, iCerrada - 1)
  const cruceConfirmado =
    !isNaN(gapCerr) && !isNaN(gapCerrAnt) && Math.sign(gapCerr) !== Math.sign(gapCerrAnt) && gapCerr !== 0
      ? gapCerr > 0
        ? 1
        : -1
      : 0

  // ¿Está cruzado ahora respecto de la vela cerrada anterior? Eso es el cruce
  // en curso: pasó con la vela abierta y todavía puede deshacerse.
  const cruceEnCurso =
    !cruceConfirmado && !isNaN(gapCerr) && Math.sign(gap) !== Math.sign(gapCerr) && gap !== 0
      ? gap > 0
        ? 1
        : -1
      : 0

  // Convergencia: el gap se está achicando hacia cero.
  const velocidad = gap - gapAnt
  const convergiendo = Math.sign(velocidad) !== Math.sign(gap) && velocidad !== 0
  const velas = convergiendo ? Math.abs(gap) / Math.abs(velocidad) : Infinity

  let estado = 'lejos'
  let dir = 0
  if (cruceConfirmado) {
    // Un cruce confirmado en la vela cerrada puede estar YA DESHECHO en la
    // vela en curso: cruzó hacia abajo y el precio de ahora lo devolvió
    // arriba. Como toda esta pestaña trabaja con el precio actual, contarlo
    // con el peso máximo (x2) sería mirar para el lado equivocado.
    //
    // No es un caso raro. Medido sobre 120 perpetuos en 4h: de 104 cruces
    // confirmados, 22 estaban revertidos = 21,2%. Por indicador el
    // Estocástico es el peor con 42%, después RSI 27%, StochRSI y SMI 8%,
    // MACD 0%. Casi la mitad de los cruces del Estocástico se deshacen.
    //
    // 'revertido' no tiene peso en PESO_ESTADO, así que suma 0 y tampoco
    // cuenta como dirección. Se muestra igual, porque saber que cruzó y
    // volvió es información, no ruido.
    const revertido = Math.sign(gap) !== 0 && Math.sign(gap) !== cruceConfirmado
    estado = revertido ? 'revertido' : 'confirmado'
    dir = cruceConfirmado
  } else if (cruceEnCurso) {
    estado = 'en-curso'
    dir = cruceEnCurso
  } else if (convergiendo && (velas <= VELAS_CERCA || gapRel < UMBRAL_PEGADO)) {
    estado = 'cerca'
    // Si cruza, cruza hacia el lado opuesto al gap actual.
    dir = gap > 0 ? -1 : 1
  }

  return {
    id: ind.id,
    estado,
    dir,
    gap,
    gapRel: isNaN(gapRel) ? null : +gapRel.toFixed(2),
    velas: velas === Infinity ? null : +velas.toFixed(1),
    convergiendo,
    rapida: ind.gapDirecto ? gap : s[ind.rapida][i],
    lenta: ind.gapDirecto ? 0 : s[ind.lenta][i],
  }
}

// Estado de los cinco indicadores para un símbolo.
export function estadoDeTodos(s) {
  const i = s.n - 1 // última vela: la EN CURSO
  const iCerrada = s.n - 2
  if (i < 2) return null
  const out = {}
  for (const ind of INDICADORES) out[ind.id] = estadoIndicador(s, ind, i, iCerrada)
  return out
}
