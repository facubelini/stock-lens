import { useMemo, useState } from 'react'
import { useDatosCombinados } from '../lib/useDatosCombinados'
import { useJson } from '../lib/useJson'
import { useClasificacion, aplicarClasificacion } from '../lib/clasificacion'
import { calcularGrahamNumber, calcularValorPorReversion } from '../lib/valuacionIntrinseca'
import { rangoYPercentil } from '../lib/historicoDerivados'
import TickerLink from '../components/TickerLink'
import CalculadoraDCF from '../components/CalculadoraDCF'
import BuscadorTicker from '../components/BuscadorTicker'
import { Vacio } from '../components/Estados'
import { fmtPrecio, fmtPct, fmtNum, estiloValor } from '../lib/formato'

function TablaGraham({ filas }) {
  const conGraham = useMemo(() => {
    return filas
      .map((f) => {
        const graham = calcularGrahamNumber(f)
        if (graham == null || !f.precio) return null
        return { ...f, _graham: graham, _margen: (graham / f.precio - 1) * 100 }
      })
      .filter(Boolean)
      .sort((a, b) => b._margen - a._margen)
      .slice(0, 60)
  }, [filas])

  if (!conGraham.length) {
    return <Vacio texto="Ningún ticker de tu universo tiene EPS y valor libro positivos para calcular el Graham Number." />
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-terminal-border">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
            <th className="px-2 py-2 font-semibold">Ticker</th>
            <th className="px-2 py-2 font-semibold">Empresa</th>
            <th className="px-2 py-2 text-right font-semibold">Precio</th>
            <th className="px-2 py-2 text-right font-semibold">Graham Number</th>
            <th className="px-2 py-2 text-right font-semibold">Margen</th>
          </tr>
        </thead>
        <tbody>
          {conGraham.map((f) => (
            <tr key={f.ticker} className="border-t border-terminal-border">
              <td className="px-2 py-1.5 font-semibold">
                <TickerLink ticker={f.ticker} />
              </td>
              <td className="max-w-[200px] truncate px-2 py-1.5 text-terminal-dim" title={f.nombre}>
                {f.nombre}
              </td>
              <td className="px-2 py-1.5 text-right tabular">{fmtPrecio(f.precio)}</td>
              <td className="px-2 py-1.5 text-right tabular text-terminal-dim">${fmtPrecio(f._graham)}</td>
              <td className="px-2 py-1.5 text-right tabular font-bold" style={estiloValor(f._margen, 40)}>
                {fmtPct(f._margen, { signo: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TablaReversion({ historico }) {
  const filas = useMemo(() => {
    const tickers = Array.isArray(historico?.tickers) ? historico.tickers : []
    return tickers
      .filter((t) => t.disponible)
      .map((t) => {
        const stats = rangoYPercentil(t.serie, 'per_ltm')
        const ultimo = [...t.serie].reverse().find((p) => p.per_ltm != null && p.precio != null)
        if (!stats || !ultimo) return null
        const valor = calcularValorPorReversion(ultimo.precio, ultimo.per_ltm, stats.promedio)
        if (valor == null) return null
        return {
          ticker: t.ticker,
          nombre: t.nombre,
          precio: ultimo.precio,
          perActual: ultimo.per_ltm,
          perPromedio: stats.promedio,
          valor,
          margen: (valor / ultimo.precio - 1) * 100,
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.margen - a.margen)
  }, [historico])

  if (!filas.length) {
    return (
      <Vacio texto='Todavía no tenés tickers con historial de PER disponible — agregalos en la pestaña "Histórico Fundamental".' />
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-terminal-border">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr className="bg-terminal-panel2 text-left text-xs uppercase tracking-wide text-terminal-dim">
            <th className="px-2 py-2 font-semibold">Ticker</th>
            <th className="px-2 py-2 font-semibold">Empresa</th>
            <th className="px-2 py-2 text-right font-semibold">Precio</th>
            <th className="px-2 py-2 text-right font-semibold">PER actual</th>
            <th className="px-2 py-2 text-right font-semibold">PER promedio (~5a)</th>
            <th className="px-2 py-2 text-right font-semibold">Valor implícito</th>
            <th className="px-2 py-2 text-right font-semibold">Margen</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => (
            <tr key={f.ticker} className="border-t border-terminal-border">
              <td className="px-2 py-1.5 font-semibold">
                <TickerLink ticker={f.ticker} />
              </td>
              <td className="max-w-[200px] truncate px-2 py-1.5 text-terminal-dim" title={f.nombre}>
                {f.nombre}
              </td>
              <td className="px-2 py-1.5 text-right tabular">{fmtPrecio(f.precio)}</td>
              <td className="px-2 py-1.5 text-right tabular">{fmtNum(f.perActual, 1)}x</td>
              <td className="px-2 py-1.5 text-right tabular text-terminal-dim">{fmtNum(f.perPromedio, 1)}x</td>
              <td className="px-2 py-1.5 text-right tabular text-terminal-dim">${fmtPrecio(f.valor)}</td>
              <td className="px-2 py-1.5 text-right tabular font-bold" style={estiloValor(f.margen, 40)}>
                {fmtPct(f.margen, { signo: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Valuaciones() {
  const { filas: base, cargando, error } = useDatosCombinados()
  const { overrides } = useClasificacion()
  const filas = useMemo(() => aplicarClasificacion(base, overrides), [base, overrides])
  const { data: historico } = useJson('historico_fundamental.json')

  const [tickerDCF, setTickerDCF] = useState('')
  const filaDCF = useMemo(() => filas.find((f) => f.ticker === tickerDCF), [filas, tickerDCF])

  if (cargando) return <div className="skeleton h-64 rounded-lg" />
  if (error) {
    return (
      <div className="rounded-lg border border-terminal-down/40 bg-terminal-down/10 p-6 text-center">
        <p className="font-semibold text-terminal-down">No se pudieron cargar los datos</p>
        <p className="text-sm text-terminal-dim">{error}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-bold text-terminal-text">Valuaciones</h1>
        <p className="text-xs text-terminal-dim">
          Tres formas de estimar "valor intrínseco", cada una con su propio supuesto — ninguna es
          "la" verdad. <b>Graham Number</b>: fórmula clásica (√22.5 × EPS × valor libro), sin
          supuestos, solo tiene sentido en empresas rentables y estables. <b>Reversión a múltiplo
          propio</b>: qué valdría la acción si su PER volviera a su propio promedio histórico (solo
          para los tickers curados de Histórico Fundamental, los únicos con esa serie). <b>DCF</b>:
          el método real de flujo de caja descontado, pero el resultado depende 100% de los
          supuestos que vos elijas — por eso es una calculadora, no un número fijo.
        </p>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-terminal-text">Graham Number</h2>
        <TablaGraham filas={filas} />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-terminal-text">Reversión a múltiplo propio (PER)</h2>
        <TablaReversion historico={historico} />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-terminal-text">Calculadora DCF</h2>
        <div className="mb-3">
          <BuscadorTicker filas={filas} onAdd={setTickerDCF} placeholder="Elegí un ticker para simular…" />
        </div>
        {!filaDCF ? (
          <Vacio texto="Elegí un ticker arriba para armar la simulación de DCF." />
        ) : (
          <CalculadoraDCF ticker={filaDCF.ticker} precio={filaDCF.precio} fcfPorAccion={filaDCF.fcf_por_accion} />
        )}
      </div>

      <p className="text-[11px] text-terminal-dim">
        Ninguno de estos métodos es una recomendación de inversión. Son herramientas de screening
        cuantitativo, cada una con supuestos y limitaciones propias — no reemplazan un análisis
        completo del negocio.
      </p>
    </div>
  )
}
