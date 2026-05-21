# Linkeon Test Server + Two-Phase Deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поднять `test.linkeon.io` как промежуточный gating-стенд: каждый `deploy.sh` сначала катит на test → гонит smoke → только если зелёный, катит на прод.

**Architecture:** Свежий VPS `dv@85.192.61.231` обживается нативным стеком (Nginx + PG/Redis/Neo4j/MinIO + Node 22 + PM2), повторяющим прод. Доступ закрыт Basic Auth на уровне Nginx, SMS отключаются через пустые env-переменные, `DEBUG_SMS_CODES=true` даёт тестам доступ к OTP. `deploy.sh` рефакторим в две фазы (test → prod), где функции деплоя параметризованы и переиспользуются.

**Tech Stack:** bash, Nginx, Let's Encrypt (certbot), PostgreSQL 16, Redis 7, Neo4j 5, MinIO, PM2, Node 22, pnpm, Playwright, axios, Jest.

**Спека:** [`docs/superpowers/specs/2026-05-21-linkeon-test-server-design.md`](../specs/2026-05-21-linkeon-test-server-design.md)

---

## Файлы изменений

| Путь | Действие |
|---|---|
| `~/Downloads/spirits_back/scripts/provision-test.sh` | новый, ~200 строк, идемпотентный bootstrap test-сервера |
| `~/Downloads/spirits_back/scripts/test-server.env.local` | новый, gitignored, креды test |
| `~/Downloads/spirits_back/scripts/deploy.sh` | refactor + PHASE 1 (test) |
| `~/Downloads/spirits_back/tests/playwright/playwright.config.js` | поддержка `BASIC_AUTH` |
| `~/Downloads/spirits_back/tests/smoke/smoke.js` | поддержка `BASIC_AUTH` через axios |
| `~/Downloads/spirits_back/.gitignore` | добавить `scripts/test-server.env.local` |
| `~/Downloads/spirits_back/CLAUDE.md` | задокументировать пайплайн |
| `~/Downloads/spirits_front/CLAUDE.md` | задокументировать пайплайн |
| на test-сервере: `/etc/nginx/sites-enabled/test.linkeon.io` | создаётся provision-скриптом |
| на test-сервере: `/home/dv/spirits_back/.env`, `/home/dv/spirits_front_src/.env` | создаются provision-скриптом |

---

## Порядок выполнения

Задачи 1–11 — provision test-сервера (одноразовый bootstrap). Задачи 12–17 — изменения в `spirits_back` (адаптация тестов + рефакторинг deploy.sh). Задача 18 — end-to-end проверка. Задача 19 — документация.

---

### Task 1: DNS-запись `test.linkeon.io`

DNS-запись A на `85.192.61.231` создаётся вручную в DNS-панели. Скрипты её не создают — только проверяют.

**Files:** —

- [ ] **Step 1: Создать A-запись в DNS-панели Linkeon**

  В DNS-провайдере, который держит зону `linkeon.io`, добавить:
  ```
  test  A  85.192.61.231  TTL 300
  ```

- [ ] **Step 2: Проверить резолв**

  Run: `dig +short test.linkeon.io @1.1.1.1`
  Expected: `85.192.61.231` (может занять до 5 минут после создания записи).

  Альтернативно: `nslookup test.linkeon.io 1.1.1.1`.

  **Не переходить к Task 2 пока резолв не отдаёт правильный IP** — certbot позже упрётся в это.

---

### Task 2: Создать `scripts/provision-test.sh` с заголовком и каркасом

**Files:**
- Create: `~/Downloads/spirits_back/scripts/provision-test.sh`

- [ ] **Step 1: Написать каркас скрипта**

  ```bash
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
  
  precheck_dns() {
    bold "[0/N] Проверяю DNS"
    local resolved
    resolved=$(dig +short "$TEST_DOMAIN" @1.1.1.1 | tail -1)
    if [[ "$resolved" != "85.192.61.231" ]]; then
      red "  DNS $TEST_DOMAIN резолвится в '$resolved', ожидаю 85.192.61.231"
      red "  Проверь DNS-запись и подожди ~5 минут перед повтором."
      exit 1
    fi
    green "  ✓ DNS ок"
  }
  
  precheck_dns
  echo
  echo "TODO: остальные шаги provisioning'а добавим в следующих задачах."
  ```

  Затем: `chmod +x ~/Downloads/spirits_back/scripts/provision-test.sh`

- [ ] **Step 2: Проверить, что каркас работает**

  Run: `bash ~/Downloads/spirits_back/scripts/provision-test.sh`
  Expected: `✓ DNS ок` и сообщение про TODO.

- [ ] **Step 3: Commit**

  ```bash
  cd ~/Downloads/spirits_back
  git add scripts/provision-test.sh
  git commit -m "feat(scripts): каркас provision-test.sh с DNS-precheck"
  ```

---

### Task 3: Установить системные пакеты

**Files:**
- Modify: `~/Downloads/spirits_back/scripts/provision-test.sh` (добавить функцию `install_system_packages`)

- [ ] **Step 1: Добавить функцию в скрипт**

  Перед `precheck_dns` добавь:

  ```bash
  install_system_packages() {
    bold "[1/N] System packages (nginx, postgresql, redis, certbot, htpasswd, dig)"
    ssh_test 'sudo bash -s' <<'REMOTE'
  set -e
  export DEBIAN_FRONTEND=noninteractive
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
  ```

  Замени тело скрипта в конце:
  ```bash
  precheck_dns
  install_system_packages
  echo
  echo "TODO: следующие шаги..."
  ```

