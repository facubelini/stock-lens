import { Link } from 'react-router-dom'
import LogoTicker from './LogoTicker'

// Link a la vista de detalle unificada de un ticker (/ticker/:ticker), para
// usar en la columna "Ticker" de cualquier tabla del sitio. Por defecto
// muestra el logo de la empresa a la izquierda (conLogo=false lo saca en
// columnas muy angostas donde no entra).
export default function TickerLink({ ticker, className = '', title, conLogo = true, tamLogo = 16 }) {
  return (
    <Link
      to={`/ticker/${encodeURIComponent(ticker)}`}
      title={title ?? `Ver ${ticker} en detalle`}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1.5 hover:text-terminal-accent hover:underline ${className}`}
    >
      {conLogo && <LogoTicker ticker={ticker} tam={tamLogo} />}
      {ticker}
    </Link>
  )
}
