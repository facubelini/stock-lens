import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getUniverso } from '../lib/crypto/binanceApi'
import { useEscaneoBinance, parametrosCambiaron } from '../lib/crypto/useEscaneo'
import { useBacktestFiguras } from '../lib/crypto/useBacktestFiguras'
import { INTERVALOS } from '../lib/crypto/constantes'
import { fmtPrice } from '../lib/crypto/formato'
import { fmtPct, fmtNum, fmtFecha } from '../lib/formato'
import { FG_MIN_RUEDAS, velasNormalizadas, figurasSimbolo } from '../lib/crypto/figuras'
import { TIPOS_FIGURAS, NOMBRE_TIPO, ESTADOS_FIGURAS, COLOR_ESTADO_FIGURA, fmtHace } from '../lib/figuras'
import Tabla from '../components/Tabla'
import { useTabla } from '../lib/useTabla'
import ComoSeCalcula, { Formula } from '../components/ComoSeCalcula'
import { Vacio } from '../components/Estados'
import { TablaEvidenciaMultiple } from '../components/BadgeEvidencia'
import BotonEscanear, { AvisoParametros } from '../components/crypto/BotonEscanear'

// Figuras Chartistas — CRIPTO: mismo detector que la version stock
// (src/lib/crypto/figuras.js, port 1:1 de scripts/pipeline/figuras.py), pero
// escaneado en VIVO contra Binance Futures (no hay pipeline server-side
// posible: Binance geo-bloquea los runners de GitHub Actions, por eso TODO
// lo cripto de esta app corre 100% en el navegador). Dos acciones bien
// separadas en esta pagina:
//   1. Escaner en vivo (esta sección): solo corre cuando tocás "Escanear",
//      sobre la temporalidad que elijas.
//   2. Backtest (mas abajo): solo corre cuando tocás su propio botón, SIEMPRE
//      sobre velas diarias, y tarda minutos — separado a propósito para que
//      nunca se dispare por accidente ni comparta código con el escaner.

function Pestanas({ opciones, valor, onChange }) {
  return (
    <div role="tablist" className="mb-3 flex flex-wrap gap-1">
      {opciones.map((o) => (
        <button
          key={o.valor}
          type="button"
          role="tab"
          aria-selected={valor === o.valor}
          onClick={() => onChange(o.valor)}
          className={`rounded border px-2.5 py-1 text-xs ${
            valor === o.valor
              ? 'border-terminal-accent bg-terminal-accent/10 font-semibold text-terminal-accent'
              : 'border-terminal-border text-terminal-dim hover:text-terminal-text'
          }`}
        >
          {o.label} <span className="tabular text-terminal-dim">({o.n})</span>
        </button>
      ))}
    </div>
  )
}

function EstadoBadge({ estado, hace }) {
  return (
    <span className="whitespace-nowrap text-xs font-semibold" style={{ color: COLOR_ESTADO_FIGURA[estado] }}>
      {estado}
      {hace != null && <span className="font-normal text-terminal-dim"> · {fmtHace(hace)}</span>}
    </span>
  )
}

function detalleNiveles(detalle, tipo) {
  if (!detalle) return null
  if (tipo === 'doble_techo' || tipo === 'doble_piso') {
    return (
      <span
        title={`Extremo 1: ${fmtPrice(detalle.extremo_1?.precio)} (hace ${fmtHace(detalle.extremo_1?.hace)}) · Extremo 2: ${fmtPrice(detalle.extremo_2?.precio)} (hace ${fmtHace(detalle.extremo_2?.hace)})`}
      >
        {fmtPrice(detalle.extremo_1?.precio)} / {fmtPrice(detalle.extremo_2?.precio)}
      </span>
    )
  }
  return (
    <span
      title={`Hombro izq.: ${fmtPrice(detalle.hombro_izquierdo?.precio)} · Cabeza: ${fmtPrice(detalle.cabeza?.precio)} · Hombro der.: ${fmtPrice(detalle.hombro_derecho?.precio)}`}
    >
      {fmtPrice(detalle.hombro_izquierdo?.precio)} / {fmtPrice(detalle.cabeza?.precio)} / {fmtPrice(detalle.hombro_derecho?.precio)}
    </span>
  )
}

