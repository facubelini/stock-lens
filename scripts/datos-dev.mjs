#!/usr/bin/env node
// npm run datos
//
// Trae public/data/ (y, con --estado, tambien data/ estado/caches) desde la
// rama huerfana `datos` del remoto, para dev/build locales. Usa
// "git archive <ref> <paths...> | tar -x": extrae SOLO esos archivos al
// working tree, sin tocar el indice/HEAD de `main` (no aparecen como
// staged/tracked en git status: la rama `datos` sigue siendo la unica
// fuente de verdad para esos paths). Necesita `tar` en el PATH (viene de
// fabrica en Windows 10/11, macOS y cualquier distro Linux/Git Bash).
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const conEstado = args.includes('--estado')
const remoto = (() => {
  const i = args.indexOf('--remote')
  return i !== -1 && args[i + 1] ? args[i + 1] : 'origin'
})()

// execSync (un solo string de shell, no execFile+args): así el pipe '|' de
// más abajo lo resuelve el shell, no node, y no hay warning de escapeo.
function correr(comando, opts = {}) {
  return execSync(comando, { cwd: raiz, stdio: 'inherit', ...opts })
}

try {
  execSync('git rev-parse --is-inside-work-tree', { cwd: raiz, stdio: 'ignore' })
} catch {
  console.error('✗ Esto no es un repo git (¿corriste npm install fuera del clone?).')
  process.exit(1)
}

console.log(`Trayendo la rama '${remoto}/datos'...`)
try {
  correr(`git fetch --depth=1 ${remoto} datos`)
} catch {
  console.error(`✗ No se pudo traer la rama 'datos' de '${remoto}'.`)
  console.error('  ¿Ya se hizo la migración (ver README, "Rama de datos")? ¿El remoto se llama distinto?')
  console.error('  Probá: npm run datos -- --remote <nombre-del-remoto>')
  process.exit(1)
}

const rutas = conEstado ? ['public/data', 'data'] : ['public/data']
console.log(`Extrayendo ${rutas.join(' + ')} de FETCH_HEAD...`)
try {
  // git archive imprime a stdout; tar -x lo lee de stdin y escribe en cwd.
  correr(`git archive FETCH_HEAD ${rutas.join(' ')} | tar -x`)
} catch (e) {
  console.error('✗ Falló la extracción (¿falta `tar` en el PATH?).', e.message)
  process.exit(1)
}

console.log(`✓ Listo: ${rutas.join(', ')} actualizados desde ${remoto}/datos.`)
if (!conEstado) {
  console.log('  (Tip: "npm run datos -- --estado" también trae data/ —los caches del pipeline— si vas a correr los scripts de Python localmente.)')
}