- [ ] **Step 2: Запустить и проверить**

  Run: `bash ~/Downloads/spirits_back/scripts/provision-test.sh`
  Expected: `✓ DNS ок` → apt сообщения → `✓ system packages установлены`.

  Verify: `ssh dv@85.192.61.231 'systemctl is-active nginx postgresql redis-server'`
  Expected: три раза `active`.

  Проверка через браузер: открыть `http://85.192.61.231/` → Nginx default page.

  PostgreSQL 16 на Ubuntu 24.04 идёт из официального репозитория (`apt info postgresql-16`). Если apt не находит — добавь PGDG repo в начале функции:
  ```bash
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  ```

- [ ] **Step 3: Commit**

  ```bash
  cd ~/Downloads/spirits_back
  git add scripts/provision-test.sh
  git commit -m "feat(scripts): provision-test.sh — установка системных пакетов"
  ```

---

### Task 4: Установить Neo4j 5 community

**Files:**
- Modify: `~/Downloads/spirits_back/scripts/provision-test.sh`

- [ ] **Step 1: Добавить функцию `install_neo4j`**

  ```bash
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
  ```

  Добавь вызов после `install_system_packages`.

- [ ] **Step 2: Запустить и проверить**

  Run: `bash ~/Downloads/spirits_back/scripts/provision-test.sh`
  Verify: `ssh dv@85.192.61.231 'systemctl is-active neo4j'` → `active`.
  Verify: `ssh dv@85.192.61.231 'curl -s http://127.0.0.1:7474'` → HTML с Neo4j Browser.

- [ ] **Step 3: Commit**

  ```bash
  git add scripts/provision-test.sh
  git commit -m "feat(scripts): provision-test.sh — установка Neo4j 5"
  ```

---

### Task 5: Установить MinIO

**Files:**
- Modify: `~/Downloads/spirits_back/scripts/provision-test.sh`

- [ ] **Step 1: Добавить функцию `install_minio`**

  ```bash
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
  
  # placeholder env, реальные значения положим в configure_secrets
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
  ```

  Добавь вызов после `install_neo4j`.

- [ ] **Step 2: Запустить и проверить**

  Run: `bash ~/Downloads/spirits_back/scripts/provision-test.sh`
  Verify: `ssh dv@85.192.61.231 'test -x /usr/local/bin/minio && echo ok'` → `ok`.
  Verify: `ssh dv@85.192.61.231 'systemctl is-enabled minio'` → `enabled`.

- [ ] **Step 3: Commit**

  ```bash
  git add scripts/provision-test.sh
  git commit -m "feat(scripts): provision-test.sh — установка MinIO + systemd unit"
  ```

---

### Task 6: Установить Node 22 + pnpm + pm2 для юзера dv

**Files:**
- Modify: `~/Downloads/spirits_back/scripts/provision-test.sh`

- [ ] **Step 1: Добавить функцию `install_node_stack`**

  ```bash
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
  ```

  Добавь вызов после `install_minio`.

- [ ] **Step 2: Запустить и проверить**

  Run: `bash ~/Downloads/spirits_back/scripts/provision-test.sh`
  Expected: версии `v22.x.x`, `9.x` (pnpm), `5.x` (pm2).

  Verify: `ssh dv@85.192.61.231 'source ~/.nvm/nvm.sh && node -v'` → `v22.x.x`.

- [ ] **Step 3: Commit**

  ```bash
  git add scripts/provision-test.sh
  git commit -m "feat(scripts): provision-test.sh — Node 22 + pnpm + pm2"
  ```

---

### Task 7: Сгенерировать секреты и записать `test-server.env.local`

**Files:**
- Modify: `~/Downloads/spirits_back/scripts/provision-test.sh`
- Modify: `~/Downloads/spirits_back/.gitignore`

- [ ] **Step 1: Добавить `scripts/test-server.env.local` в gitignore**

  Edit `~/Downloads/spirits_back/.gitignore`:
  ```
  node_modules/
  dist/
  .env
  *.log
  .worktrees/
  scripts/test-server.env.local
  ```

- [ ] **Step 2: Добавить функцию `generate_secrets`**

  ```bash
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
  ```

  Добавь вызов после `install_node_stack`.

- [ ] **Step 3: Запустить и проверить**

  Run: `bash ~/Downloads/spirits_back/scripts/provision-test.sh`
  Verify: `cat ~/Downloads/spirits_back/scripts/test-server.env.local` показывает заполненный файл.
  Verify: `git -C ~/Downloads/spirits_back status` — файл не виден.

- [ ] **Step 4: Commit**

  ```bash
  git add .gitignore scripts/provision-test.sh
  git commit -m "feat(scripts): provision-test.sh — генерация секретов + gitignore"
  ```

---

### Task 8: Сконфигурировать PostgreSQL, Redis, Neo4j, MinIO с реальными секретами

**Files:**
- Modify: `~/Downloads/spirits_back/scripts/provision-test.sh`

