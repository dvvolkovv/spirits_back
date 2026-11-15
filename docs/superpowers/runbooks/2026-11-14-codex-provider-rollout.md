# Выкат codex-провайдера (GPT-6 Astra) — runbook

Дата: 2026-11-14
Спек: docs/superpowers/specs/2026-11-14-codex-provider-design.md
План: docs/superpowers/plans/2026-11-14-codex-provider.md

Правила на весь выкат:
- Каждый шаг — только с явным OK владельца.
- Рестарты (linkeon-api, file-agent, codex-bridge) — при нуле активных стримов.
- Ключи и токены не печатать; передача значений — только через stdin.
- ~/.codex/auth.json — только читать; мост и скрипты токены НЕ обновляют.
- Live-проверки тратят квоту ChatGPT Pro — каждую выполнять ровно один раз.

## Шаг 1. Код (test → prod)
1. Убедиться, что T1–T13 влиты в main обоих репо (spirits_back, spirits_front).
2. `bash ~/Downloads/spirits_back/scripts/deploy.sh` (с мака; с ноды — `~/dev/spirits_back/scripts/deploy.sh`) — двухфазный test → smoke → prod → smoke. codex-bridge/ уезжает вместе с бэком (деплой git-based).
3. На test-ноде цепочка останется Claude → Qwen → Kimi: CODEX_FALLBACK_API_KEY там НЕ заводится (сознательно — smoke deploy.sh должен пройти без codex).
4. Релей (вручную):
   - скопировать каталог `codex-bridge/` из spirits_back в `/home/dv/file-agent/codex-bridge/` ЦЕЛИКОМ (bridge.mjs, translate.mjs, sse.mjs, keep-alive.sh и все `*.test.mjs` — они нужны для проверки);
   - обновлённый `relay-agent/llm-fallback.mjs` закоммитить как dv в живой ветке `reconcile/agent-versioned-live-part-b`;
   - на релее: `node --check` каждого .mjs, `node --test` для llm-fallback.test.mjs → 39 pass и `node --test codex-bridge/*.test.mjs` → 45 pass (ловит порчу при копировании);
   - `pm2 restart file-agent` — при нуле стримов, с OK; после — `pm2 status` и журнал без ошибок.

## Шаг 2. Сервер бэкенда (dvolkov@212.113.106.202)
1. Закрепить CLI: `npm i -g @openai/codex@0.154.0`; `codex --version`; флаги освежителя сверить с `codex exec --help`.
2. Логин владельца: на маке `ssh -L 1455:localhost:1455 dvolkov@212.113.106.202`, на сервере `codex login` — владелец одобряет в браузере САМ (пароль/2FA не трогать). Проверка: `test -r ~/.codex/auth.json && echo OK` (содержимое не выводить).
3. Smoke сосуществования: один короткий `codex exec` (gpt-5.6-luna, read-only) на сервере; на маке убедиться, что роутер жив: `curl -s http://127.0.0.1:8788/healthz` → {"ok":true}.
4. Поднять мост: `cd /home/dvolkov/spirits_back && node --test codex-bridge/*.test.mjs` → 45 pass / 0 fail (ловит порчу при выкате и версию Node), затем `cd codex-bridge && pm2 start bridge.mjs --name codex-bridge && pm2 save`. Запускать из оболочки, где НЕ экспортированы `BRIDGE_PORT`/`BRIDGE_LOG_PATH` (имена без префикса — чужая переменная окружения молча переставит мост; pm2 наследует env оболочки при первом start). Под pm2 мост поднимается благодаря диффу 4 (pm_id) — проверить `pm2 logs codex-bridge --lines 20` на строку listen.
5. `curl -s http://127.0.0.1:8790/healthz` → {"ok":true}. Ходить ТОЛЬКО на `127.0.0.1`, не на `localhost`: мост слушает IPv4 и требует Host буквально `127.0.0.1:<port>` (иначе 421), а `localhost` на Node ≥17 резолвится в `::1` первым → ECONNREFUSED.
6. Один живой smoke через мост (РОВНО РАЗ): `curl -sS http://127.0.0.1:8790/v1/messages -H 'content-type: application/json' -d '{"model":"gpt-6-astra","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"ответь ok"}]}'` → SSE с stop_reason end_turn.
7. Ключ-заглушка в .env бэка (через stdin, не печатая): добавить строку `CODEX_FALLBACK_API_KEY=local-bridge`.
8. Перезапуск API: `BACK_ONLY=1 bash ~/Downloads/spirits_back/scripts/deploy.sh` (с мака) — при нуле стримов, с OK.
9. Cron-освежитель: `crontab -e` → `0 4 */3 * * /home/dvolkov/spirits_back/codex-bridge/keep-alive.sh >> /home/dvolkov/.linkeon/logs/codex-keepalive.log 2>&1`; проверить, что `crontab -l` содержит строку. Разово проверить вручную: `bash -x /home/dvolkov/spirits_back/codex-bridge/keep-alive.sh 2>&1 | tail -8` — должен вызваться `codex exec`, а не «command not found» (скрипт сам дополняет PATH: npm-global/nvm/.local; при отсутствии codex — exit 127). Редирект делает видимыми exit 127/«command not found»: он ловит вывод до внутреннего /dev/null скрипта — keep-alive.sh глушит только stdout/stderr самих `codex exec`, а ошибки PATH-бутстрапа и shell-ошибки попадают в лог. Журнал крошечный (успешный прогон не пишет ничего), ротация не нужна. Ручной прогон тратит пренебрежимо малую квоту (один «ответь ok» на gpt-5.6-luna). Ротация журнала моста (`~/.linkeon/logs/codex-bridge.log`, ~150 Б на строку, строка на запрос): ротация у моста отсутствует — либо logrotate строго в режиме `copytruncate` (обычный create/move тихо унесёт fd, и журнал продолжит писаться в ротированный файл до рестарта), либо сознательно принять неограниченный рост с периодической проверкой места (на серверах был инцидент DiskFull 27.10).
10. Живая проверка цепочки (РОВНО РАЗ, с OK): `cd /home/dvolkov/spirits_back && npm run build && CODEX_FALLBACK_API_KEY=local-bridge node scripts/codex-fallback-check.js` → все строки OK (картинка — INFO допустим), exit 0.
11. Мониторинг: в ближайшем health-алерте строка «Codex — ответов N, ошибок M» (до первого хода — «не настроен» сменится после включения ключа).

