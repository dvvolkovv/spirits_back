#!/usr/bin/env bash
# Прогон команды студии на тестовой ноде (CLAUDE.md: сборки и тесты — не на маке).
# Пушит текущую ветку и ставит воркдерево ноды ~/ci/wt/promo-shorts на ТОЧНЫЙ коммит:
# по имени ветки нельзя — в общие чекауты коммитят параллельные сессии.
#   studio/scripts/node-run.sh "npm test"
set -euo pipefail
cmd="${1:?usage: studio/scripts/node-run.sh \"<команда в studio/>\"}"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse HEAD)"
branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
# Из отсоединённого HEAD branch == "HEAD": пуш создал бы ветку refs/heads/HEAD,
# а она при fetch затирает refs/remotes/origin/main у всех клонов (было 24.10.2026).
# Из main не гоняем: скрипт только для ветки задачи.
case "$branch" in
  HEAD) echo "node-run.sh: HEAD отсоединён — встань на ветку задачи (git switch feat/promo-shorts)" >&2; exit 1 ;;
  main|master) echo "node-run.sh: из ${branch} не запускать — только из ветки задачи" >&2; exit 1 ;;
esac
git -C "$repo" push -q origin "HEAD:refs/heads/${branch}"
ssh -o ConnectTimeout=15 dv@85.192.61.231 \
  "set -e; cd ~/ci/wt/promo-shorts && git fetch -q origin && git checkout -q --detach ${sha} && cd studio && source ~/.nvm/nvm.sh >/dev/null && ${cmd}"
