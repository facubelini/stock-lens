import { Routes, Route } from 'react-router-dom'
import Header from './components/Header'
import Listado from './pages/Listado'
import Medias from './pages/Medias'
import Fundamentales from './pages/Fundamentales'

export default function App() {
  return (
    <div className="flex min-h-full flex-col">
      <Header />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5">
        <Routes>
          <Route path="/" element={<Listado />} />
          <Route path="/medias" element={<Medias />} />
          <Route path="/fundamentales" element={<Fundamentales />} />
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