function PanelTipo({ tipo, filas }) {
  const { filtradas, sortKey, sortDir, ordenar } = useTabla(filas, { ordenInicial: { key: 'score', dir: 'desc' } })
  const info = TIPOS_FIGURAS.find((t) => t.tipo === tipo)

  const columnas = useMemo(
    () => [
      {
        key: 'symbol',
        label: 'Símbolo',
        valor: (r) => r.symbol,
        render: (r) => (
          <Link to={`/cripto/${encodeURIComponent(r.symbolRaw)}`} className="font-semibold hover:underline">
            {r.symbol}
          </Link>
        ),
      },
      { key: 'score', label: 'Score', align: 'right', ayuda: 'Score 0-100 de la figura', valor: (r) => r.score, render: (r) => <b className="text-terminal-text">{fmtNum(r.score, 0)}</b> },
      {
        key: 'niveles',
        label: info?.bajista ? 'Techos/Hombros' : 'Pisos/Hombros',
        ayuda: 'Precios de los extremos que forman la figura',
        valor: () => 0,
        render: (r) => detalleNiveles(r.detalle, tipo),
      },
      {
        key: 'neckline',
        label: 'Neckline',
        align: 'right',
        ayuda: 'Precio de la neckline hoy (interpolado si tiene pendiente)',
        valor: (r) => r.neckline_precio_hoy,
        render: (r) => fmtPrice(r.neckline_precio_hoy ?? r.detalle?.neckline_precio),
      },
      {
        key: 'dist',
        label: 'Dist. neckline',
        align: 'right',
        ayuda: 'Precio de hoy vs la neckline',
        valor: (r) => r.dist_neckline_pct,
        render: (r) => (r.dist_neckline_pct == null ? '—' : fmtPct(r.dist_neckline_pct, { signo: true })),
      },
      {
        key: 'chg24h',
        label: '24h %',
        align: 'right',
        ayuda: 'Variación real de las últimas 24 horas (ticker/24hr de Binance)',
        valor: (r) => r.chg24h,
        render: (r) => (r.chg24h == null ? '—' : <span style={{ color: r.chg24h >= 0 ? '#4ade80' : '#f87171' }}>{fmtPct(r.chg24h, { signo: true })}</span>),
      },
      {
        key: 'turnover',
        label: 'Volumen 24h',
        align: 'right',
        ayuda: 'Volumen negociado en 24h (USDT), ticker/24hr de Binance',
        valor: (r) => r.turnover,
        render: (r) => (r.turnover == null ? '—' : `$${(r.turnover / 1e6).toFixed(1)}M`),
      },
      {
        key: 'estado',
        label: 'Estado',
        valor: (r) => ESTADOS_FIGURAS.findIndex((e) => e.estado === r.estado),
        render: (r) => <EstadoBadge estado={r.estado} hace={r.hace_ruptura ?? r.hace_base} />,
      },
    ],
    [tipo, info],
  )

  return (
    <div>
      {filtradas.length === 0 ? (
        <Vacio texto={`Ningún ${NOMBRE_TIPO[tipo]} detectado en este escaneo (score ≥ 55).`} />
      ) : (
        <Tabla columnas={columnas} filas={filtradas} sortKey={sortKey} sortDir={sortDir} onSort={ordenar} />
      )}
    </div>
  )
}

