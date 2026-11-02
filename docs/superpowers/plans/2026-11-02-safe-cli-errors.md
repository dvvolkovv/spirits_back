# Ошибки Claude CLI без сырого текста — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Шаги — чекбоксы.

**Goal:** ошибка `ClaudeCliService` несёт безопасный текст и признаки (`kind`, `access`, `status`, `refusal`); классификация — по сырому тексту внутри сервиса; журналы, база и алерты — без фрагментов разговоров.

**Spec:** `docs/superpowers/specs/2026-11-02-safe-cli-errors-design.md` — читать первым.

**Tech Stack:** NestJS 10 + jest/ts-jest, Node 22.

---

## Где что делается (обязательно)

- Воркдерево `~/Downloads/spirits_back/.worktrees/safe-cli-errors`, ветка `feat/safe-cli-errors` от `origin/main` `0b5cf878`. Общий чекаут не трогать.
- **Тесты, tsc, сборки — только на ноде** `dv@85.192.61.231`, воркдерево `~/ci/wt/sce-back` (Task 0). В каждой ssh-команде — `source ~/.nvm/nvm.sh`; `ssh -n`, если команда не читает stdin.
- **На ноде не трогать** `~/spirits_back`, `~/spirits_front`, `~/dev`, сами `~/ci/spirits_back` (только `git -C … fetch` и `worktree add/remove`).
- Коммиты при TDD: падающий тест — отдельным коммитом с пушем (`test(<область>): … — красный`), реализация — следующим. **Никаких `--amend`, `push --force`, rebase.** Коммитить с явным pathspec.
- Комментарии — по-русски. Репозиторий публичный: ни телефонов, ни ключей; маркеры в тестах — вида `СЕКРЕТ-ИЗ-ОТВЕТА`, пользователи — `u-1`.
- В бэке `strictNullChecks: false`: сужение союза — только `x.ok === false`, не `!x.ok`. jest типы не проверяет — гейт `npx tsc -p tsconfig.build.json --noEmit`.

Шаблон прогона («прогон бэка: <файлы>»):

```bash
cd ~/Downloads/spirits_back/.worktrees/safe-cli-errors && git push -q && SHA=$(git rev-parse HEAD)
ssh -n dv@85.192.61.231 "cd ~/ci/wt/sce-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest <файлы> 2>&1 | tail -25"
```

«tsc бэка» — та же схема, команда `npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK`.

---

## Карта файлов

| Файл | Что |
|---|---|
| `src/common/llm-error.ts` (+ `llm-error.spec.ts`) | чистые функции: `cliDiagnostic(errors)`, `aggregateKind(kinds)`, `safeCliText(...)`, `safeKindPhrase(kind)` |
| `src/common/services/claude-cli.service.ts` | `ClaudeCliCallError` с признаками; места `fail(...)`; отказ текстом; `runRaw` по признакам; склейка; журналы |
| `src/common/services/claude-cli.safe-errors.spec.ts` (новый) | маркер не выходит наружу; признаки по видам сбоев; цепочка при сырых текстах |
| `src/common/services/claude-cli.{fallback,chain,global-switch}.spec.ts` | ожидания сырого текста → признаки и безопасный текст |
| `src/insights/insights.service.ts` (+ spec) | `isLimit` по `e.kind` |
| `src/monitoring/claude-health.service.ts` (+ `claude-health.probe.spec.ts`) | вид из `e.kind`, причина — фраза |
| `scripts/llm-fallback-check.js` | разбор склейки под новый формат |

---

### Task 0: воркдерево на ноде и база

- [ ] `ssh -n dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/sce-back origin/feat/safe-cli-errors && cd ~/ci/wt/sce-back && source ~/.nvm/nvm.sh && npm ci >/dev/null 2>&1 && (cd tests && npm ci >/dev/null 2>&1); echo READY'`
- [ ] База: `npx jest src/common src/insights src/monitoring src/tg-bot src/chat src/guest-trial` и tsc — записать числа в отчёт (раздел «База» в конце плана).

### Task 1: чистые функции в `llm-error.ts`

Тесты первыми (`llm-error.spec.ts`, новый `describe`):

- `cliDiagnostic(errors)` — первая строка-элемент, начинающаяся с `[ede_diagnostic]`, если она целиком проходит `^\[ede_diagnostic\](?: [a-z_]+=[A-Za-z0-9_.:-]*)*$`, обрезанная до 160; иначе `''`. Не-строки в массиве пропускаются. Негативные: путь `a=/home/u/doc.pdf`, `a=x@y.ru`, `a=b=c`, кириллица, `any text=x`, `A=1`, пробел в конце, перевод строки; не массив → `''`. Сторож на время: строка 1e5 — меньше 50 мс процессорного времени (`process.cpuUsage`).
- `aggregateKind(kinds)` — приоритет `weekly_limit` → `rate_limit` → `auth` → `overloaded` → `timeout` → `other`; пустой список → `other`.
- `safeKindPhrase(kind)` — фиксированная фраза вида (для `other` — «неизвестный сбой CLI»); то же, что `classifyLlmError(...).human` для пяти видов.
- `safeCliText({ what, kind, status?, exit?, detail? })` → `claude CLI <what>: <kind>[, status N][, exit N][, <detail>]`; `status` берётся, только если целое 100–599; `detail` — одна строка до 160 знаков (переводы строк → пробел).