## Шаг 3. Релей (dv@5.101.115.184) — то же, с поправками
- Закрепить CLI: `npm i -g @openai/codex@0.154.0` (как в шаге 2.1); `codex --version`.
- Туннель и логин: `ssh -L 1455:localhost:1455 dv@5.101.115.184` → `codex login` (одобряет владелец).
- Мост: `cd /home/dv/file-agent/codex-bridge && pm2 start bridge.mjs --name codex-bridge && pm2 save`; healthz. Те же оговорки, что на Шаге 2: чистый env оболочки (нет BRIDGE_PORT/BRIDGE_LOG_PATH), только `127.0.0.1` (не localhost), ротация журнала — только `copytruncate`. Под pm2 мост поднимается благодаря диффу 4 (pm_id).
- Ключ: записать `local-bridge` в `/home/dv/file-agent/secrets/codex.key` через stdin, `chmod 600`. Рестарт file-agent НЕ нужен (readProviderConfig читает файл на каждый запрос).
- Cron: `0 4 */3 * * /home/dv/file-agent/codex-bridge/keep-alive.sh >> /home/dv/.linkeon/logs/codex-keepalive.log 2>&1` (от dv); разово проверить вручную `bash -x` как в шаге 2.9 (PATH cron так же голый).
- Контроль: короткий ход через канал, который обслуживает релей, с личным выбором Codex (шаг 4) — в журнале file-agent провайдер codex.

## Шаг 4. Приёмка владельцем (E2E)
1. Админка → карточка пользователя → «Модель ответов» → Codex (GPT-6 Astra).
2. Короткий вопрос ассистенту → ответ пришёл; в журнале бэка вызов claude_cli_call с provider:'codex'.
3. Вернуть выбор на «Как у всех».
4. Глобальный рубильник: проверить метку «только аварийно» у Codex и предупреждение в confirm. НА Codex рубильник не ставить (правило).

## Откат
- Релей: `mv /home/dv/file-agent/secrets/codex.key /home/dv/file-agent/secrets/codex.key.disabled` — провайдер выключается без рестарта.
- Бэк: убрать `CODEX_FALLBACK_API_KEY` из .env + рестарт API через `BACK_ONLY=1 deploy.sh`.
- Сохранённые личные выборы 'codex' деградируют до Claude автоматически (usable() = false без конфига).
- Полное удаление: `pm2 delete codex-bridge && pm2 save` на обоих серверах; убрать строки cron; владелец может отозвать сессии в аккаунте ChatGPT. Записи в реестрах (FALLBACK_ORDER и др.) можно не удалять — без ключа провайдер не включится.