function SeccionBacktest() {
  const { resultado, corriendo, progreso, errorMsg, correr } = useBacktestFiguras()
  const [tipoBt, setTipoBt] = useState('doble_techo')

  const textoProgreso = () => {
    if (!progreso) return '🧪 Correr backtest en tu navegador (puede tardar unos minutos)'
    if (progreso.etapa === 'universo') return '⏳ armando universo…'
    if (progreso.etapa === 'descarga') return `⏳ descargando velas: ${progreso.hecho}/${progreso.total}`
    if (progreso.etapa === 'deteccion') return `⏳ detectando figuras: ${progreso.hecho}/${progreso.total}`
    return '⏳ corriendo…'
  }

  return (
    <section className="mb-5 rounded-lg border border-terminal-border bg-terminal-panel p-3">
      <h2 className="mb-1 text-sm font-bold text-terminal-text">🧪 Backtest en tu navegador</h2>
      <p className="mb-3 max-w-3xl text-xs text-terminal-dim">
        No hay pipeline server-side posible para cripto (Binance geo-bloquea los runners de GitHub Actions), así que
        este backtest corre <b>en tu navegador</b>, bajando historial real de Binance Futures: un universo acotado
        (top ~40 perpetuos USDT por volumen + BTCUSDT como benchmark) y hasta 1000 velas <b>diarias</b> por símbolo
        (siempre diarias, sea cual sea la temporalidad del escáner de arriba — para que sea comparable). Tarda unos
        minutos y consume el mismo presupuesto de pedidos a Binance que el escáner en vivo.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={correr}
          disabled={corriendo}
          className="rounded bg-terminal-accent px-3 py-1.5 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50"
        >
          {corriendo ? textoProgreso() : resultado ? '🔁 Volver a correr el backtest' : '🧪 Correr backtest en tu navegador (puede tardar unos minutos)'}
        </button>
        {resultado && (
          <span className="text-xs text-terminal-dim">
            Última corrida en esta sesión: {fmtFecha(resultado.actualizado)} · {resultado.universo_n} símbolos ·{' '}
            {resultado.velas_por_simbolo} velas diarias pedidas
          </span>
        )}
      </div>
      {corriendo && (
        <div className="mb-3 h-1 w-full overflow-hidden rounded bg-terminal-border">
          <div
            className="h-full bg-terminal-accent transition-all"
            style={{ width: `${progreso?.total ? (progreso.hecho / progreso.total) * 100 : 5}%` }}
          />
        </div>
      )}
      {errorMsg && (
        <div className="mb-3 rounded border border-terminal-down/40 bg-terminal-down/10 px-3 py-2 text-xs text-terminal-down">
          Error: {errorMsg}
        </div>
      )}
      {!resultado ? (
        <p className="rounded border border-terminal-border bg-terminal-bg px-3 py-2 text-xs text-terminal-dim">
          Todavía no corriste el backtest en esta sesión — la detección de figuras de arriba funciona igual sin él,
          pero no hay evidencia medida todavía sobre qué tan bien (o mal) le fue históricamente a cada
          figura+estado.
        </p>
      ) : (
        <>
          <Pestanas
            valor={tipoBt}
            onChange={setTipoBt}
            opciones={TIPOS_FIGURAS.map((t) => ({ valor: t.tipo, label: `${t.emoji} ${t.nombre}`, n: '' }))}
          />
          <TablaEvidenciaMultiple
            ruta={['figuras_chartistas', tipoBt]}
            etiquetas={ESTADOS_FIGURAS.map((e) => e.estado)}
            horizonte={10}
            titulo={`estado de ${NOMBRE_TIPO[tipoBt]}`}
            datos={resultado}
            benchmarkLabel="BTC"
          />
        </>
      )}
    </section>
  )
}

