#!/usr/bin/env bash
# Idempotent bootstrap для test-сервера test.linkeon.io.
# Запускается локально с твоей машины: bash scripts/provision-test.sh
# Скрипт ssh'ится на dv@85.192.61.231 и устанавливает весь стек.
#
# Предусловие: DNS-запись test.linkeon.io уже резолвится в 85.192.61.231.
# См. план в docs/superpowers/plans/2026-05-21-linkeon-test-server.md

set -euo pipefail

TEST_HOST="${TEST_HOST:-dv@85.192.61.231}"
TEST_DOMAIN="${TEST_DOMAIN:-test.linkeon.io}"
TEST_USER="${TEST_USER:-dv}"
LE_EMAIL="${LE_EMAIL:-dvvolkovv@gmail.com}"
LOCAL_ENV_FILE="${LOCAL_ENV_FILE:-$(dirname "$0")/test-server.env.local}"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1" >&2; }

ssh_test() { ssh -o StrictHostKeyChecking=accept-new "$TEST_HOST" "$@"; }

install_system_packages() {
  bold "[1/N] System packages (nginx, postgresql, redis, certbot, htpasswd, dig)"
  ssh_test 'sudo bash -s' <<'REMOTE'
set -e
export DEBIAN_FRONTEND=noninteractive

# Если postgresql-16 не находится в default repos — добавь PGDG.
if ! apt-cache show postgresql-16 >/dev/null 2>&1; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
fi

apt-get update -qq
apt-get install -y -qq \
  nginx \
  postgresql-16 postgresql-contrib \
  redis-server \
  certbot python3-certbot-nginx \
  apache2-utils \
  dnsutils curl wget gnupg ca-certificates \
  build-essential
systemctl enable --now nginx postgresql redis-server
REMOTE
  green "  ✓ system packages установлены"
}

install_neo4j() {
  bold "[2/N] Neo4j 5 community"
  ssh_test 'sudo bash -s' <<'REMOTE'
set -e
if command -v neo4j >/dev/null 2>&1; then
  echo "  neo4j уже установлен"
  exit 0
fi
export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://debian.neo4j.com/neotechnology.gpg.key | gpg --dearmor -o /usr/share/keyrings/neo4j.gpg
echo "deb [signed-by=/usr/share/keyrings/neo4j.gpg] https://debian.neo4j.com stable 5" > /etc/apt/sources.list.d/neo4j.list
apt-get update -qq
apt-get install -y -qq neo4j
systemctl enable --now neo4j
REMOTE
  green "  ✓ neo4j установлен"
}

install_minio() {
  bold "[3/N] MinIO"
  ssh_test 'sudo bash -s' <<'REMOTE'
set -e
if [ -x /usr/local/bin/minio ]; then
  echo "  minio binary уже на месте"
else
  wget -qO /usr/local/bin/minio https://dl.min.io/server/minio/release/linux-amd64/minio
  chmod +x /usr/local/bin/minio
fi

id minio >/dev/null 2>&1 || useradd -r -s /sbin/nologin minio
install -d -o minio -g minio /var/lib/minio-data /etc/minio

cat > /etc/systemd/system/minio.service <<'UNIT'
[Unit]
Description=MinIO
After=network-online.target

[Service]
User=minio
Group=minio
EnvironmentFile=/etc/minio/minio.env
ExecStart=/usr/local/bin/minio server --address :9000 --console-address :9001 /var/lib/minio-data
Restart=always
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT

# placeholder env, реальные значения положим в configure_secrets (Task 8)
if [ ! -f /etc/minio/minio.env ]; then
  cat > /etc/minio/minio.env <<EOF
MINIO_ROOT_USER=placeholder
MINIO_ROOT_PASSWORD=placeholder-replace-me
EOF
  chmod 600 /etc/minio/minio.env
fi

systemctl daemon-reload
systemctl enable minio
REMOTE
  green "  ✓ minio установлен (запустим после configure_secrets)"
}

