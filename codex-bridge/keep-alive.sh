#!/usr/bin/env bash
# Освежитель токена codex (spec 2026-11-14): раз в ~3 дня из cron дёргает
# codex exec тривиальным запросом, чтобы официальный CLI обновил
# access_token в ~/.codex/auth.json. Мост токены не обновляет никогда.
# PATH cron голый (/usr/bin:/bin) и не содержит npm-global/nvm/.local, где
# живёт codex — дополняем сами, иначе освежитель молча станет вечным no-op.
set -euo pipefail
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"
for nodebin in "$HOME"/.nvm/versions/node/*/bin; do
  [ -d "$nodebin" ] && PATH="$nodebin:$PATH"
done
command -v codex >/dev/null || exit 127
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"
codex exec --model gpt-5.6-luna --sandbox read-only --skip-git-repo-check 'ответь ok' >/dev/null 2>&1 \
  || codex exec --model gpt-5.6-luna --skip-git-repo-check 'ответь ok' >/dev/null 2>&1 \
  || true
