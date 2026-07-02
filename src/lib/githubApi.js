// Automatiza el alta manual de tickers: escribe el ticker en data/tickers.xlsx
// del repo via la API de GitHub y dispara el workflow "Actualizar datos". Asi
// el usuario no tiene que descargar/commitear el Excel a mano.
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

// Descarga tickers.xlsx, le agrega el ticker (si no está ya) preservando la
// estructura de columnas existente (una sola columna o Ticker/Industria/...),
// y lo sube de vuelta. Devuelve { agregado: bool }.
async function leerYActualizarExcel(ticker) {
  const XLSX = await import('xlsx')
  const actual = await ghFetch(`/repos/${OWNER}/${REPO}/contents/${ARCHIVO}?ref=${BRANCH}`)
  const wb = XLSX.read(actual.content, { type: 'base64' })
  const nombreHoja = wb.SheetNames[0]
  const ws = wb.Sheets[nombreHoja]
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  if (!filas.length) throw new Error('El tickers.xlsx del repo está vacío.')

  const encabezado = filas[0]
  let colTicker = encabezado.findIndex((h) => NOMBRES_TICKER.includes(_norm(h)))
  if (colTicker === -1) colTicker = 0 // una sola columna: es la de tickers

  const yaExiste = filas
    .slice(1)
    .some((f) => String(f[colTicker] ?? '').trim().toUpperCase() === ticker)
  if (yaExiste) return { agregado: false }

  const nuevaFila = new Array(encabezado.length).fill('')
  nuevaFila[colTicker] = ticker
  filas.push(nuevaFila)

  const wsNueva = XLSX.utils.aoa_to_sheet(filas)
  wb.Sheets[nombreHoja] = wsNueva
  const base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' })

  await ghFetch(`/repos/${OWNER}/${REPO}/contents/${ARCHIVO}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `watchlist: agregar ${ticker} (alta manual desde la app)`,
      content: base64,
      sha: actual.sha,
      branch: BRANCH,
    }),
  })
  return { agregado: true }
}

async function dispararWorkflow() {
  await ghFetch(`/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: BRANCH }),
  })
}

// Agrega un ticker a data/tickers.xlsx en GitHub y dispara "Actualizar datos".
// Reintenta una vez si el commit choca por sha desactualizado (409 de GitHub).
export async function agregarTickerRemoto(ticker) {
  const tk = String(ticker).trim().toUpperCase()
  if (!tk) throw new Error('Ticker vacío.')
  let resultado
  try {
    resultado = await leerYActualizarExcel(tk)
  } catch (e) {
    if (String(e.message).toLowerCase().includes('sha')) {
      resultado = await leerYActualizarExcel(tk)
    } else {
      throw e
    }
  }
  if (resultado.agregado) await dispararWorkflow()
  return resultado
}
