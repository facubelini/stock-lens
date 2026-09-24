#!/usr/bin/env node
// Se corre solo (predev) antes de "npm run dev": si falta public/data/listado.json
// (la rama `datos` nunca se trajo al working tree) avisa como traerlo. Nunca
// bloquea el arranque de Vite: solo imprime un mensaje y sigue (exit 0
// siempre), aunque falte el archivo.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const listado = path.join(raiz, 'public', 'data', 'listado.json')

if (!existsSync(listado)) {
  console.log('')
  console.log('⚠️  Falta public/data/listado.json: el Listado (y casi toda la app) va a mostrar')
  console.log('    "no se pudo cargar" hasta que traigas los datos publicados.')
  console.log('    Corré:  npm run datos')
  console.log('    (trae public/data desde la rama `datos` del repo remoto; ver README § "Rama de datos")')
  console.log('')
}
