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
install -d -o minio -g minio /home/dv/minio-data /etc/minio

cat > /etc/systemd/system/minio.service <<'UNIT'
[Unit]
Description=MinIO
After=network-online.target

[Service]
User=minio
Group=minio
EnvironmentFile=/etc/minio/minio.env
ExecStart=/usr/local/bin/minio server --address :9000 --console-address :9001 /home/dv/minio-data
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

precheck_dns
install_system_packages
install_neo4j
install_minio
install_node_stack
generate_secrets
echo
echo "TODO: остальные шаги provisioning'а добавим в следующих задачах."
