// Configuracion del "Screener Cripto v2". Todo lo que en la v1 estaba
// hardcodeado y sin calibrar vive aca, para poder moverlo y medir el efecto
// con el backtest de la misma pestania.

// Se piden 1500 velas, el maximo de Binance en una llamada (la v1 pedia 200).
// Dos motivos:
//  1. Con exactamente 200 velas una EMA200 degenera en el promedio simple de
//     la ventana — el seed de la EMA es la media de las primeras 200 y
//     despues no queda ni una iteracion exponencial.
//  2. Con 500 velas de 1h la ventana total es de apenas 21 dias, o sea UN
//     regimen de mercado: alcanza para que el backtest de un numero, no para
//     que ese numero signifique algo. Con 1500 son ~62 dias, y en diario
//     pasan de 1,4 a 4,1 anios.
// Costo: las klines con limit>1000 pesan 5 de rate limit en vez de 2, pero el
// escaneo se reparte en lotes con pausas y queda lejos del limite por minuto.
export const VELAS = 1500

// Temporalidad de entrada -> temporalidad de tendencia (confluencia
// multi-temporal). La v1 miraba una sola temporalidad.
export const PARES_TEMPORALIDAD = [
  { entrada: '15m', tendencia: '1h', etiqueta: '15m (tendencia 1h)' },
  { entrada: '1h', tendencia: '4h', etiqueta: '1h (tendencia 4h)' },
  { entrada: '4h', tendencia: '1d', etiqueta: '4h (tendencia diaria)' },
  // Antes esta opcion era diario/SEMANAL y era una trampa: la EMA200 semanal
  // pide 200 velas = ~4 anios, y Binance tope en ~209 velas semanales incluso
  // en los perpetuos mas viejos (LINK/CRV/DASH), asi que la MITAD del universo
  // quedaba con tendencia 'N/D' sin explicar por que. Medido: 13 simbolos con
  // tendencia contra 15 sin, y 6 trades en test / 0 en train — no era medible.
  // La auto-tendencia cubre 28 de 30. Ojo igual: en diario un trade sin
  // solapamiento se come semanas, asi que el backtest de este par va a tener
  // pocos trades (el panel lo marca con ⚠).
  { entrada: '1d', tendencia: '1d', etiqueta: 'Diario (tendencia diaria)' },
]

// Piso de volumen negociado en 24h (USDT). La v1 rankeaba los ~525 simbolos
// sin ningun filtro, y las lecturas mas extremas — las que quedaban arriba —
// tienden a venir de simbolos finos donde la señal es ruido y el spread se
// come el R:R.
export const PISOS_LIQUIDEZ = [
  { valor: 0, etiqueta: 'Sin filtro (como la v1)' },
  { valor: 5_000_000, etiqueta: '> $5M / 24h' },
  { valor: 20_000_000, etiqueta: '> $20M / 24h' },
  { valor: 50_000_000, etiqueta: '> $50M / 24h' },
  { valor: 200_000_000, etiqueta: '> $200M / 24h' },
]

// Comision taker de Binance USDT-M, por lado. Ida y vuelta = 2x.
export const FEE_TAKER_PCT = 0.05

// Tolerancias del setup, en % — adoptadas del analizador v8 igual que en el
// Screener de acciones, para que las dos pestanias hablen el mismo idioma.
export const TOL_ASL = 3.0 // distancia maxima a la ASL para estar "en zona"
export const TOL_CLAVE = 5.0 // distancia maxima a la media clave (EMA50)
export const TOL_EXTENSION = 8.0 // mas lejos que esto = EXTENDIDO
export const NEAR_FACTOR = 1.5 // multiplica las tolerancias para el "CERCA"
export const RSI_BULL = 50
export const RSI_BEAR = 45

// StochRSI: se exige que no venga de un extremo agotado en la direccion del
// trade (comprar con StochRSI 95 es comprar el final del tramo).
export const SRSI_TECHO_LONG = 85
export const SRSI_PISO_SHORT = 15

// Funding: |funding| por encima de esto en contra del trade degrada el
// veredicto (longs apiñados pagando funding alto = combustible de squeeze).
// El valor es el funding de un periodo de 8h, en %.
export const FUNDING_ALERTA_PCT = 0.05

// Backtest
export const BT_MAX_VELAS_EN_TRADE = 100 // timeout de la posicion
export const BT_MIN_TRADES = 30 // menos que esto no se reporta como medible

// Fraccion de la ventana que se usa como TRAIN. El resto es TEST (fuera de
// muestra). Existe porque la primera version de esta pestania reportaba UN
// solo numero sobre UNA sola ventana, y eso alcanzo para creer que la
// confluencia era rentable cuando en realidad era el regimen del momento.
export const FRACCION_TRAIN = 0.65

// ── Defaults calibrados (2026-08-28) ──────────────────────────────────────
// Salen de una busqueda sobre 1 anio de velas 1h en 57 perpetuos con
// turnover > $20M, eligiendo en TRAIN y validando una sola vez en TEST.
// SL 3xATR + TP 3R fue la unica combinacion que quedo en breakeven fuera de
// muestra (media -0.002 R/trade contra -0.036 del SL2/TP2 original), y
// ademas con el menor drawdown. NO es un sistema rentable: es el menos malo
// de los medidos. Descartado a proposito el sesgo direccional, que en train
// favorecia SHORT (+0.060) y en test LONG (+0.051) — puro regimen.
export const SL_ATR_DEFAULT = 3.0
export const TP_R_DEFAULT = 3.0
export const MULTIPLOS_ATR_V2 = [1.5, 2.0, 2.5, 3.0, 4.0]
export const MULTIPLOS_TP_R = [1.5, 2, 3, 5]