- [ ] **Step 1: Добавить функцию `configure_services`**

  ```bash
  configure_services() {
    bold "[6/N] Настройка PG/Redis/Neo4j/MinIO с реальными секретами"
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
  
  # Neo4j: смена дефолтного пароля (по умолчанию neo4j/neo4j, требует смены)
  if [ ! -f /var/lib/neo4j/.password-set ]; then
    cypher-shell -u neo4j -p neo4j "ALTER CURRENT USER SET PASSWORD FROM 'neo4j' TO '$NEO4J_PASSWORD'" || \\
      neo4j-admin dbms set-initial-password '$NEO4J_PASSWORD'
    touch /var/lib/neo4j/.password-set
  fi
  
  # MinIO: подменить env, рестарт
  cat > /etc/minio/minio.env <<EOF
  MINIO_ROOT_USER=$MINIO_ACCESS_KEY
  MINIO_ROOT_PASSWORD=$MINIO_SECRET_KEY
  EOF
  chmod 600 /etc/minio/minio.env
  systemctl restart minio
  REMOTE
    green "  ✓ сервисы настроены"
  }
  ```

  Добавь вызов после `generate_secrets`.

- [ ] **Step 2: Запустить и проверить**

  Run: `bash ~/Downloads/spirits_back/scripts/provision-test.sh`

  Verify Postgres:
  ```bash
  ssh dv@85.192.61.231 "PGPASSWORD=\$(grep POSTGRES_PASSWORD /tmp/_skip_or_run.env 2>/dev/null) psql -h 127.0.0.1 -U linkeon -d linkeon -c 'SELECT 1'"
  ```
  Или проще — с локалки:
  ```bash
  source ~/Downloads/spirits_back/scripts/test-server.env.local
  ssh dv@85.192.61.231 "PGPASSWORD=$POSTGRES_PASSWORD psql -h 127.0.0.1 -U linkeon -d linkeon -c 'SELECT 1'"
  ```
  Expected: одна строка с `1`.

  Verify MinIO: `curl -s http://85.192.61.231:9000/minio/health/live` через ssh-tunnel или локально через `ssh -L 9000:127.0.0.1:9000 dv@85.192.61.231` → `200`.

  Verify Neo4j: `ssh dv@85.192.61.231 "cypher-shell -u neo4j -p '$NEO4J_PASSWORD' 'RETURN 1'"` → строка `1`.

- [ ] **Step 3: Commit**

  ```bash
  git add scripts/provision-test.sh
  git commit -m "feat(scripts): provision-test.sh — настройка БД и MinIO с секретами"
  ```

---

### Task 9: Клонировать репозитории на test-сервер + создать `.env` файлы

**Files:**
- Modify: `~/Downloads/spirits_back/scripts/provision-test.sh`

GitHub Deploy Keys: на проде уже зарегистрирован `id_rsa.pub` юзера `dvolkov`. Для test нужен новый ключ юзера `dv` в обоих репозиториях (`spirits_back` и `spirits`).

- [ ] **Step 1: Сгенерировать SSH-ключ для `dv` на test-сервере**

  ```bash
  ssh dv@85.192.61.231 'ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C "dv@test.linkeon.io" 2>/dev/null || echo "ключ уже есть"; cat ~/.ssh/id_ed25519.pub'
  ```

  Скопируй вывод `ssh-ed25519 ...`.

- [ ] **Step 2: Зарегистрировать ключ в GitHub Deploy Keys**

  - `https://github.com/dvvolkovv/spirits_back/settings/keys` → Add deploy key → Title: `test.linkeon.io dv`, paste pubkey, **read-only**.
  - `https://github.com/dvvolkovv/spirits/settings/keys` → то же самое.

- [ ] **Step 3: Добавить github.com в known_hosts на test**

  ```bash
  ssh dv@85.192.61.231 'ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null'
  ```

  Verify: `ssh dv@85.192.61.231 'ssh -T git@github.com 2>&1 | head -1'` → `Hi dvvolkovv/...: You've successfully authenticated...`.

- [ ] **Step 4: Добавить функцию `clone_repos` в provision-test.sh**

  ```bash
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
  ```

  Добавь вызов после `configure_services`.

- [ ] **Step 5: Добавить функцию `write_env_files`**

  ```bash
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
  ```

  Вызов после `clone_repos`.

- [ ] **Step 6: Запустить и проверить**

  Run: `bash ~/Downloads/spirits_back/scripts/provision-test.sh`
  Verify:
  ```bash
  ssh dv@85.192.61.231 'ls -la ~/spirits_back/.env ~/spirits_front_src/.env; head -2 ~/spirits_back/.env'
  ```
  Expected: оба файла существуют, `chmod 600`, первая строка `NODE_ENV=production`.

- [ ] **Step 7: Commit**

  ```bash
  git add scripts/provision-test.sh
  git commit -m "feat(scripts): provision-test.sh — clone репо + .env для test"
  ```

---

### Task 10: Минимальный Nginx + Let's Encrypt cert + финальный vhost

Сначала ставим nginx-vhost на 80 порту (чтобы certbot сделал http-01), потом certbot выписывает cert, потом перезаписываем vhost на наш финальный с TLS + Basic Auth + proxy.

**Files:**
- Modify: `~/Downloads/spirits_back/scripts/provision-test.sh`

- [ ] **Step 1: Добавить функцию `setup_nginx_and_tls`**

  ```bash
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
    
    location /webhook/ {
      proxy_pass http://127.0.0.1:3001;
      proxy_set_header Host \\\$host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Real-IP \\\$remote_addr;
      proxy_buffering off;
      proxy_read_timeout 600s;
    }
    
    location /minio/ {
      proxy_pass http://127.0.0.1:9000/;
      proxy_set_header Host \\\$host;
    }
  }
  EOF
  nginx -t
  systemctl reload nginx
  REMOTE
    green "  ✓ Nginx + TLS + BasicAuth настроены"
  }
  ```

  Добавь вызов после `write_env_files`.

