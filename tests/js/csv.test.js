import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportarCSV } from '../../src/lib/csv.js'

// exportarCSV arma un Blob y dispara la descarga con un <a>: en Node se
// stubbea document y se captura el Blob que recibe URL.createObjectURL.
let blob
let link

beforeEach(() => {
  blob = null
  link = null
  vi.stubGlobal('document', {
    createElement: () => {
      link = { click: vi.fn() }
      return link
    },
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
  })
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
    blob = b
    return 'blob:falso'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Blob.text() se come el BOM: se decodifica a mano para verlo.
async function csvDe(columnas, filas) {
  exportarCSV('salida.csv', columnas, filas)
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await blob.arrayBuffer())
}

describe('exportarCSV', () => {
  it('separador ;, coma decimal, BOM UTF-8 y CRLF', async () => {
    const texto = await csvDe(
      [
        { key: 'ticker', label: 'Ticker' },
        { key: 'var', label: 'Var %' },
      ],
      [
        { ticker: 'AAPL', var: 1.25 },
        { ticker: 'KO', var: -3.5 },
      ],
    )
    expect(texto.charCodeAt(0)).toBe(0xfeff)
    expect(texto.slice(1)).toBe('Ticker;Var %\r\nAAPL;1,25\r\nKO;-3,5')
    expect(blob.type).toContain('text/csv')
    expect(link.download).toBe('salida.csv')
    expect(link.click).toHaveBeenCalled()
  })

  it('neutraliza formulas (inyeccion CSV) solo en textos', async () => {
    const filas = [
      { v: '=HYPERLINK("http://x")' },
      { v: '+1' },
      { v: '-2' },
      { v: '@SUM(A1)' },
      { v: '\tTAB' },
      { v: -2 },
      { v: 'Normal' },
    ]
    const lineas = (await csvDe([{ key: 'v', label: 'V' }], filas)).slice(1).split('\r\n').slice(1)
    expect(lineas).toEqual([
      `"'=HYPERLINK(""http://x"")"`, // apostrofo + comillas escapadas
      "'+1",
      "'-2",
      "'@SUM(A1)",
      "'\tTAB",
      '-2', // un numero negativo es un numero
      'Normal',
    ])
  })

  it('escapa separador, comillas y saltos de linea', async () => {
    const texto = await csvDe([{ key: 'v', label: 'V' }], [{ v: 'a;b' }, { v: 'dijo "hola"' }, { v: 'linea1\nlinea2' }])
    expect(texto.slice(1).split('\r\n').slice(1)).toEqual(['"a;b"', '"dijo ""hola"""', '"linea1\nlinea2"'])
  })

  it('nulos, NaN, infinitos y booleanos', async () => {
    const cols = ['a', 'b', 'c', 'd', 'e'].map((k) => ({ key: k, label: k }))
    const texto = await csvDe(cols, [{ a: null, b: undefined, c: NaN, d: Infinity, e: true }, { e: false }])
    expect(texto.slice(1).split('\r\n').slice(1)).toEqual([';;;;Sí', ';;;;No'])
  })

  it('valorCSV > valor > key, y csv:false saca la columna', async () => {
    const texto = await csvDe(
      [
        { key: 'x', label: 'X', valor: () => 'desde valor', valorCSV: (r) => `csv ${r.x}` },
        { key: 'y', label: 'Y', valor: (r) => r.y * 2 },
        { key: 'z', label: 'Z', csv: false },
      ],
      [{ x: 1, y: 2.5, z: 'oculto' }],
    )
    expect(texto.slice(1)).toBe('X;Y\r\ncsv 1;5')
  })
})
