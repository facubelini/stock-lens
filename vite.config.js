import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 'base' debe coincidir con el nombre del repositorio en GitHub Pages.
// Solo se aplica en el BUILD de produccion; en dev usamos '/' para que el
// servidor sirva la app en la raiz (mas comodo para previsualizar).
// Si el repo se llama distinto, cambia '/stock-lens/' por '/mi-repo/'.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/stock-lens/' : '/',
  server: {
    port: 5179,
    strictPort: true,
  },
}))
