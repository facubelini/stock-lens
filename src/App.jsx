import { Routes, Route } from 'react-router-dom'
import Header from './components/Header'
import WatchlistBar from './components/WatchlistBar'
import Listado from './pages/Listado'
import Medias from './pages/Medias'
import Fundamentales from './pages/Fundamentales'
import Comparables from './pages/Comparables'
import Oportunidades from './pages/Oportunidades'
import Screener from './pages/Screener'
import HistoricoFundamental from './pages/HistoricoFundamental'
import CryptoScreener from './pages/CryptoScreener'
import CryptoDetalle from './pages/CryptoDetalle'
import TopSenales from './pages/TopSenales'
import Cartera from './pages/Cartera'
import Macro from './pages/Macro'
import Herramientas from './pages/Herramientas'
import WarrenScore from './pages/WarrenScore'
import Valuaciones from './pages/Valuaciones'
import TickerDetalle from './pages/TickerDetalle'
import ComandoPaleta from './components/ComandoPaleta'

export default function App() {
  return (
    <div className="flex min-h-full flex-col">
      <ComandoPaleta />
      <Header />
      <WatchlistBar />
      <main className="w-full flex-1 px-4 py-5">
        <Routes>
          <Route path="/" element={<Listado />} />
          <Route path="/medias" element={<Medias />} />
          <Route path="/fundamentales" element={<Fundamentales />} />
          <Route path="/comparables" element={<Comparables />} />
          <Route path="/oportunidades" element={<Oportunidades />} />
          <Route path="/cartera" element={<Cartera />} />
          <Route path="/macro" element={<Macro />} />
          <Route path="/herramientas" element={<Herramientas />} />
          <Route path="/warren-score" element={<WarrenScore />} />
          <Route path="/valuaciones" element={<Valuaciones />} />
          <Route path="/screener" element={<Screener />} />
          <Route path="/historico" element={<HistoricoFundamental />} />
          <Route path="/cripto" element={<CryptoScreener />} />
          <Route path="/cripto/:symbol" element={<CryptoDetalle />} />
          <Route path="/top" element={<TopSenales />} />
          <Route path="/ticker/:ticker" element={<TickerDetalle />} />
          <Route path="*" element={<Listado />} />
        </Routes>
      </main>
      <footer className="border-t border-terminal-border px-4 py-3 text-center text-[11px] text-terminal-dim">
        Stock Lens · datos vía yfinance, sólo con fines informativos. No constituye recomendación
        de inversión.
      </footer>
    </div>
  )
}