- [ ] **Step 2: Запустить и проверить**

  Run: `bash ~/Downloads/spirits_back/scripts/provision-test.sh`

  Verify TLS:
  ```bash
  curl -sI https://test.linkeon.io/ | head -5
  ```
  Expected: `HTTP/2 401` + `www-authenticate: Basic realm="linkeon test"`.

  Verify Basic Auth работает:
  ```bash
  source ~/Downloads/spirits_back/scripts/test-server.env.local
  curl -s -u "$TEST_BASIC_AUTH" -o /dev/null -w "%{http_code}\n" https://test.linkeon.io/
  ```
  Expected: `404` (`/home/dv/spirits_front` пустая, нет `index.html` — это нормально, файл появится после первого деплоя).

  Verify HTTP → HTTPS:
  ```bash
  curl -sI http://test.linkeon.io/ | head -3
  ```
  Expected: `HTTP/1.1 301` + `location: https://test.linkeon.io/`.

- [ ] **Step 3: Commit**

  ```bash
  git add scripts/provision-test.sh
  git commit -m "feat(scripts): provision-test.sh — Nginx, Let's Encrypt cert, Basic Auth"
  ```

---

### Task 11: Финализация provision — первый build + PM2 startup

**Files:**
- Modify: `~/Downloads/spirits_back/scripts/provision-test.sh`

- [ ] **Step 1: Добавить функцию `initial_build_and_pm2`**

  ```bash
  initial_build_and_pm2() {
    bold "[10/N] Первая сборка back + front, запуск PM2"
    ssh_test 'bash -s' <<'REMOTE'
  set -e
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
  
  cd ~/spirits_back
  npm ci --no-audit --no-fund 2>&1 | tail -3
  npm run build 2>&1 | tail -3
  
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
      pm2 start dist/main.js --name linkeon-smm-worker --time
    fi
    cd ..
  fi
  
  cd ~/spirits_front_src
  pnpm install --frozen-lockfile 2>&1 | tail -3
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
  ```

  Добавь вызов после `setup_nginx_and_tls`.

- [ ] **Step 2: Заменить финальный echo на summary**

  В конце скрипта замени `echo "TODO..."` на:
  ```bash
  echo
  green "═══════════════════════════════════════════════════════════════"
  green "  ✓ test.linkeon.io готов"
  green "═══════════════════════════════════════════════════════════════"
  echo "  URL:        https://$TEST_DOMAIN"
  echo "  Basic Auth: см. \$TEST_BASIC_AUTH в $LOCAL_ENV_FILE"
  echo "  Деплой:     bash scripts/deploy.sh (TEST_ONLY=1 для проверки)"
  ```

- [ ] **Step 3: Запустить полный provision**

  Run: `bash ~/Downloads/spirits_back/scripts/provision-test.sh`
  Expected: все шаги зелёные, в конце summary с URL.

  Verify в браузере:
  - Открой `https://test.linkeon.io/` → запрос Basic Auth → введи логин/пароль из `TEST_BASIC_AUTH` → загружается my.linkeon.io UI.
  - Открой DevTools Network → запросы к `/webhook/agents` должны быть 200.
  - Open в incognito → попробуй залогиниться телефоном `70000000000`, получи код через `curl -u $TEST_BASIC_AUTH https://test.linkeon.io/webhook/debug/sms-code/70000000000`.

- [ ] **Step 4: Commit**

  ```bash
  git add scripts/provision-test.sh
  git commit -m "feat(scripts): provision-test.sh — initial build + PM2 startup"
  ```

---

### Task 12: Поддержка `BASIC_AUTH` в smoke.js

**Files:**
- Modify: `~/Downloads/spirits_back/tests/smoke/smoke.js`

- [ ] **Step 1: Прочитать текущий код smoke.js**

  Run: `head -30 ~/Downloads/spirits_back/tests/smoke/smoke.js`

  Найди, где импортируется axios или создаётся axios-инстанс.

- [ ] **Step 2: Добавить настройку axios.defaults.auth**

  Сразу после `const axios = require('axios')` (или эквивалентного импорта) добавь:

  ```js
  // Basic Auth для test-сервера (test.linkeon.io). На проде BASIC_AUTH пустой.
  if (process.env.BASIC_AUTH) {
    const [username, ...passParts] = process.env.BASIC_AUTH.split(':');
    axios.defaults.auth = { username, password: passParts.join(':') };
  }
  ```

  Если в smoke.js axios используется через `axios.create(...)`, добавь параметр `auth` в опции инстанса вместо `defaults`.

- [ ] **Step 3: Прогнать smoke на проде — убедиться, что ничего не сломалось**

  ```bash
  cd ~/Downloads/spirits_back/tests
  BASE_URL=https://my.linkeon.io node smoke/smoke.js
  ```
  Expected: тот же результат, что и до изменения (без `BASIC_AUTH` ничего не меняется).

- [ ] **Step 4: Прогнать smoke на test**

  ```bash
  source ~/Downloads/spirits_back/scripts/test-server.env.local
  cd ~/Downloads/spirits_back/tests
  BASE_URL=$TEST_BASE_URL BASIC_AUTH=$TEST_BASIC_AUTH node smoke/smoke.js
  ```
  Expected: smoke зелёный.

  Если что-то падает — большинство тестов используют `BASE_URL` и axios; если найдёшь голые `fetch()` — нужно туда тоже Basic Auth добавить (либо мигрировать на axios, либо через заголовок).

- [ ] **Step 5: Commit**

  ```bash
  cd ~/Downloads/spirits_back
  git add tests/smoke/smoke.js
  git commit -m "test(smoke): поддержка BASIC_AUTH для test.linkeon.io"
  ```

