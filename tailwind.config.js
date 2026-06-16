/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Tipografia monoespaciada para todo (estilo terminal financiera).
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        sans: ['Inter', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        // Paleta dark tipo Bloomberg / terminal.
        terminal: {
          bg: '#070a0f',        // fondo casi negro
          panel: '#0d131c',     // tarjetas / paneles
          panel2: '#111a25',    // hover / encabezados de grupo
          border: '#1d2733',    // bordes sutiles
          text: '#c9d4e0',      // texto principal
          dim: '#7d8b9c',       // texto secundario
          accent: '#f5a524',    // acento ambar (branding)
          up: '#22c55e',        // sube
          down: '#ef4444',      // baja
          info: '#38bdf8',      // info / sobreventa
          warn: '#f97316',      // sobrecompra
        },
      },
    },
  },
  plugins: [],
}
