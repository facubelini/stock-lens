#!/usr/bin/env bash
# Migracion a la rama huerfana `datos` (correr UNA sola vez, a mano, antes de
# pushear los workflows nuevos). Deja todo preparado LOCALMENTE:
#   1. Crea la rama local `datos` apuntando a un commit huerfano (sin padre)
#      con el estado ACTUAL de public/data/** + data/** (menos los inputs a
#      mano, que se quedan en main: data/tickers.xlsx,
#      data/ratios_cedear_manual.json). No la deja "checked out": el
#      working tree de `main` no se toca.
#   2. Deja STAGED (git add -N / git rm --cached) el destrackeo de esos
#      mismos paths en `main` — el commit en si NO lo hace este script: lo
#      revisas con `git status`/`git diff --staged` y lo commiteas vos.
#
# NO pushea nada (ni `datos` ni `main`): eso lo hace el coordinador a mano
# siguiendo las instrucciones que imprime al final.
#
# Precondicion: parado en la raiz del repo, en `main`, working tree limpio
# (si hay cambios sin commitear el script no sigue: podrian mezclarse con la
# migracion sin darte cuenta).

set -euo pipefail

RAIZ="$(git rev-parse --show-toplevel)"
cd "$RAIZ"

RAMA_ACTUAL="$(git rev-parse --abbrev-ref HEAD)"
if [ "$RAMA_ACTUAL" != "main" ]; then
  echo "::error::Parado en '$RAMA_ACTUAL', no en 'main'. Cambiá a main y volvé a correr esto." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "::error::Working tree sucio (git status no está limpio). Commiteá o descartá los cambios primero." >&2
  exit 1
fi
if git rev-parse --verify -q refs/heads/datos >/dev/null; then
  echo "::error::Ya existe una rama local 'datos'. Si es de un intento anterior de esta migración, borrala primero (git branch -D datos) y volvé a correr." >&2
  exit 1
fi

# Inputs a mano que se quedan versionados en main (no van a la rama datos).
INPUTS=(data/tickers.xlsx data/ratios_cedear_manual.json)

echo "== 1/3: armando el commit huerfano de 'datos' con el estado actual =="

# Indice temporal: separado del real de main, asi 'git add' de acá no deja
# nada staged en el checkout de main.
INDICE_TMP="$(mktemp -u)"
export GIT_INDEX_FILE="$INDICE_TMP"
trap 'rm -f "$INDICE_TMP"' EXIT

ARGS_EXCLUIR=()
for f in "${INPUTS[@]}"; do
  ARGS_EXCLUIR+=(":(exclude)$f")
done

if [ -d public/data ] || [ -d data ]; then
  # -f: si .gitignore ya tiene las reglas nuevas (public/data y data/* ignorados),
  # 'git add' normal no agregaria nada.
  git add -f -A -- public/data data "${ARGS_EXCLUIR[@]}"
fi
N="$(git ls-files | wc -l)"
if [ "$N" -eq 0 ]; then
  echo "::error::No hay nada para migrar (public/data y data están vacíos o no existen)." >&2
  exit 1
fi
ARBOL="$(git write-tree)"
unset GIT_INDEX_FILE
rm -f "$INDICE_TMP"
trap - EXIT

FECHA="$(date -u +'%Y-%m-%d %H:%M UTC')"
COMMIT="$(git commit-tree "$ARBOL" -m "datos: migración inicial a la rama huerfana ($FECHA)")"
git update-ref refs/heads/datos "$COMMIT"
echo "Rama local 'datos' creada: $COMMIT ($N archivo(s), sin tocar el checkout de main)."

echo
echo "== 2/3: destrackeando public/data y data/ (estado) de 'main' =="
if [ -d public/data ]; then
  git rm -r --cached --quiet public/data
fi
# Solo lo que ya estaba trackeado en main (evita errores si algo ya se habia
# sacado a mano), y nunca los inputs.
TRACKEADOS_DATA="$(git ls-files data | grep -vFf <(printf '%s\n' "${INPUTS[@]}") || true)"
if [ -n "$TRACKEADOS_DATA" ]; then
  echo "$TRACKEADOS_DATA" | xargs -r git rm --cached --quiet --
fi
echo "Listo (staged, todavía sin commitear)."

echo
echo "== 3/3: instrucciones para el coordinador =="
cat <<EOF

Revisá lo que queda staged en main (tiene que ser SOLO borrados de
public/data/** y de los archivos de estado de data/; data/tickers.xlsx y
data/ratios_cedear_manual.json NO deberían aparecer):

    git status
    git diff --staged --stat | tail -20

Si está todo bien, en este orden:

  1) Commitear el destrackeo en main (los archivos siguen en el disco, solo
     se sacan del índice; .gitignore ya los ignora):

       git commit -m "datos: mover public/data y data/estado a la rama datos"

  2) Pushear main:

       git push origin main

  3) Pushear la rama datos (recién creada, commit único $COMMIT):

       git push origin datos

  4) Recién ENTONCES pushear/mergear los workflows nuevos (.github/**) que
     dependen de que la rama 'datos' ya exista en el remoto (si no, el
     primer "git fetch origin datos" de cada workflow falla — está
     contemplado, arrancan sin estado previo, pero es mejor evitarlo).

  5) Disparar a mano "Actualizar datos" (Actions → Actualizar datos → Run
     workflow) y confirmar que: trae el estado previo, corre bien, valida,
     commitea UN commit a 'datos' (podés confirmarlo con
     'git log origin/datos' — sigue siendo un solo commit) y dispara el
     deploy encadenado.

Nota: el historial viejo de public/data/**  y data/** en 'main' (~50 MB en
los objetos del repo) NO se borra con esto — mover archivos hacia adelante
no reescribe commits pasados. Si en algún momento se quiere recuperar ese
espacio hay que reescribir la historia de main (git filter-repo o similar) y
forzar un push; es DESTRUCTIVO (todo clone/fork existente queda desalineado)
y se decidió NO hacerlo automáticamente. Se puede evaluar más adelante.
EOF