---

### Task 13: Поддержка `BASIC_AUTH` в playwright.config.js

**Files:**
- Modify: `~/Downloads/spirits_back/tests/playwright/playwright.config.js`

- [ ] **Step 1: Добавить httpCredentials в `use`**

  Найти блок:
  ```js
  use: {
    baseURL: process.env.BASE_URL || 'https://my.linkeon.io',
    ...
  }
  ```

  Заменить на:
  ```js
  use: {
    baseURL: process.env.BASE_URL || 'https://my.linkeon.io',
    httpCredentials: process.env.BASIC_AUTH
      ? (() => {
          const [username, ...rest] = process.env.BASIC_AUTH.split(':');
          return { username, password: rest.join(':') };
        })()
      : undefined,
    headless: true,
    actionTimeout: 15000,
    navigationTimeout: 30000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  ```

- [ ] **Step 2: Прогнать Playwright против test**

  ```bash
  source ~/Downloads/spirits_back/scripts/test-server.env.local
  cd ~/Downloads/spirits_back/tests
  BASE_URL=$TEST_BASE_URL BASIC_AUTH=$TEST_BASIC_AUTH npx playwright test --config=playwright/playwright.config.js --reporter=list
  ```
  Expected: всё зелёное (Playwright сам подмешивает Basic Auth в каждый request).

- [ ] **Step 3: Прогнать Playwright против прода (убедиться что не сломали)**

  ```bash
  cd ~/Downloads/spirits_back/tests
  BASE_URL=https://my.linkeon.io npx playwright test --config=playwright/playwright.config.js --reporter=list
  ```
  Expected: всё зелёное.

- [ ] **Step 4: Commit**

  ```bash
  git add tests/playwright/playwright.config.js
  git commit -m "test(playwright): httpCredentials через BASIC_AUTH env"
  ```

---

### Task 14: Рефакторинг `deploy.sh` — параметризовать `deploy_backend` / `deploy_frontend`

Текущие функции захардкожены на прод. Делаем их аргументозависимыми, чтобы переиспользовать для test и для прода.

**Files:**
- Modify: `~/Downloads/spirits_back/scripts/deploy.sh`

- [ ] **Step 1: Прочитать текущий deploy.sh и понять структуру**

  Run: `cat ~/Downloads/spirits_back/scripts/deploy.sh`

  Главные функции — `deploy_backend()`, `deploy_frontend()`, `run_smoke()`, `ssh_prod()`, `push_local_repo()`.

- [ ] **Step 2: Превратить `ssh_prod` в общий `ssh_remote`**

  Заменить:
  ```bash
  ssh_prod() {
    ssh "$PROD_HOST" "export PATH=\$HOME/.npm-global/bin:\$PATH; $*"
  }
  ```
  
  На:
  ```bash
  # Универсальный ssh-обёртка. Параметры берёт из глобальных $HOST, $PATH_EXPORT.
  # PATH_EXPORT для прода — '~/.npm-global/bin'; для test — '~/.nvm/versions/node/v22.x/bin' (или просто пустой,
  # т.к. nvm pre-загружается через .bashrc — см. ниже).
  ssh_remote() {
    ssh "$HOST" "export PATH=$PATH_EXPORT:\$HOME/.npm-global/bin:\$PATH; $*"
  }
  ```

  И заменить **все вызовы** `ssh_prod` → `ssh_remote` (там примерно 3 места: в deploy_backend, deploy_frontend, и в health-wait curl делается локально — там не трогаем).

- [ ] **Step 3: Параметризовать `deploy_backend()` через переменные окружения**

  Все обращения внутри функции к `$PROD_HOST`, `$BACK_PATH`, `$BASE_URL`, `$BRANCH` оставить как есть — но сами переменные внешние. Переименовать в функции:
  
  ```bash
  deploy_backend() {
    bold "=== BACKEND ($ENV_NAME) ==="
    bold "[back 1/3] pushing local commits to origin"
    push_local_repo "$LOCAL_BACK_DIR" "spirits_back"
  
    bold "[back 2/3] pulling on $ENV_NAME + building + restarting"
    ssh_remote "
      set -e
      cd $BACK_PATH
      git fetch origin
      git reset --hard origin/$BRANCH
      npm ci --no-audit --no-fund 2>&1 | tail -3
      npm run build 2>&1 | tail -3
      pm2 restart linkeon-api 2>&1 | tail -2
      if [ -d worker ]; then
        cd worker
        npm ci --no-audit --no-fund 2>&1 | tail -3
        npm run build 2>&1 | tail -3
        pm2 restart linkeon-smm-worker 2>&1 | tail -2
        cd ..
      fi
    " || { red "  backend deploy failed ($ENV_NAME)"; exit 1; }
  
    bold "[back 3/3] health-wait $BASE_URL"
    for i in $(seq 1 30); do
      code=$(curl -s ${BASIC_AUTH:+-u $BASIC_AUTH} -o /dev/null -w "%{http_code}" "${BASE_URL}/webhook/agents" || echo "0")
      if [[ "$code" == "200" ]]; then
        green "  ✓ /webhook/agents = 200 after ${i}s ($ENV_NAME)"
        return 0
      fi
      if [[ "$i" == "30" ]]; then
        red "  ✗ backend ($ENV_NAME) didn't come up within 30s (last $code)"
        exit 1
      fi
      sleep 1
    done
  }
  ```

