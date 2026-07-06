import { Link } from 'react-router-dom'

// Link a la vista de detalle unificada de un ticker (/ticker/:ticker), para
// usar en la columna "Ticker" de cualquier tabla del sitio.
export default function TickerLink({ ticker, className = '', title }) {
  return (
    <Link
      to={`/ticker/${encodeURIComponent(ticker)}`}
      title={title ?? `Ver ${ticker} en detalle`}
      onClick={(e) => e.stopPropagation()}
      className={`hover:text-terminal-accent hover:underline ${className}`}
    >
      {ticker}
    </Link>
  )
}
