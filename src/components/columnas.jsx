import BotonPin from './BotonPin'
import TickerLink from './TickerLink'
import MarcaStale from './MarcaStale'

// Columnas reusadas por varias tablas (formato de Tabla.jsx).

// Estrella de favoritos.
export function columnaPin(isPinned, toggle) {
  return {
    key: '_pin',
    label: '',
    align: 'center',
    sortable: false,
    csv: false,
    tdClass: 'w-6 px-0.5',
    render: (r) => <BotonPin ticker={r.ticker} isPinned={isPinned} toggle={toggle} />,
  }
}

// Ticker con link al detalle + 🕒 si el dato esta arrastrado. `extra(r)`
// agrega iconos propios de la pagina (ej. ⚠️ trampa de valor).
export function columnaTicker({ extra, conNombreEnTitle = true } = {}) {
  return {
    key: 'ticker',
    label: 'Ticker',
    align: 'left',
    valor: (r) => r.ticker,
    render: (r) => (
      <span className="inline-flex items-center gap-1 font-semibold text-terminal-text">
        <TickerLink ticker={r.ticker} title={conNombreEnTitle ? r.nombre || r.ticker : undefined} />
        {extra?.(r)}
        <MarcaStale fila={r} />
      </span>
    ),
  }
}
