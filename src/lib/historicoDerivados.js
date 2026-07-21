// Derivados client-side de la serie semanal de historico_fundamental.json:
// crecimiento interanual (YoY) de los "denominadores" absolutos y recorte por
// ventana temporal. No requieren tocar el pipeline porque ya vienen los
// valores base (eps_ttm/revenue_ttm) en cada punto.

// Agrega '<campo>_yoy' (variacion % vs. el mismo punto ~52 semanas atras) para
// cada campo pedido. La serie debe venir ordenada por fecha ascendente (asi
// la escribe el pipeline).
export function conCrecimientoYoY(serie, campos) {
  return serie.map((p, i) => {
    const extra = {}
    for (const c of campos) {
      const anterior = i >= 52 ? serie[i - 52]?.[c] : null
      extra[`${c}_yoy`] =
        anterior != null && anterior !== 0 && p[c] != null ? ((p[c] / anterior - 1) * 100) : null
    }
    return { ...p, ...extra }
  })
}

// Recorta a los ultimos N meses (null/0 = serie completa).
export function filtrarPorVentana(serie, meses) {
  if (!meses) return serie
  const corte = new Date()
  corte.setMonth(corte.getMonth() - meses)
  return serie.filter((p) => new Date(p.fecha) >= corte)
}

export const OPCIONES_VENTANA = [
  { valor: 12, etiqueta: '1 año' },
  { valor: 36, etiqueta: '3 años' },
  { valor: 60, etiqueta: '5 años' },
  { valor: 0, etiqueta: 'Todo' },
]

// Rango histórico + percentil del último valor dentro de esa distribución
// (sobre TODA la serie disponible, no la ventana elegida para graficar: el
// "dónde estoy parado vs. mi propia historia" no debería achicarse solo
// porque el usuario hizo zoom al último año).
export function rangoYPercentil(puntos, campo) {
  const valores = puntos.map((p) => p[campo]).filter((v) => v != null)
  if (valores.length < 2) return null
  const min = Math.min(...valores)
  const max = Math.max(...valores)
  const actual = valores[valores.length - 1]
  const percentil = Math.round((valores.filter((v) => v <= actual).length / valores.length) * 100)
  const promedio = valores.reduce((a, b) => a + b, 0) / valores.length
  const primero = new Date(puntos.find((p) => p[campo] != null).fecha)
  const ultimo = new Date([...puntos].reverse().find((p) => p[campo] != null).fecha)
  const anios = (ultimo - primero) / (1000 * 60 * 60 * 24 * 365.25)
  return { min, max, percentil, promedio, anios }
}
