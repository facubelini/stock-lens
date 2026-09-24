"""Pipeline de datos de Stock Lens.

Lee data/tickers.xlsx, descarga datos diarios con yfinance, calcula los
indicadores y escribe los JSON estaticos que consume el frontend en
public/data/. No requiere API keys.

Este archivo es solo el punto de entrada (CLI + orden de las etapas); la
logica vive en scripts/pipeline/:
    universo.py       Excel, filtro de basura, cache de invalidos, resolucion de simbolos
    descarga.py       yf.download en lote con reintentos, .info en paralelo, FX, CEDEAR
    fundamentales.py  ratios, dividend yield, monedas / market cap USD / CCL, insiders
    tecnico.py        medias, RSI, screener multi-temporalidad, scanner, divergencias
    vcp.py            ZigZag, deteccion de VCP y su ciclo de vida
    warren.py         Warren Score (pilares, penalizaciones, percentiles de RS)
    senales.py        EMA200 rebote/cruce, bases VCP, RSI semanal
    comparables.py    comparables por industria + Oportunidades
    procesar.py       filas por ticker + arrastre de datos viejos (stale)
    salida.py         estado previo, historiales y escritura de JSON / meta

Uso:
    python scripts/generar_datos.py
    # prueba chica, sin tocar public/data ni data/:
    python scripts/generar_datos.py --tickers AAPL,KEP,GGAL.BA --out /tmp/sl --estado /tmp/sl-estado
"""

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comun import DIR_DATOS_PUBLICOS, DIR_ESTADO, TZ, escribir_json, leer_json, num  # noqa: E402
from pipeline.comparables import calcular_oportunidades_hoy, construir_comparables, obtener_peers  # noqa: E402
from pipeline.descarga import (  # noqa: E402
    PERIODO_HISTORICO,
    candidatos_cedear,
    cargar_ratios_cedear,
    obtener_benchmark,
    obtener_fx,
    obtener_ccl_data912,
    obtener_precios_cedear_combinado,
    pedir_infos,
)
from pipeline.fundamentales import completar_market_cap_usd, filtrar_ccl  # noqa: E402
from pipeline.procesar import procesar_universo  # noqa: E402
from pipeline.salida import (  # noqa: E402
    actualizar_historial_oportunidades,
    cargar_previos,
    escribir_estado,
    escribir_meta,
    escribir_publicados,
    historial_screener,
)
from pipeline.rotacion import rot_actualizar_historial, rot_construir, rot_filas_semana, semana_iso  # noqa: E402
from pipeline.senales import construir_senales  # noqa: E402
from pipeline.seguimiento import actualizar_log, resumen_publicable  # noqa: E402
from pipeline.tecnico import promedios_por_industria  # noqa: E402
from pipeline.universo import (  # noqa: E402
    TTL_INVALIDOS_DIAS,
    filtrar_universo,
    mapear_previos,
    resolver_universo,
    universo_desde_args,
)
from pipeline.warren import calcular_warren_score, rs_percentiles  # noqa: E402

# Salvaguarda anti rate-limit: si los frescos quedan por debajo de esta
# fraccion de los tickers intentados, se aborta sin escribir (exit 1).
UMBRAL_ABORTO = 0.5


def _parsear_args(argv=None):
    ap = argparse.ArgumentParser(description="Pipeline de datos de Stock Lens (yfinance -> JSON).")
    ap.add_argument("--out", type=Path, default=DIR_DATOS_PUBLICOS, help="carpeta publicada (default: public/data)")
    ap.add_argument("--estado", type=Path, default=DIR_ESTADO, help="carpeta de estado/caches (default: data/)")
    ap.add_argument("--tickers", help="lista separada por comas que reemplaza al Excel (para pruebas)")
    ap.add_argument("--limite", type=int, help="procesa solo los primeros N tickers del Excel (para pruebas)")
    return ap.parse_args(argv)


