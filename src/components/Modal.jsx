import { useEffect, useId, useRef } from 'react'

const FOCUSABLES =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Modal accesible compartido: role="dialog" + aria-modal, Esc para cerrar,
// foco inicial adentro (el elemento con data-autofocus o el primer
// enfocable), Tab no se escapa del dialogo y al cerrar el foco vuelve a donde
// estaba. Click en el fondo cierra.
//   - titulo: texto del encabezado (se usa como aria-labelledby). Si el modal
//     dibuja su propio encabezado, pasar `etiqueta` (aria-label) en su lugar.
export default function Modal({
  onClose,
  titulo,
  etiqueta,
  children,
  overlayClassName = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4',
  className = 'w-full max-w-md rounded-lg border border-terminal-border bg-terminal-panel p-4',
}) {
  const ref = useRef(null)
  const idTitulo = useId()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previo = document.activeElement
    const nodo = ref.current
    const inicial = nodo?.querySelector('[data-autofocus]') ?? nodo?.querySelector(FOCUSABLES) ?? nodo
    inicial?.focus()

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current?.()
        return
      }
      if (e.key !== 'Tab' || !nodo) return
      const lista = [...nodo.querySelectorAll(FOCUSABLES)]
      if (!lista.length) return
      const primero = lista[0]
      const ultimo = lista[lista.length - 1]
      if (e.shiftKey && document.activeElement === primero) {
        e.preventDefault()
        ultimo.focus()
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault()
        primero.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previo && typeof previo.focus === 'function') previo.focus()
    }
  }, [])

  return (
    <div className={overlayClassName} onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titulo ? idTitulo : undefined}
        aria-label={titulo ? undefined : etiqueta}
        tabIndex={-1}
        className={`${className} focus:outline-none`}
        onClick={(e) => e.stopPropagation()}
      >
        {titulo && (
          <h3 id={idTitulo} className="mb-2 text-sm font-semibold text-terminal-text">
            {titulo}
          </h3>
        )}
        {children}
      </div>
    </div>
  )
}
