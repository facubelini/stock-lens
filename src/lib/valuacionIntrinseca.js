// Tres formas de estimar "valor intrínseco", cada una con su propio
// supuesto y limitación — ninguna es "la" verdad, son herramientas
// distintas para el mismo problema. Todo client-side, sobre datos que ya
// vienen en fundamentales.json/historico_fundamental.json (sin requests
// nuevos, sin API keys).

// 1) Graham Number: formula clasica de Benjamin Graham, sqrt(22.5 x EPS x
// valor libro por accion). Determinista, sin supuestos que inventar — pero
// solo tiene sentido para empresas rentables y estables (value investing
// clasico). En empresas de crecimiento o con perdidas da null a proposito,
// no un numero sin sentido.
export function calcularGrahamNumber(fila) {
  const eps = fila?.eps
  const bookValue = fila?.book_value
  const precio = fila?.precio
  if (eps == null || bookValue == null || eps <= 0 || bookValue <= 0) return null
  const graham = Math.sqrt(22.5 * eps * bookValue)
  // Guardarail: en CEDEARs de empresas extranjeras (y en Berkshire por su
  // split 1500:1 entre A/B-shares), yfinance a veces devuelve EPS/bookValue
  // en una escala o moneda distinta a la del precio — el resultado se
  // dispara a un Graham Number absurdo (se probaron casos reales: Berkshire
  // ~40-7000x el precio, CEDEARs coreanos ~11-19x). Comparado con eso, un
  // valor genuinamente barato (PER y P/B muy bajos a la vez) rara vez pasa
  // de ~4-5x — asi que un ratio mayor a 10x es, en la practica, casi
  // siempre un problema de dato y no una ganga real.
  if (precio != null && graham > precio * 10) return null
  return graham
}

// 2) DCF (flujo de caja descontado): el metodo "de verdad", pero el
// resultado depende 100% de los supuestos de crecimiento y tasa de
// descuento que elija quien lo usa — por eso es una calculadora
// interactiva, no un numero que la app afirme como un hecho. Proyecta el
// FCF por accion `aniosProyeccion` años, descuenta cada año, y suma un
// valor terminal (modelo de crecimiento de Gordon) tambien descontado.
export function calcularDCF({
  fcfPorAccion,
  crecimientoAnualPct,
  aniosProyeccion,
  tasaDescuentoPct,
  crecimientoTerminalPct,
}) {
  if (fcfPorAccion == null || fcfPorAccion <= 0) return null
  const r = tasaDescuentoPct / 100
  const g = crecimientoTerminalPct / 100
  if (r <= g) return null // el modelo de Gordon exige tasa de descuento > crecimiento terminal

  let valorPresente = 0
  let fcf = fcfPorAccion
  for (let anio = 1; anio <= aniosProyeccion; anio++) {
    fcf *= 1 + crecimientoAnualPct / 100
    valorPresente += fcf / (1 + r) ** anio
  }
  const fcfTerminal = fcf * (1 + g)
  const valorTerminal = fcfTerminal / (r - g)
  const valorTerminalDescontado = valorTerminal / (1 + r) ** aniosProyeccion

  return valorPresente + valorTerminalDescontado
}

// 3) Reversion al multiplo propio: no es "intrinseco" en sentido clasico,
// es mean-reversion — "si el PER volviera a su propio promedio historico,
// el precio implicito seria este". Solo disponible para los tickers
// curados de Histórico Fundamental (los unicos con serie historica real de
// PER via EDGAR); para el resto del universo no hay forma de saber el PER
// que tenia la empresa hace 3 años sin ese dato.
export function calcularValorPorReversion(precioActual, perActual, perPromedioHistorico) {
  if (!precioActual || !perActual || !perPromedioHistorico || perActual <= 0) return null
  return precioActual * (perPromedioHistorico / perActual)
}

export const DCF_DEFAULTS = {
  crecimientoAnualPct: 8,
  aniosProyeccion: 10,
  tasaDescuentoPct: 10,
  crecimientoTerminalPct: 2.5,
}
