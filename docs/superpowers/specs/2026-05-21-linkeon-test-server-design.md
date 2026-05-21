# Тестовый стенд Linkeon и двухфазный деплой

Дата: 2026-05-21
Статус: утверждён, готов к плану реализации

## Цель

Получить изолированную тестовую среду `test.linkeon.io` для my.linkeon.io, через которую обязательно проходит каждый деплой перед прод-сервером `212.113.106.202`. Прод не катим, пока на тесте не зелёный smoke.

## Контекст

- Прод-сервер `dvolkov@212.113.106.202` обслуживает и API (PM2 `linkeon-api`, порт 3001), и статику фронта через Nginx.
- Текущий пайплайн `~/Downloads/spirits_back/scripts/deploy.sh` сразу катит на прод и потом гоняет smoke. Если smoke падает — поздно.
- Тестовый сервер `dv@85.192.61.231` (Ubuntu 24.04) уже выдан, юзер `dv` имеет NOPASSWD sudo и SSH-ключевой доступ. Больше на нём ничего не установлено.
- В коде уже есть нужные ручки: `auth.service.ts:62` падает в `logger.warn` если SMS Aero env пустые; `DEBUG_SMS_CODES=true` открывает `/webhook/debug/sms-code/:phone`, которым уже пользуются smoke-тесты.

## Решения

| Вопрос | Решение |
|---|---|
| Домен / TLS | `test.linkeon.io` + Let's Encrypt (DNS A-запись на `85.192.61.231`) |
| Деплой-флоу | Один `deploy.sh`: TEST → smoke → PROD → smoke. Если test-smoke красный, прод не трогаем |
| Защита доступа | Basic Auth на Nginx уровне на всё, кроме `/.well-known/acme-challenge/` |
| Стек | Полностью изолированный: свои PostgreSQL/Redis/Neo4j/MinIO |
| SMS | Отключаем через пустые `SMSAERO_LOGIN`/`SMSAERO_API_KEY`; `DEBUG_SMS_CODES=true` для тестов |
| Платежи | YooKassa отключена (env пустой); платёжные пути на тесте не проверяем |

## Архитектура

### Топология тестового сервера

`test.linkeon.io` → `85.192.61.231`, всё под юзером `dv` (зеркало прода с `dvolkov`).

Стек ставится нативно (apt + бинарники), без Docker, чтобы повторить прод 1:1:

| Компонент | Версия | Назначение |
|---|---|---|
| Nginx | apt | reverse-proxy + TLS + Basic Auth |
| Certbot | snap/apt | Let's Encrypt cert на `test.linkeon.io` |
| PostgreSQL 16 | apt (postgresql.org repo) | основная БД |
| Redis 7 | apt | кеш + SMS-коды |
| Neo4j 5 community | apt (neo4j.com repo) | graph совместимости/рефералки |
| MinIO | официальный бинарник + systemd | object storage для SMM |
| Node 22 + pnpm | nvm | runtime backend, build frontend |
| PM2 | npm -g | `linkeon-api` + `linkeon-smm-worker` |

### Раскладка путей

```
/home/dv/spirits_back/         git репо backend (origin = spirits_back, branch b2b)
/home/dv/spirits_front_src/    git репо frontend (origin = spirits, branch b2b)
/home/dv/spirits_front/        dist фронта, отдаётся Nginx
/home/dv/minio-data/           MinIO storage
/etc/nginx/sites-enabled/test.linkeon.io
/etc/nginx/.htpasswd-test
```

### Сеть

- 443/TCP — публично (TLS+Basic Auth)
- 80/TCP — публично, редирект на 443 (кроме `/.well-known/acme-challenge/` для certbot renew)
- 22/TCP — публично (SSH)
- 3001 (API), 9000/9001 (MinIO), 5432 (PG), 6379 (Redis), 7687/7474 (Neo4j) — только `127.0.0.1`

### Nginx-конфиг

