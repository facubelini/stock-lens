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