def main(argv=None):
    args = _parsear_args(argv)
    out = args.out.resolve()
    estado = args.estado.resolve()
    out.mkdir(parents=True, exist_ok=True)
    estado.mkdir(parents=True, exist_ok=True)

    ahora = datetime.now(TZ)
    ahora_iso = ahora.isoformat()
    ahora_utc = datetime.now(timezone.utc)
    hoy = ahora.strftime("%Y-%m-%d")

    # --- Universo: Excel - basura por regla - invalidos cacheados ---
    tickers, descartados, invalidos_vigentes, salteados = filtrar_universo(
        universo_desde_args(args), estado / "invalidos_cache.json", ahora
    )
    print(
        f"Universo: {len(tickers)} tickers a procesar (periodo {PERIODO_HISTORICO}); "
        f"{len(descartados)} descartados por regla, {len(salteados)} invalidos en cache (TTL {TTL_INVALIDOS_DIAS}d).\n"
    )

    # --- Estado de la corrida anterior ---
    # Para arrastrar el ultimo dato bueno de un ticker que falla hoy
    # (yfinance flaky) y para no cambiar de plaza el simbolo resuelto.
    previos, prev_meta = cargar_previos(out)
    ts_prev = prev_meta.get("ultima_actualizacion")
    simbolo_previo = mapear_previos(list(tickers["Ticker"]) + salteados, previos["listado"])

    # --- Descargas ---
    ratios_cedear = cargar_ratios_cedear()
    print("Descargando historicos (en lote)...")
    t0 = time.monotonic()
    resueltos = resolver_universo(list(tickers["Ticker"]), simbolo_previo)
    print(f"  {len(resueltos)}/{len(tickers)} resueltos en {time.monotonic() - t0:.0f}s.")
    bench_closes = obtener_benchmark(resueltos)
    infos = pedir_infos([s for s, _ in resueltos.values()])
    cedears = candidatos_cedear(resueltos, ratios_cedear, set(tickers["Ticker"]), infos)
    print(f"Descargando precio de {len(cedears)} CEDEARs (data912 primero, Yahoo .BA de respaldo)...")
    precios_cedear = obtener_precios_cedear_combinado(cedears)

    # --- Una pasada por ticker (+ arrastre de los que fallan) ---
    ctx = {
        "prev_fundamentales": previos["fundamentales"],
        "ratios_cedear": ratios_cedear,
        "precios_cedear": precios_cedear,
        "bench_closes": bench_closes,
        "ahora_iso": ahora_iso,
        "ahora_utc": ahora_utc,
    }
    res = procesar_universo(tickers, resueltos, infos, ctx, previos, simbolo_previo, ts_prev, ahora)
    listado, medias, fundamentales, screener = res["listado"], res["medias"], res["fundamentales"], res["screener"]

    # --- Salvaguarda anti rate-limit ---
    # Se compara contra los tickers INTENTADOS en esta corrida (referencia
    # estable, no el conteo de la corrida anterior: ese se podia ir
    # achicando corrida a corrida si Yahoo fallaba de a poco). Aborta con
    # exit 1 (el workflow queda en rojo y no commitea) en vez de exit 0.
    n_intentados = len(tickers)
    n_frescos = sum(1 for f in listado if not f.get("stale"))
    if n_intentados >= 5 and n_frescos < n_intentados * UMBRAL_ABORTO:
        msg = (
            f"ABORTO: solo {n_frescos} tickers frescos de {n_intentados} intentados "
            f"(< {UMBRAL_ABORTO:.0%}, posible rate-limit de Yahoo). No se escribio nada."
        )
        print(f"\n::error::{msg}")
        sys.exit(1)

    # --- Segunda pasada: todo lo que necesita el universo completo ---
    ccl_mediana = filtrar_ccl(medias)
    ccl_data912 = obtener_ccl_data912()
    if ccl_data912 and ccl_mediana:
        dif_pct = (ccl_data912 / ccl_mediana - 1) * 100
        print(f"  CCL de data912: {ccl_data912:.2f} (mediana implicita propia: {ccl_mediana:.2f}, {dif_pct:+.1f}%).")

    print("\nArmando comparables por industria...")
    peers, cache_peers = obtener_peers(fundamentales, leer_json(estado / "comparables_cache.json", {}) or {}, hoy)
    monedas = {f.get("moneda") for f in fundamentales} | {p.get("moneda") for p in peers.values()}
    completar_market_cap_usd(fundamentales, peers, obtener_fx(monedas, ccl_mediana))
    comparables = construir_comparables(fundamentales, peers)

    print("\nCalculando Warren Score (percentil de fuerza relativa sobre el universo USD)...")
    rs_mapa = rs_percentiles(res["warren_datos"])
    warren_score = calcular_warren_score(res["warren_datos"], rs_mapa)
    senales = construir_senales(res["senales_datos"], rs_mapa, ahora_iso)
    print(
        "Señales: EMA200 diaria {}/{} · semanal {}/{} (rebote/cruce) · {} bases VCP · RSI semanal {}/{}".format(
            *(len(senales["ema200"][tf][t]) for tf in ("diario", "semanal") for t in ("rebote", "cruce")),
            len(senales["vcp"]), len(senales["rsi_semanal"]["alcista"]), len(senales["rsi_semanal"]["bajista"]),
        )
    )

    print("Actualizando el historial semanal de Rotacion (RRG)...")
    filas_semana = rot_filas_semana(res["warren_datos"], rs_mapa, fundamentales)
    historial_rotacion = rot_actualizar_historial(
        leer_json(estado / "rotacion_historial.json", {}) or {}, filas_semana, semana_iso(ahora)
    )
    escribir_json(estado / "rotacion_historial.json", historial_rotacion)
    rotacion = rot_construir(historial_rotacion, ahora_iso)
    print(f"  {len(rotacion['acciones'])} accion(es) + {len(rotacion['etfs'])} ETF(s) con RS Score esta semana.")

    n_compra = sum(
        1 for f in screener if any((f.get(tf) or {}).get("verdict") == "COMPRA" for tf in ("diario", "semanal", "mensual"))
    )
    print(f"Screener: {n_compra} ticker(s) con señal de COMPRA en alguna temporalidad.")

    print("Actualizando el seguimiento en vivo de las señales...")
    closes_por_ticker = {sym: h["Close"].dropna() for sym, h in resueltos.values() if "Close" in h}
    precios_hoy = {sym: float(c.iloc[-1]) for sym, c in closes_por_ticker.items() if len(c)}
    log_senales = actualizar_log(
        leer_json(estado / "senales_log.json", {}), senales, precios_hoy, closes_por_ticker, hoy, ahora_iso
    )
    escribir_json(estado / "senales_log.json", log_senales)
    escribir_json(
        out / "senales_seguimiento.json", resumen_publicable(log_senales, ahora_iso), ignorar_claves=("actualizado",)
    )

    historial = historial_screener(out, estado, screener, ahora)
    print("Actualizando historial de Oportunidades...")
    calificados_hoy = calcular_oportunidades_hoy(fundamentales, comparables, screener)
    historial_oportunidades = actualizar_historial_oportunidades(
        leer_json(out / "oportunidades_historial.json", []), calificados_hoy, ahora
    )
    print(f"  {len(calificados_hoy)} ticker(s) cumplen hoy valor+señal.")

    # --- Escritura (atomica, minificada, solo si cambio) ---
    cambios = escribir_publicados(
        out,
        {
            "listado": listado,
            "promedios": promedios_por_industria(listado),
            "medias": medias,
            "fundamentales": fundamentales,
            "comparables": comparables,
            "screener": screener,
            "scanner_setups": res["scanner_setups"],
            "historial_oportunidades": historial_oportunidades,
            "warren_score": warren_score,
            "senales": senales,
            "rotacion": rotacion,
            "mensuales": res["mensuales"],
        },
        historial,
        ahora_iso,
    )
    escribir_estado(estado, historial, cache_peers, invalidos_vigentes, res["sin_arrastre"], hoy)

    invalidos = res["invalidos"]
    n_arrastrados = sum(1 for f in listado if f.get("stale"))
    meta = {
        "ultima_actualizacion": ahora_iso,
        "n_tickers": len(listado),
        "n_frescos": n_frescos,
        "n_intentados": n_intentados,
        "ccl_implicito_mediana": num(ccl_mediana, 2),
        "ccl_data912": num(ccl_data912, 2),
        "tickers_invalidos": sorted(set(invalidos) | set(salteados)),
        "tickers_descartados": descartados,
    }
    escribir_meta(out, meta, cambios)

    print(
        f"\nListo. {n_frescos} frescos, {n_arrastrados} arrastrados, {len(invalidos)} sin datos hoy, "
        f"{len(salteados)} salteados por cache, {len(descartados)} descartados por regla."
    )
    if invalidos:
        print(f"Sin datos hoy: {invalidos}")


if __name__ == "__main__":
    main()
