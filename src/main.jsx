import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App.jsx'
import { WatchlistProvider } from './lib/watchlist'
import { ClasificacionProvider } from './lib/clasificacion'
import { CryptoScanProvider } from './lib/cryptoScan'
import { AlertasProvider } from './lib/alertas'
import './index.css'

// HashRouter: evita 404 al refrescar en GitHub Pages (las rutas viven tras el '#').
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <WatchlistProvider>
        <ClasificacionProvider>
          <CryptoScanProvider>
            <AlertasProvider>
              <App />
            </AlertasProvider>
          </CryptoScanProvider>
        </ClasificacionProvider>
      </WatchlistProvider>
    </HashRouter>
  </React.StrictMode>,
)
