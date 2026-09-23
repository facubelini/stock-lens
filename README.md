# 🔍 Stock Lens

Webapp estática (en español) para analizar acciones a partir de un listado de
tickers en Excel. Muestra el análisis en **tres pestañas independientes**:

1. **Listado** — Variación % del día + RSI(14), en **recuadros por industria** (cada uno con su promedio).
2. **Medias móviles** — Distancia % del precio a EMA21, EMA50, EMA150 y SMA200 (diario).
3. **Fundamentales** — PER (trailing/forward), PEG, EV/Sales, P/B, P/S, market cap, EPS, margen, ROE, dividend yield y beta.

Todas las pestañas tienen **buscador, filtros por país e industria, ordenamiento por columna,
★ favoritos** (se guardan en el navegador y quedan fijados arriba) y **exportar a CSV**.

## Cómo funciona

- **No hay API en runtime.** Un pipeline de Python (`yfinance`) corre en GitHub
  Actions y genera archivos **JSON estáticos** versionados en el repo. El
  frontend (React + Vite + Tailwind) sólo hace `fetch` a esos JSON.
- Esto evita API keys, problemas de CORS y dependencias pagas.
- ⚠️ **Los datos no son en tiempo real tick a tick.** Reflejan la última corrida
  del pipeline. La fecha se muestra siempre en el header (zona horaria de Buenos Aires).

## Estructura

```
data/
  tickers.xlsx             # input: tu listado de tickers (lo cargás vos)
  historico_tickers.json   # tickers del "Histórico fundamental" (editable desde la app)
  ratios_cedear_manual.json# ratios CEDEAR que no están en el listado de Comafi
  screener_historial.json  # estado: historial maestro de señales (NO se publica)
  invalidos_cache.json     # estado: tickers sin datos, no se reintentan por 7 días
  comparables_cache.json   # estado: .info de los peers de comparables (cache diario)
  cik_cache.json           # estado: ticker -> CIK de la SEC
scripts/
  requirements.txt         # versiones exactas (pineadas)
  comun.py                 # utilidades compartidas (RSI único, num, JSON atómico/minificado)
  generar_datos.py         # pipeline real (lee Excel -> calcula -> escribe JSON)
  mercado_macro.py         # VIX, yield curve, Fear & Greed, CPI/desempleo/Fed
  historico_fundamental.py # P/E, EV/Sales, P/S históricos (SEC EDGAR)
  backtests.py             # backtest del Screener + Score (una sola descarga)
  generar_datos_mock.py    # datos sintéticos para desarrollar la UI sin red
  crear_tickers_ejemplo.py # crea un data/tickers.xlsx de ejemplo
public/data/               # salida publicada (JSON minificados)
  listado.json, medias.json, fundamentales.json, comparables.json, screener.json,
  scanner_setups.json, warren_score.json, oportunidades_historial.json,
  mercado_macro.json, historico_fundamental.json, backtest_*.json, meta.json
  historial/<TICKER>.json  # historial de señales del screener (90 días) por ticker
  mensual/<TICKER>.json    # cierres de fin de mes (5 años) por ticker
src/                        # frontend React (pages/, components/, lib/)
.github/
  actions/commit-datos/    # commit + push con reintento (compartido por los workflows)
  workflows/
    datos.yml              # pipeline de acciones + macro, commitea los JSON
    historico.yml          # histórico fundamental (semanal)
    backtest.yml           # backtests (mensual)
    deploy.yml             # build + deploy a GitHub Pages
```

## El Excel de entrada (`data/tickers.xlsx`)

Una hoja con (al menos) la columna de tickers en la primera fila. **Solo la
columna de tickers es obligatoria**; el resto, si no está, se completa solo
desde Yahoo Finance:

| Columna                   | Obligatoria | Descripción |
|---------------------------|-------------|-------------|
| `Ticker` (o `Código`/`Symbol`) | Sí     | Símbolo tal cual lo usa Yahoo Finance (ej. `AAPL`, `YPF`, `GGAL.BA`) |
| `Industria`               | No          | Para agrupar. Si falta, se usa el **sector** de yfinance |
| `Pais`                    | No          | Para el filtro por país. Si falta, se usa el **country** de yfinance |
| `Nombre`                  | No          | Nombre legible. Si falta, el que devuelva yfinance |

Así, un Excel con una sola columna de tickers ya funciona: la app clasifica
cada acción por sector y país automáticamente.

Si un ticker no devuelve datos, queda registrado en `meta.json`
(`tickers_invalidos`) y el resto se procesa igual.

> 💡 Para acciones argentinas en el mercado local, usá el sufijo `.BA`
> (ej. `GGAL.BA`). Sin sufijo, `GGAL`/`YPF`/`PAM`/`BMA` son los ADRs de NYSE.

## Uso local

### 1. Frontend

