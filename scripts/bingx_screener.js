// Genera public/data/bingx_screener.json: el screener v3 sobre los perpetuos
// de BingX, que tiene ~928 pares USDT contra ~526 de Binance.
//
// POR QUE ES UN PIPELINE Y NO UN ESCANEO EN VIVO: BingX no manda
// 'Access-Control-Allow-Origin', asi que el navegador bloquea el fetch por
// CORS. Verificado desde el sitio publicado: Binance responde y BingX tira
// "Failed to fetch". Desde Node no hay CORS, asi que corre en GitHub Actions
// y commitea el JSON, igual que el pipeline de acciones.
//
// Reusa el motor del v2 (src/lib/crypto/v2/*) sin duplicar logica: el
// adaptador de BingX normaliza las klines al formato de arrays de Binance.
//
// Uso:
//   node scripts/bingx_screener.js

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getUniversoV3, getKlinesV3, sleep } from '../src/lib/crypto/v3/bingxApi.js'
import { velasCerradas, calcularSeries } from '../src/lib/crypto/v2/indicadores.js'
import { armarFila } from '../src/lib/crypto/v2/senal.js'
import { backtestSimbolo, estadisticas } from '../src/lib/crypto/v2/backtest.js'
import { SL_ATR_DEFAULT, TP_R_DEFAULT, FRACCION_TRAIN } from '../src/lib/crypto/v2/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RAIZ = path.resolve(__dirname, '..')
const DIR_SALIDA = path.join(RAIZ, 'public', 'data')
const RUTA = path.join(DIR_SALIDA, 'bingx_screener.json')

// BingX mueve ~10x menos volumen que Binance (BTC ~$900M vs ~$9.6B), asi que
// el piso de liquidez se escala: $2M aca es comparable a ~$20M alla.
const PISO_LIQUIDEZ = 2_000_000
const MAX_SIMBOLOS = 260 // techo para acotar la corrida del workflow
const ENTRADA = '1h'
const TENDENCIA = '4h'
const VELAS_ENTRADA = 1000 // maximo de BingX
const VELAS_TENDENCIA = 600
const TAMANO_LOTE = 6 // 2 llamadas por simbolo; BingX es mas sensible que Binance
const PAUSA_MS = 250

async function main() {
  console.log('Universo BingX...')
  const uni = await getUniversoV3({ minTurnover: PISO_LIQUIDEZ })
  const lista = uni.simbolos.slice(0, MAX_SIMBOLOS)
  console.log(
    `  ${uni.totalDisponible} perpetuos USDT · ${uni.descartadosPorLiquidez} bajo $${
      PISO_LIQUIDEZ / 1e6
    }M · se analizan ${lista.length}` +
      (uni.simbolos.length > MAX_SIMBOLOS
        ? ` (se recortaron ${uni.simbolos.length - MAX_SIMBOLOS} por el techo de ${MAX_SIMBOLOS})`
        : ''),
  )

  const filas = []
  // Trades acumulados de las 3 reglas x (train,test) para el backtest agregado.
  const acum = { v2: { train: [], test: [] }, v1: { train: [], test: [] }, piso: { train: [], test: [] } }
  let omitidos = 0
  let fallos = 0

  for (let i = 0; i < lista.length; i += TAMANO_LOTE) {
    const lote = lista.slice(i, Math.min(i + TAMANO_LOTE, lista.length))
    const parciales = await Promise.all(
      lote.map(async (meta) => {
        const [kE, kT] = await Promise.all([
          getKlinesV3(meta.symbol, ENTRADA, VELAS_ENTRADA),
          getKlinesV3(meta.symbol, TENDENCIA, VELAS_TENDENCIA),
        ])
        if (!kE || !kT) return { error: true }
        const cE = velasCerradas(kE)
        const cT = velasCerradas(kT)
        if (cE.length < 220 || cT.length < 2) return { omitido: true }
        const sE = calcularSeries(cE)
        const sT = calcularSeries(cT)
        const fila = armarFila({
          symbol: meta.symbol,
          seriesEntrada: sE,
          seriesTendencia: sT,
          meta,
          intervaloEntrada: ENTRADA,
          atrMult: SL_ATR_DEFAULT,
          feePct: meta.feeTakerPct,
          rMultiploTP: TP_R_DEFAULT,
        })
        if (!fila) return { omitido: true }
        // Backtest del simbolo, con la misma separacion train/test que la v2.
        const bt = backtestSimbolo({
          sE,
          sT,
          intervaloEntrada: ENTRADA,
          atrMult: SL_ATR_DEFAULT,
          feePct: meta.feeTakerPct,
          fundingPct: meta.fundingPct ?? 0,
          rMultiploTP: TP_R_DEFAULT,
        })
        return { fila, bt, velas: cE.length }
      }),
    )

    for (const p of parciales) {
      if (p.error) fallos++
      else if (p.omitido) omitidos++
      else {
        filas.push(p.fila)
        for (const k of Object.keys(acum)) {
          acum[k].train.push(...p.bt[k].train)
          acum[k].test.push(...p.bt[k].test)
        }
      }
    }
    const hecho = Math.min(i + TAMANO_LOTE, lista.length)
    console.log(`  ${hecho}/${lista.length} (${filas.length} con señal calculada)`)
    if (hecho < lista.length) await sleep(PAUSA_MS)
  }

  // El link va a BingX, no a Binance (armarFila arma el de Binance por defecto).
  for (const f of filas) {
    f.link = `https://bingx.com/es-es/perpetual/${f.base}-USDT`
  }
  filas.sort((a, b) => b.conviccion - a.conviccion)

  const backtest = {}
  for (const k of Object.keys(acum)) {
    backtest[k] = { train: estadisticas(acum[k].train), test: estadisticas(acum[k].test) }
  }

  const salida = {
    actualizado: new Date().toISOString(),
    exchange: 'BingX',
    config: {
      entrada: ENTRADA,
      tendencia: TENDENCIA,
      velasEntrada: VELAS_ENTRADA,
      slAtr: SL_ATR_DEFAULT,
      tpR: TP_R_DEFAULT,
      pisoLiquidez: PISO_LIQUIDEZ,
      fraccionTrain: FRACCION_TRAIN,
    },
    universo: {
      totalDisponible: uni.totalDisponible,
      descartadosPorLiquidez: uni.descartadosPorLiquidez,
      analizados: filas.length,
      omitidosSinHistorial: omitidos,
      fallosDeRed: fallos,
      recortadosPorTecho: Math.max(0, uni.simbolos.length - MAX_SIMBOLOS),
    },
    backtest,
    filas,
  }

  await mkdir(DIR_SALIDA, { recursive: true })
  await writeFile(RUTA, JSON.stringify(salida, null, 1))
  const operables = filas.filter((f) => f.veredicto === 'COMPRA' || f.veredicto === 'VENTA').length
  console.log(
    `Listo: ${filas.length} filas (${operables} operables), ${omitidos} sin historial, ${fallos} fallos de red.`,
  )
  console.log(
    `Backtest v2 -> train ${backtest.v2.train.expectativa} R (n=${backtest.v2.train.trades}) · ` +
      `test ${backtest.v2.test.expectativa} R (n=${backtest.v2.test.trades})`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
