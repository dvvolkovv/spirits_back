#!/usr/bin/env bash
# Прогон команды на тестовой ноде (CLAUDE.md: сборки и тесты — не на маке).
# Пушит текущую ветку и ставит воркдерево ноды ~/ci/wt/promo-shorts на ТОЧНЫЙ коммит:
# по имени ветки нельзя — в общие чекауты коммитят параллельные сессии.
#   studio/scripts/node-run.sh "npm test"                           — в studio/
#   NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts" — в корне бэкенда
# Два прогона сразу (параллельные сессии, субагенты) воркдерево не делят: второй ждёт
# первого на flock до 15 минут, а не переключает коммит у него из-под ног.
set -euo pipefail
cmd="${1:?usage: studio/scripts/node-run.sh \"<команда>\"}"
dir="${NODE_RUN_DIR:-studio}"
case "$dir" in
  studio|.) ;;
  *) echo "node-run.sh: NODE_RUN_DIR — studio или . (корень бэкенда), получено «${dir}»" >&2; exit 1 ;;
esac
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
# Одно мастер-соединение на все прогоны (ControlPersist): sshd ноды рвёт новые
# подключения по MaxStartups 10:30:100 — её постоянно перебирают боты.
ssh -o ConnectTimeout=15 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 \
  "set -e; exec 9>~/ci/wt/.promo-shorts.lock; flock -w 900 9 || { echo 'node-run.sh: воркдерево занято другим прогоном дольше 15 минут' >&2; exit 1; }; cd ~/ci/wt/promo-shorts && git fetch -q origin && git checkout -q --detach ${sha} && cd ${dir} && source ~/.nvm/nvm.sh >/dev/null && ${cmd}"
