import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, Link } from 'react-router-dom'
import Header from './components/Header'
import WatchlistBar from './components/WatchlistBar'
import ComandoPaleta from './components/ComandoPaleta'
import BannerDatosDesactualizados from './components/BannerDatosDesactualizados'
import { TablaSkeleton } from './components/Estados'

// Cada pestaña es un chunk aparte (React.lazy): el bundle inicial solo trae
// el shell (header, barra de lista, paleta) y la pagina que se abre; el
// resto se baja al navegar.
const Listado = lazy(() => import('./pages/Listado'))
const Medias = lazy(() => import('./pages/Medias'))
const Fundamentales = lazy(() => import('./pages/Fundamentales'))
const Comparables = lazy(() => import('./pages/Comparables'))
const Oportunidades = lazy(() => import('./pages/Oportunidades'))
const Screener = lazy(() => import('./pages/Screener'))
const HistoricoFundamental = lazy(() => import('./pages/HistoricoFundamental'))
const CryptoScreener = lazy(() => import('./pages/CryptoScreener'))
const CryptoDetalle = lazy(() => import('./pages/CryptoDetalle'))
const AccionesTokenizadas = lazy(() => import('./pages/AccionesTokenizadas'))
const ScreenerCruces = lazy(() => import('./pages/ScreenerCruces'))
const TopSenales = lazy(() => import('./pages/TopSenales'))
const Cartera = lazy(() => import('./pages/Cartera'))
const Macro = lazy(() => import('./pages/Macro'))
const Herramientas = lazy(() => import('./pages/Herramientas'))
const Screeners = lazy(() => import('./pages/Screeners'))
const PrePostMarket = lazy(() => import('./pages/PrePostMarket'))
const Scanner = lazy(() => import('./pages/Scanner'))
const WarrenScore = lazy(() => import('./pages/WarrenScore'))
const Senales = lazy(() => import('./pages/Senales'))
const TickerDetalle = lazy(() => import('./pages/TickerDetalle'))

function CargandoPagina() {
  return (
    <div role="status" aria-label="Cargando pestaña">
      <div className="skeleton mb-4 h-6 w-48" />
      <TablaSkeleton columnas={5} filas={8} />
    </div>
  )
}

function NoEncontrada() {
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel p-8 text-center">
      <p className="mb-1 text-lg font-semibold text-terminal-text">Página no encontrada</p>
      <p className="mb-4 text-sm text-terminal-dim">La dirección no corresponde a ninguna pestaña de Stock Lens.</p>
      <Link to="/" className="rounded bg-terminal-accent px-3 py-1.5 text-sm font-semibold text-black hover:opacity-90">
        Ir al Listado
      </Link>
    </div>
  )
}

export default function App() {
  return (
    <div className="flex min-h-full flex-col">
      <ComandoPaleta />
      <Header />
      <BannerDatosDesactualizados />
      <WatchlistBar />
      <main className="w-full flex-1 px-4 py-5">
        <Suspense fallback={<CargandoPagina />}>
          <Routes>
            <Route path="/" element={<Listado />} />
            <Route path="/medias" element={<Medias />} />
            <Route path="/fundamentales" element={<Fundamentales />} />
            <Route path="/comparables" element={<Comparables />} />
            <Route path="/oportunidades" element={<Oportunidades />} />
            <Route path="/cartera" element={<Cartera />} />
            <Route path="/macro" element={<Macro />} />
            <Route path="/herramientas" element={<Herramientas />} />
            <Route path="/screeners" element={<Screeners />} />
            <Route path="/pre-post" element={<PrePostMarket />} />
            <Route path="/scanner" element={<Scanner />} />
            <Route path="/warren-score" element={<WarrenScore />} />
            <Route path="/senales" element={<Senales />} />
            <Route path="/screener" element={<Screener />} />
            <Route path="/historico" element={<HistoricoFundamental />} />
            <Route path="/cripto" element={<CryptoScreener />} />
            <Route path="/cripto/:symbol" element={<CryptoDetalle />} />
            <Route path="/cruces" element={<ScreenerCruces />} />
            {/* La v2 y la v3 se reemplazaron por el screener de cruces; se
                redirige para no romper enlaces guardados. */}
            <Route path="/cripto-v2" element={<Navigate to="/cruces" replace />} />
            <Route path="/cripto-v3" element={<Navigate to="/cruces" replace />} />
            <Route path="/tokenizadas" element={<AccionesTokenizadas />} />
            <Route path="/tokenizadas/:symbol" element={<CryptoDetalle />} />
            <Route path="/top" element={<TopSenales />} />
            <Route path="/ticker/:ticker" element={<TickerDetalle />} />
            <Route path="*" element={<NoEncontrada />} />
          </Routes>
        </Suspense>
      </main>
      <footer className="border-t border-terminal-border px-4 py-3 text-center text-[11px] text-terminal-dim">
        Stock Lens · datos vía yfinance, sólo con fines informativos. No constituye recomendación
        de inversión.
      </footer>
    </div>
  )
}
