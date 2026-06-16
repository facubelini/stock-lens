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
data/tickers.xlsx          # input: tu listado de tickers (lo cargás vos)
scripts/
  requirements.txt         # yfinance, pandas, numpy, openpyxl
  generar_datos.py         # pipeline real (lee Excel -> calcula -> escribe JSON)
  generar_datos_mock.py    # datos sintéticos para desarrollar la UI sin red
  crear_tickers_ejemplo.py # crea un data/tickers.xlsx de ejemplo
public/data/*.json         # salida del pipeline (listado, medias, fundamentales, meta)
src/                        # frontend React (pages/, components/, lib/)
.github/workflows/
  datos.yml                # corre el pipeline y commitea los JSON
  deploy.yml               # build + deploy a GitHub Pages
```

## El Excel de entrada (`data/tickers.xlsx`)

Una hoja con estas columnas en la primera fila:

| Columna     | Obligatoria | Descripción |
|-------------|-------------|-------------|
| `Ticker`    | Sí          | Símbolo tal cual lo usa Yahoo Finance (ej. `AAPL`, `YPF`, `GGAL.BA`) |
| `Industria` | Sí          | Para agrupar (ej. "Tech USA", "Finanzas", "Energía", "Argentina") |
| `Pais`      | Sí          | Para el filtro por país (ej. "USA", "Argentina") |
| `Nombre`    | No          | Nombre legible; si falta, se usa el que devuelva yfinance |

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

¿Querés sólo ver la UI sin descargar nada? Usá datos sintéticos:

```bash
python scripts/generar_datos_mock.py
```

Cualquiera de los dos escribe los JSON en `public/data/`.

## Actualizar los datos en producción

- **Automático:** el workflow **`Actualizar datos`** corre por cron (cada hora
  en el horario de mercado USA, días hábiles). Editá el `schedule` en
  [`.github/workflows/datos.yml`](.github/workflows/datos.yml) para cambiar la frecuencia.
- **Manual:** GitHub → pestaña **Actions** → workflow **"Actualizar datos"** →
  **Run workflow**.

Cuando el pipeline commitea JSON nuevos, el workflow **`Deploy a GitHub Pages`**
se dispara solo (vía `workflow_run`) y vuelve a publicar el sitio.

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
