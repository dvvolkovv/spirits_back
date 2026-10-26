#!/usr/bin/env bash
# Прогон команды на тестовой ноде (CLAUDE.md: сборки и тесты — не на маке).
# Пушит текущую ветку и ставит воркдерево ноды ~/ci/wt/promo-shorts на ТОЧНЫЙ коммит:
# по имени ветки нельзя — в общие чекауты коммитят параллельные сессии.
#   studio/scripts/node-run.sh "npm test"                           — в studio/
#   NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts" — в корне бэкенда
# Два прогона сразу (параллельные сессии, субагенты) воркдерево не делят: второй ждёт
# первого на flock до 5 минут, а не переключает коммит у него из-под ног. Команда
# ограничена 30 минутами: зависший прогон не держит лок вечно.
# Коды выхода: 75 — воркдерево занято (повторить позже), 2 — неверный вызов,
# 3 — воркдерево ноды не встало на коммит (команда не запускалась), 124 или 137 —
# команда не уложилась в 30 минут, 255 — ssh (сброс по MaxStartups: повторить через
# 1–2 минуты), иначе — код самой команды.
set -euo pipefail
[ $# -eq 1 ] || { echo 'usage: studio/scripts/node-run.sh "<команда>" — команда одной строкой в кавычках' >&2; exit 2; }
cmd="$1"
dir="${NODE_RUN_DIR:-studio}"
case "$dir" in
  studio|.) ;;
  *) echo "node-run.sh: NODE_RUN_DIR — studio или . (корень бэкенда), получено «${dir}»" >&2; exit 2 ;;
esac
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse HEAD)"
branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
# Из отсоединённого HEAD branch == "HEAD": пуш создал бы ветку refs/heads/HEAD,
# а она при fetch затирает refs/remotes/origin/main у всех клонов (было 24.10.2026).
# Из main не гоняем: скрипт только для ветки задачи.
case "$branch" in
  HEAD) echo "node-run.sh: HEAD отсоединён — встань на ветку задачи (git switch feat/promo-shorts)" >&2; exit 2 ;;
  main|master) echo "node-run.sh: из ${branch} не запускать — только из ветки задачи" >&2; exit 2 ;;
esac
# Незакоммиченное на ноду не уезжает: прогон проверит прежний код. Новые файлы тоже
# считаются — забытый git add молча оставил бы новую сюиту вне прогона.
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "node-run.sh: есть незакоммиченные правки или новые файлы — на ноду уедет только ${sha:0:7}" >&2
fi
echo "node-run.sh: ${sha:0:7} → ${dir}" >&2
git -C "$repo" push -q origin "HEAD:refs/heads/${branch}"
# Команда уезжает одним словом: на ноде её разбирает bash -ec, а не цепочка подготовки.
q="$(printf '%q' "$cmd")"
# Одно мастер-соединение на все прогоны (ControlPersist): sshd ноды рвёт новые
# подключения по MaxStartups 10:30:100 — её постоянно перебирают боты. Keepalive —
# чтобы прогон не висел на мёртвом соединении мастера (сон мака, смена сети).
# На одно соединение sshd пускает до 10 сессий (MaxSessions) — с запасом.
# Подготовка воркдерева — одной группой: любой её сбой фатален. Под set -e упавшее
# звено списка && шелл не останавливает, и команда выполнилась бы на чужом коммите.
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 \
    -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 \
  "set -e
exec 9>~/ci/wt/.promo-shorts.lock
if ! flock -w 300 9; then echo 'node-run.sh: воркдерево занято другим прогоном дольше 5 минут, его владелец:' >&2; cat ~/ci/wt/.promo-shorts.owner >&2 2>/dev/null || true; exit 75; fi
echo \"\$(date -Is) ${sha:0:7} ${dir} pid \$\$\" > ~/ci/wt/.promo-shorts.owner
{ cd ~/ci/wt/promo-shorts && timeout 120 git fetch -q origin 'refs/heads/${branch}' && test -z \"\$(git status --porcelain --untracked-files=no)\" && git checkout -q --detach ${sha} && cd ${dir} && source ~/.nvm/nvm.sh >/dev/null; } || { echo 'node-run.sh: воркдерево ноды не встало на ${sha:0:7} (fetch, незакоммиченное в дереве ноды или checkout)' >&2; git -C ~/ci/wt/promo-shorts status --short >&2 || true; exit 3; }
exec timeout -k 30 1800 bash -ec ${q}"
