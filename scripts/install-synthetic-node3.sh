#!/usr/bin/env bash
#
# Установка/обновление synthetic-раннера на node-3 (DR-узел).
#
# Зачем: раннер исторически жил ТОЛЬКО на диске node-3 (/opt/observability/),
# мимо git — переустановка узла его сносила, а SYNTHETIC_PUSH_TOKEN дрейфовал
# относительно прод-.env (инцидент 2026-05-31: пуши падали с 401, мониторинг
# «ослеп» на неделю). Этот скрипт делает установку воспроизводимой и держит
# единый источник токена — прод-.env.
#
# Идемпотентен. Запускать с машины, у которой есть ssh и на прод, и на node-3.
#
# Usage:
#   bash scripts/install-synthetic-node3.sh
# Env (опц.):
#   PROD_SSH=dvolkov@212.113.106.202
#   NODE3_SSH=dvolkov@5.45.115.22
#   SYNTHETIC_TEST_REFRESH_JWT=<bootstrap refresh jwt>  # нужен только для ПЕРВОЙ
#       установки; при обновлении берётся существующий из run.sh на node-3.
set -euo pipefail

PROD_SSH="${PROD_SSH:-dvolkov@212.113.106.202}"
NODE3_SSH="${NODE3_SSH:-dvolkov@5.45.115.22}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_SRC="$SCRIPT_DIR/synthetic-runner.js"
REMOTE_DIR=/opt/observability
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"

[ -f "$RUNNER_SRC" ] || { echo "ERROR: $RUNNER_SRC не найден"; exit 1; }

echo "==> Токен SYNTHETIC_PUSH_TOKEN из прод-.env (единый источник)"
PUSH_TOKEN=$(ssh $SSH_OPTS "$PROD_SSH" 'grep -E "^SYNTHETIC_PUSH_TOKEN=" ~/spirits_back/.env | cut -d= -f2-')
[ -n "$PUSH_TOKEN" ] || { echo "ERROR: SYNTHETIC_PUSH_TOKEN пуст в прод-.env — задайте его там и перезапустите linkeon-api"; exit 1; }
echo "    ok (len ${#PUSH_TOKEN})"

echo "==> Refresh-JWT: берём существующий с node-3, иначе из env"
REFRESH_JWT=$(ssh $SSH_OPTS "$NODE3_SSH" "sudo grep -oE 'SYNTHETIC_TEST_REFRESH_JWT=[^ ]+' $REMOTE_DIR/synthetic-run.sh 2>/dev/null | head -1 | cut -d= -f2- | tr -d \"'\"" || true)
REFRESH_JWT="${REFRESH_JWT:-${SYNTHETIC_TEST_REFRESH_JWT:-}}"
[ -n "$REFRESH_JWT" ] || { echo "ERROR: нет bootstrap SYNTHETIC_TEST_REFRESH_JWT (ни на node-3, ни в env)"; exit 1; }
echo "    ok (len ${#REFRESH_JWT})"

echo "==> Копирую hardened runner на node-3"
scp $SSH_OPTS "$RUNNER_SRC" "$NODE3_SSH:/tmp/synthetic-runner.js"
ssh $SSH_OPTS "$NODE3_SSH" "sudo mkdir -p $REMOTE_DIR && sudo mv /tmp/synthetic-runner.js $REMOTE_DIR/synthetic-runner.js && sudo chmod 644 $REMOTE_DIR/synthetic-runner.js"

echo "==> Пишу run.sh (root, 700) с токеном/JWT"
ssh $SSH_OPTS "$NODE3_SSH" "sudo tee $REMOTE_DIR/synthetic-run.sh >/dev/null <<EOS
#!/usr/bin/env bash
set -e
export SYNTHETIC_PUSH_TOKEN='$PUSH_TOKEN'
export SYNTHETIC_TEST_REFRESH_JWT='$REFRESH_JWT'
export SYNTHETIC_STATE_FILE=/var/lib/synthetic/state.json
export BASE_URL=https://my.linkeon.io
cd $REMOTE_DIR
exec /usr/bin/node synthetic-runner.js
EOS
sudo chmod 700 $REMOTE_DIR/synthetic-run.sh"

echo "==> cron.d (*/5) + чистка .disabled-дубля"
ssh $SSH_OPTS "$NODE3_SSH" "echo '*/5 * * * * root $REMOTE_DIR/synthetic-run.sh >> /var/log/synthetic.log 2>&1' | sudo tee /etc/cron.d/synthetic >/dev/null && sudo chmod 644 /etc/cron.d/synthetic && sudo rm -f /etc/cron.d/synthetic.disabled"

echo "==> Прогон для проверки"
ssh $SSH_OPTS "$NODE3_SSH" "sudo $REMOTE_DIR/synthetic-run.sh 2>&1 | tail -8"
echo "==> Готово."
