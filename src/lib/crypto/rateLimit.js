// Guardia de rate limit de Binance, COMPARTIDA por todas las pestanias de
// cripto (v1, v2 y Acciones Tokenizadas) y por el script de Actions.
//
// Por que existe: Binance limita por IP con un presupuesto de "peso" por
// minuto. Al pasarse responde 429, y si uno sigue mandando pedidos escala a
// 418 ("I'm a teapot"), que es un BLOQUEO de IP que ademas rompe binance.com
// en el navegador — es la misma IP.
//
// Medido en vivo el 2026-09-01: el header 'retry-after' arranco en 555
// segundos y despues de UN solo pedido mas salto a 1024. O sea que cada
// request durante el bloqueo LO EXTIENDE. De ahi la regla principal de este
// modulo: una vez detectado el bloqueo, no se toca mas la red hasta que pase.
//
// El bug que lo provoco: los fetch hacian `if (!r.ok) return null`, asi que un
// 429 se tragaba en silencio y el escaneo seguia disparando los cientos de
// pedidos restantes. Eso es lo que convierte un limite blando en un baneo
// largo.
//
// LIMITACION: 'retry-after' y 'x-mbx-used-weight-1m' NO son legibles desde el
// navegador. Binance manda Access-Control-Allow-Origin pero no
// Access-Control-Expose-Headers, asi que fetch() no los expone (desde Node si
// se leen). O sea que en el browser no se puede autorregular leyendo el peso
// consumido: el unico control real es pedir menos velas y menos simbolos.

const SEGUNDOS_BLOQUEO_ASUMIDO = 600

export class ErrorRateLimit extends Error {
  constructor(segundos) {
    super(
      `Binance bloqueó tu IP por exceso de pedidos (HTTP 418/429). ` +
        `Esperá ~${Math.ceil(segundos / 60)} minutos y NO reintentes mientras tanto: ` +
        `cada pedido durante el bloqueo lo extiende. También afecta a binance.com en el navegador.`,
    )
    this.name = 'ErrorRateLimit'
    this.segundos = segundos
  }
}

// Estado compartido: si una pestania se come el bloqueo, las demas lo saben.
let bloqueadoHasta = 0

// Segundos que faltan para poder volver a pedir (0 = libre).
export function segundosBloqueado() {
  const falta = bloqueadoHasta - Date.now()
  return falta > 0 ? Math.ceil(falta / 1000) : 0
}

function registrarBloqueo(r) {
  const ra = Number(r.headers?.get?.('retry-after')) || 0
  const seg = ra > 0 ? ra : SEGUNDOS_BLOQUEO_ASUMIDO
  bloqueadoHasta = Date.now() + seg * 1000
  return seg
}

// Todo pedido a Binance pasa por aca. Si ya sabemos que estamos bloqueados,
// falla sin tocar la red.
export async function pedirBinance(url) {
  const falta = segundosBloqueado()
  if (falta > 0) throw new ErrorRateLimit(falta)
  const r = await fetch(url)
  if (r.status === 429 || r.status === 418) throw new ErrorRateLimit(registrarBloqueo(r))
  return r
}
