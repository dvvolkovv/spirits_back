#!/usr/bin/env bash
# Pings the AI analyst worker every run so the Claude Code OAuth access token
# stays fresh — without traffic for days the refresh-token chain can lapse and
# the next user-driven /chat call returns auth errors. Logs go to syslog tag
# 'analyst-keepwarm' so they show up in journalctl + monitor.taler.tirol push.
set -euo pipefail
sid="keepwarm-$(date -u +%Y%m%dT%H%M%SZ)"
secrets_file="${RELAY_SECRETS_FILE:-$HOME/file-agent/relay-secrets}"
secret=$(grep -v '^#' "$secrets_file" 2>/dev/null | grep -m1 . || true)
# Заголовок не через argv (не светится в `ps`/истории) — через файл-дескриптор
# процесс-подстановки, как и ждёт curl от `-H @файл`.
status=$(curl -sS -o /tmp/keepwarm.out -w '%{http_code}' \
  --connect-timeout 10 --max-time 90 \
  -X POST http://127.0.0.1:3033/chat \
  -H @<(printf 'X-Agent-Secret: %s\n' "$secret") \
  -F "sessionId=$sid" -F 'message=ping') || status=000
if [[ "$status" == "200" ]]; then
  logger -t analyst-keepwarm "ok sid=$sid"
else
  body=$(head -c 200 /tmp/keepwarm.out 2>/dev/null || true)
  logger -t analyst-keepwarm -p user.warning "FAIL status=$status body=$body"
fi
