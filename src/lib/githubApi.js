// Automatiza el alta/baja manual de tickers: escribe/saca el ticker en
// data/tickers.xlsx del repo via la API de GitHub y dispara el workflow
// "Actualizar datos". Asi el usuario no tiene que descargar/commitear el
// Excel a mano.
//
// Requiere un GitHub Personal Access Token (PAT) del propio usuario, guardado
// solo en su navegador. Por defecto en sessionStorage (se borra al cerrar la
// pestaña); con "recordar en este dispositivo" va a localStorage. El token
// nunca sale de acá: se usa solo para llamar directo a api.github.com desde
// el browser.

const OWNER = 'facubelini'
const REPO = 'stock-lens'
const BRANCH = 'main'
const ARCHIVO = 'data/tickers.xlsx'
const WORKFLOW = 'datos.yml'
const KEY_PAT = 'stocklens_gh_pat'

function _leer(storage) {
  try {
    return storage.getItem(KEY_PAT) || ''
  } catch {
    return ''
  }
}

function _borrar(storage) {
  try {
    storage.removeItem(KEY_PAT)
  } catch {
    /* almacenamiento no disponible: ignorar */
  }
}

export function getPat() {
  return _leer(sessionStorage) || _leer(localStorage)
}

// true si el token actual esta persistido (localStorage, sobrevive a cerrar
// el navegador). Las versiones anteriores lo guardaban siempre ahi: esos
// tokens se siguen leyendo igual (migracion transparente) y se muestran como
// "recordado" hasta que el usuario lo vuelva a guardar o lo borre.
export function patRecordado() {
  return Boolean(_leer(localStorage))
}

export function setPat(pat, { recordar = false } = {}) {
  const valor = String(pat ?? '').trim()
  _borrar(sessionStorage)
  _borrar(localStorage)
  if (!valor) return
  try {
    ;(recordar ? localStorage : sessionStorage).setItem(KEY_PAT, valor)
  } catch {
    /* almacenamiento no disponible: ignorar */
  }
}

async function ghFetch(path, opts = {}) {
  const pat = getPat()
  if (!pat) throw new Error('Falta configurar tu GitHub token.')
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  })
  if (!res.ok) {
    const cuerpo = await res.json().catch(() => ({}))
    const base = cuerpo.message || `${res.status} ${res.statusText}`
    let msg = base
    if (res.status === 401) msg = 'Token inválido o vencido. Volvé a configurarlo.'
    else if (res.status === 403) msg = `Sin permisos suficientes (${base}). Revisá los scopes del token.`
    else if (res.status === 404) msg = `No encontrado (${base}). Revisá owner/repo.`
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  return res.status === 204 ? null : res.json()
}

function _norm(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

const NOMBRES_TICKER = ['ticker', 'codigo', 'symbol', 'simbolo', 'code', 'tickers']

// El pipeline (resolver_ticker en generar_datos.py) prueba el ticker "pelado"
// del Excel y, si no resuelve, reintenta con sufijo .SA (Brasil) o .BA
// (Argentina) — el ticker que ve el usuario en la app es ese resuelto (ej.
// "BAYN.BA"), pero en tickers.xlsx casi siempre esta guardado sin sufijo
// (ej. "BAYN"). Si no se saca el sufijo antes de comparar, alta/baja nunca
// hacen match contra la fila real y la baja falla en silencio (se reporta
// "ya no estaba" aunque siga ahi).
function _sinSufijo(t) {
  return String(t ?? '').trim().toUpperCase().replace(/\.(SA|BA)$/, '')
}

// Descarga y parsea tickers.xlsx del repo, detectando la columna de tickers
// (una sola columna, o un encabezado tipo Ticker/Codigo/Symbol).
async function leerExcelRepo() {
  const XLSX = await import('xlsx')
  const actual = await ghFetch(`/repos/${OWNER}/${REPO}/contents/${ARCHIVO}?ref=${BRANCH}`)
  const wb = XLSX.read(actual.content, { type: 'base64' })
  const nombreHoja = wb.SheetNames[0]
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[nombreHoja], { header: 1, defval: '' })
  if (!filas.length) throw new Error('El tickers.xlsx del repo está vacío.')
  const encabezado = filas[0]
  let colTicker = encabezado.findIndex((h) => NOMBRES_TICKER.includes(_norm(h)))
  if (colTicker === -1) colTicker = 0 // una sola columna: es la de tickers
  return { XLSX, wb, nombreHoja, filas, colTicker, sha: actual.sha }
}

