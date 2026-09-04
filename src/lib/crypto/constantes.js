// Constantes compartidas entre Crypto Screener y la vista de detalle de un
// símbolo, para que ambas usen exactamente los mismos parámetros.
export const INTERVALOS = [
  { valor: '15m', etiqueta: '15 minutos' },
  { valor: '1h', etiqueta: '1 hora' },
  { valor: '4h', etiqueta: '4 horas' },
  { valor: '1d', etiqueta: 'Diario' },
]
export const MULTIPLOS_ATR = [1.5, 2.0, 3.0]

// Cuantas velas se piden por simbolo. Estaba en 200, y con exactamente 200 la
// EMA200 degeneraba en el promedio simple de la ventana: stdEMA() arranca con
// la media de las primeras 200 y despues no le queda ni UNA iteracion
// exponencial. O sea que el bloque "EMA alcista/bajista completo" (±2 puntos
// del score) y la columna EMA salian de una SMA200 disfrazada, sobre una
// ventana de 8 dias en 1h.
//
// 500 es el maximo que se puede pedir sin pagar mas rate limit. Medido contra
// la API (2026-09-04, leyendo 'x-mbx-used-weight-1m' con curl, que desde el
// browser no se puede porque Binance no expone el header):
//   limit <= 500  -> peso 2   |  501..1000 -> peso 5  |  >1000 -> peso 10
// El escaneo son ~500 simbolos x 1 llamada, asi que sigue costando ~1000 de
// los 2400 por minuto: exactamente lo mismo que antes.
export const VELAS = 500
export const APALANCAMIENTOS = [2, 3, 5, 7, 10, 15, 20, 25, 30, 50, 75, 100, 125]
export const CORTO = ['se', 'sf', 'sh', 'sw']
export const LARGO = ['le', 'lf', 'lo', 'lw']

export const COLOR_SENAL = {
  se: { bg: 'rgba(239,68,68,0.32)', text: '#fecaca' },
  sf: { bg: 'rgba(239,68,68,0.26)', text: '#fca5a5' },
  sh: { bg: 'rgba(239,68,68,0.19)', text: '#fca5a5' },
  sw: { bg: 'rgba(239,68,68,0.10)', text: '#f87171' },
  n: { bg: 'rgba(125,139,156,0.12)', text: '#9ca3af' },
  lw: { bg: 'rgba(34,197,94,0.10)', text: '#6ee7b7' },
  lo: { bg: 'rgba(34,197,94,0.19)', text: '#bbf7d0' },
  lf: { bg: 'rgba(34,197,94,0.26)', text: '#86efac' },
  le: { bg: 'rgba(34,197,94,0.32)', text: '#86efac' },
}

// Categorias del universo TradFi (campo underlyingType de exchangeInfo).
// 'orden' define el orden de los chips de filtro en la pestania.
export const CATEGORIAS_TRADFI = {
  EQUITY: { etiqueta: 'Acciones y ETF US', corta: 'US', orden: 1 },
  HK_EQUITY: { etiqueta: 'Hong Kong', corta: 'HK', orden: 2 },
  KR_EQUITY: { etiqueta: 'Corea', corta: 'KR', orden: 3 },
  CN_EQUITY: { etiqueta: 'China', corta: 'CN', orden: 4 },
  COMMODITY: { etiqueta: 'Commodities', corta: 'COMM', orden: 5 },
  INDEX: { etiqueta: 'Índices', corta: 'IDX', orden: 6 },
  PREMARKET: { etiqueta: 'Pre-IPO', corta: 'PRE', orden: 7 },
}

export const CATEGORIA_DEFAULT = { etiqueta: 'Otros', corta: '—', orden: 99 }
