#!/usr/bin/env bash
# Smoke runner — unit, then API+DB, then browser. Fail-fast.
# Use: bash tests/smoke/run.sh [layer]
#   layer = unit | api | browser | all (default)
#
# Env: BASE_URL (default https://my.linkeon.io), TEST_PHONE (default 70000000000)
#      BASIC_AUTH (optional, user:pass for Basic Auth on test server)
#      SSH_TARGET (optional, override SSH host for DB-check, default dvolkov@212.113.106.202)

set -uo pipefail

LAYER="${1:-all}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
cd "$ROOT"

BASE_URL="${BASE_URL:-https://my.linkeon.io}"
TEST_PHONE="${TEST_PHONE:-70000000000}"
BASIC_AUTH="${BASIC_AUTH:-}"
SSH_TARGET="${SSH_TARGET:-dvolkov@212.113.106.202}"
PG_DSN="${PG_DSN:-}"

# Где гонять jest. ВСЕГДА тестовая нода, а не $SSH_TARGET: во второй фазе тот
# указывает на прод, и запускать там тысячу тестов — худшее из решений.
#
# На маке их гонять нельзя (решение владельца 15.08.2026, см. CLAUDE.md): он
# не тянет, прогоны упираются в таймауты и съедают машину. 27.08.2026 я это
# правило нарушил, добавив сюда прогон src/ — load average ушёл за восемь, и
# владелец прибил node руками посреди выката.
JEST_HOST="${JEST_HOST:-dv@85.192.61.231}"
JEST_PATH="${JEST_PATH:-\$HOME/spirits_back}"

# Потолок воркеров. У ноды 4 ядра и 8 ГБ, и на ней же работают API тестового
# стенда, LiveKit и smm-воркер — оставляем им половину машины.
#
# Без потолка jest берёт «ядра минус один» на КАЖДЫЙ прогон, они складываются,
# и получается девять процессов на четыре ядра при 74 МБ свободной памяти:
# прогон не ускоряется, а уходит в своп.
#
# Настоящая цена набора была не в этом. Она была в ts-jest без
# isolatedModules, который заново типизировал проект на каждый файл теста:
# 1031 тест не укладывался в восемнадцать минут, а после починки проходит за
# шестнадцать секунд.
JEST_WORKERS="${JEST_WORKERS:-2}"


print_header() {
  echo
  echo "════════════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "════════════════════════════════════════════════════════════════════"
}

FAILED=0

if [[ "$LAYER" == "unit" || "$LAYER" == "all" ]]; then
  print_header "LAYER 1/3 — Backend unit tests (Jest, на тестовой ноде)"

  # Гоняем в ТОМ чекауте, куда только что выкатились, — то есть проверяем
  # ровно тот код, который поехал, а не копию на машине разработчика. Там уже
  # стоят зависимости и лежит свежая сборка, так что ни install, ни build
  # здесь не нужны. Ветку не переключаем: чекаут живой, из него работает API
  # тестового стенда.
  #
  # Два прогона, а не один: у tests/unit свой конфиг jest, у спеков рядом с
  # исходниками — корневой. Путь src/ указан намеренно, иначе jest
  # подхватывает .worktrees/ с чужими незаконченными ветками и гейт краснеет
  # от чужой работы.
  want_sha=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo '')
  got_sha=$(ssh -o ConnectTimeout=15 -o BatchMode=yes "$JEST_HOST" \
    "git -C $JEST_PATH rev-parse HEAD" 2>/dev/null | tr -d '[:space:]')

  if [[ -z "$got_sha" ]]; then
    echo "  ✗ не достучались до $JEST_HOST — тесты не прогнаны"
    FAILED=1
  else
    # Расхождение — не повод молчать: при PROD_ONLY тестовая нода остаётся на
    # старом коде, и зелёный слой означал бы «проверили не то».
    if [[ -n "$want_sha" && "$got_sha" != "$want_sha" ]]; then
      echo "  ⚠ на ноде ${got_sha:0:8}, выкатываем ${want_sha:0:8} — тесты прогоняются по коду ноды"
    fi
    # Полный набор гоняется в ОБЕИХ фазах, и это ничего не стоит: 1031 тест
    # проходит за 16 секунд (замер 27.08.2026, две трети — накладные расходы
    # на запуск). Была ветка «перед продом пропускать, код же тот же самый» —
    # снята: экономить полминуты ценой лишнего условия незачем.
    if ! ssh -o ConnectTimeout=15 -o BatchMode=yes "$JEST_HOST" \
      "source ~/.nvm/nvm.sh >/dev/null 2>&1; \
       cd $JEST_PATH/tests && npx jest unit/ --silent --maxWorkers=$JEST_WORKERS && \
       cd $JEST_PATH && npx jest src/ --silent --maxWorkers=$JEST_WORKERS"; then
      echo "  ✗ jest failed (на $JEST_HOST)"
      FAILED=1
    fi
  fi
fi

if [[ "$LAYER" == "api" || "$LAYER" == "all" ]]; then
  print_header "LAYER 2/3 — API + DB smoke (Node)"
  if ! BASE_URL="$BASE_URL" TEST_PHONE="$TEST_PHONE" \
       BASIC_AUTH="$BASIC_AUTH" SSH_TARGET="$SSH_TARGET" PG_DSN="$PG_DSN" \
       node smoke/smoke.js; then
    echo "  ✗ api/db failed"
    FAILED=1
  fi
fi

if [[ "$LAYER" == "browser" || "$LAYER" == "all" ]]; then
  print_header "LAYER 3/3 — Browser smoke (Playwright)"
  if ! BASE_URL="$BASE_URL" TEST_PHONE="$TEST_PHONE" \
       BASIC_AUTH="$BASIC_AUTH" SSH_TARGET="$SSH_TARGET" \
       npx playwright test --config=playwright/playwright.config.js --reporter=list; then
    echo "  ✗ browser failed"
    FAILED=1
  fi
fi

echo
if [[ $FAILED -eq 0 ]]; then
  echo "════════════════════════════════════════════════════════════════════"
  echo "  ✓ ALL SMOKE LAYERS GREEN"
  echo "════════════════════════════════════════════════════════════════════"
  exit 0
else
  echo "════════════════════════════════════════════════════════════════════"
  echo "  ✗ SMOKE FAILURES — see above"
  echo "════════════════════════════════════════════════════════════════════"
  exit 1
fi
