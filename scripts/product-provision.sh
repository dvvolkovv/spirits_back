#!/usr/bin/env bash
# Заводит продукт целиком: реестр на проде, чекаут и контейнер на хосте
# продуктов, vhost в nginx. Печатает runner-токен один раз.
#
# Использование:
#   scripts/product-provision.sh <user_id> <Имя продукта> <slug>
#
# Почему скриптом, а не руками: сегодня эта операция состояла из семи команд
# через два сервера, и на ней уже была перепутана переменная окружения
# (PRODUCT_START_CMD вместо PRODUCT_START_SCRIPT) — продукт при этом поднялся,
# но выкаты стали фиктивными. Ручные шаги здесь стоят слишком дорого.
set -euo pipefail

PROD_HOST="${PROD_HOST:-dvolkov@212.113.106.202}"
PRODUCTS_HOST="${PRODUCTS_HOST:-root@139.59.210.42}"
PRODUCTS_IP="${PRODUCTS_IP:-139.59.210.42}"
LINKEON_URL="${LINKEON_URL:-https://my.linkeon.io}"
DOMAIN_SUFFIX="${DOMAIN_SUFFIX:-p.linkeon.io}"

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <user_id> <Имя продукта> <slug>" >&2
  exit 2
fi
USER_ID="$1"; NAME="$2"; SLUG="$3"

[[ "$SLUG" =~ ^[a-z0-9-]+$ ]] || { echo "slug: только строчные латинские, цифры и дефис" >&2; exit 2; }

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "\033[32m  ✓ %s\033[0m\n" "$1"; }
die()  { printf "\033[31m  ✗ %s\033[0m\n" "$1" >&2; exit 1; }

bold "[1/6] проверяю, что слаг свободен"
EXISTS=$(ssh "$PROD_HOST" "psql \"\$(grep -E '^DATABASE_URL=' ~/spirits_back/.env | cut -d= -f2- | tr -d '\"')\" -tAc \"SELECT count(*) FROM products WHERE slug='$SLUG'\"")
[[ "$EXISTS" == "0" ]] || die "продукт со слагом $SLUG уже заведён"
ok "слаг свободен"

bold "[2/6] выбираю свободный порт на хосте продуктов"
PORT=$(ssh "$PRODUCTS_HOST" '
  for p in $(seq 8001 8099); do
    if ! docker ps --format "{{.Ports}}" | grep -q ":$p->"; then echo "$p"; exit 0; fi
  done
  exit 1') || die "свободных портов в диапазоне 8001-8099 нет"
ok "порт $PORT"

bold "[3/6] создаю чекаут продукта"
ssh "$PRODUCTS_HOST" "
  set -e
  D=/srv/products/$SLUG
  [ -e \$D ] && { echo 'каталог уже существует'; exit 1; }
  mkdir -p \$D && cd \$D
  cat > package.json <<'PKG'
{ \"name\": \"$SLUG\", \"version\": \"1.0.0\", \"private\": true,
  \"scripts\": { \"start\": \"node server.js\", \"build\": \"echo nothing to build\" } }
PKG
  cat > server.js <<'SRV'
const http = require('http');
const PORT = process.env.PORT || 3000;
const page = '<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><title>Новый продукт</title></head>'
  + '<body><h1>Новый продукт</h1><p>Этот сайт правит ассистент Linkeon.</p></body></html>';
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ok:true})); }
  res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
  res.end(page);
}).listen(PORT);
SRV
  cat > CLAUDE.md <<'DOC'
# $NAME

Сайт на голом node. Правится ассистентом Linkeon.