```bash
npm install
npm run dev      # servidor de desarrollo (http://localhost:5179)
npm run build    # build de producción a dist/
npm run preview  # previsualizar el build
```

### 2. Generar datos

Creá el entorno de Python e instalá dependencias:

```bash
python -m venv scripts/.venv
# Windows PowerShell:
scripts/.venv/Scripts/Activate.ps1
# Linux/Mac:
source scripts/.venv/bin/activate

pip install -r scripts/requirements.txt
```

Si todavía no tenés tu Excel, generá uno de ejemplo:

```bash
python scripts/crear_tickers_ejemplo.py   # crea data/tickers.xlsx
```

Corré el pipeline real (descarga de yfinance, necesita internet):

```bash
python scripts/generar_datos.py
```

Para probar un cambio sin tocar los datos reales, restringí el universo y
mandá la salida y el estado a carpetas temporales:

```bash
python scripts/generar_datos.py --tickers AAPL,KEP,GGAL.BA,SPY --out /tmp/sl --estado /tmp/sl-estado
python scripts/generar_datos.py --limite 20 --out /tmp/sl --estado /tmp/sl-estado
```

¿Querés sólo ver la UI sin descargar nada? Usá datos sintéticos (escriben en
una carpeta temporal; para pisar `public/data/` hay que pedirlo con
`--out public/data --forzar`):

```bash
python scripts/generar_datos_mock.py --out /tmp/sl-mock
```

### Cómo se comporta el pipeline

- **Descarga en lote** (`yf.download`) con reintentos; los tickers que ya
  resolvieron alguna vez usan siempre el mismo símbolo (no saltan de plaza
  `.BA`/`.SA` por un fallo puntual). Sólo los que nunca resolvieron prueban
  sufijos.
- **Basura del Excel** (DIVIDENDOS, EFECTIVO, bonos AL/GD...) se descarta por
  regla; los tickers sin datos van a `data/invalidos_cache.json` y no se
  reintentan durante 7 días.
- **Arrastre:** si un ticker falla (red o error de cálculo) se publica su último
  dato bueno con `stale: true` y `actualizado` (timestamp de la última descarga
  buena). Pasados 7 días se descarta.
- **Salvaguarda:** si menos del 50% de los tickers intentados trae datos frescos
  (rate-limit de Yahoo), aborta sin escribir nada y sale con error (el workflow
  queda en rojo).
- **Sin commits vacíos:** los JSON se escriben minificados, de forma atómica y
  sólo si cambiaron; las filas no llevan timestamp propio (está en
  `meta.json`), así una corrida sin novedades no genera commit ni deploy.
- **Monedas:** `fundamentales.json` trae `moneda` y `market_cap_usd` (ARS con el
  CCL implícito mediano de la corrida, el resto con `USD{M}=X`). Si el precio y
  los balances están en monedas distintas, P/S, P/B y EV/Sales van en `null`
  (y también el PER cuando la cotización no es en USD). Las medianas de
  comparables sólo usan tickers en USD.

## Actualizar los datos en producción

- **Automático:** el workflow **`Actualizar datos`** corre por cron 5 veces por
  día hábil (pre-market, apertura, mediodía, cierre, post-market; los horarios
  están corridos porque GitHub arranca los crons con horas de atraso). Incluye
  los indicadores de mercado/macro. Editá el `schedule` en
  [`.github/workflows/datos.yml`](.github/workflows/datos.yml) para cambiar la frecuencia.
- Los workflows de datos (`Actualizar datos`, `Historico fundamental`,
  `Backtest Screener`) comparten un grupo de `concurrency`: nunca corren dos a
  la vez, así que no se pisan los pushes.
- **Manual:** GitHub → pestaña **Actions** → workflow **"Actualizar datos"** →
  **Run workflow**.

Cuando el pipeline commitea JSON nuevos, el workflow **`Deploy a GitHub Pages`**
se dispara solo (vía `workflow_run`) y vuelve a publicar el sitio. Si la corrida
no commiteó nada, no se deploya.

### Cambiar de tickers

1. Editá / reemplazá `data/tickers.xlsx`.
2. Commiteá y pusheá a `main`.
3. Dispará **"Actualizar datos"** (o esperá al próximo cron).

## Deploy (GitHub Pages)

El deploy es automático vía Actions. Pasos manuales mínimos (una sola vez):

1. **Settings → Pages → Build and deployment → Source: `GitHub Actions`**.
2. Verificá que `base` en [`vite.config.js`](vite.config.js) coincida con el
   nombre del repo (por defecto `'/stock-lens/'`).
3. Subí tu `data/tickers.xlsx` real y dispará el workflow de datos.

El sitio queda en `https://<usuario>.github.io/<repo>/`.

---

_Datos vía yfinance. Sólo con fines informativos; no constituye recomendación de inversión._