export default function FigurasChartistasCripto() {
  const [intervalo, setIntervalo] = useState('4h')

  // Universo cripto con volumen (getUniverso, la misma función que usa
  // Cruces): trae de paso el % real de 24h y el volumen negociado, para
  // mostrarlos en la tabla sin pedirlos aparte (no hay "RS Score" en cripto,
  // así que esas dos columnas ocupan su lugar).
  const cargarSimbolos = useCallback(async () => {
    const { simbolos } = await getUniverso({ conFunding: false })
    return simbolos.map((s) => ({ symbol: s.symbol, chg24h: s.chg24hReal, turnover: s.turnover }))
  }, [])

  // Detecta las 4 figuras sobre las velas CERRADAS del símbolo (se descarta
  // la vela en curso, misma convención que analyzeKlines/calcTPSL). Un
  // símbolo puede aparecer con 0 a 4 figuras a la vez.
  const analizarFiguras = useCallback((symbol, klinesRaw, meta) => {
    const cerradas = klinesRaw.slice(0, -1)
    if (cerradas.length < FG_MIN_RUEDAS) return null
    const velas = velasNormalizadas(cerradas)
    const figuras = figurasSimbolo(velas)
    return { symbolRaw: symbol, symbol: symbol.replace('USDT', '/USDT'), figuras, ...meta }
  }, [])

  const parametros = useMemo(() => ({ intervalo }), [intervalo])
  const escaneo = useEscaneoBinance({
    cargarSimbolos,
    intervalo,
    analizar: analizarFiguras,
    parametros,
    ordenar: null, // se ordena por score DENTRO de cada pestaña de tipo, no la lista de símbolos
  })
  const { datos, corriendo, progreso, ultimaActualizacion, errorMsg, omitidos, parametrosEscaneo } = escaneo
  const cambiados = !corriendo && datos.length > 0 && parametrosCambiaron(parametrosEscaneo, parametros)

  const [tipo, setTipo] = useState('doble_techo')
  const porTipo = useMemo(() => {
    const m = Object.fromEntries(TIPOS_FIGURAS.map((t) => [t.tipo, []]))
    for (const fila of datos) {
      for (const fig of fila.figuras ?? []) {
        if (m[fig.tipo]) {
          m[fig.tipo].push({
            // 'ticker' es alias de symbolRaw: Tabla.jsx (compartido con las
            // páginas de acciones) usa row.ticker como key de React y para
            // los pines — acá no hay pines, pero la key sigue haciendo falta.
            ticker: fila.symbolRaw,
            symbolRaw: fila.symbolRaw,
            symbol: fila.symbol,
            chg24h: fila.chg24h,
            turnover: fila.turnover,
            ...fig,
          })
        }
      }
    }
    return m
  }, [datos])

  return (
    <div className="min-w-0">
      <div className="mb-3">
        <h1 className="text-lg font-bold text-terminal-text">📐 Figuras Chartistas (Cripto)</h1>
        <p className="max-w-3xl text-xs text-terminal-dim">
          Doble Techo, Doble Piso y Hombro-Cabeza-Hombro (HCH / HCH invertido) sobre futuros perpetuos USDT de
          Binance — mismo detector que la versión de acciones (mismo ZigZag adaptativo, mismos umbrales, mismo
          ciclo de vida y misma fórmula de score 0-100), portado 1:1 a JavaScript. Corre 100% en tu navegador: no
          se auto-actualiza, tenés que tocar <b>Escanear</b>.
        </p>
        <p className="mt-1 max-w-3xl text-xs text-terminal-warn">
          ⚠️ <b>¿En qué temporalidad ve el patrón?</b> La que elijas en el selector de abajo (1m a 1d) — a diferencia
          de las acciones, que <Formula>scripts/pipeline/figuras.py</Formula> analiza <b>siempre en velas diarias</b>
          {' '}(yfinance <Formula>interval="1d"</Formula>, sin excepción). Acá "150 velas" (la ventana de búsqueda) y
          "90 velas" (el mínimo de historia) son literalmente eso: 150/90 VELAS de la temporalidad elegida — 150
          velas de 1 minuto son 2,5 horas; 150 velas de 1 día son 5 meses. La geometría es idéntica en cualquier
          temporalidad, no hay ningún ajuste especial para cripto en los umbrales — pero una figura en 1m y la misma
          figura en 1d representan estructuras de mercado completamente distintas en escala de tiempo real.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="text-xs text-terminal-dim">Temporalidad</label>
        <select
          value={intervalo}
          onChange={(e) => setIntervalo(e.target.value)}
          className="rounded border border-terminal-border bg-terminal-panel px-2.5 py-1.5 text-sm text-terminal-text focus:border-terminal-accent focus:outline-none"
        >
          {INTERVALOS.map((i) => (
            <option key={i.valor} value={i.valor}>
              {i.etiqueta}
            </option>
          ))}
        </select>
        <BotonEscanear escaneo={escaneo} hayDatos={datos.length > 0} />
        {ultimaActualizacion && (
          <span className="text-xs text-terminal-dim">
            Actualizado: {ultimaActualizacion}
            {omitidos > 0 && (
              <span title="Símbolos sin fila: el pedido de velas falló o no tienen las 90 velas mínimas en esta temporalidad.">
                {' '}
                · {omitidos} omitidos
              </span>
            )}
          </span>
        )}
      </div>

      <AvisoParametros
        visible={cambiados}
        escaneados={`temporalidad ${parametrosEscaneo?.intervalo}`}
      />

      {corriendo && (
        <div className="mb-4 h-1 w-full overflow-hidden rounded bg-terminal-border">
          <div
            className="h-full bg-terminal-accent transition-all"
            style={{ width: `${progreso.total ? (progreso.hecho / progreso.total) * 100 : 0}%` }}
          />
        </div>
      )}

      {errorMsg && (
        <div className="mb-4 rounded border border-terminal-down/40 bg-terminal-down/10 px-3 py-2 text-xs text-terminal-down">
          Error: {errorMsg}
        </div>
      )}

      {!datos.length && !corriendo ? (
        <div className="mb-5 rounded-lg border border-terminal-border bg-terminal-panel p-10 text-center text-sm text-terminal-dim">
          Presioná <b>Escanear</b> para analizar todos los futuros perpetuos de Binance en la temporalidad elegida.
        </div>
      ) : (
        <section className="mb-5 min-w-0 rounded-lg border border-terminal-border bg-terminal-panel p-3">
          <Pestanas
            valor={tipo}
            onChange={setTipo}
            opciones={TIPOS_FIGURAS.map((t) => ({ valor: t.tipo, label: `${t.emoji} ${t.nombre}`, n: porTipo[t.tipo]?.length ?? 0 }))}
          />
          <PanelTipo tipo={tipo} filas={porTipo[tipo] ?? []} />
        </section>
      )}

      <SeccionBacktest />

      <ComoSeCalcula titulo="¿Cómo se calcula cada figura?" className="mt-2">
        <p>
          Mismo detector que la versión de acciones (<Formula>src/lib/crypto/figuras.js</Formula>, port 1:1 de{' '}
          <Formula>scripts/pipeline/figuras.py</Formula>): las 4 figuras se detectan sobre un ZigZag adaptativo con
          umbral <Formula>max(3%, 1,5 × ATR14%)</Formula> sobre una ventana de ~150 velas (más ancha que la de un VCP:
          el HCH necesita 5 swings y tarda más en formarse).
        </p>
        <p>
          <b className="text-terminal-text">⛰️ Doble Techo</b> (bajista) / <b className="text-terminal-text">🏔️ Doble Piso</b>{' '}
          (alcista): dos swings del mismo signo dentro de <Formula>±3%</Formula> entre sí, separados por exactamente
          un swing intermedio que esté al menos <Formula>5%</Formula> más allá de los dos extremos — esa neckline no
          puede tener más de 40 velas de antigüedad en su segundo extremo. Ruptura: cierre del otro lado de la
          neckline.
        </p>
        <p>
          <b className="text-terminal-text">👤 Hombro-Cabeza-Hombro</b> (bajista) /{' '}
          <b className="text-terminal-text">🙃 HCH Invertido</b> (alcista): 5 swings consecutivos
          hombro-valle-cabeza-valle-hombro con la cabeza al menos <Formula>3%</Formula> más allá que el promedio de
          los dos hombros, hombros dentro de <Formula>±5%</Formula> entre sí. La neckline conecta los dos
          valles/picos intermedios (puede tener pendiente); si difieren más de <Formula>8%</Formula> se descarta
          (sería un canal, no un cuello).
        </p>
        <p>
          <b className="text-terminal-text">Score (0-100)</b>: doble techo/piso ={' '}
          <Formula>simetría (35) + profundidad en ATR14% (35) + volumen (30)</Formula>; HCH/invertido ={' '}
          <Formula>simetría de hombros (30) + prominencia de la cabeza en ATR14% (35) + volumen (35)</Formula>. Solo
          se muestran figuras con score ≥ 55.
        </p>
        <p>
          <b className="text-terminal-text">Estado</b> (ciclo de vida — para saber si ya rompió se re-detecta la
          figura cortando el historial en cada una de las últimas 15 velas, porque la ruptura crea un swing nuevo y
          la detección de hoy ya no ve la figura vieja): Formándose → Recién rompió → Rompió y confirmó / Rompió sin
          confirmar, o Falló antes de romper / Rompió y falló si el precio invalidó la figura.
        </p>
        <p>
          <b className="text-terminal-warn">¿En qué temporalidad?</b> La que elijas arriba (1m/3m/15m/1h/4h/1d) —
          las <i>acciones</i> siempre se analizan en velas <b>diarias</b> (single temporalidad, fija); en{' '}
          <i>cripto</i> el usuario elige, y "150 velas" / "90 velas" son cantidades de velas de ESA temporalidad, no
          un período de tiempo fijo. El backtest de más arriba, en cambio, siempre corre sobre velas diarias (para
          que sea comparable entre sí y con la versión stock), sea cual sea la temporalidad que tengas elegida acá.
        </p>
        <p>
          <b className="text-terminal-warn">Ojo</b>: acá no hay "RS Score" (percentil de Fuerza Relativa vs. un
          índice) porque no existe un benchmark equivalente a SPY para todo el universo cripto — se muestran 24h % y
          volumen 24h en su lugar. El badge de evidencia de la sección de backtest usa <Formula>BTCUSDT</Formula>{' '}
          como benchmark en su lugar, y solo aparece después de correr el backtest al menos una vez en esta sesión.
        </p>
      </ComoSeCalcula>
    </div>
  )
}
