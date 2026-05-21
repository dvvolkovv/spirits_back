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
echo
echo "TODO: остальные шаги provisioning'а добавим в следующих задачах."