async function escribirExcelRepo({ XLSX, wb, nombreHoja, filas, sha }, mensaje) {
  wb.Sheets[nombreHoja] = XLSX.utils.aoa_to_sheet(filas)
  const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' })
  await ghFetch(`/repos/${OWNER}/${REPO}/contents/${ARCHIVO}`, {
    method: 'PUT',
    body: JSON.stringify({ message: mensaje, content: base64, sha, branch: BRANCH }),
  })
}

async function agregarEnExcel(ticker) {
  const ctx = await leerExcelRepo()
  const objetivo = _sinSufijo(ticker)
  const yaExiste = ctx.filas
    .slice(1)
    .some((f) => _sinSufijo(f[ctx.colTicker]) === objetivo)
  if (yaExiste) return { agregado: false }
  const nuevaFila = new Array(ctx.filas[0].length).fill('')
  // Se guarda sin sufijo, consistente con el resto del archivo (el pipeline
  // le agrega .SA/.BA solo si hace falta para resolverlo).
  nuevaFila[ctx.colTicker] = objetivo
  ctx.filas.push(nuevaFila)
  await escribirExcelRepo(ctx, `watchlist: agregar ${objetivo} (alta manual desde la app)`)
  return { agregado: true }
}

async function quitarDeExcel(ticker) {
  const ctx = await leerExcelRepo()
  const encabezado = ctx.filas[0]
  const cuerpo = ctx.filas.slice(1)
  const objetivo = _sinSufijo(ticker)
  const restantes = cuerpo.filter((f) => _sinSufijo(f[ctx.colTicker]) !== objetivo)
  if (restantes.length === cuerpo.length) return { eliminado: false } // no estaba en el excel
  ctx.filas = [encabezado, ...restantes]
  await escribirExcelRepo(ctx, `watchlist: eliminar ${objetivo} (baja manual desde la app)`)
  return { eliminado: true }
}

async function dispararWorkflow(nombreWorkflow = WORKFLOW) {
  await ghFetch(`/repos/${OWNER}/${REPO}/actions/workflows/${nombreWorkflow}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: BRANCH }),
  })
}

// Reintenta una vez si el commit choca por sha desactualizado (409 de GitHub,
// ej. si el bot del pipeline commiteo datos justo en el medio).
async function conReintento(fn) {
  try {
    return await fn()
  } catch (e) {
    // 409 = conflicto de sha; algunas respuestas 422 tambien lo mencionan en
    // el mensaje ("sha wasn't supplied" / "does not match").
    if (e.status === 409 || String(e.message).toLowerCase().includes('sha')) return await fn()
    throw e
  }
}

// Agrega un ticker a data/tickers.xlsx en GitHub y dispara "Actualizar datos".
export async function agregarTickerRemoto(ticker) {
  const tk = String(ticker).trim().toUpperCase()
  if (!tk) throw new Error('Ticker vacío.')
  const resultado = await conReintento(() => agregarEnExcel(tk))
  if (resultado.agregado) await dispararWorkflow()
  return resultado
}

// Saca un ticker de data/tickers.xlsx en GitHub y dispara "Actualizar datos"
// (así el pipeline deja de traerlo y desaparece del resto de las pestañas).
export async function quitarTickerRemoto(ticker) {
  const tk = String(ticker).trim().toUpperCase()
  if (!tk) throw new Error('Ticker vacío.')
  const resultado = await conReintento(() => quitarDeExcel(tk))
  if (resultado.eliminado) await dispararWorkflow()
  return resultado
}

// Dispara "Actualizar datos" a mano (ej. botón de refresh en Screener), sin
// tocar tickers.xlsx — sirve para forzar una corrida fuera del cron.
export async function dispararActualizacionDatos() {
  await dispararWorkflow()
}
