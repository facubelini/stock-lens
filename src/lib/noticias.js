// Noticias recientes por ticker via Google News RSS, client-side. Mismo
// patron probado en "Stock Radar" (proyecto propio): Google News RSS no
// tiene headers CORS (Access-Control-Allow-Origin ausente, ademas
// Cross-Origin-Resource-Policy: same-site), asi que un fetch directo desde
// el navegador falla siempre. rss2json.com envuelve el RSS en JSON con CORS
// habilitado, sin necesitar API key.
const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url='
const MAX_ITEMS = 8

function urlNoticias(query) {
  const q = encodeURIComponent(query)
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`
}

export async function obtenerNoticias(query) {
  const url = RSS2JSON + encodeURIComponent(urlNoticias(query))
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (data.status !== 'ok') throw new Error('feed error')
  return (data.items ?? []).slice(0, MAX_ITEMS)
}

// Sentimiento de titulares: heuristica de palabras clave (no NLP real), en
// ingles porque las noticias vienen en ingles (hl=en-US). Cuenta matches de
// cada lista con limite de palabra (\b) para no confundir "cuts" adentro de
// "biscuits" — sirve para un vistazo rapido, no reemplaza leer la noticia.
const PALABRAS_POSITIVAS = [
  'surge', 'surges', 'surging', 'soar', 'soars', 'soaring', 'jump', 'jumps', 'jumping',
  'rally', 'rallies', 'rallying', 'beat', 'beats', 'upgrade', 'upgrades', 'upgraded',
  'bullish', 'outperform', 'outperforms', 'record high', 'all-time high', 'strong',
  'growth', 'profit', 'profits', 'gain', 'gains', 'rise', 'rises', 'rising', 'higher',
  'boost', 'boosts', 'raise', 'raises', 'raised', 'tops', 'exceed', 'exceeds', 'exceeded',
  'optimism', 'optimistic', 'breakthrough', 'expansion', 'win', 'wins', 'winning',
  'buy rating', 'climb', 'climbs', 'climbing', 'rebound', 'rebounds', 'rebounding',
]
const PALABRAS_NEGATIVAS = [
  'plunge', 'plunges', 'plunging', 'slump', 'slumps', 'crash', 'crashes', 'crashing',
  'downgrade', 'downgrades', 'downgraded', 'bearish', 'miss', 'misses', 'missed',
  'warn', 'warns', 'warning', 'cut', 'cuts', 'lawsuit', 'investigation', 'probe',
  'recall', 'layoff', 'layoffs', 'decline', 'declines', 'declining', 'fall', 'falls',
  'falling', 'drop', 'drops', 'dropping', 'lower', 'weak', 'loss', 'losses', 'concern',
  'concerns', 'risk', 'risks', 'delay', 'delays', 'delayed', 'halt', 'halts', 'fraud',
  'scandal', 'fine', 'fined', 'sue', 'sues', 'sued', 'bankruptcy', 'default',
  'sell rating', 'sell-off', 'selloff', 'tumble', 'tumbles', 'tumbling', 'slide', 'slides',
]

function _escaparRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function _contarCoincidencias(texto, lista) {
  const t = texto.toLowerCase()
  let n = 0
  for (const palabra of lista) {
    if (new RegExp(`\\b${_escaparRegex(palabra)}\\b`, 'i').test(t)) n++
  }
  return n
}

export function clasificarSentimiento(titulo) {
  if (!titulo) return 'neutral'
  const pos = _contarCoincidencias(titulo, PALABRAS_POSITIVAS)
  const neg = _contarCoincidencias(titulo, PALABRAS_NEGATIVAS)
  if (pos === neg) return 'neutral'
  return pos > neg ? 'positivo' : 'negativo'
}
