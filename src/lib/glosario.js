// Glosario de ratios fundamentales: qué significan y cómo leerlos.
// Las guías son orientativas (rangos generales), NO recomendaciones de inversión.
// Los múltiplos "normales" varían MUCHO por industria; ver la fila de mediana
// por industria en la tabla para tener un parámetro real de cada grupo.

export const GLOSARIO = [
  {
    clave: 'per_trailing',
    label: 'PER (trailing)',
    def: 'Precio dividido por la ganancia por acción de los últimos 12 meses. Cuántos años de ganancias actuales estás pagando.',
    guia: 'Orientativo: <15 suele ser barato · 15–25 razonable · >25 exige crecimiento alto. Negativo = la empresa pierde plata.',
  },
  {
    clave: 'per_forward',
    label: 'PER forward',
    def: 'Igual que el PER pero usando la ganancia ESTIMADA del próximo año.',
    guia: 'Si es menor que el PER trailing, el mercado espera que las ganancias crezcan.',
  },
  {
    clave: 'peg',
    label: 'PEG',
    def: 'PER dividido por el crecimiento esperado de las ganancias. Ajusta el PER por crecimiento.',
    guia: '~1 se considera justo · <1 barato para su crecimiento · >2 caro.',
  },
  {
    clave: 'ev_sales',
    label: 'EV/Sales',
    def: 'Valor de empresa (capitalización + deuda − caja) sobre las ventas. Sirve cuando todavía no hay ganancias.',
    guia: 'Más bajo = más barato respecto a sus ingresos. Muy dependiente de la industria.',
  },
  {
    clave: 'pb',
    label: 'P/B',
    def: 'Precio sobre valor libro (patrimonio contable por acción).',
    guia: '<1 cotiza por debajo de su valor contable. Bancos suelen estar cerca de 1; tech, mucho más alto.',
  },
  {
    clave: 'ps',
    label: 'P/S',
    def: 'Precio sobre ventas por acción.',
    guia: 'Útil para empresas sin ganancias. Más bajo = más barato respecto a sus ventas.',
  },
  {
    clave: 'market_cap',
    label: 'Market Cap',
    def: 'Capitalización bursátil = precio × cantidad de acciones. Es el "tamaño" de la empresa.',
    guia: 'Grande (>10 B) suele ser más estable; chica (<2 B) más volátil.',
  },
  {
    clave: 'eps',
    label: 'EPS',
    def: 'Ganancia por acción de los últimos 12 meses, en la moneda de la acción.',
    guia: 'Positivo y creciente es lo deseable. Negativo = pérdidas.',
  },
  {
    clave: 'profit_margin',
    label: 'Margen neto',
    def: 'Ganancia neta sobre ventas: cuánto queda de cada $100 facturados.',
    guia: 'Más alto = más rentable. "Normal" depende fuerte de la industria (software alto, retail bajo).',
  },
  {
    clave: 'roe',
    label: 'ROE',
    def: 'Retorno sobre el patrimonio: ganancia sobre el capital de los accionistas.',
    guia: '>15% suele considerarse bueno. Ojo si es muy alto por estar muy endeudada.',
  },
  {
    clave: 'dividend_yield',
    label: 'Dividend yield',
    def: 'Dividendo anual sobre el precio. Lo que rinde por dividendos.',
    guia: '0% = no paga (reinvierte). Muy alto (>8%) a veces es señal de riesgo, no de oportunidad.',
  },
  {
    clave: 'beta',
    label: 'Beta',
    def: 'Volatilidad de la acción respecto al mercado.',
    guia: '1 = se mueve como el mercado · >1 más volátil · <1 más defensiva.',
  },
  {
    clave: 'debt_to_equity',
    label: 'Deuda/Patrimonio',
    def: 'Deuda total sobre patrimonio (según yfinance, suele venir expresado en %). Cuánto se financia con deuda.',
    guia: 'Más alto = más apalancada (más riesgo). Bancos y utilities operan naturalmente más altos.',
  },
  {
    clave: 'current_ratio',
    label: 'Liquidez corriente',
    def: 'Activo corriente sobre pasivo corriente: capacidad de cubrir deudas a menos de un año.',
    guia: '>1 sano · <1 puede indicar tensión de caja.',
  },
]

// Mapa clave -> entrada, para tooltips por columna.
export const GLOSARIO_POR_CLAVE = Object.fromEntries(GLOSARIO.map((g) => [g.clave, g]))
