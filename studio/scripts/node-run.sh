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
git -C "$repo" push -q origin "HEAD:refs/heads/${branch}"
ssh -o ConnectTimeout=15 dv@85.192.61.231 \
  "set -e; cd ~/ci/wt/promo-shorts && git fetch -q origin && git checkout -q --detach ${sha} && cd studio && source ~/.nvm/nvm.sh >/dev/null && ${cmd}"