install_node_stack() {
  bold "[4/N] Node 22 + pnpm + pm2 (для юзера $TEST_USER)"
  ssh_test 'bash -s' <<'REMOTE'
set -e
export NVM_DIR="$HOME/.nvm"
if [ ! -d "$NVM_DIR" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22

if ! command -v pnpm >/dev/null; then
  npm install -g pnpm
fi
if ! command -v pm2 >/dev/null; then
  npm install -g pm2
fi

node -v && pnpm -v && pm2 -v
REMOTE
  green "  ✓ node stack установлен"
}

generate_secrets() {
  bold "[5/N] Генерация секретов"
  if [ -f "$LOCAL_ENV_FILE" ]; then
    green "  $LOCAL_ENV_FILE уже существует — не перезаписываю"
    return 0
  fi

  gen() { openssl rand -hex 24; }
  local pg_pass neo4j_pass minio_user minio_pass jwt_a jwt_r basic_pass
  pg_pass=$(gen)
  neo4j_pass=$(gen)
  minio_user="linkeon-test"
  minio_pass=$(gen)
  jwt_a=$(gen)
  jwt_r=$(gen)
  basic_pass=$(openssl rand -base64 18 | tr -d '/+=' | head -c 24)

  cat > "$LOCAL_ENV_FILE" <<EOF
# Сгенерировано provision-test.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)
# GITIGNORED. Не комитить.
TEST_HOST=$TEST_HOST
TEST_BACK_PATH=/home/$TEST_USER/spirits_back
TEST_FRONT_SRC=/home/$TEST_USER/spirits_front_src
TEST_FRONT_SERVED=/home/$TEST_USER/spirits_front
TEST_BASE_URL=https://$TEST_DOMAIN
TEST_BASIC_AUTH=linkeon:$basic_pass

# Backend .env values (для отладки/восстановления)
POSTGRES_PASSWORD=$pg_pass
NEO4J_PASSWORD=$neo4j_pass
MINIO_ACCESS_KEY=$minio_user
MINIO_SECRET_KEY=$minio_pass
JWT_ACCESS_SECRET=$jwt_a
JWT_REFRESH_SECRET=$jwt_r
EOF
  chmod 600 "$LOCAL_ENV_FILE"
  green "  ✓ $LOCAL_ENV_FILE создан"
}

precheck_dns() {
  bold "[0/N] Проверяю DNS"
  # Пробуем несколько resolver'ов — propagation между ними может занять минуты.
  # Достаточно, чтобы хоть один ответил правильным IP.
  local resolvers=("" "@1.1.1.1" "@8.8.8.8")
  local ok=""
  for r in "${resolvers[@]}"; do
    local resolved
    # shellcheck disable=SC2086
    resolved=$(dig +short "$TEST_DOMAIN" $r 2>/dev/null | tail -1)
    if [[ "$resolved" == "85.192.61.231" ]]; then
      ok="${r:-system}"
      break
    fi
  done
  if [[ -z "$ok" ]]; then
    red "  DNS $TEST_DOMAIN не резолвится в 85.192.61.231 ни через system, ни через 1.1.1.1/8.8.8.8"
    red "  Проверь DNS-запись и подожди ~5 минут перед повтором."
    exit 1
  fi
  green "  ✓ DNS ок (через $ok)"
}

configure_services() {
  bold "[6/N] Настройка PG/Neo4j/MinIO с реальными секретами"
  # shellcheck disable=SC1090
  . "$LOCAL_ENV_FILE"

  ssh_test "sudo bash -s" <<REMOTE
set -e

# PostgreSQL: юзер linkeon + БД linkeon
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='linkeon'" | grep -q 1 \\
  || sudo -u postgres psql -c "CREATE USER linkeon WITH PASSWORD '$POSTGRES_PASSWORD'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='linkeon'" | grep -q 1 \\
  || sudo -u postgres createdb -O linkeon linkeon
sudo -u postgres psql -c "ALTER USER linkeon WITH PASSWORD '$POSTGRES_PASSWORD'"

# Neo4j: смена дефолтного пароля. На свежей установке Neo4j 5 default neo4j/neo4j
# требует change-on-login, поэтому пробуем два пути:
# 1) set-initial-password (работает только если auth ещё не использовался)
# 2) cypher-shell с ALTER CURRENT USER (работает после default-auth в состоянии "change required")
if [ ! -f /var/lib/neo4j/.password-set ]; then
  systemctl stop neo4j
  if neo4j-admin dbms set-initial-password "$NEO4J_PASSWORD" 2>&1 | tee /tmp/neo4j-init.log; then
    if grep -qE "Changed password|set" /tmp/neo4j-init.log; then
      :  # успех
    fi
  fi
  systemctl start neo4j

  # Дождаться bolt-порта
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if (echo > /dev/tcp/127.0.0.1/7687) 2>/dev/null; then break; fi
    sleep 2
  done

  # Проверка: попробуем подключиться новым паролем. Если не пускает —
  # значит set-initial-password не сработал, делаем через cypher-shell.
  if ! cypher-shell -a bolt://127.0.0.1:7687 -u neo4j -p "$NEO4J_PASSWORD" "RETURN 1" >/dev/null 2>&1; then
    cypher-shell -a bolt://127.0.0.1:7687 -u neo4j -p neo4j \\
      "ALTER CURRENT USER SET PASSWORD FROM 'neo4j' TO '$NEO4J_PASSWORD'" \\
      || { echo "FATAL: Neo4j password change failed via cypher-shell" >&2; exit 1; }
  fi

  touch /var/lib/neo4j/.password-set
fi

# MinIO: подменить env, рестарт
cat > /etc/minio/minio.env <<EOF
MINIO_ROOT_USER=$MINIO_ACCESS_KEY
MINIO_ROOT_PASSWORD=$MINIO_SECRET_KEY
EOF
chmod 600 /etc/minio/minio.env
systemctl restart minio

# Дождаться MinIO health
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf http://127.0.0.1:9000/minio/health/live >/dev/null; then break; fi
  sleep 2
done
REMOTE
  green "  ✓ сервисы настроены"
}

clone_repos() {
  bold "[7/N] Клонирование репозиториев"
  ssh_test 'bash -s' <<'REMOTE'
set -e
cd ~
if [ ! -d spirits_back ]; then
  git clone git@github.com:dvvolkovv/spirits_back.git
fi
cd spirits_back && git fetch origin && git checkout b2b && git reset --hard origin/b2b && cd ..

if [ ! -d spirits_front_src ]; then
  git clone git@github.com:dvvolkovv/spirits.git spirits_front_src
fi
cd spirits_front_src && git fetch origin && git checkout b2b && git reset --hard origin/b2b && cd ..

mkdir -p ~/spirits_front
REMOTE
  green "  ✓ репозитории склонированы"
}

write_env_files() {
  bold "[8/N] .env файлы для back и front"
  # shellcheck disable=SC1090
  . "$LOCAL_ENV_FILE"

  ssh_test "bash -s" <<REMOTE
set -e
cat > ~/spirits_back/.env <<EOF
NODE_ENV=production
PORT=3001
DEBUG_SMS_CODES=true

SMSAERO_LOGIN=
SMSAERO_API_KEY=
YOOKASSA_SHOP_ID=
YOOKASSA_SECRET_KEY=

JWT_ACCESS_SECRET=$JWT_ACCESS_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET

POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=linkeon
POSTGRES_USER=linkeon
POSTGRES_PASSWORD=$POSTGRES_PASSWORD

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_URL=redis://127.0.0.1:6379

DATABASE_URL=postgresql://linkeon:$POSTGRES_PASSWORD@127.0.0.1:5432/linkeon

NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=$NEO4J_PASSWORD

MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_ACCESS_KEY=$MINIO_ACCESS_KEY
MINIO_SECRET_KEY=$MINIO_SECRET_KEY
MINIO_PUBLIC_URL=https://$TEST_DOMAIN/minio
MINIO_BUCKET_MUSIC=linkeon-smm-music
EOF
chmod 600 ~/spirits_back/.env

cat > ~/spirits_front_src/.env <<EOF
VITE_BACKEND_URL=https://$TEST_DOMAIN
EOF
REMOTE
  green "  ✓ .env файлы записаны"
}

setup_nginx_and_tls() {
  bold "[9/N] Nginx + Let's Encrypt"
  # shellcheck disable=SC1090
  . "$LOCAL_ENV_FILE"
  local basic_user basic_pass
  basic_user="${TEST_BASIC_AUTH%%:*}"
  basic_pass="${TEST_BASIC_AUTH#*:}"

  ssh_test "sudo bash -s" <<REMOTE
set -e

# 1. minimal vhost на 80 для http-01
mkdir -p /var/www/letsencrypt
cat > /etc/nginx/sites-available/$TEST_DOMAIN <<EOF
server {
  listen 80;
  server_name $TEST_DOMAIN;
  location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
  location / { return 200 "bootstrap"; add_header Content-Type text/plain; }
}
EOF
ln -sf /etc/nginx/sites-available/$TEST_DOMAIN /etc/nginx/sites-enabled/$TEST_DOMAIN
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# 2. certbot — webroot, чтобы не править nginx на лету
if [ ! -d /etc/letsencrypt/live/$TEST_DOMAIN ]; then
  certbot certonly --webroot -w /var/www/letsencrypt \\
    -d $TEST_DOMAIN \\
    --non-interactive --agree-tos -m $LE_EMAIL
fi

# 3. htpasswd
if [ ! -f /etc/nginx/.htpasswd-test ]; then
  htpasswd -cb /etc/nginx/.htpasswd-test '$basic_user' '$basic_pass'
else
  htpasswd -b /etc/nginx/.htpasswd-test '$basic_user' '$basic_pass'
fi
chmod 644 /etc/nginx/.htpasswd-test

# 4. финальный vhost: 80 → redirect, 443 TLS+BasicAuth+proxy
cat > /etc/nginx/sites-available/$TEST_DOMAIN <<EOF
server {
  listen 80;
  server_name $TEST_DOMAIN;
  location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
  location / { return 301 https://\\\$host\\\$request_uri; }
}

server {
  listen 443 ssl http2;
  server_name $TEST_DOMAIN;
  ssl_certificate     /etc/letsencrypt/live/$TEST_DOMAIN/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$TEST_DOMAIN/privkey.pem;

  location /.well-known/acme-challenge/ {
    root /var/www/letsencrypt;
    auth_basic off;
  }

  auth_basic           "linkeon test";
  auth_basic_user_file /etc/nginx/.htpasswd-test;

  root /home/$TEST_USER/spirits_front;
  index index.html;
  location / { try_files \\\$uri /index.html; }

  # API: без Basic Auth. JWT (Bearer) и Basic не уживаются в одном Authorization
  # хедере — клиенты с Bearer-токеном получали 401 от nginx до того как запрос
  # доходил до API. Публичные эндпоинты защищены тем что хост test.linkeon.io
  # не индексируется и SMS Aero/YooKassa не настроены (всё no-op).
  location /webhook/ {
    auth_basic off;
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host \\\$host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Real-IP \\\$remote_addr;
    proxy_buffering off;
    proxy_read_timeout 600s;
  }

  # MinIO: без Basic Auth — public objects (аватары, музыка) фронт грузит
  # с URL https://test.linkeon.io/minio/<bucket>/... ИЗ-под basic-auth страницы,
  # т.е. браузер не подмешает там Basic. Так же как на проде из MinIO напрямую.
  location /minio/ {
    auth_basic off;
    proxy_pass http://127.0.0.1:9000/;
    proxy_set_header Host \\\$host;
  }
}
EOF
nginx -t
systemctl reload nginx
REMOTE

  # nginx (www-data) должен иметь +x на домашнюю директорию пользователя
  ssh_test "chmod o+x /home/$TEST_USER"
  green "  ✓ Nginx + TLS + BasicAuth настроены"
}

initial_build_and_pm2() {
  bold "[10/N] Первая сборка back + front, запуск PM2"
  ssh_test 'bash -s' <<'REMOTE'
set -e
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"

cd ~/spirits_back
npm ci --no-audit --no-fund 2>&1 | tail -3
npm run build 2>&1 | tail -3
set -a; . .env; set +a; npm run migrate 2>&1

if pm2 describe linkeon-api >/dev/null 2>&1; then
  pm2 restart linkeon-api
else
  pm2 start dist/main.js --name linkeon-api --time
fi

if [ -d worker ]; then
  cd worker
  npm ci --no-audit --no-fund 2>&1 | tail -3
  npm run build 2>&1 | tail -3
  if pm2 describe linkeon-smm-worker >/dev/null 2>&1; then
    pm2 restart linkeon-smm-worker
  else
    pm2 start dist/index.js --name linkeon-smm-worker --time
  fi
  cd ..
fi

cd ~/spirits_front_src
pnpm install --frozen-lockfile --ignore-scripts 2>&1 | tail -3
pnpm build 2>&1 | tail -3
rsync -az dist/ ~/spirits_front/

pm2 save
REMOTE

  # pm2 startup — нужен sudo, делаем отдельно
  ssh_test 'bash -s' <<'REMOTE'
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
sudo env PATH="$PATH:$(dirname $(which node))" pm2 startup systemd -u $USER --hp $HOME
REMOTE
  green "  ✓ initial build + PM2 готовы"
}

precheck_dns
install_system_packages
install_neo4j
install_minio
install_node_stack
generate_secrets
configure_services
clone_repos
write_env_files
setup_nginx_and_tls
initial_build_and_pm2
echo
green "═══════════════════════════════════════════════════════════════"
green "  ✓ test.linkeon.io готов"
green "═══════════════════════════════════════════════════════════════"
echo "  URL:        https://$TEST_DOMAIN"
echo "  Basic Auth: см. \$TEST_BASIC_AUTH в $LOCAL_ENV_FILE"
echo "  Деплой:     bash scripts/deploy.sh (TEST_ONLY=1 для проверки)"
