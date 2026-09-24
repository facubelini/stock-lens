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

// Warren Score (modelo tipo "Warren Bife Dashboard" v4.9). Mismos umbrales
// que scripts/pipeline/warren.py (ws_calcular_ticker / ws_pilar_fuerza /
// ws_penalizaciones / calcular_warren_score): si se toca uno alla, tocarlo aca.
export function ExplicacionWarrenScore({ className }) {
  return (
    <ComoSeCalcula titulo="¿Cómo se calcula el Warren Score?" className={className}>
      <p>
        <Formula>score = clamp(A + B + C + D + penalizaciones, 0, 100)</Formula> y después los topes
        (caps). Es técnico/cuantitativo: no mira PER, ingresos ni deuda. Solo los tickers en USD
        entran (la fuerza relativa se mide contra SPY).
      </p>
      <p>
        Funciones: <Formula>tri(x, a, b, c, d)</Formula> = trapecio (0 hasta a, sube a 1 en b, 1
        entre b y c, baja a 0 en d); <Formula>lineal(x, x0, x1, y0, y1)</Formula> = recta recortada
        a [y0, y1]. <Formula>ATR14%</Formula> = ATR de Wilder de 14 ruedas / precio × 100: las
        distancias se miden en ATRs para que una acción volátil no quede siempre “extendida”.
      </p>
      <p>
        <b className="text-terminal-text">A · Tendencia (20)</b>:{' '}
        <Formula>tri(dist SMA50 en ATR, −5, −2, 4, 8) × 10</Formula> +{' '}
        <Formula>tri(dist EMA200 en ATR, 0, 0, 8, 14) × 5,83</Formula> +{' '}
        <Formula>lineal(pendiente EMA200, 0, 0,15, 0, 4,17)</Formula>. Pendiente = variación diaria
        promedio (%) de la EMA200 en las últimas 20 ruedas (0,15 ≈ +3% en 20 ruedas). Premia estar
        arriba de las medias pero sin estirarse.
      </p>
      <p>
        <b className="text-terminal-text">B · Fuerza relativa (25)</b>: rendimiento relativo vs SPY
        (series alineadas por fecha) <Formula>0,4·r63 + 0,2·r126 + 0,2·r189 + 0,2·r252</Formula> con{' '}
        <Formula>rN = (1 + ret N) / (1 + ret SPY N) − 1</Formula>; RS = percentil 0-100 en el
        universo USD (también hace 5 y 21 ruedas).{' '}
        <Formula>vía nivel = lineal(RS, 45, 75, 0, 20)</Formula>;{' '}
        <Formula>vía delta = lineal(RS − max(RS mes ant., 40), 0, 20, 0, 20)</Formula> si RS − RS
        semana ant. &gt; −5. Puntos = <Formula>min(max(vía nivel, vía delta) + 5 si FR &gt; SMA50, 25)</Formula>,
        donde FR = precio / SPY.
      </p>
      <p>
        <b className="text-terminal-text">C · Contracción (35)</b>: ratio = volatilidad de 20 ruedas /
        su mediana del último año, el <b>mínimo de las últimas 7 ruedas</b>.{' '}
        <Formula>tri(ratio, 0, 0, 0,70, 1,05) × 15,25 × factor</Formula>, con{' '}
        <Formula>factor = 1 − 0,5 × clamp((avance 5 ruedas en ATR − 0,8) / 1,7, 0, 1)</Formula> +{' '}
        <Formula>tri(RSI14, 30, 45, 60, 70) × 11,25</Formula> + VCP{' '}
        <Formula>lineal(score VCP, 40, 100, 0, 6,8) + 1,7 si el volumen se secó</Formula>. Menos la
        verticalidad: <Formula>lineal(subida desde el mínimo de 15 ruedas en ATR, 5, 11, 0, 8)</Formula>.
      </p>
      <p>
        VCP: ZigZag con umbral <Formula>max(3%, 1,5 × ATR14%)</Formula> sobre ~120 ruedas; desde el
        máximo más alto (pivote), cada caída máximo → mínimo es una contracción. Detectado si hay ≥2
        seguidas cada una menor que la anterior (10% de tolerancia), la última ≤12% y el precio entre
        −10% y +2% del pivote. Score: 2 contracciones 50, 3 → 70, 4+ → 85, más hasta 10 por lo
        apretada de la última, 5 por cercanía al pivote y 5 si bajó el volumen.
      </p>
      <p>
        <b className="text-terminal-text">D · Gatillo (20)</b>:{' '}
        <Formula>tri(dist. mín. 52s % / volatilidad anual %, 0,3, 0,5, 1,8, 3,2) × 5</Formula> +{' '}
        <Formula>tri(semanas de base, 1, 7, 26, 55) × 10</Formula> +{' '}
        <Formula>lineal(posición en la base %, 20, 50, 0, 5)</Formula>. Base = desde el máximo más
        alto de ~55 semanas (si está rompiendo, la base que acaba de terminar); posición = (precio −
        mínimo de la base) / (pivote − mínimo). Si D suma menos de 10 vale 0 (setup inmaduro).
      </p>
      <p>
        <b className="text-terminal-text">Penalizaciones</b>: 🎈 sobreextensión (&gt;7 ATR sobre la
        SMA50 o RSI &gt;80) −6 · 🩸 distribución (a ≤5% del máximo, ≥6 de 8 velas rojas y volumen
        verde &lt;80% del rojo) −15 · 💥 reversión con volumen (&lt;−3% con &gt;1,5× volumen) −8 · ⛔
        breakout fallido (rompió el máximo de 52s hace 6-15 ruedas y volvió abajo) −10 · agotamiento
        (tope −14): 📉 divergencia RSI −8, 🪫 divergencia OBV −4, 🐘 churning en máximos −4. ⚠️ vela
        de rechazo en máximos: si se confirma (la rueda siguiente cierra roja) tope de 70. 💣 bomba =
        ruptura con volumen ≥1,5× y cierre en el 30% superior (aviso, 0 pts).
      </p>
      <p>
        <b className="text-terminal-text">Gate Stage 2</b>: precio ≤ EMA200 → tope 40 (“CAP 40”).
        Stage de Weinstein: 1 base (bajo EMA200, EMA200 sube) · 2 avance (sobre EMA200 y sube) · 3
        techo (sobre EMA200, no sube) · 4 declive.
      </p>
    </ComoSeCalcula>
  )
}