- [ ] **Step 4: То же для `deploy_frontend()`**

  ```bash
  deploy_frontend() {
    bold "=== FRONTEND ($ENV_NAME) ==="
    bold "[front 1/2] pushing local commits to origin"
    push_local_repo "$LOCAL_FRONT_DIR" "spirits_front"
  
    bold "[front 2/2] pulling on $ENV_NAME + building + deploying to nginx dir"
    ssh_remote "
      set -e
      cd $FRONT_SRC
      git fetch origin
      git reset --hard origin/$BRANCH
      echo 'VITE_BACKEND_URL=$BASE_URL' > .env
      pnpm install --frozen-lockfile 2>&1 | tail -3
      pnpm build 2>&1 | tail -3
      rsync -az dist/ $FRONT_SERVED/
    " || { red "  frontend deploy failed ($ENV_NAME)"; exit 1; }
    green "  ✓ frontend bundle deployed ($ENV_NAME)"
  }
  ```

  **Внимание:** убрал `--delete` из `rsync` (см. CLAUDE.md в spirits_front: «Запрет rsync --delete»).

- [ ] **Step 5: Прогнать существующий прод-деплой через рефакторёный скрипт**

  Подмена через переменные:
  ```bash
  cd ~/Downloads/spirits_back
  ENV_NAME=prod \
  HOST=dvolkov@212.113.106.202 \
  PATH_EXPORT='~/.npm-global/bin' \
  BACK_PATH=/home/dvolkov/spirits_back \
  FRONT_SRC=/home/dvolkov/spirits_front_src \
  FRONT_SERVED=/home/dvolkov/spirits_front \
  BASE_URL=https://my.linkeon.io \
  BRANCH=b2b \
  BASIC_AUTH= \
  bash -c 'source scripts/deploy.sh; deploy_backend; deploy_frontend'
  ```
  
  *Этот шаг — sanity check рефакторинга; не дёргает PHASE 2 пока что.*

  Expected: прод задеплоился как обычно.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/deploy.sh
  git commit -m "refactor(deploy): параметризация deploy_backend/deploy_frontend"
  ```

---

### Task 15: Добавить PHASE 1 (TEST) в `deploy.sh`

**Files:**
- Modify: `~/Downloads/spirits_back/scripts/deploy.sh`

- [ ] **Step 1: Source `test-server.env.local` в начале скрипта**

  Сразу после `set -uo pipefail`:

  ```bash
  # Local creds (gitignored)
  TEST_ENV_FILE="$(dirname "${BASH_SOURCE[0]}")/test-server.env.local"
  if [[ -f "$TEST_ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$TEST_ENV_FILE"
  fi
  ```

- [ ] **Step 2: Заменить main блок на двухфазный**

  Текущий main:
  ```bash
  if [[ -z "${SMOKE_ONLY:-}" ]]; then
    if [[ -z "${FRONT_ONLY:-}" ]]; then deploy_backend;  fi
    if [[ -z "${BACK_ONLY:-}"  ]]; then deploy_frontend; fi
  else
    echo "(SMOKE_ONLY=1 — skipping deploy)"
  fi
  
  if [[ -z "${SKIP_SMOKE:-}" ]]; then
    run_smoke || exit 2
  else
    echo "(SKIP_SMOKE=1 — done without smoke)"
  fi
  ```

  Заменить на:
  ```bash
  run_phase() {
    local phase="$1"  # "test" или "prod"
    case "$phase" in
      test)
        ENV_NAME=test
        HOST="${TEST_HOST:?TEST_HOST не задан — заполни scripts/test-server.env.local}"
        PATH_EXPORT='$HOME/.nvm/versions/node/v22*/bin'
        BACK_PATH="$TEST_BACK_PATH"
        FRONT_SRC="$TEST_FRONT_SRC"
        FRONT_SERVED="$TEST_FRONT_SERVED"
        BASE_URL="$TEST_BASE_URL"
        BASIC_AUTH="$TEST_BASIC_AUTH"
        ;;
      prod)
        ENV_NAME=prod
        HOST="$PROD_HOST"
        PATH_EXPORT='$HOME/.npm-global/bin'
        BACK_PATH="${PROD_BACK_PATH:-/home/dvolkov/spirits_back}"
        FRONT_SRC="${PROD_FRONT_SRC:-/home/dvolkov/spirits_front_src}"
        FRONT_SERVED="${PROD_FRONT_SERVED:-/home/dvolkov/spirits_front}"
        BASE_URL="${PROD_BASE_URL:-https://my.linkeon.io}"
        BASIC_AUTH=
        ;;
    esac
    export ENV_NAME HOST PATH_EXPORT BACK_PATH FRONT_SRC FRONT_SERVED BASE_URL BASIC_AUTH BRANCH
    
    if [[ -z "${SMOKE_ONLY:-}" ]]; then
      if [[ -z "${FRONT_ONLY:-}" ]]; then deploy_backend;  fi
      if [[ -z "${BACK_ONLY:-}"  ]]; then deploy_frontend; fi
    fi
    
    # Smoke
    local skip_var="SKIP_${phase^^}_SMOKE"  # SKIP_TEST_SMOKE / SKIP_PROD_SMOKE
    if [[ -z "${SKIP_SMOKE:-}" && -z "${!skip_var:-}" ]]; then
      bold "=== SMOKE ($ENV_NAME) ==="
      cd "$LOCAL_BACK_DIR/tests"
      if BASE_URL="$BASE_URL" BASIC_AUTH="$BASIC_AUTH" bash smoke/run.sh; then
        green "  ✓ SMOKE GREEN ($ENV_NAME)"
      else
        red "  ✗ SMOKE FAILED ($ENV_NAME)"
        return 1
      fi
    fi
  }
  
  # ── main ──
  if [[ -z "${PROD_ONLY:-}" ]]; then
    bold "════════════ PHASE 1: TEST ════════════"
    run_phase test || { red "TEST phase failed — НЕ КАЧУ НА ПРОД"; exit 1; }
  fi
  
  if [[ -z "${TEST_ONLY:-}" ]]; then
    bold "════════════ PHASE 2: PROD ════════════"
    run_phase prod || exit 2
  fi
  
  green "════════════════════════════════════════════════════════════════════"
  green "  ✓ ALL PHASES GREEN"
  green "════════════════════════════════════════════════════════════════════"
  ```

- [ ] **Step 3: Удалить ненужную функцию `run_smoke`**

  Старая `run_smoke()` теперь встроена в `run_phase`. Удалить её и старое определение `ssh_prod` (заменено на `ssh_remote`).

- [ ] **Step 4: Прогнать TEST_ONLY**

  ```bash
  cd ~/Downloads/spirits_back
  TEST_ONLY=1 bash scripts/deploy.sh
  ```
  Expected: PHASE 1 — деплой на test + smoke — зелёный. PHASE 2 пропущена.

- [ ] **Step 5: Прогнать обычный (две фазы)**

  ```bash
  bash scripts/deploy.sh
  ```
  Expected: PHASE 1 → smoke (test) → PHASE 2 → smoke (prod) → `ALL PHASES GREEN`.

  Если test-smoke падает → прод не должен быть тронут. Verify: `ssh dvolkov@212.113.106.202 'pm2 ls'` — last restart timestamp не изменился.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/deploy.sh
  git commit -m "feat(deploy): двухфазный пайплайн test → smoke → prod → smoke"
  ```