```nginx
server {
    listen 443 ssl http2;
    server_name test.linkeon.io;
    ssl_certificate     /etc/letsencrypt/live/test.linkeon.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/test.linkeon.io/privkey.pem;

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        auth_basic off;
    }

    auth_basic           "linkeon test";
    auth_basic_user_file /etc/nginx/.htpasswd-test;

    root /home/dv/spirits_front;
    index index.html;
    location / { try_files $uri /index.html; }

    location /webhook/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 600s;
    }

    location /minio/ {
        proxy_pass http://127.0.0.1:9000/;
        proxy_set_header Host $host;
    }
}
```

`.htpasswd-test` создаётся через `htpasswd -c -B /etc/nginx/.htpasswd-test linkeon` с сильным паролем (хранится в `scripts/test-server.env.local`).

### `.env` файлы

**Backend (`/home/dv/spirits_back/.env`):**

```env
NODE_ENV=production
DEBUG_SMS_CODES=true

SMSAERO_LOGIN=
SMSAERO_API_KEY=
YOOKASSA_SHOP_ID=
YOOKASSA_SECRET_KEY=

JWT_ACCESS_SECRET=<generated, не повторяет прод>
JWT_REFRESH_SECRET=<generated>

POSTGRES_HOST=127.0.0.1
POSTGRES_DB=linkeon
POSTGRES_USER=linkeon
POSTGRES_PASSWORD=<generated>

REDIS_HOST=127.0.0.1

NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<generated>

MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_ACCESS_KEY=<generated>
MINIO_SECRET_KEY=<generated>
MINIO_PUBLIC_URL=https://test.linkeon.io/minio
MINIO_BUCKET_MUSIC=linkeon-smm-music
```

**Frontend (`/home/dv/spirits_front_src/.env`):**

```env
VITE_BACKEND_URL=https://test.linkeon.io
```

Basic Auth ходит только через Nginx, в Node не уходит. Браузер сам подмешивает `Authorization: Basic` после первого ввода.

## Тесты

Smoke-уровни уже параметризованы через `BASE_URL`, добавляем второй параметр.

**`tests/playwright/playwright.config.js`** — добавить `httpCredentials`:

```js
use: {
  baseURL: process.env.BASE_URL || 'https://my.linkeon.io',
  httpCredentials: process.env.BASIC_AUTH
    ? {
        username: process.env.BASIC_AUTH.split(':')[0],
        password: process.env.BASIC_AUTH.split(':').slice(1).join(':'),
      }
    : undefined,
  // ...
}
```

**`tests/smoke/smoke.js`** — глобальный axios-интерсептор: если `process.env.BASIC_AUTH` задан, выставить `axios.defaults.auth = { username, password }`. На проде переменная пустая → ничего не меняется.

**Тестовые телефоны** (`70000000000`, `79030169187`) создаются на test автоматически при первом успешном `check-code` (welcome-bonus 25k токенов — как на проде). Никакого seed-скрипта.

## Деплой-пайплайн

Перерабатываем `~/Downloads/spirits_back/scripts/deploy.sh` в две фазы. Существующие `deploy_backend()`/`deploy_frontend()` параметризуем переменными `HOST`, `BACK_PATH`, `FRONT_SRC`, `FRONT_SERVED`, `BASE_URL`, `BRANCH` — те же функции вызываем сначала с test-набором, потом с prod-набором.

```
PHASE 1: TEST
  1.1  push local commits to origin (back + front)
  1.2  ssh test → git pull → npm ci → build → pm2 restart (back, worker, front rsync)
  1.3  health-wait: GET https://test.linkeon.io/webhook/agents с Basic Auth, до 30s
  1.4  smoke: BASE_URL=https://test.linkeon.io BASIC_AUTH=$TEST_BASIC_AUTH bash tests/smoke/run.sh
       ┳ fail → exit 1 ДО касания прода

PHASE 2: PROD
  2.1  ssh prod → git pull → ... → pm2 restart (как сейчас)
  2.2  health-wait на https://my.linkeon.io, до 30s
  2.3  smoke: BASE_URL=https://my.linkeon.io (без BASIC_AUTH)
```

