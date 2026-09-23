import ComoSeCalcula, { Formula } from './ComoSeCalcula'
import { CORTES_SCORE } from '../lib/score'
import { PESO_VERDICT, PESO_TF, desgloseConviccion } from '../lib/screenerEstilos'
import { RATIOS_VALOR } from '../lib/valuacion'

// Bloques "¿Cómo se calcula?" reusados en varias pestañas. El texto sale de
// las mismas constantes que usa el cálculo (score.js, screenerEstilos.js,
// valuacion.js) para que no se desincronice si se toca un peso.

export function ExplicacionScore({ className }) {
  return (
    <ComoSeCalcula titulo="¿Cómo se calcula el Score?" className={className}>
      <p>
        Promedio ponderado de 3 partes (cada una 0-100). Si falta una, su peso se reparte entre las
        disponibles: <Formula>score = Σ(parte × peso) / Σ(pesos disponibles)</Formula>.
      </p>
      <p>
        <b className="text-terminal-text">Tendencia (40%)</b>:{' '}
        <Formula>(clamp(dist. SMA200, ±30) + clamp(dist. EMA50, ±20) + 50)</Formula> → 0 si está
        30%/20% o más por debajo de ambas medias, 100 si está igual de arriba.
      </p>
      <p>
        <b className="text-terminal-text">Momentum (30%)</b>: <Formula>100 − |RSI − 55| × 2,2</Formula>{' '}
        → máximo con RSI 55; RSI 30 u 80 dan 45.
      </p>
      <p>
        <b className="text-terminal-text">Valuación (30%)</b>: promedio de{' '}
        <Formula>100 − (PER − 10) × 3</Formula> y <Formula>100 − (PEG − 1) × 50</Formula> (cada uno
        entre 0 y 100; PER o PEG ≤ 0 no se usan).
      </p>
      <p>
        Cortes: <b style={{ color: '#22c55e' }}>≥{CORTES_SCORE.favorable} Favorable</b> ·{' '}
        <b style={{ color: '#f5a524' }}>≥{CORTES_SCORE.neutral} Neutral</b> ·{' '}
        <b style={{ color: '#ef4444' }}>&lt;{CORTES_SCORE.neutral} Flojo</b>. El desglose con los
        números de cada ticker está en su vista de detalle (click en el ticker) y en el tooltip del
        semáforo.
      </p>
    </ComoSeCalcula>
  )
}

export function ExplicacionConviccion({ fila, className }) {
  const d = fila ? desgloseConviccion(fila) : null
  return (
    <ComoSeCalcula titulo="¿Cómo se calcula la convicción (Conv.)?" className={className}>
      <p>
        <Formula>Conv. = Σ peso(veredicto) × peso(temporalidad)</Formula> sobre Diario, Semanal y
        Mensual del Screener técnico.
      </p>
      <p>
        Veredicto:{' '}
        {Object.entries(PESO_VERDICT)
          .map(([v, p]) => `${v} ${p > 0 ? '+' : ''}${String(p).replace('.', ',')}`)
          .join(' · ')}
        . Temporalidad:{' '}
        {Object.entries(PESO_TF)
          .map(([tf, p]) => `${tf} ×${String(p).replace('.', ',')}`)
          .join(' · ')}{' '}
        (una señal de más largo plazo pesa más que un rebote de un día).
      </p>
      <p>
        Rango posible: de −9,0 (VENTA en las 3) a +12,0 (COMPRA en las 3). Positivo = sesgo
        alcista, negativo = bajista.
      </p>
      {d && (
        <p>
          Este ticker:{' '}
          <Formula>
            {d.terminos
              .map((t) => `${t.verdict ?? 'N/D'} ${String(t.pesoVerdict).replace('.', ',')}×${String(t.pesoTf).replace('.', ',')}`)
              .join(' + ')}{' '}
            = {d.total.toFixed(1).replace('.', ',')}
          </Formula>
        </p>
      )}
    </ComoSeCalcula>
  )
}

export function ExplicacionDescuento({ className }) {
  return (
    <ComoSeCalcula titulo="¿Cómo se calcula el descuento vs. industria?" className={className}>
      <p>
        Para cada ratio de valuación ({RATIOS_VALOR.map((k) => ({ per_trailing: 'PER', ev_sales: 'EV/Sales', ps: 'P/S' })[k] ?? k).join(', ')}):{' '}
        <Formula>descuento = (mediana industria − valor) / mediana × 100</Formula>. Se promedian solo
        los ratios disponibles; un ratio ≤ 0 (pérdidas) o sin dato, propio o de la mediana, queda
        afuera en vez de contar como cero.
      </p>
      <p>
        Positivo = cotiza más barato que la mediana de sus comparables curados (pestaña
        Comparables), negativo = más caro. <b className="text-terminal-text">Calidad</b>: ROE y
        margen neto por encima de la mediana de la industria. <b className="text-terminal-text">⚠️
        trampa de valor</b>: ROE o margen negativos, o insiders solo vendiendo en 6 meses.
      </p>
    </ComoSeCalcula>
  )
}