---

### Task 16: Обновить заголовок и флаги в `deploy.sh`

**Files:**
- Modify: `~/Downloads/spirits_back/scripts/deploy.sh`

- [ ] **Step 1: Переписать комментарий-шапку**

  Заменить старый блок комментариев (lines 1–34) на:

  ```bash
  #!/usr/bin/env bash
  # Двухфазный деплой my.linkeon.io.
  #
  # PHASE 1 (test):  push origin → ssh test → git pull → build → pm2 restart → smoke
  # PHASE 2 (prod):  то же на проде. Запускается ТОЛЬКО если PHASE 1 зелёная.
  #
  # Креды test-сервера лежат в scripts/test-server.env.local (gitignored,
  # генерится provision-test.sh).
  #
  # Env флаги:
  #   TEST_ONLY=1        — только PHASE 1
  #   PROD_ONLY=1        — только PHASE 2 (hotfix в обход test, использовать осторожно)
  #   FRONT_ONLY=1       — пропустить backend в обеих фазах
  #   BACK_ONLY=1        — пропустить frontend в обеих фазах
  #   SKIP_SMOKE=1       — пропустить обе smoke-проверки
  #   SKIP_TEST_SMOKE=1  — задеплоить на test без smoke (а потом обычно на прод)
  #   SKIP_PROD_SMOKE=1  — на проде задеплоить без smoke
  #   SMOKE_ONLY=1       — пропустить деплой, гонять только smoke текущей фазы
  #
  # Прод-настройки (можно переопределить):
  #   PROD_HOST          dvolkov@212.113.106.202
  #   PROD_BACK_PATH     /home/dvolkov/spirits_back
  #   PROD_FRONT_SRC     /home/dvolkov/spirits_front_src
  #   PROD_FRONT_SERVED  /home/dvolkov/spirits_front
  #   PROD_BASE_URL      https://my.linkeon.io
  #   BRANCH             b2b
  ```

- [ ] **Step 2: Проверить, что прод-only режим работает**

  ```bash
  PROD_ONLY=1 SKIP_SMOKE=1 bash scripts/deploy.sh
  ```
  Expected: PHASE 1 пропущена; прод обновлён; smoke пропущен.

  *Это полезно как hotfix-режим: если test упал по infra-причине, а на проде нужно срочно катить.*

- [ ] **Step 3: Commit**

  ```bash
  git add scripts/deploy.sh
  git commit -m "docs(deploy): обновить шапку с описанием новых флагов"
  ```

---

### Task 17: Документация — CLAUDE.md в обоих репо

**Files:**
- Modify: `~/Downloads/spirits_back/CLAUDE.md`
- Modify: `~/Downloads/spirits_front/CLAUDE.md`

- [ ] **Step 1: Обновить `spirits_back/CLAUDE.md`**

  Найти раздел про деплой (`## Деплой` или подобный). Добавить/заменить:

  ```markdown
  ## Деплой

  **Команда:** `bash scripts/deploy.sh`

  Двухфазный пайплайн:
  1. **PHASE 1 — test.linkeon.io.** `git pull` на `dv@85.192.61.231` → build → `pm2 restart` → smoke.
  2. **PHASE 2 — my.linkeon.io.** То же на проде. Запускается только если PHASE 1 зелёная.

  Если smoke на test красный — `deploy.sh` выходит с кодом 1 ДО касания прода.

  Полезные флаги: `TEST_ONLY=1`, `PROD_ONLY=1` (hotfix), `FRONT_ONLY=1`, `BACK_ONLY=1`, `SKIP_SMOKE=1`, `SKIP_TEST_SMOKE=1`, `SMOKE_ONLY=1`. Полный список — в шапке `scripts/deploy.sh`.

  ### Тестовый сервер

  `test.linkeon.io` (`dv@85.192.61.231`, Ubuntu 24.04). Полный зеркальный стек прода: PostgreSQL/Redis/Neo4j/MinIO. SMS Aero и YooKassa отключены. Защищён Basic Auth на уровне Nginx.

  Bootstrap: `bash scripts/provision-test.sh` (один раз). Креды лежат в `scripts/test-server.env.local` (gitignored).
  ```

