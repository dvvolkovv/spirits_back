# Attendee — мост в встречи Google Meet

Attendee держит в встрече Chrome-бота и обменивается с нами звуком по
вебсокету. Через него ассистент попадает в площадки без LiveKit.

Живёт на **отдельном хосте**. Не на проде: каждый бот — полный Chrome со
страницей Meet, а на `212.113.106.202` уже API, Postgres, Redis, Neo4j и
LiveKit; конкуренция за CPU ударит по SFU.

## ⚠️ Читать первым: Celery-режим не годится для продакшена

Дословно из README проекта (проверено 07.09.2026):

> By default, Attendee launches bots as Celery tasks. This mode is convenient
> for local development and testing, **but it is not suitable for production**
> for two reasons.
>
> The correct way to run Attendee in production is with Kubernetes, where each
> bot runs in its own isolated pod. Enable this by setting the environment
> variable: `LAUNCH_BOT_METHOD="kubernetes"`
>
> **Our paid self-hosting plan** includes official directions and support for
> running Attendee with Kubernetes.

Две причины непригодности:

1. **Перетекание звука.** Несколько ботов в одном Celery-контейнере делят
   аудиоустройства, и звук разных встреч может смешаться. В переговорах с
   клиентами это неприемлемо — не «шум», а утечка одной встречи в другую.
2. **Рестарт убивает живых ботов.** Деплой или перезапуск контейнера
   выбрасывает бота из идущей встречи.

Kubernetes мы не держим, а официальные инструкции к нему — в платном плане.
Поэтому решение на v1 (см. ниже) — **жёсткий потолок в одну одновременную
встречу**: при одном боте перетекать нечему.

Потолок держится с нашей стороны, а не надеждой:

- диапазон портов в `voice-host/.env` сужается до одного:
  `ATTENDEE_WS_PORT_MIN=8140`, `ATTENDEE_WS_PORT_MAX=8140`. Второе
  одновременное задание не найдёт свободного порта и честно откажет;
- та же регулярка в `nginx-attendee.conf` сужается до `8140`;
- `deploy.sh` перед выкаткой проверяет активные звонки — встречу Meet видно
  там же, `provider='meet'`.

Когда одной встречи станет мало — либо платный план и Kubernetes, либо по
хосту Attendee на встречу. Это решение владельца, не техническое.

## Установка

Опубликованного образа **нет** — собирается из исходников. Postgres и Redis
Attendee поднимает своим compose, наши трогать не нужно.

```bash
git clone https://github.com/attendee-labs/attendee.git
cd attendee
# Зафиксировать коммит: Attendee ходит по живой вёрстке Meet, и обновление
# «когда-нибудь потом» ломает встречу в неожиданный момент.
git log --oneline -1   # записать sha сюда, в этот файл

docker compose -f dev.docker-compose.yaml build          # ~5 минут

# Сгенерировать .env
docker compose -f dev.docker-compose.yaml run --rm attendee-app-local \
  python init_env.py > .env

# Дописать в .env хранилище записей и продовые настройки (см. ниже)
$EDITOR .env

docker compose -f dev.docker-compose.yaml up -d
docker compose -f dev.docker-compose.yaml exec attendee-app-local \
  python manage.py migrate
```

Дальше через UI на `:8000`: создать аккаунт (письмо подтверждения приходит **в
логи контейнера**, не на почту), войти, в разделе «API Keys» выпустить ключ.

### Что дописать в `.env` Attendee

`init_env.py` генерирует основное. Руками добавляются:

- **Хранилище записей** — в инструкции это AWS S3. Записи нам не нужны, но
  переменные требуются. Подставить наш MinIO (он уже есть на проде и в
  `docker-compose.minio.yml`), а не заводить AWS: лишний платный аккаунт ради
  функции, которой мы не пользуемся.
- Оставить `LAUNCH_BOT_METHOD` пустым (Celery-режим) — осознанно, см. шапку.

### Что дописать в наш `.env`

Бэкенд (`~/spirits_back/.env`):

```env
ATTENDEE_BASE_URL=https://<хост attendee>
ATTENDEE_API_KEY=<из UI>
ATTENDEE_WEBHOOK_SECRET=<из UI, раздел вебхуков>
ATTENDEE_WEBHOOK_URL=https://my.linkeon.io/webhook/meet/attendee
```

Воркер (`~/spirits_back/voice-host/.env`):

```env
ATTENDEE_WS_PORT_MIN=8140
ATTENDEE_WS_PORT_MAX=8140
ATTENDEE_WS_PUBLIC_BASE=wss://my.linkeon.io
```

`ATTENDEE_AUDIO_WS_URL` не нужен: адрес вебсокета собирает воркер сам — порт
свой у каждого задания.

### Nginx на проде

Положить `nginx-attendee.conf` в конфиг сайта `my.linkeon.io`, заменив
`ATTENDEE_HOST_IP` на адрес хоста Attendee. Диапазон в регулярке обязан
совпадать с `ATTENDEE_WS_PORT_MIN/MAX`.

## Проверка

```bash
# API отвечает
curl -s -o /dev/null -w '%{http_code}\n' https://<хост attendee>/

# Ключ рабочий
curl -s https://<хост attendee>/api/v1/bots \
  -H "Authorization: Token $ATTENDEE_API_KEY" | head -c 200

# Наш вебсокет достижим снаружи через nginx (ожидается 400/426, не 502:
# это значит, что nginx дошёл до порта, а там нет апгрейда)
curl -s -o /dev/null -w '%{http_code}\n' https://my.linkeon.io/attendee/8140
```

## Обновление

Attendee ходит по живой вёрстке Google Meet, поэтому обновляться придётся —
но осознанно, а не по `latest`:

1. Проверить активные встречи: `SELECT count(*) FROM voice_calls WHERE
   provider='meet' AND status IN ('dialing','active')`.
2. `git fetch && git checkout <новый sha>`, пересобрать, накатить миграции.
3. Провести живую встречу до того, как объявить обновление успешным: сборка и
   миграции не проверяют, что бот всё ещё умеет входить в Meet.
4. Записать новый sha в этот файл.

## Смежное

- Спека: `docs/superpowers/specs/2026-09-06-meeting-bridge-meet-design.md`
- План: `docs/superpowers/plans/2026-09-07-meeting-bridge-meet.md`
- Наша сторона моста: `voice-host/src/attendee-audio.ts`,
  `src/meeting/attendee.client.ts`, `src/meeting/meet-webhook.controller.ts`
