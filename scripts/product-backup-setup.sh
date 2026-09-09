#!/usr/bin/env bash
# Заводит удалённый репозиторий для продукта, чтобы его код существовал не в
# единственном экземпляре.
#
# Проблема, которую это решает: чекаут продукта живёт только на хосте продуктов.
# repo_url в реестре пуст, а значит git push в раннере — пустышка. Гибель одного
# дроплета уносит весь код клиента вместе с историей и возможностью отката.
#
# Ограничение текущей реализации: bare-репозитории лежат на прод-сервере, и хост
# продуктов ходит туда по SSH-ключу. Это допустимо, пока обе машины наши. Для
# клиентских VM так делать нельзя — там раннер обязан оставаться единственным,
# кто инициирует соединения, и ключей от чужих машин у нас быть не должно;
# бэкап тогда пойдёт через HTTPS тем же runner-токеном.
#
# Использование:
#   scripts/product-backup-setup.sh <slug>
set -euo pipefail

PROD_HOST="${PROD_HOST:-dvolkov@212.113.106.202}"
PRODUCTS_HOST="${PRODUCTS_HOST:-root@139.59.210.42}"
REPO_ROOT="${REPO_ROOT:-/home/dvolkov/product-repos}"

[[ $# -ge 1 ]] || { echo "usage: $0 <slug>" >&2; exit 2; }
SLUG="$1"
ok() { printf "\033[32m  ✓ %s\033[0m\n" "$1"; }
die() { printf "\033[31m  ✗ %s\033[0m\n" "$1" >&2; exit 1; }

echo "[1/5] ключ хоста продуктов"
PUB=$(ssh "$PRODUCTS_HOST" '
  [ -f /root/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C linkeon-products -f /root/.ssh/id_ed25519
  cat /root/.ssh/id_ed25519.pub')
ok "ключ есть"

echo "[2/5] доступ на прод-сервер"
ssh "$PROD_HOST" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
  grep -qF '$PUB' ~/.ssh/authorized_keys || echo '$PUB' >> ~/.ssh/authorized_keys"
ok "ключ прописан"

echo "[3/5] bare-репозиторий"
ssh "$PROD_HOST" "mkdir -p $REPO_ROOT && cd $REPO_ROOT && [ -d '$SLUG.git' ] || git init --bare -q '$SLUG.git'"
ok "$REPO_ROOT/$SLUG.git"

echo "[4/5] привязываю и пушу"
REMOTE="$PROD_HOST:$REPO_ROOT/$SLUG.git"
ssh "$PRODUCTS_HOST" "
  cd /srv/products/$SLUG
  git -c safe.directory=/srv/products/$SLUG remote remove origin 2>/dev/null || true
  git -c safe.directory=/srv/products/$SLUG remote add origin '$REMOTE'
  GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=accept-new' \
    git -c safe.directory=/srv/products/$SLUG push -q --all origin
  chown -R 1000:1000 /srv/products/$SLUG/.git
"
ok "запушено"

echo "[5/5] прописываю repo_url в реестре"
ssh "$PROD_HOST" "psql \"\$(grep -E '^DATABASE_URL=' ~/spirits_back/.env | cut -d= -f2- | tr -d '\"')\" -v ON_ERROR_STOP=1 -qc \"
  UPDATE products SET repo_url='$REMOTE' WHERE slug='$SLUG'\"" >/dev/null
ok "repo_url задан — раннер начнёт пушить каждый ход"

# Копия бесполезна, пока из неё нельзя восстановиться. Проверяем не наличие
# каталога, а то, что клон разворачивается и содержит точку входа.
echo "[проверка] восстанавливаюсь из копии"
RESTORED=$(ssh "$PROD_HOST" "rm -rf /tmp/restore-$SLUG && git clone -q $REPO_ROOT/$SLUG.git /tmp/restore-$SLUG && ls /tmp/restore-$SLUG/server.js >/dev/null && git -C /tmp/restore-$SLUG rev-parse HEAD; rm -rf /tmp/restore-$SLUG")
HEAD_LIVE=$(ssh "$PRODUCTS_HOST" "git -C /srv/products/$SLUG -c safe.directory=/srv/products/$SLUG rev-parse HEAD")
[[ "$RESTORED" == "$HEAD_LIVE" ]] || die "клон разошёлся с живым чекаутом: $RESTORED vs $HEAD_LIVE"
ok "клон совпал с живым чекаутом: ${RESTORED:0:7}"
