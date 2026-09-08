# linkeon-product-runner

Агент Linkeon на VM клиентского продукта. Забирает задания long-poll'ом,
гоняет `claude -p` в чекауте продукта, коммитит, деплоит и откатывает при
красном health-check.

Соединение всегда инициирует эта машина. Linkeon не хранит SSH-ключей от
клиентских VM и не ходит сюда сам.

## Установка на VM продукта

```bash
sudo mkdir -p /opt/linkeon-product-runner
sudo rsync -az --exclude node_modules --exclude .git \
  ./ root@<vm>:/opt/linkeon-product-runner/
ssh root@<vm> 'cd /opt/linkeon-product-runner && npm ci && npm run build'
```

`rsync` без `--delete` — сознательно: с `--delete` он уже сносил `.env`
воркера на этом проекте.

## Конфиг

`/etc/linkeon-product-runner.env`:

```
LINKEON_URL=https://my.linkeon.io
RUNNER_TOKEN=<из scripts/products-register.sh, показывается один раз>
CHECKOUT_PATH=/home/dv/selyanska
CLAUDE_BIN=/usr/bin/claude
```

`CLAUDE_BIN` задаётся явно: бэкенд Linkeon зовёт `/usr/bin/claude`, а не тот
`claude`, что первым найдётся в `PATH` интерактивного шелла — на серверах это
разные бинари.

## Запуск

```bash
# Подставить фактический путь к node: /usr/bin/node есть не на всякой машине.
# На тестовой ноде node стоит под nvm, и юнит с захардкоженным путём падает
# с status=203/EXEC — проверено установкой.
sed -e "s|__NODE__|$(command -v node)|" \
    -e "s|__NODE_BIN__|$(dirname "$(command -v node)")|" linkeon-product-runner.service \
  | sudo tee /etc/systemd/system/linkeon-product-runner.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now linkeon-product-runner
journalctl -u linkeon-product-runner -f
```

Раннер намеренно живёт под systemd, а сам продукт — под PM2. В образце
`selyanska` агент жил дочерним процессом бота, из-за чего `pm2 restart`
убивал его посреди ответа. Разные супервизоры разрывают эту связь:
`pm2 restart` продукта раннера не касается.

## Проверка

```bash
# heartbeat дошёл до Linkeon
psql "$DATABASE_URL" -c 'SELECT slug, runner_seen_at FROM products'
```

`runner_seen_at` обновляется на каждом опросе, даже когда заданий нет.
Молчание дольше порога означает, что раннер мёртв, а не что ходов не было.

## Подпроект в корне репозитория — обязательный шаг

`product-runner/` лежит в корне `spirits_back` рядом с `worker/`, `voice-host/`
и `relay-agent/`. У всех них свои `package.json` и `tsconfig.json`, и каждый
обязан быть исключён из `tsconfig.build.json` бэкенда:

```json
"exclude": ["node_modules", "test", "dist", "scripts", "tests",
            "worker", "voice-host", "product-runner", "**/*spec.ts"]
```

Без этого файлы подпроекта попадают в сборку бэкенда, общий корень исходников
поднимается на уровень выше, и весь вывод уезжает в `dist/src/`. pm2 запускает
`dist/main.js`, не находит его и уходит в цикл перезапусков: стенд отвечает
502, а двухфазный деплой останавливается на PHASE 1.

Эта поломка случалась трижды — с `worker`, `voice-host` и `product-runner`.
Проверка `tsc --noEmit -p tsconfig.json` её не показывает: это другой конфиг,
и он ничего не выводит. Единственная проверка, которая ловит, —
`npm run build` с последующим `ls dist/main.js`.
