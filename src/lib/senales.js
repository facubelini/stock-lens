// Datos compartidos de la pagina Señales (pages/Senales.jsx) y la ficha del
// ticker ("También destaca en"). Los calculos viven en
// scripts/generar_datos.py (sen_contactos_ema / ws_ciclo_vcp /
// sen_rsi_semanal / construir_senales); aca solo se formatean.

// Paneles de la pagina: el id es el ancla (/senales?panel=<id>&tab=<tab>).
export const PANELES = {
  cartelera: { id: 'cartelera', titulo: '📰 Cartelera del día' },
  emaDiaria: { id: 'ema-diaria', titulo: '📈 EMA200 Diaria: Rebote / Cruce' },
  emaSemanal: { id: 'ema-semanal', titulo: '🎯 EMA200 Semanal: Rebote / Cruce' },
  vcp: { id: 'vcp', titulo: '🧬 Bases VCP de Alta Calidad' },
  rsiSemanal: { id: 'rsi-semanal', titulo: '📶 RSI Semanal: Cruce en su SMA14' },
}

// Estados del ciclo de vida de la base VCP (ws_ciclo_vcp), en orden de
// "madurez", con su color.
export const ESTADOS_VCP = [
  { estado: 'Formándose', color: '#7d8b9c' },
  { estado: 'Armado', color: '#f5a524' },
  { estado: 'Recién rompió', color: '#4ade80' },
  { estado: 'Rompió y confirmó', color: '#16a34a' },
  { estado: 'Rompió sin confirmar', color: '#fbbf24' },
  { estado: 'Falló antes de romper', color: '#f97316' },
  { estado: 'Rompió y falló', color: '#ef4444' },
]
export const COLOR_ESTADO_VCP = Object.fromEntries(ESTADOS_VCP.map((e) => [e.estado, e.color]))

function plural(n, uno, varios) {
  return `${n} ${n === 1 ? uno : varios}`
}

// Hace cuanto fue el contacto / cruce: 0 = la vela actual.
export function fmtHace(hace, semanal = false) {
  if (hace == null) return '—'
  if (semanal) return hace === 0 ? 'esta semana' : plural(hace, 'semana', 'semanas')
  return hace === 0 ? 'hoy' : plural(hace, 'rueda', 'ruedas')
}

// Dias corridos -> "12 días" / "5 meses" / "3,6 años".
export function fmtUltimaVez(dias) {
  if (dias == null) return '—'
  if (dias < 45) return plural(dias, 'día', 'días')
  if (dias < 365) return plural(Math.round(dias / 30.44), 'mes', 'meses')
  const anios = dias / 365.25
  return `${anios.toLocaleString('es-AR', { maximumFractionDigits: 1 })} ${anios < 1.05 ? 'año' : 'años'}`
}

export function urlPanel(panel, tab) {
  const q = new URLSearchParams({ panel })
  if (tab) q.set('tab', tab)
  return `/senales?${q}`
}

// Paneles de senales.json donde aparece hoy `ticker` (para la ficha).
export function panelesDelTicker(senales, ticker) {
  if (!senales || !ticker) return []
  const t = ticker.toUpperCase()
  const es = (f) => String(f.ticker).toUpperCase() === t
  const salida = []
  const ema = [
    ['diario', PANELES.emaDiaria, '📈 EMA200 Diaria'],
    ['semanal', PANELES.emaSemanal, '🎯 EMA200 Semanal'],
  ]
  for (const [tf, panel, nombre] of ema) {
    for (const [tab, etiqueta] of [['rebote', 'Rebote'], ['cruce', 'Cruce al alza']]) {
      const f = senales.ema200?.[tf]?.[tab]?.find(es)
      if (f) salida.push({ key: `${tf}-${tab}`, to: urlPanel(panel.id, tab), texto: `${nombre}: ${etiqueta}`, detalle: fmtHace(f.hace, tf === 'semanal') })
    }
  }
  const vcp = senales.vcp?.find(es)
  if (vcp) {
    salida.push({
      key: 'vcp',
      to: urlPanel(PANELES.vcp.id),
      texto: `🧬 Bases VCP de Alta Calidad — VCP Score ${Math.round(vcp.score)}`,
      detalle: vcp.estado,
    })
  }
  for (const [tab, etiqueta] of [['alcista', 'cruce alcista'], ['bajista', 'cruce bajista']]) {
    const f = senales.rsi_semanal?.[tab]?.find(es)
    if (f) salida.push({ key: `rsi-${tab}`, to: urlPanel(PANELES.rsiSemanal.id, tab), texto: `📶 RSI semanal: ${etiqueta}`, detalle: fmtHace(f.hace, true) })
  }
  return salida
}
