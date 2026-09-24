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

`public/data/` (salida publicada) y `data/` (estado/caches del pipeline, salvo
los dos inputs a mano) **NO viven en `main`**: viven en la rama huerfana
`datos` — ver [§ Rama de datos](#rama-de-datos). Lo que sigue es la
estructura de esos directorios tal cual los ve un checkout con `npm run
datos` ya corrido (o un workflow, que los trae solo).

```
data/
  tickers.xlsx             # input: tu listado de tickers (lo cargás vos) — EN main
  ratios_cedear_manual.json# input: ratios CEDEAR que no están en el listado de Comafi — EN main
  screener_historial.json  # estado: historial maestro de señales (NO se publica) — rama datos
  invalidos_cache.json     # estado: tickers sin datos, no se reintentan por 7 días — rama datos
  comparables_cache.json   # estado: .info de los peers de comparables (cache diario) — rama datos
  cik_cache.json           # estado: ticker -> CIK de la SEC — rama datos
  edgar_cache/             # estado: companyfacts de SEC EDGAR, gz — rama datos
  alertas_estado.json      # estado: dedupe de eventos ya avisados por Telegram — rama datos
  alertas_config.json      # input opcional: watchlist para alertas ({"tickers": [...]}) — EN main
scripts/
  requirements.txt         # versiones exactas (pineadas)
  requirements-dev.txt     # + pytest / time-machine para los tests
  comun.py                 # utilidades compartidas (RSI único, num, JSON atómico/minificado)
  generar_datos.py         # pipeline real: CLI + orden de las etapas (la lógica vive en pipeline/)
  pipeline/
    universo.py            # Excel, filtro de basura, cache de inválidos, resolución de símbolos
    descarga.py            # yf.download en lote con reintentos, .info en paralelo, FX, CEDEAR
    fundamentales.py       # ratios, dividend yield, monedas / market cap USD / CCL, insiders
    tecnico.py             # medias, RSI, screener multi-temporalidad, scanner, divergencias
    vcp.py                 # ZigZag, detección de VCP y su ciclo de vida
    warren.py              # Warren Score (pilares, penalizaciones, percentiles de RS)
    senales.py             # EMA200 rebote/cruce, bases VCP, RSI semanal
    comparables.py         # comparables por industria + Oportunidades
    procesar.py            # filas por ticker + arrastre de datos viejos (stale)
    salida.py              # estado previo, historiales y escritura de JSON / meta
  validar_datos.py         # contrato de public/data (corre en CI antes de commitear)
  mercado_macro.py         # VIX, yield curve, Fear & Greed, CPI/desempleo/Fed
  historico_fundamental.py # P/E, EV/Sales, P/S históricos (SEC EDGAR)
  backtests.py             # backtest del Screener + Score (una sola descarga)
  generar_datos_mock.py    # datos sintéticos para desarrollar la UI sin red
  crear_tickers_ejemplo.py # crea un data/tickers.xlsx de ejemplo
  alertas.py               # alertas por Telegram (eventos nuevos vs. corrida anterior)
  monitoreo/
    telegram.py            # envío de mensajes por Telegram (compartido)
    aviso_falla.py         # aviso de Telegram cuando falla un workflow de datos/deploy
  datos-dev.mjs            # "npm run datos": trae public/data (+ data con --estado) de la rama datos
  check-datos-dev.mjs      # "predev": avisa si falta public/data/listado.json
  migrar_rama_datos.sh     # migración one-shot a la rama datos (correr UNA sola vez)
public/data/               # salida publicada (JSON minificados) — rama datos
  listado.json, medias.json, fundamentales.json, comparables.json, screener.json,
  scanner_setups.json, warren_score.json, oportunidades_historial.json,
  mercado_macro.json, backtest_*.json, meta.json
  fundamental/<TICKER>.json + indice.json  # histórico fundamental (SEC EDGAR)
  historial/<TICKER>.json  # historial de señales del screener (90 días) por ticker
  mensual/<TICKER>.json    # cierres de fin de mes (5 años) por ticker
src/                        # frontend React (pages/, components/, lib/)
  lib/frescura.js           # umbral de "datos viejos" (26h semana / 74h fin de semana)
  components/BannerDatosDesactualizados.jsx  # banner ámbar en el app shell
tests/                      # pytest (pipeline) + tests/js/ (vitest) + golden/ y fixtures/
.github/
  actions/commit-datos-rama/ # arma y pushea el commit huerfano a `datos` (compartido)
  workflows/
    tests.yml               # pytest + vitest + build en cada push/PR que toca código
    datos.yml                # pipeline de acciones + macro, valida, commitea y alerta
    historico.yml            # histórico fundamental (semanal)
    backtest.yml              # backtests (mensual)
    deploy.yml                 # build + deploy a GitHub Pages
    monitoreo-frescura.yml       # chequeo de staleness cada pocas horas en días hábiles
    _monitoreo-falla.yml          # reusable: issue + Telegram cuando falla un workflow
```

## Rama de datos

`public/data/` (JSON publicados) y el estado/caches de `data/` viven en una
rama **huerfana** llamada `datos`, no en `main`. Motivo: cada corrida del
pipeline commiteaba varios MB de JSON a `main` (el repo empaquetado venía
creciendo ~24 MB/mes); con todo eso en una rama aparte, `main` sólo tiene
código y crece con los commits normales de desarrollo.

- **`datos` es SIEMPRE un solo commit.** Cada corrida de un workflow de datos
  arma un commit huerfano (sin padre) desde cero con el estado completo
  (`public/data/` + `data/` menos los inputs a mano) y lo pushea con
  `--force` a `refs/heads/datos`. No es historizada a propósito: no tiene
  sentido guardar el historial completo de cada JSON generado, y así el
  clone/fetch de esa rama es siempre liviano.
- **Los workflows de datos** (`datos.yml`, `historico.yml`, `backtest.yml`)
  antes de correr sus scripts traen el estado anterior con
  `git fetch --depth=1 origin datos && git archive origin/datos | tar -x`
  (así el pipeline ve los caches/históricos previos), corren, validan y
  commitean con la acción compartida `.github/actions/commit-datos-rama`
  (arma el árbol completo — no sólo lo que tocó ese workflow — con un índice
  de git temporal, así no se pisan entre sí los distintos pipelines).
- **`deploy.yml`** hace checkout de `main` (código) + `git archive
  origin/datos public/data | tar -x` (sólo `public/data`, `data/` es interno
  del pipeline) antes de `npm run build`. Se dispara por `workflow_run` de
  los workflows de datos (comparando la fecha del commit de `datos` contra el
  inicio de esa corrida: como `datos` no tiene historia compartida entre
  commits, no se puede comparar shas como con `main`) y por `push` a `main`
  (cambios de código).
- **Inputs a mano** (`data/tickers.xlsx`, `data/ratios_cedear_manual.json`,
  `data/alertas_config.json`) siguen versionados en `main` normalmente.
- **Local:** `npm run datos` trae `public/data/` (con `-- --estado` también
  `data/`) desde `origin/datos` al working tree, sin tocar el índice de
  `main` (no aparecen como "staged" en `git status`). Necesita `tar` en el
  PATH (viene de fábrica en Windows 10/11, macOS y Linux/Git Bash). `npm run
  dev` avisa (sin bloquear) si falta `public/data/listado.json`.
- **Migración (una sola vez):** `scripts/migrar_rama_datos.sh` arma la rama
  `datos` local desde el estado actual y deja el destrackeo de `main`
  staged, listo para revisar y commitear — ver los pasos exactos en el PR/
  commit de la migración. El historial viejo de esos archivos sigue estando
  en los commits pasados de `main` (mover archivos hacia adelante no lo
  reescribe); limpiarlo requeriría reescribir la historia (`git filter-repo`
  o similar) con un force-push, es **destructivo** para cualquier clone/fork
  existente y se decidió no hacerlo automáticamente.

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
npm run datos    # trae public/data/ desde la rama `datos` (ver § Rama de datos)
npm run dev      # servidor de desarrollo (http://localhost:5179)
npm run build    # build de producción a dist/
npm run preview  # previsualizar el build
```

`npm run dev` avisa (sin bloquear) si falta `public/data/listado.json`.

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
- **Contrato de datos:** antes de commitear, `scripts/validar_datos.py` revisa
  que todos los JSON parseen sin NaN, la forma y los campos de cada archivo,
  los rangos (RSI, score, pilares, dividend yield), los archivos por ticker y
  que `n_frescos` no caiga más de 30% contra el `meta.json` de la corrida
  anterior (rama `datos`). `|var_pct| > 60` es sólo un **aviso** (no bloquea:
  un movimiento real de 60%+ existe, ej. splits o noticias fuertes). Si algo
  falla, el workflow no commitea.

### 3. Tests

```bash
pip install -r scripts/requirements-dev.txt
pytest -q          # pipeline: unitarios + golden byte a byte
npm test           # frontend (vitest)
```

El golden (`tests/test_golden.py`) corre el pipeline completo sin red sobre un
universo chico con las respuestas de Yahoo grabadas en `tests/fixtures/` y el
reloj congelado, y compara byte a byte todo lo que escribe. Si un cambio de
comportamiento es a propósito: `python tests/golden/grabacion.py actualizar`
(regenera la salida esperada; revisar el diff). Para volver a grabar la red:
`python tests/golden/grabacion.py grabar`. En Windows el golden necesita la
máquina en UTC-3 (en Linux se fija solo).

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

## Alertas por Telegram

`scripts/alertas.py` corre como último paso de **`Actualizar datos`** y manda
UN mensaje (HTML, se parte si supera 4096 caracteres) con los eventos
**nuevos** desde la corrida anterior (dedupe en `data/alertas_estado.json`,
rama `datos`):

- una base VCP que pasó a **"Recién rompió"** o **"Armado"**;
- un ticker que entró al **podio (top 3)** del Warren Score, o cruzó **≥ 80**;
- un evento nuevo de **EMA200 semanal** (rebote o cruce);
- un cruce nuevo de **RSI semanal alcista con RS ≥ 70**;
- sólo para los tickers de `data/alertas_config.json` (opcional, en `main`,
  formato `{"tickers": ["AAPL", "AMZN"]}` — hoy "Mi Cartera" vive sólo en el
  navegador del usuario, un workflow no puede leerla): cruce de **EMA200
  diario** o **movimiento diario ≥ ±5%**.

Cada evento incluye ticker, qué pasó, los números clave y un link a la ficha
(`https://facubelini.github.io/stock-lens/#/ticker/<TICKER>`). Si faltan las
credenciales no manda nada y sale con código 0 (nunca hace fallar el
workflow).

### Setup (una sola vez)

1. **Crear el bot:** hablar con [@BotFather](https://t.me/BotFather) en
   Telegram → `/newbot` → seguir los pasos → copiar el **token** que da
   (`123456:ABC-...`).
2. **Conseguir el chat id:** mandarle cualquier mensaje al bot recién creado
   y luego abrir en el navegador
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → buscar
   `"chat":{"id": ...}` en la respuesta JSON (ese número es el chat id; si es
   un chat individual, es tu propio user id de Telegram).
3. **Cargar los secrets del repo:** GitHub → **Settings → Secrets and
   variables → Actions → New repository secret**:
   - `TELEGRAM_BOT_TOKEN` = el token del paso 1.
   - `TELEGRAM_CHAT_ID` = el id del paso 2.
4. Listo: la próxima corrida de **"Actualizar datos"** ya manda alertas si
   hay eventos nuevos. Probar en seco sin credenciales ni red:
   `python scripts/alertas.py --dry-run`.

## Monitoreo

- **Falla de un workflow** (`Actualizar datos`, `Historico fundamental`,
  `Backtest Screener`, `Deploy a GitHub Pages`): al terminar, cada uno llama
  al job reusable
  [`_monitoreo-falla.yml`](.github/workflows/_monitoreo-falla.yml), que si
  falló abre (o comenta, si ya está abierto) un issue **"⚠️ Falla en
  \<workflow\>"** labeled `monitoreo` con el link a la corrida y el/los jobs
  que fallaron, y manda Telegram (si están los secrets); si salió bien y
  había un issue abierto, lo cierra solo.
- **Frescura de los datos:** [`monitoreo-frescura.yml`](.github/workflows/monitoreo-frescura.yml)
  corre cada 4h y chequea `meta.json` de la rama `datos` contra el mismo
  umbral que el banner de la app (26h entre semana, 74h el fin de semana);
  si está viejo, issue **"⚠️ Datos desactualizados"** + Telegram; si está
  fresco y había un issue abierto, lo cierra.
- **Banner en la app:** `src/components/BannerDatosDesactualizados.jsx` (en
  el shell, `src/App.jsx`) lee `meta.json` con el mismo umbral
  (`src/lib/frescura.js`) y muestra un aviso ámbar descartable; nada si los
  datos están frescos. El descarte se recuerda por corrida (vuelve a
  aparecer si `ultima_actualizacion` cambia y sigue desactualizado).

---

_Datos vía yfinance. Sólo con fines informativos; no constituye recomendación de inversión._
