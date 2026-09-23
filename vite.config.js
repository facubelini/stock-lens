import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Content-Security-Policy como <meta>, SOLO en el build de produccion: en dev
// Vite inyecta scripts inline y abre un websocket para HMR que esta politica
// bloquearia. connect-src lista todos los hosts a los que la app hace fetch
// (grep de fetch(/https:// en src/): GitHub API (alta/baja de tickers),
// rss2json (noticias), Binance futuros/spot/data-api (cripto) y sus streams
// websocket. Si se agrega un fetch a otro host, sumarlo aca o el navegador lo
// bloquea en produccion.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // 'unsafe-inline' en estilos: React aplica style={{...}} en muchos componentes.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  [
    "connect-src 'self'",
    'https://api.github.com',
    'https://api.rss2json.com',
    'https://fapi.binance.com',
    'https://api.binance.com',
    'https://data-api.binance.vision',
    'wss://fstream.binance.com',
    'wss://stream.binance.com:9443',
  ].join(' '),
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

function cspPlugin() {
  return {
    name: 'stocklens-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

// 'base' debe coincidir con el nombre del repositorio en GitHub Pages.
// Se aplica en el BUILD de produccion y en 'vite preview' (que sirve ese
// build: con '/' los assets de /stock-lens/ daban 404); en dev usamos '/'
// para que el servidor sirva la app en la raiz.
// Si el repo se llama distinto, cambia '/stock-lens/' por '/mi-repo/'.
export default defineConfig(({ command, isPreview }) => ({
  plugins: [react(), cspPlugin()],
  base: command === 'build' || isPreview ? '/stock-lens/' : '/',
  build: {
    // SheetJS (~500 KB) es un chunk aparte que solo se baja al cargar/bajar
    // un Excel (import dinamico); no es parte de la carga inicial.
    chunkSizeWarningLimit: 550,
  },
  server: {
    port: 5179,
    strictPort: true,
  },
}))
