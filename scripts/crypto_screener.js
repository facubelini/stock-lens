// Corre el mismo motor del Crypto Screener (src/lib/crypto/*) fuera del
// navegador, en Node, para dejar un snapshot + registro historico de
// precios/señales sin depender de que el usuario tenga la pestaña abierta.
// Reusa las mismas funciones puras que usa la UI (fetch a Binance +
// analyzeKlines) — cero logica duplicada entre el scan manual y este
// snapshot automatico.
//
// Uso:
//   node scripts/crypto_screener.js

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeKlines } from '../src/lib/crypto/indicadores.js'
import { getKlines, getSymbols, sleep } from '../src/lib/crypto/binanceApi.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RAIZ = path.resolve(__dirname, '..')
const DIR_SALIDA = path.join(RAIZ, 'public', 'data')
const RUTA_SNAPSHOT = path.join(DIR_SALIDA, 'crypto_screener.json')
const RUTA_HISTORIAL = path.join(DIR_SALIDA, 'crypto_historial.json')

// Mismos defaults que ve un usuario al abrir la pestaña sin tocar nada.
const INTERVALO = '1h'
const MULTIPLO_ATR = 2.0
const TAMANO_LOTE = 15
const DIAS_HISTORIAL = 90 // a 2 corridas/dia, ~180 entradas como techo

async function escanear() {
  const symbols = await getSymbols()
  const resultados = []
  for (let i = 0; i < symbols.length; i += TAMANO_LOTE) {
    const lote = symbols.slice(i, Math.min(i + TAMANO_LOTE, symbols.length))
    const parciales = await Promise.all(
      lote.map(async (s) => {
        const k = await getKlines(s, INTERVALO, 200)
        return analyzeKlines(s, k, MULTIPLO_ATR)
      }),
    )
    resultados.push(...parciales.filter(Boolean))
    console.log(`  ${Math.min(i + TAMANO_LOTE, symbols.length)}/${symbols.length}`)
    if (i + TAMANO_LOTE < symbols.length) await sleep(150)
  }
  resultados.sort((a, b) => a.score - b.score)
  return resultados
}

async function leerJsonSiExiste(ruta) {
  if (!existsSync(ruta)) return null
  try {
    return JSON.parse(await readFile(ruta, 'utf-8'))
  } catch {
    return null
  }
}

async function actualizarHistorial(resultados, ahoraIso) {
  let historial = await leerJsonSiExiste(RUTA_HISTORIAL)
  if (!Array.isArray(historial)) historial = []

  historial.push({
    fecha_hora: ahoraIso,
    tickers: Object.fromEntries(
      resultados.map((r) => [r.symbol, { precio: r.price, score: r.score, cls: r.cls }]),
    ),
  })

  const corte = Date.now() - DIAS_HISTORIAL * 24 * 60 * 60 * 1000
  return historial.filter((h) => new Date(h.fecha_hora).getTime() >= corte)
}

async function main() {
  console.log(`Escaneando futuros perpetuos USDT (temporalidad ${INTERVALO})...`)
  const resultados = await escanear()
  const ahoraIso = new Date().toISOString()

  await mkdir(DIR_SALIDA, { recursive: true })

  await writeFile(
    RUTA_SNAPSHOT,
    JSON.stringify({ actualizado: ahoraIso, intervalo: INTERVALO, resultados }, null, 2),
  )
  console.log(`-> ${path.relative(RAIZ, RUTA_SNAPSHOT)} (${resultados.length} simbolos)`)

  const historial = await actualizarHistorial(resultados, ahoraIso)
  await writeFile(RUTA_HISTORIAL, JSON.stringify(historial, null, 2))
  console.log(`-> ${path.relative(RAIZ, RUTA_HISTORIAL)} (${historial.length} corridas registradas)`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
