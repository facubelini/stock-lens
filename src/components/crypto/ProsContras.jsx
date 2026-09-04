// Desglose del score en PROS y CONTRAS de la posición señalada.
//
// El score del v1 es con signo (negativo = SHORT, positivo = LONG) y sale de
// sumar seis bloques de indicadores. Así que para un SHORT los aportes
// negativos son los pros y los positivos las contras — al revés en un LONG.
// Antes esto se mostraba como una lista plana donde no se veía qué empujaba
// para cada lado ni cuánto pesaba, y los aportes de ±0.5 no aparecían.
//
// Las filas del Screener v2 no traen 'aportes' (su score es una cuenta de
// condiciones cumplidas, sin signo), así que ahí se cae al listado de siempre.
export default function ProsContras({ fila }) {
  if (!fila.aportes?.length) {
    return (
      <>
        <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
          Indicadores
        </div>
        <div className="text-xs leading-relaxed text-terminal-text">
          {(fila.details ?? '').split(' · ').map((s) => (
            <div key={s}>• {s}</div>
          ))}
        </div>
      </>
    )
  }

  const neutral = fila.score === 0
  const esShort = fila.score < 0
  // Signo que juega A FAVOR de la posición señalada.
  const signoPro = esShort ? -1 : 1
  const conPeso = fila.aportes.filter((a) => a.puntos !== 0)
  const pros = conPeso.filter((a) => Math.sign(a.puntos) === signoPro)
  const contras = conPeso.filter((a) => Math.sign(a.puntos) === -signoPro)
  const neutros = fila.aportes.filter((a) => a.puntos === 0)
  const suma = (arr) => +arr.reduce((s, a) => s + a.puntos, 0).toFixed(1)
  const conSigno = (v) => (v > 0 ? `+${v}` : String(v))

  const lado = esShort ? 'SHORT' : 'LONG'
  const lista = (items, favorable) => (
    <div className="text-xs leading-relaxed">
      {items.length === 0 ? (
        <div className="text-terminal-dim">— nada</div>
      ) : (
        items.map((a) => (
          <div key={a.bloque} className="flex gap-1.5">
            <span
              className={`w-9 shrink-0 text-right font-bold tabular ${
                favorable ? 'text-terminal-up' : 'text-terminal-down'
              }`}
            >
              {conSigno(a.puntos)}
            </span>
            <span className="text-terminal-text">{a.texto}</span>
          </div>
        ))
      )}
    </div>
  )

  return (
    <>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-terminal-dim">
        Pros y contras del score
      </div>

      <div className="mb-2 rounded border border-terminal-up/25 bg-terminal-up/5 p-2.5">
        <div className="mb-1.5 text-[11px] font-bold text-terminal-up">
          {neutral ? `▲ Empuja a LONG (${conSigno(suma(fila.aportes.filter((a) => a.puntos > 0)))})` : `✓ A favor del ${lado} (${conSigno(suma(pros))})`}
        </div>
        {lista(neutral ? fila.aportes.filter((a) => a.puntos > 0) : pros, true)}
      </div>

      <div className="mb-2 rounded border border-terminal-down/25 bg-terminal-down/5 p-2.5">
        <div className="mb-1.5 text-[11px] font-bold text-terminal-down">
          {neutral ? `▼ Empuja a SHORT (${conSigno(suma(fila.aportes.filter((a) => a.puntos < 0)))})` : `✗ En contra (${conSigno(suma(contras))})`}
        </div>
        {lista(neutral ? fila.aportes.filter((a) => a.puntos < 0) : contras, false)}
      </div>

      {neutros.length > 0 && (
        <div className="mb-2 rounded border border-terminal-border bg-terminal-bg p-2.5">
          <div className="mb-1.5 text-[11px] font-bold text-terminal-dim">
            ○ No aportan (0)
          </div>
          <div className="text-xs leading-relaxed text-terminal-dim">
            {neutros.map((a) => (
              <div key={a.bloque}>• {a.texto}</div>
            ))}
          </div>
        </div>
      )}

      {/* La cuenta a la vista, para que el score no sea un numero magico. */}
      <p className="text-[11px] leading-relaxed text-terminal-dim">
        <b>Score {conSigno(fila.score)}</b> ={' '}
        {neutral ? (
          <>
            {conSigno(suma(fila.aportes.filter((a) => a.puntos > 0)))} a long{' '}
            {conSigno(suma(fila.aportes.filter((a) => a.puntos < 0)))} a short — se cancelan.
          </>
        ) : (
          <>
            {conSigno(suma(pros))} a favor {conSigno(suma(contras))} en contra. Cada bloque aporta
            hasta ±2; el volumen solo confirma lo que ya marcan los demás.
          </>
        )}
      </p>
    </>
  )
}
