// Automatiza el alta/baja manual de tickers: escribe/saca el ticker en
// data/tickers.xlsx del repo via la API de GitHub y dispara el workflow
// "Actualizar datos". Asi el usuario no tiene que descargar/commitear el
// Excel a mano.
//
// Requiere un GitHub Personal Access Token (PAT) del propio usuario, guardado
// solo en su navegador (localStorage) — mismo patron que el editor del
// portfolio. El token nunca sale de acá: se usa solo para llamar directo a
// api.github.com desde el browser.

const OWNER = 'facubelini'
const REPO = 'stock-lens'
const BRANCH = 'main'
const ARCHIVO = 'data/tickers.xlsx'
const WORKFLOW = 'datos.yml'
const ARCHIVO_HISTORICO = 'data/historico_tickers.json'
const WORKFLOW_HISTORICO = 'historico.yml'
const LIMITE_HISTORICO = 10
const KEY_PAT = 'stocklens_gh_pat'

export function getPat() {
  try {
    return localStorage.getItem(KEY_PAT) || ''
  } catch {
    return ''
  }
}

export function setPat(pat) {
  try {
    if (pat) localStorage.setItem(KEY_PAT, pat.trim())
    else localStorage.removeItem(KEY_PAT)
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
    if (res.status === 401) throw new Error('Token inválido o vencido. Volvé a configurarlo.')
    if (res.status === 403) throw new Error(`Sin permisos suficientes (${base}). Revisá los scopes del token.`)
    if (res.status === 404) throw new Error(`No encontrado (${base}). Revisá owner/repo.`)
    throw new Error(base)
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
  const yaExiste = ctx.filas
    .slice(1)
    .some((f) => String(f[ctx.colTicker] ?? '').trim().toUpperCase() === ticker)
  if (yaExiste) return { agregado: false }
  const nuevaFila = new Array(ctx.filas[0].length).fill('')
  nuevaFila[ctx.colTicker] = ticker
  ctx.filas.push(nuevaFila)
  await escribirExcelRepo(ctx, `watchlist: agregar ${ticker} (alta manual desde la app)`)
  return { agregado: true }
}

async function quitarDeExcel(ticker) {
  const ctx = await leerExcelRepo()
  const encabezado = ctx.filas[0]
  const cuerpo = ctx.filas.slice(1)
  const restantes = cuerpo.filter((f) => String(f[ctx.colTicker] ?? '').trim().toUpperCase() !== ticker)
  if (restantes.length === cuerpo.length) return { eliminado: false } // no estaba en el excel
  ctx.filas = [encabezado, ...restantes]
  await escribirExcelRepo(ctx, `watchlist: eliminar ${ticker} (baja manual desde la app)`)
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
    if (String(e.message).toLowerCase().includes('sha')) return await fn()
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

// --- Lista de hasta 10 tickers para "Histórico Fundamental" (data/historico_tickers.json) ---

function _base64ToUtf8(base64) {
  return decodeURIComponent(escape(atob(base64.replace(/\n/g, ''))))
}

function _utf8ToBase64(texto) {
  return btoa(unescape(encodeURIComponent(texto)))
}

async function leerListaHistorico() {
  const actual = await ghFetch(`/repos/${OWNER}/${REPO}/contents/${ARCHIVO_HISTORICO}?ref=${BRANCH}`)
  let lista = []
  try {
    const parseado = JSON.parse(_base64ToUtf8(actual.content))
    if (Array.isArray(parseado)) lista = parseado
  } catch {
    /* archivo vacío o corrupto: se trata como lista vacía */
  }
  return { lista, sha: actual.sha }
}

async function escribirListaHistorico(lista, sha, mensaje) {
  await ghFetch(`/repos/${OWNER}/${REPO}/contents/${ARCHIVO_HISTORICO}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: mensaje,
      content: _utf8ToBase64(JSON.stringify(lista, null, 2)),
      sha,
      branch: BRANCH,
    }),
  })
}

export async function obtenerTickersHistorico() {
  const { lista } = await leerListaHistorico()
  return lista
}

// Agrega un ticker a data/historico_tickers.json (máximo 10) y dispara el
// workflow "Historico fundamental".
export async function agregarTickerHistorico(ticker) {
  const tk = String(ticker).trim().toUpperCase()
  if (!tk) throw new Error('Ticker vacío.')
  const resultado = await conReintento(async () => {
    const { lista, sha } = await leerListaHistorico()
    if (lista.includes(tk)) return { agregado: false, lista }
    if (lista.length >= LIMITE_HISTORICO) {
      throw new Error(`Ya tenés el máximo de ${LIMITE_HISTORICO} tickers. Sacá uno antes de agregar otro.`)
    }
    const nueva = [...lista, tk]
    await escribirListaHistorico(nueva, sha, `historico: agregar ${tk}`)
    return { agregado: true, lista: nueva }
  })
  if (resultado.agregado) await dispararWorkflow(WORKFLOW_HISTORICO)
  return resultado
}

// Saca un ticker de data/historico_tickers.json y dispara el workflow.
export async function quitarTickerHistorico(ticker) {
  const tk = String(ticker).trim().toUpperCase()
  if (!tk) throw new Error('Ticker vacío.')
  const resultado = await conReintento(async () => {
    const { lista, sha } = await leerListaHistorico()
    if (!lista.includes(tk)) return { eliminado: false, lista }
    const nueva = lista.filter((t) => t !== tk)
    await escribirListaHistorico(nueva, sha, `historico: eliminar ${tk}`)
    return { eliminado: true, lista: nueva }
  })
  if (resultado.eliminado) await dispararWorkflow(WORKFLOW_HISTORICO)
  return resultado
}