- [ ] **Step 2: Обновить `spirits_front/CLAUDE.md`**

  В разделе про деплой добавить параллельную секцию (поскольку deploy.sh живёт в spirits_back):

  ```markdown
  ## Деплой

  Используется единый `scripts/deploy.sh` из репо **spirits_back**:

  ```bash
  bash ~/Downloads/spirits_back/scripts/deploy.sh
  ```

  Двухфазный: сначала `test.linkeon.io`, потом — если smoke зелёный — `my.linkeon.io`. Если на test упало, прод не трогается. Подробнее — `~/Downloads/spirits_back/CLAUDE.md`.
  ```

  Старый блок про ручной деплой через rsync убрать (он теперь обходит test и потому небезопасен).

- [ ] **Step 3: Commit (back)**

  ```bash
  cd ~/Downloads/spirits_back
  git add CLAUDE.md
  git commit -m "docs: описание двухфазного деплоя и test-сервера"
  ```

- [ ] **Step 4: Commit (front)**

  ```bash
  cd ~/Downloads/spirits_front
  git add CLAUDE.md
  git commit -m "docs: единая команда деплоя через spirits_back/deploy.sh"
  ```

---

### Task 18: End-to-end проверка

**Files:** —

- [ ] **Step 1: Внести тривиальное изменение в frontend**

  Например, добавить пробел в комментарий в `src/App.tsx` или в string в `i18n/locales/ru.json`. Закоммитить локально (но не пушить — это сделает deploy.sh).

- [ ] **Step 2: Запустить полный deploy**

  ```bash
  cd ~/Downloads/spirits_back
  bash scripts/deploy.sh
  ```

  Что ожидать в логе:
  - `════ PHASE 1: TEST ════`
  - `pushing local commits to origin` (back + front)
  - `pulling on test + building + restarting`
  - `health-wait test.linkeon.io ... ✓ 200`
  - `=== SMOKE (test) ===` → unit → api → playwright → `✓ SMOKE GREEN (test)`
  - `════ PHASE 2: PROD ════`
  - то же для прода
  - `✓ ALL PHASES GREEN`

  Время полного прогона: ~5–8 минут (зависит от Playwright).

- [ ] **Step 3: Проверить негативный сценарий — намеренно сломать smoke**

  Временно изменить какой-нибудь smoke-тест чтобы он гарантированно падал (поменять ожидаемое значение). Запустить `bash scripts/deploy.sh`.

  Expected: PHASE 1 smoke падает → `red TEST phase failed — НЕ КАЧУ НА ПРОД` → exit 1. Прод **не должен** быть тронут (verify через `ssh dvolkov@212.113.106.202 'pm2 describe linkeon-api | grep restart'` — last restart timestamp не изменился относительно момента до этого запуска).

  После проверки — вернуть smoke-тест в рабочее состояние.

- [ ] **Step 4: Документация — не нужно ничего коммитить, тест-изменение откатить**

  Откатить тривиальные изменения если они служили только для проверки.

---

### Task 19: Сохранить новые ключевые факты в memory

**Files:** —

После всех изменений у тебя в голове сидит куча информации, которая будет полезна в будущих сессиях. Сохрани её:

- [ ] **Step 1: Записать в auto-memory новый деплой-флоу**

  В `/Users/dmitry/.claude/projects/-Users-dmitry-Downloads-spirits-front/memory/`:

  - Обновить `linkeon_test_server.md` — добавить факты про Basic Auth, MinIO, какие сервисы стоят.
  - Создать `feedback_two_phase_deploy.md`: всегда деплоить через `deploy.sh` без флагов; флаги типа `PROD_ONLY=1` использовать только как hotfix-инструмент при подтверждённой проблеме инфры теста.

- [ ] **Step 2: Обновить MEMORY.md индекс**

  Добавить одну строку в `MEMORY.md`.

---

## Self-Review

**Spec coverage:** все секции спеки покрыты задачами:
- Топология (Tasks 2–6) ✓
- Конфиг/env (Tasks 7, 9) ✓
- Basic Auth + Nginx (Task 10) ✓
- Тесты с BASIC_AUTH (Tasks 12, 13) ✓
- Двухфазный deploy.sh (Tasks 14–16) ✓
- Документация (Task 17) ✓
- E2E проверка (Task 18) ✓

**Placeholder scan:** ни одного «TBD»/«similar to»/«add appropriate handling» — все шаги конкретны.

**Type consistency:** имена переменных bash консистентны между Task 14 и Task 15 (`ENV_NAME`, `HOST`, `BACK_PATH`, `FRONT_SRC`, `FRONT_SERVED`, `BASE_URL`, `BASIC_AUTH`, `BRANCH`, `PATH_EXPORT`). Функции `ssh_remote`, `deploy_backend`, `deploy_frontend`, `run_phase` определены строго в одном месте.

**Известный риск:** PATH_EXPORT для test использует glob `~/.nvm/versions/node/v22*/bin`. Если nvm установит подверсию 22.13 или новее, glob продолжит работать; но если у `dv` будет несколько версий, может выбрать не ту. Если это станет проблемой — заменить glob на явный путь, сохранённый при provision'е в `test-server.env.local`.