Красный коммит → реализация → зелёный (прогон бэка: `src/common/llm-error.spec.ts`).

### Task 2: `ClaudeCliCallError` и места `fail(...)`

- `class ClaudeCliCallError extends Error { constructor(message, readonly toolUsed, readonly info: { kind?, access?, status?, refusal? } = {}) }` + геттеры `kind`, `access`, `status`, `refusal` (или поля). Безопасный текст — в `super(...)`.
- Каждое место, где сейчас в текст ошибки попадает сырой кусок (по spec: поток `exited with code` и `is_error`; json `exited with code` и `is_error`; `invalid JSON`; отказ текстом в `runRaw`), меняется так: сырой текст собирается как раньше → `kind = classifyLlmError(raw).kind`, `access = isFallbackWorthy(raw)`, `status` из `api_error_status`, `detail` = `cliDiagnostic(errors)` или текст отказа (`looksLikeCliRefusal`) → `fail(safeCliText(...), { kind, access, status, refusal })`. Таймаут и `spawn error` — текст прежний (безопасен), признаки — `timeout`/`other`, `access: false`.
- Журналы `claude CLI exit N: …` и `parse error` — безопасный текст + `stdout N байт, stderr M байт`.
- Тесты (`claude-cli.safe-errors.spec.ts`, моки `spawn` — как в `claude-cli.chain.spec.ts`): маркер `СЕКРЕТ-ИЗ-ОТВЕТА` в `result`, в stdout, в stderr, в `errors[]`, в сообщении `JSON.parse` → не встречается в `err.message`, `err.stack` и ни в одном вызове `logger.*` (шпион на все уровни); признаки по видам — список из spec.

Красный → зелёный (прогон: `src/common/services`).

### Task 3: `runRaw` по признакам, склейка, журналы

- `access = err.access ?? isFallbackWorthy(msg)`, `kind = err.kind ?? classifyLlmError(msg).kind`.
- `parts` — из безопасных `message`; итоговая ошибка после цепочки — `ClaudeCliCallError(parts.join(' | '), false, { kind: aggregateKind(kinds), access: anyAccess })`.
- Журналы перехода и «запасные тоже не ответили» — безопасный текст (он уже такой — проверить, что нигде не остался сырой `msg` до создания ошибки).
- Тесты: цепочка Claude 401 → Qwen → Kimi с маркером в сырых текстах — переход работает, маркер нигде; итоговая ошибка несёт сводный `kind`; обновить ожидания `claude-cli.fallback.spec.ts`, `claude-cli.chain.spec.ts`, `claude-cli.global-switch.spec.ts`, где проверялся сырой текст (`Failed to authenticate`, `boom`, `real reason`, `529` в тексте…) — на признаки (`err.kind`, `err.access`, `status 529`) и безопасный текст. Ожидание журнала в `claude-cli.fallback.spec.ts` (переход на запасного) — под новый текст.

Красный → зелёный (прогон: `src/common`), tsc.

### Task 4: потребители и живой скрипт

- `insights.service.ts`: `isLimit(e)` — `e.kind ∈ {weekly_limit, rate_limit}`, если признак есть; иначе прежняя проверка текста. `PostponeError` — с безопасным текстом. Тест: ошибка с `kind: 'weekly_limit'` и безопасным текстом откладывает прогон.
- `claude-health.service.ts` (проба): вид — `e.kind ?? classifyLlmError(e.message).kind`; причина — `safeKindPhrase(kind)`, для `other` — `safeKindPhrase('other')` + безопасный `e.message` (до 160). Тест: ошибка с маркером в сыром тексте (через мок CLI) — алерт и `llmError` без маркера, вид верный.
- `scripts/llm-fallback-check.js` — разбор склейки под новый формат (проверить по месту, что именно он ищет).

Прогон: `src/insights src/monitoring`, tsc.

### Task 5: полные прогоны, живая проверка, ревью

- Нода: полный `npx jest src/` и `tests/unit` (после `npm run build`), tsc — дельта к базе ноль.
- Живая проверка: `scripts/llm-fallback-check.js` на ноде (ключи через stdin, как в плане Kimi Task 7) — сценарии зелёные, в выводе нет сырого текста.
- Итоговое ревью (opus) по `origin/main...feat/safe-cli-errors`.
- Слияние в main и выкат `deploy.sh` — **только с OK владельца**, соседей предупредить.

---

## База (Task 0)

(заполняется)
