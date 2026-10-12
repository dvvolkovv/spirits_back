#!/usr/bin/env bash
# Переносит модуль Human Design и базу городов из land_linkeon (калькулятор
# linkeon.io) в бэкенд — для инструмента calculate_human_design.
#
# Модуль правится ТОЛЬКО в land_linkeon (там его проверяет эталон Swiss
# Ephemeris на 300 рождений и 10 карт ручной сверки); сюда — этим скриптом.
# Тесты едут вместе: vitest → jest (импорт vitest убирается, *.test.ts →
# *.spec.ts, путь к эталону — через __dirname, expect с сообщением — обёрткой;
# см. to_spec ниже). Сторож границы лендинга
# (boundary.test.ts) не нужен бэкенду и не переносится.
#
# Запуск из корня spirits_back:
#   bash scripts/sync-human-design.sh [путь к land_linkeon]
set -euo pipefail
LAND="$(cd "${1:-$HOME/Downloads/land_linkeon}" && pwd)"
# Всегда из корня spirits_back — где бы ни запускали: ниже стирается src/human-design/lib.
cd "$(dirname "$0")/.."
SRC="$LAND/src/lib/human-design"
DST="src/human-design/lib"
[ -f "$SRC/index.ts" ] || { echo "нет $SRC/index.ts — укажите путь к land_linkeon" >&2; exit 1; }
grep -q '"name": "spirits-back"' package.json || { echo "скрипт лежит не в spirits_back" >&2; exit 1; }
if [ -n "$(git -C "$LAND" status --porcelain -- src/lib/human-design src/lib/cities.ts src/lib/cities.test.ts src/content/hd/cities.ru.json)" ]; then
  echo "в land_linkeon незакоммиченные правки модуля или базы городов — сначала коммит там" >&2
  exit 1
fi
# Коммит, который последним трогал копируемое, — а не HEAD лендинга: иначе
# любой посторонний коммит там переписывал бы README здесь.
SHA=$(git -C "$LAND" log -1 --format=%h -- src/lib/human-design src/lib/cities.ts src/lib/cities.test.ts src/content/hd/cities.ru.json)

# Копия верна только на той же версии библиотеки эфемерид, что у калькулятора.
ver() { sed -n 's/.*"astronomy-engine": *"[^0-9]*\([0-9][0-9.]*\)".*/\1/p' "$1" | head -1; }
if [ "$(ver "$LAND/package.json")" != "$(ver package.json)" ]; then
  echo "astronomy-engine: в land_linkeon $(ver "$LAND/package.json"), здесь $(ver package.json) — сначала выровнять версии" >&2
  exit 1
fi

# Тест vitest → спека jest: без импорта vitest, путь к эталону через __dirname,
# expect с сообщением — обёрткой (jest 29 на втором аргументе бросает
# «Expect takes at most one argument»; обёртка отбрасывает сообщение, статические
# expect.any / expect.arrayContaining остаются).
to_spec() {
  local src="$1" out="$2"
  sed -e "/^import .* from 'vitest';$/d" \
      -e "s#new URL('./__fixtures__/\([^']*\)', import.meta.url)#join(__dirname, '__fixtures__', '\1')#" \
      "$src" > "$out"
  {
    echo "const jestExpect = (globalThis as unknown as { expect: jest.Expect }).expect;"
    echo "const expect = Object.assign(<T>(actual: T, _message?: string) => jestExpect(actual), jestExpect);"
    if grep -q "join(__dirname" "$out"; then echo "import { join } from 'node:path';"; fi
    cat "$out"
  } > "$out.tmp" && mv "$out.tmp" "$out"
}

rm -rf "$DST"
mkdir -p "$DST/__fixtures__" src/human-design/data

for f in "$SRC"/*.ts; do
  base=$(basename "$f")
  case "$base" in
    boundary.test.ts) continue ;;
    *.test.ts) to_spec "$f" "$DST/${base%.test.ts}.spec.ts" ;;
    *) cp "$f" "$DST/$base" ;;
  esac
done
cp -R "$SRC/__fixtures__/." "$DST/__fixtures__/"

cp "$LAND/src/lib/cities.ts" src/human-design/cities.ts
to_spec "$LAND/src/lib/cities.test.ts" src/human-design/cities.spec.ts
cp "$LAND/src/content/hd/cities.ru.json" src/human-design/data/cities.ru.json

cat > "$DST/README.md" <<EOF
# Копия модуля Human Design

Источник — \`land_linkeon/src/lib/human-design/\` @ \`$SHA\` (калькулятор
linkeon.io/calculators/human-design/). **Здесь не править**: правка — в
land_linkeon, перенос — \`bash scripts/sync-human-design.sh\`. Тесты и эталон
Swiss Ephemeris перенесены вместе: если копия разошлась с калькулятором,
покраснеет \`reference.spec.ts\`.
EOF

cat > src/human-design/data/README.md <<EOF
# База городов

\`cities.ru.json\` — города GeoNames от 15 000 жителей с русскими названиями и
IANA-поясом; собирает \`land_linkeon/scripts/build-hd-cities.py\`, сюда —
\`scripts/sync-human-design.sh\` (land_linkeon @ \`$SHA\`).
Данные GeoNames (https://www.geonames.org/) — по лицензии CC BY 4.0.
EOF

if grep -rln "import.meta\|from 'vitest'" "$DST" src/human-design/cities.ts src/human-design/cities.spec.ts; then
  echo "остались следы vitest или ESM — скрипт надо поправить" >&2
  exit 1
fi
echo "перенесено из land_linkeon@$SHA"