## Где что
- \`server.js\` — весь сайт, точка входа
- Порт берётся из \`PORT\`, менять нельзя: снаружи на него смотрит nginx
- \`/health\` отдаёт \`{\"ok\":true}\` — по нему проверяется, что правка не сломала сайт

## Как это работает
Продукт живёт в контейнере под PM2, процесс называется \`product\`.
После правки: \`npm run build\`, затем \`pm2 restart product\`.

## Что не трогать
\`/health\` обязан отвечать 200 и JSON. Если он сломается, ход откатится
автоматически, а правка потеряется.
DOC
  git init -q
  git config user.email 'assistant@linkeon.io'
  git config user.name 'Linkeon Assistant'
  git add -A && git commit -qm 'первичный каркас продукта'
  chown -R 1000:1000 \$D
"
ok "чекаут /srv/products/$SLUG создан"

bold "[4/6] завожу в реестре на проде"
OUT=$(ssh "$PROD_HOST" "cd ~/spirits_back && DATABASE_URL=\$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '\"') bash scripts/products-register.sh '$USER_ID' '$NAME' '$SLUG' /product")
PRODUCT_ID=$(echo "$OUT" | head -1 | tr -d ' ')
TOKEN=$(echo "$OUT" | grep '^RUNNER_TOKEN=' | cut -d= -f2)
[[ -n "$TOKEN" ]] || die "токен не получен"
ssh "$PROD_HOST" "psql \"\$(grep -E '^DATABASE_URL=' ~/spirits_back/.env | cut -d= -f2- | tr -d '\"')\" -v ON_ERROR_STOP=1 -qc \"
  UPDATE products SET build_cmd='npm run build', restart_cmd='pm2 restart product',
    health_url='http://127.0.0.1:3000/health', domain='$SLUG.$DOMAIN_SUFFIX', host_ip='$PRODUCTS_IP'
  WHERE slug='$SLUG'\"" >/dev/null
ok "продукт $PRODUCT_ID заведён"

bold "[5/6] поднимаю контейнер"
# PRODUCT_START_SCRIPT — путь к точке входа, НЕ команда. С командой pm2 владеет
# оболочкой, а не node: при перезапуске старый процесс выживает сиротой, держит
# порт и отвечает старым кодом. Health-check тогда проверяет сироту, выкат
# считается удачным, а автооткат не срабатывает никогда.
ssh "$PRODUCTS_HOST" "
  docker run -d --name '$SLUG' --restart unless-stopped \
    -v /srv/products/$SLUG:/product \
    -p 127.0.0.1:$PORT:3000 \
    -e LINKEON_URL='$LINKEON_URL' \
    -e RUNNER_TOKEN='$TOKEN' \
    -e CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat /root/.secrets/claude-oauth-token)\" \
    -e PRODUCT_START_SCRIPT=server.js -e PORT=3000 \
    --memory=1g --cpus=1 linkeon-product:base >/dev/null
  sleep 12
  product-vhost '$SLUG' '$PORT' >/dev/null
"
ok "контейнер и vhost подняты"

bold "[6/6] проверяю"
PM2=$(ssh "$PRODUCTS_HOST" "docker exec '$SLUG' pm2 jlist 2>/dev/null | python3 -c \"import sys,json;print(json.load(sys.stdin)[0]['pm2_env']['status'])\"")
[[ "$PM2" == "online" ]] || die "продукт не поднялся под pm2: $PM2"
ok "pm2: online"

CODE=$(ssh "$PRODUCTS_HOST" "curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:$PORT/")
[[ "$CODE" == "200" ]] || die "сайт отвечает $CODE"
ok "сайт отвечает 200"

# Heartbeat доказывает, что раннер не просто запустился, а достучался до
# Linkeon с этим токеном. Без него продукт молча не получал бы работу.
for _ in $(seq 1 12); do
  SEEN=$(ssh "$PROD_HOST" "psql \"\$(grep -E '^DATABASE_URL=' ~/spirits_back/.env | cut -d= -f2- | tr -d '\"')\" -tAc \"SELECT runner_seen_at IS NOT NULL FROM products WHERE slug='$SLUG'\"")
  [[ "$SEEN" == "t" ]] && break
  sleep 5
done
[[ "$SEEN" == "t" ]] || die "раннер не отметился на проде — продукт не будет получать задачи"
ok "heartbeat дошёл до Linkeon"

echo
bold "готово: https://$SLUG.$DOMAIN_SUFFIX"
echo "RUNNER_TOKEN=$TOKEN"
echo "Сохрани токен сейчас — второй раз он не покажется."