### Флаги

| Флаг | Поведение |
|---|---|
| (без флагов) | TEST → smoke → PROD → smoke |
| `TEST_ONLY=1` | только PHASE 1 |
| `PROD_ONLY=1` | только PHASE 2 (для hotfix'ов в обход test) |
| `SKIP_SMOKE=1` | пропустить обе smoke-проверки |
| `SKIP_TEST_SMOKE=1` | деплой на test без smoke, потом обычный прод-деплой и его smoke |
| `FRONT_ONLY=1` / `BACK_ONLY=1` | как сейчас, действуют в обеих фазах |
| `SMOKE_ONLY=1` | пропустить деплой, прогнать только прод-smoke (как сейчас) |

### Креды для деплоя

Файл `~/Downloads/spirits_back/scripts/test-server.env.local` (gitignored), source'ится в начале `deploy.sh`:

```sh
TEST_HOST=dv@85.192.61.231
TEST_BACK_PATH=/home/dv/spirits_back
TEST_FRONT_SRC=/home/dv/spirits_front_src
TEST_FRONT_SERVED=/home/dv/spirits_front
TEST_BASE_URL=https://test.linkeon.io
TEST_BASIC_AUTH=linkeon:<password>
```

## Bootstrap (один раз)

Отдельный скрипт `~/Downloads/spirits_back/scripts/provision-test.sh` — идемпотентный, запускается один раз руками. Делает:

1. DNS-запись `test.linkeon.io A 85.192.61.231` — **ставится вне скрипта** в DNS-панели, скрипт только проверяет резолв
2. apt-пакеты: postgresql-16, redis, nginx, certbot, htpasswd
3. neo4j-community из официального apt-repo
4. MinIO бинарник + systemd unit + базовый bucket
5. Node 22 через nvm для юзера `dv`, pnpm + pm2 глобально
6. Создание Postgres-юзера/БД, Redis ACL, Neo4j-пароля, MinIO root-key
7. Клонирование репозиториев через deploy keys (тот же id_rsa.pub что и на проде, или новый — отдельный вопрос на этапе плана)
8. `.env` файлы с сгенерированными секретами; копия в локальный `scripts/test-server.env.local`
9. Certbot выписывает cert на `test.linkeon.io` (после того как DNS зарезолвился)
10. Nginx vhost + `.htpasswd-test`
11. Первый build + `pm2 start` + `pm2 save` + `pm2 startup`

После этого `deploy.sh` без флагов работает end-to-end.

## Файлы изменений

| Файл | Действие |
|---|---|
| `~/Downloads/spirits_back/scripts/deploy.sh` | refactor: параметризовать функции, добавить PHASE 1 |
| `~/Downloads/spirits_back/scripts/provision-test.sh` | новый, для one-time bootstrap |
| `~/Downloads/spirits_back/scripts/test-server.env.local` | новый, gitignored, креды test |
| `~/Downloads/spirits_back/tests/playwright/playwright.config.js` | поддержка `BASIC_AUTH` через `httpCredentials` |
| `~/Downloads/spirits_back/tests/smoke/smoke.js` | поддержка `BASIC_AUTH` через `axios.defaults.auth` |
| `~/Downloads/spirits_back/.gitignore` | добавить `scripts/test-server.env.local` |
| `~/Downloads/spirits_back/CLAUDE.md` | задокументировать новый пайплайн и test-сервер |
| `~/Downloads/spirits_front/CLAUDE.md` | то же со стороны front |
| Nginx на test-сервере | `/etc/nginx/sites-enabled/test.linkeon.io` |

## Out of scope

- Платёжные сценарии на test (YooKassa отключена)
- Реальная отправка SMS на test
- IP-allowlist (вместо Basic Auth)
- Шеринг storage между test и прод
- Docker / k8s / любая контейнеризация
