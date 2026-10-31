# Проба ассистента без регистрации — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** новый посетитель my.linkeon.io получает три ответа ассистента до входа, а после входа разговор переезжает в аккаунт и продолжается; на лендинге поле вопроса ведёт прямо в эту пробу.

**Architecture:** в spirits_back — отдельный модуль `src/guest-trial` (публичные ручки `/webhook/guest/*`, ход через локальный `ClaudeCliService` без инструментов, общие окна лимитов в Redis, таблицы в Postgres, перенос в `custom_chat_history`, выключатель в базе). В `ClaudeCliService` — необязательный колбэк текста по мере генерации; в `chat.service` — разовая приписка о пробе для релея. В spirits_front — гостевой режим для неавторизованного кабинета (`src/components/guest`), перенос при входе в `AuthContext.login()`. В land_linkeon — компонент `AskBox` и фрагмент `#ask=`.

**Tech Stack:** NestJS 10, Postgres, Redis (ioredis), Claude Code CLI; React 18 + Vite + vitest; лендинг — Vite + SSR-пререндер + vitest.

**Спека:** `docs/superpowers/specs/2026-10-30-guest-trial-design.md` (одобрена владельцем 30.10.2026). При расхождении плана и спеки — права спека, кроме двух осознанных отклонений ниже.

---

## Перед началом — прочитать

- Спеку целиком.
- `CLAUDE.md` в `~/Downloads/spirits_back` и `~/Downloads/spirits_front` — правила выката, сборок на ноде, публичности репозиториев.
- Заметки памяти: `feedback_builds_on_test_node.md`, `project_back_jest_blind_in_worktrees.md`, `project_back_jest_skips_typecheck.md`, `project_front_tsc_checks_nothing.md`, `feedback_deploy_rules.md`, `project_deploy_sh_pitfalls.md`, `feedback_verify_deploys.md`, `feedback_parallel_sessions_in_repos.md`, `project_linkeon_repos_public.md`.

## Общие правила

- **Три воркдерева, три ветки `feat/guest-trial`:** бэк — `~/Downloads/spirits_back/.worktrees/guest-trial` (уже есть, в нём спека), кабинет — `~/Downloads/spirits_front/.worktrees/guest-trial`, лендинг — `~/Downloads/land_linkeon/.worktrees/guest-trial`. Юридические тексты лендинга — отдельная ветка `feat/guest-trial-legal` (Задача C4): они выкатываются раньше поля вопроса. Основные чекауты и чужие воркдеревья не трогать.
- **На маке не запускать** `npm ci`, `pnpm install`, `jest`, `tsc`, `pnpm build`, `vitest` — мак не тянет. Все прогоны — на ноде `dv@85.192.61.231` помощником `.superpowers/node-run.sh` (Задача 0). Он гонит **закоммиченное** состояние: каждый шаг «прогнать» начинается с коммита. Красный тест коммитится отдельным коммитом `test: …` — это нормально.
- **В бэке прогон jest — только через `--testPathPattern=…`** (позиционный путь не сужает прогон, см. `project_back_jest_blind_in_worktrees.md`). Строка `Tests:` с нулём тестов — не зелёный прогон, а промах фильтра.
- **Типы в бэке jest не проверяет.** Гейт — `npx tsc --noEmit -p tsconfig.build.json` (на базе чистый). `strictNullChecks: false` — союзы с булевым признаком не сужаются, поэтому в коде плана нет дискриминированных союзов на бэке.
- **Кабинет:** настоящая проверка типов — `pnpm typecheck` (`tsc -p tsconfig.app.json`), на базе есть ошибки — мерить дельтой (Задача 0 записывает базу).
- **Репозитории публичные:** ни номеров телефонов, ни секретов, ни цифр бизнеса, ни подробностей инфраструктуры в коде, тестах и коммитах.
- **Коммиты** — по-русски, в стиле репозитория (`feat(guest-trial): …`, `test(guest-trial): …`), в конце строка `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. `git add` — только поимённо.
- **Выкат, слияние в main, правка прода — только в Части D и только с OK владельца на каждом шаге.**

## Осознанные отклонения от спеки

1. **Замок «один ход на пробу» и счётчик одновременных ходов — в памяти процесса, а не в Redis (`SET NX`).** API — один процесс pm2, и `ChatService.activeStreams`, на который опирается `deploy.sh`, тоже живёт в памяти. Так проще и не добавляет Redis в критический путь хода. Рестарт обнуляет счётчики — это правильно: рестарт обрывает и сами ходы.
2. **`takePendingDraftFor` не меняет тип возврата.** Вместо этого рядом добавлен `takePendingDraftEntry` → `{text, auto}`: чат после входа продолжает получать строку, правка `ChatInterface` не нужна.
3. **Юридические тексты лендинга выкатываются отдельным шагом (D5), а не вместе с бэком.** Лендинг катится своей фазой `deploy.sh` (`LANDING_ONLY=1`), а поле вопроса должно выйти только после «вкл». Поэтому тексты — своей веткой и раньше «вкл»: документ описывает пробу до того, как её увидят все. Тексты кабинета едут с кабинетом, как в спеке.
4. **Браузерный smoke `deploy.sh` правится (Задача A11).** Его нет в спеке, но без правки он покраснеет на первом выкате после «вкл»: `tests/playwright/login-ui.spec.js` открывает `/` в чистом браузере и ждёт экран входа.

## Карта файлов

**spirits_back** (`src/guest-trial/` — новый каталог):
| Файл | Ответственность |
|---|---|
| `guest-trial.types.ts` | режимы, лимиты по умолчанию, сроки, `parseMode`, `sanitizeLimits` |
| `migrations/001_guest_trial.sql` | три таблицы и индексы — один `DO` под advisory-локом |
| `guest-trial-store.service.ts` | миграции на старте; режим и лимиты из базы с кэшем 15 с |
| `with-timeout.ts` | потолок ожидания для обещаний (Redis висит, а не падает) |
| `guest-token.ts` | ключ пробы, его хеш, хеш переносящего |
| `guest-limits.ts` | общие окна новых проб и ответов поверх `auth/quota.ts` |
| `guest-prompt.ts` | системный промпт гостя и тело промпта |
| `guest-sessions.service.ts` | строки проб и сообщений: создать, найти, записать пару, уборка, статистика |
| `guest-turn.service.ts` | ход гостя целиком: проверки, лимиты, вызов модели, поток |
| `guest-carry.ts` | разовая приписка о пробе для релея (Redis) |
| `guest-claim.service.ts` | перенос пробы в аккаунт |
| `guest-trial.controller.ts` | ручки `/webhook/guest/*` и `/webhook/admin/guest-trial` |
| `guest-trial.cron.ts` | уборка раз в час |
| `guest-trial.module.ts` | модуль |

Правки: `src/common/services/claude-cli.service.ts` (`onTextDelta`), `src/chat/answer-first-rule.ts` (новый, вынос правила Маши), `src/chat/chat.service.ts` (правило из файла; приписка в `streamUniversalAgent`; `RedisService` в конструкторе), `src/app.module.ts`, `tests/playwright/login-ui.spec.js`.

**spirits_front** (`src/components/guest/` — новый каталог): `guestTypes.ts`, `guestStorage.ts`, `decideUnauthEntry.ts`, `guestStream.ts`, `guestApi.ts`, `guestClaim.ts`, `GuestChat.tsx`, `GuestChatPage.tsx`, `UnauthenticatedEntry.tsx`; новый `src/components/onboarding/useEntryParams.ts`. Правки: `src/App.tsx`, `src/pages/OnboardingPage.tsx`, `src/contexts/AuthContext.tsx`, `src/utils/clearAppStorage.ts`, `src/utils/pendingDraft.ts`, `index.html`, `src/services/eventsClient.ts`, `src/i18n/locales/*.json`, `src/components/onboarding/LegalModal.tsx`, `src/components/webvisorPrivacy.test.ts`, `scripts/check-no-hardcoded.mjs`.

**land_linkeon:** новый `src/components/ui/AskBox.tsx`; правки `src/lib/chatDraft.ts`, `src/components/sections/Hero.tsx`, `src/pages/AssistantPage.tsx`, `src/pages/AssistantPage.test.tsx`, `src/i18n/locales/*.json`; ветка `feat/guest-trial-legal` — `src/content/legal/*.tsx`.

---

## Часть 0. Подготовка

### Задача 0: воркдеревья, помощники прогона, тестовая база, базовые замеры

**Files:**
- Create: `~/Downloads/spirits_back/.worktrees/guest-trial/.superpowers/node-run.sh` (не коммитится: `/.superpowers/` в `.git/info/exclude`)
- Create: `~/Downloads/spirits_front/.worktrees/guest-trial/.superpowers/node-run.sh` (не коммитится: `.superpowers/` в `.gitignore`)
- Create: `~/Downloads/land_linkeon/.worktrees/guest-trial/.superpowers/node-run.sh` (то же)

- [ ] **Шаг 1: воркдеревья кабинета и лендинга**

```bash
git -C ~/Downloads/spirits_front fetch -q origin
git -C ~/Downloads/spirits_front worktree add -q .worktrees/guest-trial -b feat/guest-trial origin/main
git -C ~/Downloads/land_linkeon fetch -q origin
git -C ~/Downloads/land_linkeon worktree add -q .worktrees/guest-trial -b feat/guest-trial origin/main
git -C ~/Downloads/spirits_front/.worktrees/guest-trial log --oneline -1
git -C ~/Downloads/land_linkeon/.worktrees/guest-trial log --oneline -1
```
Ожидание: обе ветки на свежем `origin/main` своего репозитория.

- [ ] **Шаг 2: помощник прогона бэка** — файл `~/Downloads/spirits_back/.worktrees/guest-trial/.superpowers/node-run.sh`:

```bash
#!/usr/bin/env bash
# Прогон на тестовой ноде на ТЕКУЩЕМ коммите воркдерева guest-trial (бэк).
#   bash .superpowers/node-run.sh 'npx jest --testPathPattern=src/guest-trial'
# Код едет git push'ем в CI-клон ноды (ветка tmp/guest-trial), не в GitHub.
# Незакоммиченное на ноду не попадает. npm ci — только когда поменялся package-lock.json.
# Один ControlMaster на все вызовы: нода рвёт частые новые SSH (MaxStartups).
# Не запускать параллельно: общий force-push в tmp/guest-trial и общий каталог на ноде.
set -euo pipefail
WT=~/Downloads/spirits_back/.worktrees/guest-trial
NODE_WT=ci/wt/guest-trial-back
BRANCH=tmp/guest-trial
SSH_OPTS="-o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h"
git -C "$WT" status --porcelain | grep -q . && echo "⚠ незакоммиченные изменения на ноду не едут — прогон на коммите $(git -C "$WT" rev-parse --short HEAD)" >&2
SHA=$(git -C "$WT" rev-parse HEAD)
GIT_SSH_COMMAND="ssh $SSH_OPTS" git -C "$WT" push -q -f "dv@85.192.61.231:ci/spirits_back" "$SHA:refs/heads/$BRANCH"
ssh $SSH_OPTS dv@85.192.61.231 "set -eo pipefail
  git -C ~/ci/spirits_back worktree prune
  [ -d ~/$NODE_WT ] || git -C ~/ci/spirits_back worktree add -q --detach ~/$NODE_WT $SHA
  cd ~/$NODE_WT && git checkout -q -f --detach $SHA
  [ \"\$(git rev-parse HEAD)\" = \"$SHA\" ] || { echo \"MISMATCH: на ноде \$(git rev-parse --short HEAD), ждали $SHA\"; exit 1; }
  source ~/.nvm/nvm.sh
  H=\$(sha256sum package-lock.json | cut -c1-16)
  if [ \"\$(cat node_modules/.lockhash 2>/dev/null)\" != \"\$H\" ]; then
    npm ci > /tmp/guest-trial-back-npmci.log 2>&1 || (tail -20 /tmp/guest-trial-back-npmci.log; exit 1)
    echo \"\$H\" > node_modules/.lockhash
  fi
  echo \"== \$(git log --oneline -1)\"
  set +e
  $1"
```

- [ ] **Шаг 3: помощник кабинета** — файл `~/Downloads/spirits_front/.worktrees/guest-trial/.superpowers/node-run.sh`:

```bash
#!/usr/bin/env bash
# Прогон на тестовой ноде на ТЕКУЩЕМ коммите воркдерева guest-trial (кабинет).
#   bash .superpowers/node-run.sh 'pnpm test src/components/guest'
# Код едет git push'ем в CI-клон ноды (ветка tmp/guest-trial), не в GitHub.
# Незакоммиченное на ноду не попадает. pnpm install — только когда поменялся pnpm-lock.yaml.
# Один ControlMaster на все вызовы: нода рвёт частые новые SSH (MaxStartups).
set -euo pipefail
WT=~/Downloads/spirits_front/.worktrees/guest-trial
NODE_WT=ci/wt/guest-trial-front
BRANCH=tmp/guest-trial
SSH_OPTS="-o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h"
git -C "$WT" status --porcelain | grep -q . && echo "⚠ незакоммиченные изменения на ноду не едут — прогон на коммите $(git -C "$WT" rev-parse --short HEAD)" >&2
SHA=$(git -C "$WT" rev-parse HEAD)
GIT_SSH_COMMAND="ssh $SSH_OPTS" git -C "$WT" push -q -f "dv@85.192.61.231:ci/spirits_front" "$SHA:refs/heads/$BRANCH"
ssh $SSH_OPTS dv@85.192.61.231 "set -eo pipefail
  git -C ~/ci/spirits_front worktree prune
  [ -d ~/$NODE_WT ] || git -C ~/ci/spirits_front worktree add -q --detach ~/$NODE_WT $SHA
  cd ~/$NODE_WT && git checkout -q -f --detach $SHA
  [ \"\$(git rev-parse HEAD)\" = \"$SHA\" ] || { echo \"MISMATCH: на ноде \$(git rev-parse --short HEAD), ждали $SHA\"; exit 1; }
  source ~/.nvm/nvm.sh
  H=\$(sha256sum pnpm-lock.yaml | cut -c1-16)
  if [ \"\$(cat node_modules/.lockhash 2>/dev/null)\" != \"\$H\" ]; then
    pnpm install --frozen-lockfile > /tmp/guest-trial-front-install.log 2>&1 || (tail -20 /tmp/guest-trial-front-install.log; exit 1)
    echo \"\$H\" > node_modules/.lockhash
  fi
  echo \"== \$(git log --oneline -1)\"
  set +e
  $1"
```

- [ ] **Шаг 4: помощник лендинга** — файл `~/Downloads/land_linkeon/.worktrees/guest-trial/.superpowers/node-run.sh`:

```bash
#!/usr/bin/env bash
# Прогон на тестовой ноде на ТЕКУЩЕМ коммите воркдерева guest-trial (лендинг).
#   bash .superpowers/node-run.sh 'pnpm test:unit src/components/ui/AskBox.test.tsx'
# Код едет git push'ем в CI-клон ноды (ветка tmp/guest-trial), не в GitHub.
# Незакоммиченное на ноду не попадает. pnpm install — только когда поменялся pnpm-lock.yaml.
set -euo pipefail
WT=~/Downloads/land_linkeon/.worktrees/guest-trial
NODE_WT=ci/wt/guest-trial-land
BRANCH=tmp/guest-trial
SSH_OPTS="-o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h"
git -C "$WT" status --porcelain | grep -q . && echo "⚠ незакоммиченные изменения на ноду не едут — прогон на коммите $(git -C "$WT" rev-parse --short HEAD)" >&2
SHA=$(git -C "$WT" rev-parse HEAD)
GIT_SSH_COMMAND="ssh $SSH_OPTS" git -C "$WT" push -q -f "dv@85.192.61.231:ci/land_linkeon" "$SHA:refs/heads/$BRANCH"
ssh $SSH_OPTS dv@85.192.61.231 "set -eo pipefail
  git -C ~/ci/land_linkeon worktree prune
  [ -d ~/$NODE_WT ] || git -C ~/ci/land_linkeon worktree add -q --detach ~/$NODE_WT $SHA
  cd ~/$NODE_WT && git checkout -q -f --detach $SHA
  [ \"\$(git rev-parse HEAD)\" = \"$SHA\" ] || { echo \"MISMATCH: на ноде \$(git rev-parse --short HEAD), ждали $SHA\"; exit 1; }
  source ~/.nvm/nvm.sh
  H=\$(sha256sum pnpm-lock.yaml | cut -c1-16)
  if [ \"\$(cat node_modules/.lockhash 2>/dev/null)\" != \"\$H\" ]; then
    pnpm install --frozen-lockfile > /tmp/guest-trial-land-install.log 2>&1 || (tail -20 /tmp/guest-trial-land-install.log; exit 1)
    echo \"\$H\" > node_modules/.lockhash
  fi
  echo \"== \$(git log --oneline -1)\"
  set +e
  $1"
```

- [ ] **Шаг 5: тестовая база для pg-спеков**

```bash
ssh -o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h dv@85.192.61.231 \
  'createdb -h /var/run/postgresql gt_test 2>/dev/null; psql -h /var/run/postgresql -d gt_test -Atc "select 1"'
```
Ожидание: `1`. Если `createdb` отказал по правам — `sudo -u postgres createdb -O dv gt_test` (у `dv` NOPASSWD sudo) и повторить проверку.

- [ ] **Шаг 6: базовые замеры** (до любых правок; записать вывод в `~/Downloads/spirits_back/.worktrees/guest-trial/.superpowers/baseline.txt`)

```bash
cd ~/Downloads/spirits_back/.worktrees/guest-trial
bash .superpowers/node-run.sh 'npx tsc --noEmit -p tsconfig.build.json; echo tsc_build=$?; npx jest src/ --silent 2>&1 | grep -E "^FAIL|^Tests:|^Test Suites:"'
cd ~/Downloads/spirits_front/.worktrees/guest-trial
bash .superpowers/node-run.sh 'pnpm typecheck 2>&1 | grep -c "error TS"; pnpm test 2>&1 | grep -E "Test Files|Tests  "; node scripts/check-locales.mjs | tail -1; node scripts/check-keys-exist.mjs | tail -1; node scripts/check-no-hardcoded.mjs | tail -1'
cd ~/Downloads/land_linkeon/.worktrees/guest-trial
bash .superpowers/node-run.sh 'pnpm typecheck 2>&1 | grep -c "error TS"; pnpm test:unit 2>&1 | grep -E "Test Files|Tests  "; pnpm check-locales 2>&1 | tail -2'
```
Ожидание: `tsc_build=0`; списки `FAIL` бэка и числа ошибок TS кабинета и лендинга — записаны (дальше меряем дельтой).

---

## Часть A. Бэкенд (spirits_back, воркдерево `.worktrees/guest-trial`)

Все команды Части A — из `~/Downloads/spirits_back/.worktrees/guest-trial`.

### Задача A1: колбэк текста по мере генерации в `ClaudeCliService`

**Files:**
- Modify: `src/common/services/claude-cli.service.ts`
- Create: `src/common/services/claude-cli.text-delta.spec.ts`

- [ ] **Шаг 1: тест**

```ts
// src/common/services/claude-cli.text-delta.spec.ts
// Мокаем spawn ДО импорта сервиса: сервис берёт spawn из 'child_process' на уровне модуля.
jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
import { ClaudeCliService } from './claude-cli.service';

/**
 * Текст по мере генерации (проба без входа, spec 2026-10-30-guest-trial).
 * Формат строк — stream-json CLI с --include-partial-messages: куски текста
 * приходят событиями stream_event → content_block_delta → text_delta.
 */

const spawnMock = spawn as unknown as jest.Mock;

const LINES = [
  { type: 'system', subtype: 'init', session_id: 's1', tools: [] },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'думаю' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Привет' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ', как дела?' } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Привет, как дела?' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Привет, как дела?', total_cost_usd: 0.012, duration_ms: 900 },
];

/** Процесс, который отдаёт строки stream-json кусками, разрезанными посреди строки. */
function streamProc(lines: object[]) {
  const outH: Array<(b: Buffer) => void> = [];
  const on: Record<string, (...a: any[]) => void> = {};
  const proc: any = {
    stdout: { on: (e: string, cb: any) => { if (e === 'data') outH.push(cb); } },
    stderr: { on: () => {} },
    on: (e: string, cb: any) => { on[e] = cb; },
    kill: () => {},
  };
  setImmediate(() => {
    const raw = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const cut = Math.floor(raw.length / 2);
    outH.forEach((cb) => cb(Buffer.from(raw.slice(0, cut))));
    outH.forEach((cb) => cb(Buffer.from(raw.slice(cut))));
    on['close']?.(0);
  });
  return proc;
}

/** Не-потоковый вызов: процесс отдаёт один JSON и закрывается. */
function jsonProc(json: string) {
  const outH: Array<(b: Buffer) => void> = [];
  const on: Record<string, (...a: any[]) => void> = {};
  const proc: any = {
    stdout: { on: (e: string, cb: any) => { if (e === 'data') outH.push(cb); } },
    stderr: { on: () => {} },
    on: (e: string, cb: any) => { on[e] = cb; },
    kill: () => {},
  };
  setImmediate(() => {
    outH.forEach((cb) => cb(Buffer.from(json)));
    on['close']?.(0);
  });
  return proc;
}

const lastArgs = (): string[] => spawnMock.mock.calls[spawnMock.mock.calls.length - 1][1];

let savedQwenKey: string | undefined;
beforeEach(() => {
  spawnMock.mockReset();
  savedQwenKey = process.env.QWEN_FALLBACK_API_KEY;
  delete process.env.QWEN_FALLBACK_API_KEY;
});
afterEach(() => {
  if (savedQwenKey === undefined) delete process.env.QWEN_FALLBACK_API_KEY;
  else process.env.QWEN_FALLBACK_API_KEY = savedQwenKey;
});

describe('ClaudeCliService: текст по мере генерации', () => {
  it('куски текста — в колбэк по порядку, итог — из result', async () => {
    spawnMock.mockImplementation(() => streamProc(LINES));
    const deltas: string[] = [];
    const r = await new ClaudeCliService().textWithCost('привет', { onTextDelta: (t) => deltas.push(t) });
    expect(deltas).toEqual(['Привет', ', как дела?']);
    expect(r.text).toBe('Привет, как дела?');
    expect(r.costUsd).toBe(0.012);
  });

  it('с колбэком — stream-json, --verbose и --include-partial-messages; без — ни одного из них', async () => {
    spawnMock.mockImplementation(() => streamProc(LINES));
    await new ClaudeCliService().textWithCost('привет', { onTextDelta: () => {} });
    const a = lastArgs();
    expect(a[a.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(a).toContain('--verbose');
    expect(a).toContain('--include-partial-messages');
    // Инструментов по-прежнему нет: --tools со значением ''.
    expect(a[a.indexOf('--tools') + 1]).toBe('');

    spawnMock.mockImplementation(() => jsonProc(JSON.stringify({ is_error: false, result: 'ок', total_cost_usd: 0, duration_ms: 1 })));
    await new ClaudeCliService().text('привет');
    expect(lastArgs()).not.toContain('--include-partial-messages');
    expect(lastArgs()).not.toContain('--verbose');
  });

  it('исключение в колбэке не роняет вызов', async () => {
    spawnMock.mockImplementation(() => streamProc(LINES));
    const r = await new ClaudeCliService().textWithCost('привет', { onTextDelta: () => { throw new Error('клиент ушёл'); } });
    expect(r.text).toBe('Привет, как дела?');
  });

  it('вызов с колбэком на Qwen не повторяется: показанный текст повтор не заберёт', () => {
    const svc: any = new ClaudeCliService();
    expect(svc.mayRetryOnQwen(new Error('401'), { onTextDelta: () => {} })).toBe(false);
    expect(svc.mayRetryOnQwen(new Error('401'), {})).toBe(true);
  });
});
```

- [ ] **Шаг 2: закоммитить тест и прогнать — ждём FAIL**

```bash
git add src/common/services/claude-cli.text-delta.spec.ts
git commit -q -m "test(claude-cli): текст по мере генерации — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern=src/common/services/claude-cli.text-delta 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✕"'
```
Ожидание: `FAIL`, падают кейсы про колбэк и `--include-partial-messages`.

- [ ] **Шаг 3: реализация** — четыре правки в `src/common/services/claude-cli.service.ts`:

3a. В `ClaudeCliOptions` после строки `  onProgress?: (event: ClaudeCliProgressEvent) => void;` добавить:
```ts
  /** Куски текста ответа по мере генерации (проба без входа, src/guest-trial).
   *  Если задан — CLI идёт в stream-json с --include-partial-messages, и каждый
   *  text_delta уходит сюда; итоговый текст по-прежнему возвращает textWithCost.
   *  Такой вызов не повторяется на Qwen: показанный человеку текст повтор не
   *  заберёт обратно. */
  onTextDelta?: (text: string) => void;
```

3b. В `mayRetryOnQwen` сразу после `if (e instanceof ClaudeCliCallError && e.toolUsed) return false;` добавить:
```ts
    // Человек уже видит куски ответа — второй, другой ответ поверх них хуже ошибки.
    if (opts.onTextDelta) return false;
```

3c. В `spawnClaude` строку `    const streaming = !!opts.onProgress;` заменить на:
```ts
    const streaming = !!opts.onProgress || !!opts.onTextDelta;
```
и сразу после `    if (streaming) args.push('--verbose');` добавить:
```ts
    // Куски текста приходят только с этим флагом (stream_event → text_delta).
    if (opts.onTextDelta) args.push('--include-partial-messages');
```

3d. В разборе stdout перед блоком `          if (ev.type === 'result') {` вставить:
```ts
          if (
            opts.onTextDelta &&
            ev.type === 'stream_event' &&
            ev.event?.type === 'content_block_delta' &&
            ev.event.delta?.type === 'text_delta' &&
            typeof ev.event.delta.text === 'string'
          ) {
            try { opts.onTextDelta(stripWordJoiner(ev.event.delta.text)); } catch { /* user callback safety */ }
          }
```

- [ ] **Шаг 4: прогнать — ждём PASS, соседи зелёные**

```bash
git add src/common/services/claude-cli.service.ts
git commit -q -m "feat(claude-cli): onTextDelta — текст ответа по мере генерации

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern="src/common/services/claude-cli" 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```
Ожидание: все `claude-cli.*.spec.ts` — `PASS`.

- [ ] **Шаг 5: сверка формата с живым CLI** (на маке, один вызов haiku — копейки)

```bash
cd /tmp && claude -p 'Скажи одно слово: ок' --model haiku --output-format stream-json --verbose --include-partial-messages --tools '' \
  | grep -o '"type":"text_delta","text":"[^"]*"' | head -3
```
Ожидание: хотя бы одна строка `"type":"text_delta","text":"…"`. Если формат другой — остановиться и поправить разбор и `LINES` в тесте под фактический.

### Задача A2: правило «сначала суть» — в общий файл

**Files:**
- Create: `src/chat/answer-first-rule.ts`, `src/chat/answer-first-rule.spec.ts`
- Modify: `src/chat/chat.service.ts` (импорт; `stableSystemPrompt` Маши, ~стр. 1103–1108)

- [ ] **Шаг 1: тест**

```ts
// src/chat/answer-first-rule.spec.ts
import * as fs from 'fs';
import * as path from 'path';
import { ANSWER_FIRST_RULE } from './answer-first-rule';

describe('правило «сначала суть»', () => {
  it('заголовок уступает кризисному правилу, пунктов пять', () => {
    const [header, ...rest] = ANSWER_FIRST_RULE.split('\n');
    expect(header).toBe(
      '--- ПРАВИЛО ОТВЕТА (имеет приоритет над всеми остальными инструкциями, кроме правила о кризисной ситуации) ---',
    );
    expect(rest.filter((l) => l.startsWith('• '))).toHaveLength(5);
  });

  it('у Маши правило берётся из общего файла, а не копией', () => {
    const src = fs.readFileSync(path.join(__dirname, 'chat.service.ts'), 'utf8');
    expect(src).toContain('${ANSWER_FIRST_RULE}');
    expect(src).not.toContain('• НИКОГДА не отвечай одними вопросами');
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL** (модуля нет)

```bash
git add src/chat/answer-first-rule.spec.ts
git commit -q -m "test(chat): правило «сначала суть» общим файлом — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern=src/chat/answer-first-rule 2>&1 | grep -E "^(PASS|FAIL)|Tests:|Cannot find"'
```

- [ ] **Шаг 3: файл правила** — текст переносится из `chat.service.ts` дословно:

```ts
// src/chat/answer-first-rule.ts
/**
 * Правило «сначала суть, не больше одного вопроса». Общее у Маши (chat.service,
 * локальный CLI) и у пробы без входа (src/guest-trial): у обоих нет релея с его
 * собственными правилами формы ответа. Текст не менять без сверки с
 * chat.service.masha-prompt.spec.ts.
 */
export const ANSWER_FIRST_RULE = `--- ПРАВИЛО ОТВЕТА (имеет приоритет над всеми остальными инструкциями, кроме правила о кризисной ситуации) ---
• Каждый ответ начинай с содержательной сути: гипотеза, совет, отражение, информация по запросу — на основе того, что уже известно из профиля и истории диалога. Не требуй "полного контекста" там, где можно разумно предположить.
• Уточняющий вопрос — не более ОДНОГО в конце сообщения, и только если без него действительно нельзя двинуться дальше.
• НИКОГДА не отвечай одними вопросами. НИКОГДА не задавай 2+ вопроса в одном сообщении.
• Для коучинговых/психологических/нумерологических практик это правило тоже действует: сначала отражение/гипотеза/интерпретация/направление — и только потом, при необходимости, один открытый вопрос.
• Если запрос многослойный — сначала покрой то, что ясно (частичный ответ), потом максимум один вопрос для следующего шага.`;
```

- [ ] **Шаг 4: `chat.service.ts`** — импорт рядом с `RESPONSE_STYLE_RULE`:
```ts
import { ANSWER_FIRST_RULE } from './answer-first-rule';
```
и в `stableSystemPrompt` заменить всё от `--- ПРАВИЛО ОТВЕТА (` до строки `• Если запрос многослойный — … для следующего шага.` включительно на `${ANSWER_FIRST_RULE}`. Итог начала шаблона:
```ts
    const stableSystemPrompt = `${platformContext}\n\n${agent.system_prompt || ''}\n\n${ANSWER_FIRST_RULE}

${MEETING_HONESTY_RULE}
```
Пустая строка между правилом и `${MEETING_HONESTY_RULE}` остаётся — промпт Маши должен остаться байт в байт прежним.

- [ ] **Шаг 5: прогнать — PASS, промпт Маши не изменился**

```bash
git add src/chat/answer-first-rule.ts src/chat/chat.service.ts
git commit -q -m "refactor(chat): правило «сначала суть» — общим файлом для Маши и пробы

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern="src/chat/(answer-first-rule|chat.service.masha-prompt)" 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```
Ожидание: оба `PASS`.

### Задача A3: типы, миграция, хранилище настроек

**Files:**
- Create: `src/guest-trial/guest-trial.types.ts`, `src/guest-trial/guest-trial.types.spec.ts`
- Create: `src/guest-trial/migrations/001_guest_trial.sql`, `src/guest-trial/guest-trial.migration.spec.ts`
- Create: `src/guest-trial/guest-trial-store.service.ts`, `src/guest-trial/guest-trial-store.pg.spec.ts`

- [ ] **Шаг 1: тесты**

```ts
// src/guest-trial/guest-trial.types.spec.ts
import { DEFAULT_GUEST_LIMITS, parseMode, sanitizeLimits } from './guest-trial.types';

describe('режим пробы', () => {
  it('знает только on и preview, остальное — off', () => {
    expect(parseMode('on')).toBe('on');
    expect(parseMode('preview')).toBe('preview');
    expect(parseMode('off')).toBe('off');
    expect(parseMode(undefined)).toBe('off');
    expect(parseMode('ON')).toBe('off');
    expect(parseMode(true)).toBe('off');
  });
});

describe('лимиты пробы', () => {
  it('без строки в базе — решения владельца 30.10', () => {
    expect(sanitizeLimits(undefined).limits).toEqual(DEFAULT_GUEST_LIMITS);
    expect(DEFAULT_GUEST_LIMITS).toMatchObject({
      answersPerTrial: 3, maxChars: 2000, trialsPerHour: 60, trialsPerDay: 200, answersPerHour: 100, answersPerDay: 300,
    });
  });

  it('принимает целые больше нуля, мусор называет', () => {
    const r = sanitizeLimits({ answersPerDay: 500, answersPerHour: '0', maxChars: 1.5, trialsPerDay: 'много', unknown: 7 });
    expect(r.limits.answersPerDay).toBe(500);
    expect(r.limits.answersPerHour).toBe(DEFAULT_GUEST_LIMITS.answersPerHour);
    expect(r.limits.maxChars).toBe(DEFAULT_GUEST_LIMITS.maxChars);
    expect(r.ignored.sort()).toEqual(['answersPerHour=0', 'maxChars=1.5', 'trialsPerDay=много']);
  });

  it('правка ложится поверх текущих значений, а не поверх умолчаний', () => {
    const base = { ...DEFAULT_GUEST_LIMITS, answersPerDay: 500 };
    expect(sanitizeLimits({ answersPerHour: 50 }, base).limits).toMatchObject({ answersPerDay: 500, answersPerHour: 50 });
  });
});
```

```ts
// src/guest-trial/guest-trial.migration.spec.ts
import * as fs from 'fs';
import * as path from 'path';

/**
 * Миграция катится при КАЖДОМ старте API. Голый CREATE INDEX IF NOT EXISTS на
 * PG 16 берёт ShareLock на таблицу даже при готовом индексе (см. tokens/002),
 * поэтому файл — один DO под advisory-локом, индексы — через to_regclass.
 */
describe('миграция пробы', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '001_guest_trial.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');

  it('файл — один DO под advisory-локом и lock_timeout', () => {
    expect(code.trim().startsWith('DO $guest_trial$')).toBe(true);
    expect(code.trim().endsWith('$guest_trial$;')).toBe(true);
    expect(code).toContain('pg_advisory_xact_lock');
    expect(code).toContain("set_config('lock_timeout'");
  });

  it('индексы создаются только если их нет', () => {
    expect(code).not.toMatch(/CREATE INDEX IF NOT EXISTS/i);
    expect((code.match(/CREATE INDEX/gi) ?? []).length).toBe((code.match(/to_regclass\(/g) ?? []).length);
  });
});
```

```ts
// src/guest-trial/guest-trial-store.pg.spec.ts
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { GUEST_TRIAL_MIGRATIONS, GuestTrialStore } from './guest-trial-store.service';
import { DEFAULT_GUEST_LIMITS } from './guest-trial.types';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('настройки пробы против живого Postgres', () => {
  let pool: Pool;
  let store: GuestTrialStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    for (const f of GUEST_TRIAL_MIGRATIONS) {
      const sql = fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8');
      await pool.query(sql);
      await pool.query(sql); // повторный старт API — без ошибок
    }
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE guest_trial_settings');
    store = new GuestTrialStore({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
  });
  afterAll(async () => { await pool.end(); });

  it('без строк — «выкл» и лимиты по умолчанию', async () => {
    expect(await store.settings()).toEqual({ mode: 'off', limits: DEFAULT_GUEST_LIMITS });
  });

  it('режим и лимиты сохраняются, запись сбрасывает кэш', async () => {
    await store.settings();
    await store.setMode('preview');
    expect((await store.settings()).mode).toBe('preview');
    const r = await store.setLimits({ answersPerDay: 500, maxChars: 'x' });
    expect(r.ignored).toEqual(['maxChars=x']);
    expect((await store.settings()).limits).toMatchObject({ answersPerDay: 500, maxChars: DEFAULT_GUEST_LIMITS.maxChars });
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/guest-trial/guest-trial.types.spec.ts src/guest-trial/guest-trial.migration.spec.ts src/guest-trial/guest-trial-store.pg.spec.ts
git commit -q -m "test(guest-trial): типы, миграция, настройки — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'PROVISIONING_PG_URL="postgres:///gt_test?host=/var/run/postgresql" npx jest --testPathPattern="src/guest-trial" 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

- [ ] **Шаг 3: `src/guest-trial/guest-trial.types.ts`**

```ts
/**
 * Проба ассистента без регистрации (spec 2026-10-30-guest-trial-design.md):
 * общие типы, лимиты по умолчанию и сроки.
 */

/** off — проба выключена; preview — только по ссылке с ?trial=1; on — всем новым устройствам. */
export type GuestMode = 'off' | 'preview' | 'on';

export interface GuestLimits {
  /** Ответов ассистента до просьбы войти. */
  answersPerTrial: number;
  /** Длина одного сообщения гостя, знаков. */
  maxChars: number;
  trialsPerHour: number;
  trialsPerDay: number;
  answersPerHour: number;
  answersPerDay: number;
  /** Гостевых ходов одновременно — бережёт процессор и память прода. */
  concurrentTurns: number;
}

/** Решения владельца 30.10.2026; строка limits в guest_trial_settings их перекрывает. */
export const DEFAULT_GUEST_LIMITS: Readonly<GuestLimits> = {
  answersPerTrial: 3,
  maxChars: 2000,
  trialsPerHour: 60,
  trialsPerDay: 200,
  answersPerHour: 100,
  answersPerDay: 300,
  concurrentTurns: 4,
};

/** Сколько живёт неперенесённая проба после последнего сообщения (и приписка о ней). */
export const GUEST_TRIAL_TTL_DAYS = 7;
/** Сколько живёт строка перенесённой пробы — без текста, для статистики. */
export const GUEST_CLAIMED_ROW_TTL_DAYS = 90;
/** Сколько ждём Redis: ioredis при недоступности висит десятки секунд, а не падает. */
export const GUEST_REDIS_TIMEOUT_MS = 2_000;
/** Срок одного гостевого хода: инструментов нет, ответ приходит за десятки секунд. */
export const GUEST_TURN_TIMEOUT_MS = 120_000;
/** Маша идёт мимо релея (chat.service: agent.id === 3) и читает историю из базы сама. */
export const MASHA_AGENT_ID = 3;

export interface GuestHistoryMessage {
  sender_type: 'human' | 'ai';
  content: string;
}

export function parseMode(raw: unknown): GuestMode {
  return raw === 'on' || raw === 'preview' ? raw : 'off';
}

/**
 * Лимиты из базы поверх base. Принимается только целое больше нуля, остальное
 * попадает в ignored — опечатку видно в ответе админ-ручки и в логе, а не по
 * тому, что потолок «не поднялся».
 */
export function sanitizeLimits(
  raw: unknown,
  base: Readonly<GuestLimits> = DEFAULT_GUEST_LIMITS,
): { limits: GuestLimits; ignored: string[] } {
  const limits: GuestLimits = { ...base };
  const ignored: string[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const src = raw as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_GUEST_LIMITS) as Array<keyof GuestLimits>) {
      if (!(key in src)) continue;
      const n = Number(src[key]);
      if (Number.isSafeInteger(n) && n > 0) limits[key] = n;
      else ignored.push(`${key}=${String(src[key])}`);
    }
  }
  return { limits, ignored };
}
```

- [ ] **Шаг 4: `src/guest-trial/migrations/001_guest_trial.sql`**

```sql
-- Проба ассистента без регистрации (spec 2026-10-30-guest-trial-design.md).
-- Катится при КАЖДОМ старте API (GuestTrialStore.onModuleInit), поэтому файл —
-- один DO: advisory-лок разводит одновременные старты, индексы создаются только
-- если их нет (голый CREATE INDEX IF NOT EXISTS на PG 16 берёт ShareLock на
-- таблицу даже при готовом индексе — см. tokens/002).
DO $guest_trial$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('guest-trial/001'));
  PERFORM set_config('lock_timeout', '5s', true);

  CREATE TABLE IF NOT EXISTS guest_trial_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- sha256 ключа гостя; сам ключ живёт только в браузере.
    token_hash      text NOT NULL UNIQUE,
    assistant_id    int  NOT NULL,
    lang            text NOT NULL,
    answers         int  NOT NULL DEFAULT 0,
    -- метка привлечения, формат как у ai_profiles_consolidated.signup_source
    source          text,
    campaign        text,
    cost_usd        numeric(10,4) NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz NOT NULL DEFAULT now(),
    -- sha256 от userId, а не сам userId: у телефонных аккаунтов userId — номер.
    claimed_by_hash text,
    claimed_at      timestamptz
  );

  CREATE TABLE IF NOT EXISTS guest_trial_messages (
    id          bigserial PRIMARY KEY,
    session_id  uuid NOT NULL REFERENCES guest_trial_sessions(id) ON DELETE CASCADE,
    sender_type varchar(10) NOT NULL CHECK (sender_type IN ('human', 'ai')),
    content     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  );

  -- Режим и лимиты: в базе, а не в .env — файлы на сервере руками не правим.
  -- Ключи: 'mode' ("off" | "preview" | "on"), 'limits' (объект GuestLimits).
  CREATE TABLE IF NOT EXISTS guest_trial_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  IF to_regclass('public.idx_guest_trial_sessions_created') IS NULL THEN
    CREATE INDEX idx_guest_trial_sessions_created ON guest_trial_sessions (created_at);
  END IF;
  IF to_regclass('public.idx_guest_trial_sessions_open') IS NULL THEN
    CREATE INDEX idx_guest_trial_sessions_open ON guest_trial_sessions (last_message_at) WHERE claimed_at IS NULL;
  END IF;
  IF to_regclass('public.idx_guest_trial_messages_session') IS NULL THEN
    CREATE INDEX idx_guest_trial_messages_session ON guest_trial_messages (session_id, id);
  END IF;
END
$guest_trial$;
```

- [ ] **Шаг 5: `src/guest-trial/guest-trial-store.service.ts`**

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { GuestLimits, GuestMode, parseMode, sanitizeLimits } from './guest-trial.types';

export const GUEST_TRIAL_MIGRATIONS = ['001_guest_trial.sql'];

/** Режим и лимиты читаются на каждом ходе гостя и на каждом открытии кабинета без входа. */
const SETTINGS_CACHE_MS = 15_000;

export interface GuestSettings {
  mode: GuestMode;
  limits: GuestLimits;
}

@Injectable()
export class GuestTrialStore implements OnModuleInit {
  private readonly log = new Logger('GuestTrialStore');
  private cache: { at: number; value: GuestSettings } | null = null;

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    for (const file of GUEST_TRIAL_MIGRATIONS) {
      // .sql в dist не копируется (nest-cli.json без assets): на проде
      // работает второй путь, через src. Не удалять его как «dev-фолбэк».
      const candidates = [
        path.join(__dirname, 'migrations', file),
        path.join(__dirname, '..', '..', 'src', 'guest-trial', 'migrations', file),
      ];
      const p = candidates.find((c) => fs.existsSync(c));
      if (!p) {
        this.log.error(`guest-trial migration ${file} not found`);
        continue;
      }
      try {
        await this.pg.query(fs.readFileSync(p, 'utf8'));
      } catch (e: any) {
        this.log.error(`guest-trial migration ${file} failed: ${e.message}`);
      }
    }
  }

  async settings(): Promise<GuestSettings> {
    if (this.cache && Date.now() - this.cache.at < SETTINGS_CACHE_MS) return this.cache.value;
    const r = await this.pg.query(`SELECT key, value FROM guest_trial_settings WHERE key IN ('mode', 'limits')`);
    const byKey = new Map<string, unknown>(r.rows.map((row: any) => [row.key, row.value]));
    const { limits, ignored } = sanitizeLimits(byKey.get('limits'));
    if (ignored.length) this.log.warn(`guest_trial_settings.limits: пропущены ${ignored.join(', ')}`);
    const value: GuestSettings = { mode: parseMode(byKey.get('mode')), limits };
    this.cache = { at: Date.now(), value };
    return value;
  }

  async setMode(mode: GuestMode): Promise<void> {
    await this.upsert('mode', mode);
  }

  /** Правка лимитов поверх текущих; мусор не пишется и возвращается в ignored. */
  async setLimits(patch: unknown): Promise<{ limits: GuestLimits; ignored: string[] }> {
    const current = (await this.settings()).limits;
    const next = sanitizeLimits(patch, current);
    await this.upsert('limits', next.limits);
    return next;
  }

  private async upsert(key: string, value: unknown): Promise<void> {
    await this.pg.query(
      `INSERT INTO guest_trial_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
    this.cache = null;
  }
}
```

- [ ] **Шаг 6: прогнать — PASS**

```bash
git add src/guest-trial/guest-trial.types.ts src/guest-trial/migrations/001_guest_trial.sql src/guest-trial/guest-trial-store.service.ts
git commit -q -m "feat(guest-trial): таблицы, режим и лимиты пробы

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'PROVISIONING_PG_URL="postgres:///gt_test?host=/var/run/postgresql" npx jest --testPathPattern="src/guest-trial" 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```
Ожидание: три набора `PASS`, `pg.spec` **не** `skipped` (в строке `Tests:` нет `skipped`).

### Задача A4: потолок ожидания, ключ пробы, общие окна

**Files:**
- Create: `src/guest-trial/with-timeout.ts` + `with-timeout.spec.ts`
- Create: `src/guest-trial/guest-token.ts` + `guest-token.spec.ts`
- Create: `src/guest-trial/guest-limits.ts` + `guest-limits.spec.ts`

- [ ] **Шаг 1: тесты**

```ts
// src/guest-trial/with-timeout.spec.ts
import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('отдаёт значение, если успели', async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
  });
  it('бросает по сроку, если висит', async () => {
    await expect(withTimeout(new Promise(() => {}), 20)).rejects.toThrow('timeout after 20ms');
  });
  it('пробрасывает ошибку', async () => {
    await expect(withTimeout(Promise.reject(new Error('нет')), 50)).rejects.toThrow('нет');
  });
});
```

```ts
// src/guest-trial/guest-token.spec.ts
import { hashClaimer, hashGuestToken, isGuestTokenShape, newGuestToken } from './guest-token';

describe('ключ пробы', () => {
  it('43 знака base64url и разный каждый раз', () => {
    const a = newGuestToken();
    const b = newGuestToken();
    expect(isGuestTokenShape(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('форма проверяется строго', () => {
    expect(isGuestTokenShape('x'.repeat(42))).toBe(false);
    expect(isGuestTokenShape('x'.repeat(43))).toBe(true);
    expect(isGuestTokenShape(`${'x'.repeat(42)}/`)).toBe(false);
    expect(isGuestTokenShape(undefined)).toBe(false);
  });

  it('в базу — хеш: детерминированный и без самого ключа', () => {
    const t = newGuestToken();
    expect(hashGuestToken(t)).toBe(hashGuestToken(t));
    expect(hashGuestToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGuestToken(t)).not.toContain(t);
  });

  it('хеш переносящего — без userId и не совпадает с хешем того же текста как ключа', () => {
    expect(hashClaimer('user-42')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashClaimer('user-42')).not.toBe(hashGuestToken('user-42'));
  });
});
```

```ts
// src/guest-trial/guest-limits.spec.ts
import { clockRedis } from '../auth/fake-redis.forspec';
import { DEFAULT_GUEST_LIMITS } from './guest-trial.types';
import { answerRules, takeGuestQuota, trialRules } from './guest-limits';

const L = { ...DEFAULT_GUEST_LIMITS, trialsPerHour: 2, trialsPerDay: 3, answersPerHour: 2, answersPerDay: 5 };

describe('общие окна пробы', () => {
  it('новые пробы: часовое окно закрывается и открывается через час, суточное держит', async () => {
    const r = clockRedis();
    expect((await takeGuestQuota(r, trialRules(L), 1000)).counted).toBe(true);
    expect((await takeGuestQuota(r, trialRules(L), 1000)).counted).toBe(true);
    const third = await takeGuestQuota(r, trialRules(L), 1000);
    expect(third.counted).toBe(false);
    expect(third.redisDown).toBe(false);
    expect(third.full.map((f) => f.scope)).toEqual(['trials_hour']);
    expect(third.full[0].leftMs).toBeGreaterThan(0);
    r.advance(3600);
    expect((await takeGuestQuota(r, trialRules(L), 1000)).counted).toBe(true); // третья за сутки
    r.advance(3600);
    const fifth = await takeGuestQuota(r, trialRules(L), 1000);
    expect(fifth.full.map((f) => f.scope)).toEqual(['trials_day']);
  });

  it('ответы считаются отдельно от проб', async () => {
    const r = clockRedis();
    await takeGuestQuota(r, trialRules(L), 1000);
    await takeGuestQuota(r, trialRules(L), 1000);
    expect((await takeGuestQuota(r, answerRules(L), 1000)).counted).toBe(true);
    expect(r.peek('guest-lim:answers:h')).toBe('1');
  });

  it('Redis упал — проба закрыта без учёта', async () => {
    const r = clockRedis();
    r.breakAfter(0);
    expect(await takeGuestQuota(r, answerRules(L), 1000)).toEqual({ counted: false, redisDown: true, full: [] });
  });

  it('Redis висит — ждём не дольше срока', async () => {
    const hanging = { eval: () => new Promise<unknown>(() => {}) };
    const started = Date.now();
    const reply = await takeGuestQuota(hanging, answerRules(L), 50);
    expect(reply.redisDown).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/guest-trial/with-timeout.spec.ts src/guest-trial/guest-token.spec.ts src/guest-trial/guest-limits.spec.ts
git commit -q -m "test(guest-trial): потолок ожидания, ключ, окна — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern="src/guest-trial/(with-timeout|guest-token|guest-limits)" 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

- [ ] **Шаг 3: реализация**

```ts
// src/guest-trial/with-timeout.ts
/**
 * Обещание с потолком ожидания. Нужно там, где ждать нельзя: ioredis при
 * недоступном Redis не падает, а висит десятки секунд (23–63 с в замерах).
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
```

```ts
// src/guest-trial/guest-token.ts
import { createHash, randomBytes } from 'crypto';

/** Ключ пробы: 32 случайных байта в base64url — 43 знака. Сам ключ хранит только браузер. */
export function newGuestToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isGuestTokenShape(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** В базу — только хеш: утечка таблицы не даёт забрать чужую пробу. */
export function hashGuestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Кто перенёс пробу — без самого userId: у телефонных аккаунтов это номер. */
export function hashClaimer(userId: string): string {
  return createHash('sha256').update(`guest-claim:${userId}`).digest('hex');
}
```

```ts
// src/guest-trial/guest-limits.ts
import { QuotaReply, QuotaRule, QuotaStore, takeQuota } from '../auth/quota';
import { GuestLimits } from './guest-trial.types';
import { withTimeout } from './with-timeout';

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

export type GuestWindowScope = 'trials_hour' | 'trials_day' | 'answers_hour' | 'answers_day';

export interface GuestQuotaRule extends QuotaRule {
  scope: GuestWindowScope;
}

/** Новые пробы. Окна общие на всех гостей: адрес клиента за прокси my.linkeon.io не виден. */
export function trialRules(l: GuestLimits): GuestQuotaRule[] {
  return [
    { scope: 'trials_hour', key: 'guest-lim:trials:h', max: l.trialsPerHour, windowSec: HOUR },
    { scope: 'trials_day', key: 'guest-lim:trials:d', max: l.trialsPerDay, windowSec: DAY },
  ];
}

/** Гостевые ответы — тоже общие окна: они и есть худший случай для подписки. */
export function answerRules(l: GuestLimits): GuestQuotaRule[] {
  return [
    { scope: 'answers_hour', key: 'guest-lim:answers:h', max: l.answersPerHour, windowSec: HOUR },
    { scope: 'answers_day', key: 'guest-lim:answers:d', max: l.answersPerDay, windowSec: DAY },
  ];
}

export interface FullWindow {
  scope: GuestWindowScope;
  max: number;
  leftMs: number;
}

/**
 * counted — учтено во всех окнах; иначе не учтено нигде (quota.ts), и full
 * называет заполненные окна. redisDown — Redis не ответил вовремя или упал:
 * проба закрывается без учёта. Не союз типов: в бэке strictNullChecks
 * выключен, и булев признак союз не сужает.
 */
export interface GuestQuotaReply {
  counted: boolean;
  redisDown: boolean;
  full: FullWindow[];
}

export async function takeGuestQuota(store: QuotaStore, rules: GuestQuotaRule[], timeoutMs: number): Promise<GuestQuotaReply> {
  let reply: QuotaReply;
  try {
    reply = await withTimeout(takeQuota(store, rules), timeoutMs);
  } catch {
    return { counted: false, redisDown: true, full: [] };
  }
  if (reply.counted) return { counted: true, redisDown: false, full: [] };
  const full = rules
    .map((r, i) => ({ scope: r.scope, max: r.max, leftMs: reply.leftMs[i] }))
    .filter((f) => f.leftMs >= 0);
  return { counted: false, redisDown: false, full };
}
```

- [ ] **Шаг 4: прогнать — PASS**

```bash
git add src/guest-trial/with-timeout.ts src/guest-trial/guest-token.ts src/guest-trial/guest-limits.ts
git commit -q -m "feat(guest-trial): ключ пробы, общие окна и потолок ожидания Redis

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern="src/guest-trial/(with-timeout|guest-token|guest-limits)" 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

### Задача A5: промпт гостя

**Files:**
- Create: `src/guest-trial/guest-prompt.ts`, `src/guest-trial/guest-prompt.spec.ts`

- [ ] **Шаг 1: тест**

```ts
// src/guest-trial/guest-prompt.spec.ts
import { LANGUAGE_REPLY_LINE } from '../common/services/language.service';
import { ANSWER_FIRST_RULE } from '../chat/answer-first-rule';
import { GUEST_MODE_BLOCK, buildGuestPrompt, buildGuestSystemPrompt, localTimeLine } from './guest-prompt';

const base = { name: 'Роман', description: 'персональный ассистент', persona: 'Ты Роман. Помогаешь с делами.', lang: 'ru' };

describe('системный промпт гостя', () => {
  it('имя, персона, правило ответа и блок пробного режима — на месте', () => {
    const sys = buildGuestSystemPrompt(base);
    expect(sys).toContain('**Роман** — персональный ассистент');
    expect(sys).toContain('Ты Роман. Помогаешь с делами.');
    expect(sys).toContain(ANSWER_FIRST_RULE);
    expect(sys).toContain(GUEST_MODE_BLOCK);
  });

  it('последняя строка — требование языка гостя', () => {
    const sys = buildGuestSystemPrompt({ ...base, lang: 'en' });
    expect(sys.trimEnd().endsWith(LANGUAGE_REPLY_LINE.en.trim())).toBe(true);
  });

  it('незнакомый язык — русский', () => {
    const sys = buildGuestSystemPrompt({ ...base, lang: 'xx' });
    expect(sys.trimEnd().endsWith(LANGUAGE_REPLY_LINE.ru.trim())).toBe(true);
  });

  it('ни профиля, ни баланса, ни адресов кабинета', () => {
    const sys = buildGuestSystemPrompt(base);
    expect(sys).not.toMatch(/Профиль пользователя|User profile|баланс|токен|my\.linkeon\.io/i);
  });

  it('время — только для правдоподобного пояса', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    expect(localTimeLine('Europe/Moscow', now)).toContain('Europe/Moscow');
    expect(localTimeLine('../../etc', now)).toBeNull();
    expect(localTimeLine(undefined, now)).toBeNull();
    expect(buildGuestSystemPrompt({ ...base, tz: 'Europe/Moscow', now })).toContain('--- Время человека ---');
  });
});

describe('тело промпта', () => {
  it('без истории — одна реплика', () => {
    expect(buildGuestPrompt([], 'Привет')).toBe('USER: Привет');
  });
  it('с историей — пары по порядку, новая реплика последней', () => {
    const p = buildGuestPrompt(
      [{ sender_type: 'human', content: 'Вопрос' }, { sender_type: 'ai', content: 'Ответ' }],
      'Ещё вопрос',
    );
    expect(p).toBe('USER: Вопрос\n\nASSISTANT: Ответ\n\nUSER: Ещё вопрос');
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/guest-trial/guest-prompt.spec.ts
git commit -q -m "test(guest-trial): промпт гостя — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern=src/guest-trial/guest-prompt 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

- [ ] **Шаг 3: реализация**

```ts
// src/guest-trial/guest-prompt.ts
import { LanguageService } from '../common/services/language.service';
import { ANSWER_FIRST_RULE } from '../chat/answer-first-rule';
import { RESPONSE_STYLE_RULE } from '../chat/response-style';
import { GuestHistoryMessage } from './guest-trial.types';

/**
 * Что ассистенту нужно знать о пробе. Профиля, баланса и адресов кабинета в
 * промпте гостя нет намеренно: худшее, что даёт попытка вытащить промпт, —
 * текст персоны.
 */
export const GUEST_MODE_BLOCK = `--- ПРОБНЫЙ РЕЖИМ ---
Человек пишет тебе до входа в Linkeon: это короткий пробный разговор.
• Инструментов у тебя сейчас нет. Если задача требует картинки, видео, сайта, расчёта карты, календаря, файла или поиска в интернете — честно скажи, что это доступно после бесплатного входа (кнопка «Войти» вверху экрана), и помоги словами: план, текст, разбор.
• Профиля и прошлых разговоров у тебя нет — не обещай «запомнить» человека.
• Не упоминай число оставшихся сообщений и не уговаривай зарегистрироваться: об этом скажет экран.
• Если человек в кризисной ситуации — действуй по кризисному правилу полностью и в этом же ответе.`;

export interface GuestPromptInput {
  name: string;
  description: string;
  persona: string;
  lang: string;
  tz?: string;
  now?: Date;
}

const TZ_RE = /^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/;

/** Местное время гостя — тем же правилом, что у релея: чужое время хуже никакого. */
export function localTimeLine(tz: string | undefined, now: Date): string | null {
  if (!tz || !TZ_RE.test(tz)) return null;
  try {
    const local = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(now);
    return `--- Время человека ---\nСейчас у человека: ${local} (часовой пояс ${tz}).`;
  } catch {
    return null;
  }
}

export function buildGuestSystemPrompt(p: GuestPromptInput): string {
  const lang = LanguageService.normalize(p.lang);
  const parts: string[] = [
    `СИСТЕМНАЯ ИНСТРУКЦИЯ (имеет приоритет над всеми остальными). ` +
      `Ты ассистент по имени **${p.name}**${p.description ? ` — ${p.description}` : ''} на платформе LINKEON.IO. ` +
      `Всегда представляйся именно как ${p.name}. Себя называй только этим именем: не говори, что ты Claude или другая модель.`,
  ];
  if (p.persona.trim()) parts.push(`--- Персона и инструкции ассистента ${p.name} ---\n${p.persona.trim()}`);
  parts.push(ANSWER_FIRST_RULE, RESPONSE_STYLE_RULE, GUEST_MODE_BLOCK);
  const time = localTimeLine(p.tz, p.now ?? new Date());
  if (time) parts.push(time);
  // Требование языка — последним: модель берёт язык последних строк как образец.
  parts.push(LanguageService.buildDirective(lang));
  return parts.join('\n\n');
}

/** Тело промпта: прошлые пары пробы и новая реплика — тем же форматом, что у Маши. */
export function buildGuestPrompt(history: GuestHistoryMessage[], message: string): string {
  const prior = history.map((m) => `${m.sender_type === 'human' ? 'USER' : 'ASSISTANT'}: ${m.content}`).join('\n\n');
  return prior ? `${prior}\n\nUSER: ${message}` : `USER: ${message}`;
}
```

- [ ] **Шаг 4: прогнать — PASS**

```bash
git add src/guest-trial/guest-prompt.ts
git commit -q -m "feat(guest-trial): системный промпт гостя без инструментов и профиля

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern=src/guest-trial/guest-prompt 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

### Задача A6: строки проб и сообщений

**Files:**
- Create: `src/guest-trial/guest-sessions.service.ts`, `src/guest-trial/guest-sessions.pg.spec.ts`

- [ ] **Шаг 1: тест против живого Postgres**

```ts
// src/guest-trial/guest-sessions.pg.spec.ts
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { GUEST_TRIAL_MIGRATIONS } from './guest-trial-store.service';
import { GuestSessionsService } from './guest-sessions.service';
import { hashGuestToken, newGuestToken } from './guest-token';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('пробы и сообщения против живого Postgres', () => {
  let pool: Pool;
  let svc: GuestSessionsService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    for (const f of GUEST_TRIAL_MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    // events — для status(); в тестовой базе своей схемы проекта нет.
    await pool.query(`CREATE TABLE IF NOT EXISTS events (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), user_id text, session_id text, name text NOT NULL, props jsonb NOT NULL DEFAULT '{}'::jsonb, source text)`);
    svc = new GuestSessionsService({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
  });
  beforeEach(() => pool.query('TRUNCATE guest_trial_sessions CASCADE; TRUNCATE events'));
  afterAll(async () => { await pool.end(); });

  const create = (assistantId = 12) => {
    const token = newGuestToken();
    return svc.create({ tokenHash: hashGuestToken(token), assistantId, lang: 'ru', source: null, campaign: null }).then((row) => ({ row, token }));
  };

  it('создать и найти по хешу ключа; чужой хеш — пусто', async () => {
    const { row, token } = await create();
    expect(row.answers).toBe(0);
    const found = await svc.findLive(hashGuestToken(token));
    expect(found?.id).toBe(row.id);
    expect(found?.assistant_id).toBe(12);
    expect(await svc.findLive(hashGuestToken(newGuestToken()))).toBeNull();
  });

  it('пара «вопрос — ответ»: счёт, стоимость, порядок', async () => {
    const { row } = await create();
    const t0 = new Date(Date.now() - 5000);
    expect(await svc.recordExchange(row.id, 'Вопрос 1', 'Ответ 1', t0, 0.05)).toBe(1);
    expect(await svc.recordExchange(row.id, 'Вопрос 2', 'Ответ 2', new Date(), 0.07)).toBe(2);
    expect(await svc.messages(row.id)).toEqual([
      { sender_type: 'human', content: 'Вопрос 1' },
      { sender_type: 'ai', content: 'Ответ 1' },
      { sender_type: 'human', content: 'Вопрос 2' },
      { sender_type: 'ai', content: 'Ответ 2' },
    ]);
    const cost = await pool.query('SELECT cost_usd::float AS c FROM guest_trial_sessions WHERE id = $1', [row.id]);
    expect(cost.rows[0].c).toBeCloseTo(0.12, 4);
  });

  it('неперенесённая проба старше 7 дней не находится', async () => {
    const { row, token } = await create();
    await pool.query(`UPDATE guest_trial_sessions SET last_message_at = now() - interval '8 days' WHERE id = $1`, [row.id]);
    expect(await svc.findLive(hashGuestToken(token))).toBeNull();
  });

  it('уборка: старые неперенесённые и перенесённые старше 90 дней — удаляются, свежие — нет', async () => {
    const oldOpen = (await create()).row;
    const fresh = (await create()).row;
    const oldClaimed = (await create()).row;
    const recentClaimed = (await create()).row;
    await pool.query(`UPDATE guest_trial_sessions SET last_message_at = now() - interval '8 days' WHERE id = $1`, [oldOpen.id]);
    await pool.query(`UPDATE guest_trial_sessions SET claimed_at = now() - interval '91 days', claimed_by_hash = 'h' WHERE id = $1`, [oldClaimed.id]);
    await pool.query(`UPDATE guest_trial_sessions SET claimed_at = now() - interval '1 day', claimed_by_hash = 'h', last_message_at = now() - interval '30 days' WHERE id = $1`, [recentClaimed.id]);
    expect(await svc.purge()).toBe(2);
    const left = await pool.query('SELECT id::text AS id FROM guest_trial_sessions ORDER BY created_at');
    expect(left.rows.map((r: any) => r.id).sort()).toEqual([fresh.id, recentClaimed.id].sort());
  });

  it('статистика считает пробы, ответы, переносы и события', async () => {
    const { row } = await create();
    await svc.recordExchange(row.id, 'В', 'О', new Date(), 0.1);
    await pool.query(`INSERT INTO events (name) VALUES ('guest_trial_wall'), ('guest_trial_view'), ('guest_trial_view')`);
    const s = await svc.status();
    expect(s).toMatchObject({ trials_day: 1, answers_day: 1, claims_day: 0, guest_trial_view_day: 2, guest_trial_wall_day: 1 });
    expect(s.cost_usd_day).toBeCloseTo(0.1, 4);
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/guest-trial/guest-sessions.pg.spec.ts
git commit -q -m "test(guest-trial): строки проб и сообщений — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'PROVISIONING_PG_URL="postgres:///gt_test?host=/var/run/postgresql" npx jest --runInBand --testPathPattern=src/guest-trial/guest-sessions 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

- [ ] **Шаг 3: реализация**

```ts
// src/guest-trial/guest-sessions.service.ts
import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { GUEST_CLAIMED_ROW_TTL_DAYS, GUEST_TRIAL_TTL_DAYS, GuestHistoryMessage } from './guest-trial.types';

export interface GuestSessionRow {
  id: string;
  assistant_id: number;
  lang: string;
  answers: number;
  claimed_by_hash: string | null;
  claimed_at: Date | null;
  last_message_at: Date;
}

const ROW = `id::text AS id, assistant_id, lang, answers, claimed_by_hash, claimed_at, last_message_at`;

@Injectable()
export class GuestSessionsService {
  constructor(private readonly pg: PgService) {}

  async create(p: { tokenHash: string; assistantId: number; lang: string; source: string | null; campaign: string | null }): Promise<GuestSessionRow> {
    const r = await this.pg.query(
      `INSERT INTO guest_trial_sessions (token_hash, assistant_id, lang, source, campaign)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${ROW}`,
      [p.tokenHash, p.assistantId, p.lang, p.source, p.campaign],
    );
    return r.rows[0];
  }

  /** Проба по хешу ключа. Неперенесённая — только если последнему сообщению меньше 7 дней. */
  async findLive(tokenHash: string): Promise<GuestSessionRow | null> {
    const r = await this.pg.query(
      `SELECT ${ROW} FROM guest_trial_sessions
        WHERE token_hash = $1
          AND (claimed_at IS NOT NULL OR last_message_at > now() - make_interval(days => $2))`,
      [tokenHash, GUEST_TRIAL_TTL_DAYS],
    );
    return r.rows[0] ?? null;
  }

  async messages(sessionId: string): Promise<GuestHistoryMessage[]> {
    const r = await this.pg.query(
      `SELECT sender_type, content FROM guest_trial_messages WHERE session_id = $1::uuid ORDER BY id`,
      [sessionId],
    );
    return r.rows;
  }

  /** Пара «вопрос — ответ» и счёт пробы одним запросом. Отдаёт новое число ответов. */
  async recordExchange(sessionId: string, human: string, ai: string, humanAt: Date, costUsd: number): Promise<number> {
    const r = await this.pg.query(
      `WITH ins AS (
         INSERT INTO guest_trial_messages (session_id, sender_type, content, created_at)
         VALUES ($1::uuid, 'human', $2, $4), ($1::uuid, 'ai', $3, now())
       )
       UPDATE guest_trial_sessions
          SET answers = answers + 1, cost_usd = cost_usd + $5, last_message_at = now()
        WHERE id = $1::uuid
       RETURNING answers`,
      [sessionId, human, ai, humanAt, costUsd],
    );
    return Number(r.rows[0]?.answers ?? 0);
  }

  /** Неперенесённые — через 7 дней тишины, строки перенесённых (без текста) — через 90 дней. */
  async purge(): Promise<number> {
    const r = await this.pg.query(
      `DELETE FROM guest_trial_sessions
        WHERE (claimed_at IS NULL AND last_message_at < now() - make_interval(days => $1))
           OR (claimed_at IS NOT NULL AND claimed_at < now() - make_interval(days => $2))`,
      [GUEST_TRIAL_TTL_DAYS, GUEST_CLAIMED_ROW_TTL_DAYS],
    );
    return r.rowCount ?? 0;
  }

  /** Счётчики для админ-ручки: сутки и 7 дней. */
  async status(): Promise<Record<string, number>> {
    const s = await this.pg.query(
      `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS trials_day,
              count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS trials_week,
              coalesce(sum(answers) FILTER (WHERE created_at > now() - interval '1 day'), 0)::int AS answers_day,
              coalesce(sum(answers) FILTER (WHERE created_at > now() - interval '7 days'), 0)::int AS answers_week,
              count(*) FILTER (WHERE claimed_at > now() - interval '1 day')::int AS claims_day,
              count(*) FILTER (WHERE claimed_at > now() - interval '7 days')::int AS claims_week,
              coalesce(sum(cost_usd) FILTER (WHERE created_at > now() - interval '1 day'), 0)::float AS cost_usd_day,
              coalesce(sum(cost_usd) FILTER (WHERE created_at > now() - interval '7 days'), 0)::float AS cost_usd_week
         FROM guest_trial_sessions`,
    );
    const e = await this.pg.query(
      `SELECT name,
              count(*) FILTER (WHERE ts > now() - interval '1 day')::int AS day,
              count(*)::int AS week
         FROM events
        WHERE name IN ('guest_trial_view', 'guest_trial_wall', 'guest_trial_closed')
          AND ts > now() - interval '7 days'
        GROUP BY name`,
    );
    const out: Record<string, number> = { ...s.rows[0] };
    for (const row of e.rows) {
      out[`${row.name}_day`] = row.day;
      out[`${row.name}_week`] = row.week;
    }
    return out;
  }
}
```

- [ ] **Шаг 4: прогнать — PASS**

```bash
git add src/guest-trial/guest-sessions.service.ts
git commit -q -m "feat(guest-trial): строки проб — запись пар, уборка, статистика

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'PROVISIONING_PG_URL="postgres:///gt_test?host=/var/run/postgresql" npx jest --runInBand --testPathPattern=src/guest-trial/guest-sessions 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```
Ожидание: `PASS`, 5 тестов, без `skipped`.

### Задача A7: ход гостя

**Files:**
- Create: `src/guest-trial/guest-turn.service.ts`, `src/guest-trial/guest-turn.service.spec.ts`

- [ ] **Шаг 1: тест**

```ts
// src/guest-trial/guest-turn.service.spec.ts
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));
import { sendTelegramAlert } from '../common/telegram-alert';
import { clockRedis } from '../auth/fake-redis.forspec';
import { CHAT_MODEL } from '../common/chat-model';
import { GUEST_MODE_BLOCK } from './guest-prompt';
import { DEFAULT_GUEST_LIMITS, GuestLimits, GuestMode } from './guest-trial.types';
import { GuestTurnService, parseGuestTurnInput } from './guest-turn.service';

const AGENT = { id: 12, name: 'Роман', description: 'персональный ассистент', persona: 'Ты Роман.' };

function makeRes() {
  const chunks: string[] = [];
  const res: any = {
    statusCode: 200,
    jsonBody: undefined as any,
    ended: false,
    get writableEnded() { return this.ended; },
    status(code: number) { this.statusCode = code; return this; },
    setHeader() {},
    write(s: string) { chunks.push(s); return true; },
    json(b: any) { this.jsonBody = b; this.ended = true; return this; },
    end() { this.ended = true; },
  };
  const events = () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { res, events };
}

/** Пробы в памяти — тот же интерфейс, что у GuestSessionsService. */
function memorySessions() {
  const rows = new Map<string, any>();
  const byHash = new Map<string, string>();
  const msgs = new Map<string, any[]>();
  let n = 0;
  return {
    rows,
    create: jest.fn(async (p: any) => {
      const id = `s${++n}`;
      const row = { id, assistant_id: p.assistantId, lang: p.lang, answers: 0, claimed_by_hash: null, claimed_at: null, last_message_at: new Date() };
      rows.set(id, row);
      byHash.set(p.tokenHash, id);
      msgs.set(id, []);
      return { ...row };
    }),
    findLive: jest.fn(async (hash: string) => {
      const id = byHash.get(hash);
      return id ? { ...rows.get(id) } : null;
    }),
    messages: jest.fn(async (id: string) => [...(msgs.get(id) ?? [])]),
    recordExchange: jest.fn(async (id: string, human: string, ai: string) => {
      msgs.get(id)!.push({ sender_type: 'human', content: human }, { sender_type: 'ai', content: ai });
      const r = rows.get(id);
      r.answers += 1;
      return r.answers;
    }),
  };
}

const okReply = async (_p: string, o: any) => {
  o.onTextDelta?.('Здра');
  o.onTextDelta?.('вствуйте');
  return { text: 'Здравствуйте', costUsd: 0.05 };
};

function harness(opts: { mode?: GuestMode; limits?: Partial<GuestLimits>; reply?: (p: string, o: any) => Promise<{ text: string; costUsd: number }> } = {}) {
  const limits = { ...DEFAULT_GUEST_LIMITS, ...opts.limits };
  const store = { settings: jest.fn(async () => ({ mode: opts.mode ?? 'on', limits })) };
  const pg = { query: jest.fn(async (sql: string, params: any[]) => (/FROM agents a/.test(sql) && params[0] === 12 ? { rows: [AGENT] } : { rows: [] })) };
  const redis = clockRedis();
  const cli = { textWithCost: jest.fn(opts.reply ?? okReply) };
  const sessions = memorySessions();
  const chat = { beginStream: jest.fn(), endStream: jest.fn() };
  const events = { track: jest.fn() };
  const svc = new GuestTurnService(pg as any, redis as any, cli as any, store as any, sessions as any, chat as any, events as any);
  svc.redisTimeoutMs = 50;
  const turn = async (body: any = {}) => {
    const { res, events: evs } = makeRes();
    await svc.handle(parseGuestTurnInput({ assistantId: '12', message: 'Привет', lang: 'ru', ...body }), res);
    return { res, evs: evs() };
  };
  return { svc, turn, cli, sessions, chat, events, redis, store };
}

beforeEach(() => (sendTelegramAlert as jest.Mock).mockClear());

describe('ход гостя: режимы', () => {
  it('«выкл» — стена closed, модель не зовётся', async () => {
    const h = harness({ mode: 'off' });
    const { evs } = await h.turn();
    expect(evs.map((e) => e.type)).toEqual(['guest', 'wall']);
    expect(evs[1]).toEqual({ type: 'wall', reason: 'closed' });
    expect(h.cli.textWithCost).not.toHaveBeenCalled();
  });

  it('«предпросмотр» — только с preview', async () => {
    const h = harness({ mode: 'preview' });
    expect((await h.turn()).evs[1]).toEqual({ type: 'wall', reason: 'closed' });
    expect((await h.turn({ preview: true })).evs.find((e) => e.type === 'end')).toEqual({ type: 'end', content: 'Здравствуйте' });
  });
});

describe('ход гостя: поток', () => {
  it('новая проба: ключ, остаток, куски, итог — и запись пары', async () => {
    const h = harness();
    const { evs } = await h.turn();
    expect(evs[0].type).toBe('guest');
    expect(evs[0].token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(evs[0].left).toBe(3);
    expect(evs.slice(1).map((e) => e.type)).toEqual(['begin', 'item', 'item', 'end']);
    expect(h.sessions.recordExchange).toHaveBeenCalledWith('s1', 'Привет', 'Здравствуйте', expect.any(Date), 0.05);
    expect(h.events.track).toHaveBeenCalledWith('guest_trial_answer', expect.objectContaining({
      props: expect.objectContaining({ n: 1, trial: 's1', assistant_id: '12', lang: 'ru', cost_usd: 0.05 }),
    }));
  });

  it('модель зовётся без инструментов, без запасного Qwen, с персоной и пробным режимом', async () => {
    const h = harness();
    await h.turn();
    const [prompt, o] = h.cli.textWithCost.mock.calls[0];
    expect(prompt).toBe('USER: Привет');
    expect(o).toMatchObject({ model: CHAT_MODEL, noFallback: true });
    expect(o.tools).toBeUndefined();
    expect(o.mcpServers).toBeUndefined();
    expect(o.allowedTools).toBeUndefined();
    expect(o.system).toContain('Ты Роман.');
    expect(o.system).toContain(GUEST_MODE_BLOCK);
  });

  it('третий ответ — стена limit после итога; четвёртый — стена без модели', async () => {
    const h = harness();
    const first = await h.turn();
    const token = first.evs[0].token;
    await h.turn({ token });
    const third = await h.turn({ token });
    expect(third.evs.slice(-2)).toEqual([{ type: 'end', content: 'Здравствуйте' }, { type: 'wall', reason: 'limit' }]);
    const calls = h.cli.textWithCost.mock.calls.length;
    const fourth = await h.turn({ token });
    expect(fourth.evs).toEqual([{ type: 'guest', left: 0 }, { type: 'wall', reason: 'limit' }]);
    expect(h.cli.textWithCost.mock.calls.length).toBe(calls);
  });

  it('второй ход видит первую пару в промпте', async () => {
    const h = harness();
    const token = (await h.turn()).evs[0].token;
    await h.turn({ token, message: 'А ещё?' });
    expect(h.cli.textWithCost.mock.calls[1][0]).toBe('USER: Привет\n\nASSISTANT: Здравствуйте\n\nUSER: А ещё?');
  });
});

describe('ход гостя: отказы', () => {
  it('незнакомый ассистент и слишком длинное сообщение — 400', async () => {
    const h = harness({ limits: { maxChars: 10 } });
    expect((await h.turn({ assistantId: '999' })).res.statusCode).toBe(400);
    expect((await h.turn({ message: 'x'.repeat(11) })).res.statusCode).toBe(400);
    expect(h.cli.textWithCost).not.toHaveBeenCalled();
  });

  it('чужой ключ — 404, ключ другого ассистента — 409', async () => {
    const h = harness();
    expect((await h.turn({ token: 'x'.repeat(43) })).res.statusCode).toBe(404);
    const token = (await h.turn()).evs[0].token;
    h.sessions.rows.get('s1').assistant_id = 14;
    expect((await h.turn({ token })).res.statusCode).toBe(409);
  });

  it('сбой модели и отказ CLI текстом — error, пара не пишется', async () => {
    const failing = harness({ reply: async () => { throw new Error('claude CLI exited with code 1'); } });
    expect((await failing.turn()).evs.slice(-1)).toEqual([{ type: 'error', code: 'model' }]);
    expect(failing.sessions.recordExchange).not.toHaveBeenCalled();

    const refusal = harness({ reply: async () => ({ text: "You've hit your weekly limit · resets 10am (UTC)", costUsd: 0 }) });
    expect((await refusal.turn()).evs.slice(-1)).toEqual([{ type: 'error', code: 'model' }]);
    expect(refusal.sessions.recordExchange).not.toHaveBeenCalled();
  });

  it('общий потолок ответов — closed и одно сообщение владельцу за окно', async () => {
    const h = harness({ limits: { answersPerHour: 1 } });
    await h.turn();
    const second = await h.turn();
    expect(second.evs.slice(-1)).toEqual([{ type: 'wall', reason: 'closed' }]);
    await h.turn();
    await new Promise((r) => setImmediate(r));
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(h.events.track).toHaveBeenCalledWith('guest_trial_closed', { props: { scope: 'answers_hour' } });
  });

  it('Redis висит — closed за срок, модель не зовётся', async () => {
    const h = harness();
    (h.redis as any).eval = () => new Promise(() => {});
    const { evs } = await h.turn();
    expect(evs.slice(-1)).toEqual([{ type: 'wall', reason: 'closed' }]);
    expect(h.cli.textWithCost).not.toHaveBeenCalled();
  });

  it('потолок одновременных ходов — error busy; счётчики возвращаются', async () => {
    let release: () => void = () => {};
    let calls = 0;
    const h = harness({
      limits: { concurrentTurns: 1 },
      // Первый ход висит, пока его не отпустят; следующие отвечают сразу.
      reply: () => (++calls === 1
        ? new Promise((resolve) => { release = () => resolve({ text: 'Готово', costUsd: 0 }); })
        : Promise.resolve({ text: 'Потом', costUsd: 0 })),
    });
    const first = h.turn();
    await new Promise((r) => setTimeout(r, 20));
    const second = await h.turn();
    expect(second.evs.slice(-1)).toEqual([{ type: 'error', code: 'busy' }]);
    release();
    await first;
    expect(h.chat.beginStream).toHaveBeenCalledTimes(1);
    expect(h.chat.endStream).toHaveBeenCalledTimes(1);
    expect((await h.turn()).evs.find((e) => e.type === 'end')).toBeTruthy();
  });

  it('второй ход той же пробы, пока идёт первый, — 409', async () => {
    let release: () => void = () => {};
    let calls = 0;
    const h = harness({
      reply: () => (++calls === 1
        ? Promise.resolve({ text: 'Первый', costUsd: 0 })
        : new Promise((resolve) => { release = () => resolve({ text: 'Второй', costUsd: 0 }); })),
    });
    const token = (await h.turn()).evs[0].token;
    const pending = h.turn({ token });
    await new Promise((r) => setTimeout(r, 20));
    expect((await h.turn({ token })).res.statusCode).toBe(409);
    release();
    await pending;
  });
});

describe('разбор тела хода', () => {
  it('источник — только из известных видов, sid — только безопасные знаки', () => {
    const i = parseGuestTurnInput({ assistantId: '12', message: 'x', lang: 'de-DE', source: 'utm:vk/cpc', sid: 's_ab.c-1', preview: true });
    expect(i).toMatchObject({ lang: 'de', source: 'utm:vk/cpc', sid: 's_ab.c-1', preview: true, token: null });
    const j = parseGuestTurnInput({ source: '<script>', sid: 'a b', preview: 'true' });
    expect(j).toMatchObject({ source: null, sid: null, preview: false });
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/guest-trial/guest-turn.service.spec.ts
git commit -q -m "test(guest-trial): ход гостя — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern=src/guest-trial/guest-turn 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

- [ ] **Шаг 3: реализация**

```ts
// src/guest-trial/guest-turn.service.ts
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Response } from 'express';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import { LanguageService } from '../common/services/language.service';
import { looksLikeCliRefusal } from '../common/llm-error';
import { CHAT_MODEL } from '../common/chat-model';
import { sendTelegramAlert } from '../common/telegram-alert';
import { firstInWindow, humanLeft, opensAtMsk } from '../auth/limit-alert';
import { AgentsService } from '../agents/agents.service';
import { ChatService } from '../chat/chat.service';
import { EventsService } from '../events/events.service';
import { GuestTrialStore } from './guest-trial-store.service';
import { GuestSessionRow, GuestSessionsService } from './guest-sessions.service';
import { GuestQuotaReply, answerRules, takeGuestQuota, trialRules } from './guest-limits';
import { buildGuestPrompt, buildGuestSystemPrompt } from './guest-prompt';
import { hashGuestToken, isGuestTokenShape, newGuestToken } from './guest-token';
import { GUEST_REDIS_TIMEOUT_MS, GUEST_TURN_TIMEOUT_MS } from './guest-trial.types';
import { withTimeout } from './with-timeout';

export interface GuestTurnInput {
  token: string | null;
  assistantId: string;
  message: string;
  lang: string;
  tz?: string;
  source: string | null;
  campaign: string | null;
  /** linkeon_session_id вкладки — склеить события сервера с событиями фронта. */
  sid: string | null;
  preview: boolean;
}

/** Те же виды меток, что принимает EventsService.setSignupSourceIfEmpty. */
const SOURCE_RE = /^(utm:|referral:|ref-site:|direct$|organic$)/;

export function parseGuestTurnInput(body: any): GuestTurnInput {
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const source = str(body?.source, 120);
  const sid = str(body?.sid, 64);
  return {
    token: str(body?.token, 64) || null,
    assistantId: str(body?.assistantId, 16).trim(),
    message: typeof body?.message === 'string' ? body.message : '',
    lang: LanguageService.normalize(str(body?.lang, 16)),
    tz: str(body?.tz, 64) || undefined,
    source: SOURCE_RE.test(source) ? source : null,
    campaign: str(body?.campaign, 120) || null,
    sid: /^[\w.-]+$/.test(sid) ? sid : null,
    preview: body?.preview === true,
  };
}

interface GuestAgent {
  id: number;
  name: string;
  description: string;
  persona: string;
}

const SCOPE_TEXT: Record<string, string> = {
  trials_hour: 'новых проб в час',
  trials_day: 'новых проб в сутки',
  answers_hour: 'гостевых ответов в час',
  answers_day: 'гостевых ответов в сутки',
};

/** О лежащем Redis — не чаще раза в 10 минут: отметку «уже сообщили» без него не поставить. */
const REDIS_ALERT_EVERY_MS = 10 * 60_000;
const PING_MS = 20_000;

@Injectable()
export class GuestTurnService {
  private readonly log = new Logger('GuestTurn');
  /** Ходов в полёте и проб с ходом в полёте — в памяти: процесс API один, как и счётчик ходов ChatService. */
  private inFlight = 0;
  private readonly busy = new Set<string>();
  private lastRedisAlertAt = 0;
  /** Публичное ради тестов: в них Redis «висит» 50 мс, а не 2 с. */
  redisTimeoutMs = GUEST_REDIS_TIMEOUT_MS;

  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly claudeCli: ClaudeCliService,
    private readonly store: GuestTrialStore,
    private readonly sessions: GuestSessionsService,
    @Optional() private readonly chat?: ChatService,
    @Optional() private readonly events?: EventsService,
  ) {}

  async handle(input: GuestTurnInput, res: Response): Promise<void> {
    const { mode, limits } = await this.store.settings();
    if (mode === 'off' || (mode === 'preview' && !input.preview)) {
      this.closedStream(res, null);
      return;
    }

    const agent = await this.loadAgent(input.assistantId, input.lang);
    if (!agent) {
      res.status(400).json({ error: 'assistant' });
      return;
    }
    const message = input.message.trim();
    if (!message || message.length > limits.maxChars) {
      res.status(400).json({ error: 'message' });
      return;
    }

    let session: GuestSessionRow;
    let issued: string | null = null;
    if (input.token) {
      const found = isGuestTokenShape(input.token) ? await this.sessions.findLive(hashGuestToken(input.token)) : null;
      if (!found) {
        res.status(404).json({ error: 'trial' });
        return;
      }
      if (found.assistant_id !== agent.id) {
        res.status(409).json({ error: 'assistant_mismatch' });
        return;
      }
      session = found;
    } else {
      const q = await takeGuestQuota(this.redis, trialRules(limits), this.redisTimeoutMs);
      if (!q.counted) {
        this.closedStream(res, q);
        return;
      }
      issued = newGuestToken();
      session = await this.sessions.create({
        tokenHash: hashGuestToken(issued),
        assistantId: agent.id,
        lang: input.lang,
        source: input.source,
        campaign: input.campaign,
      });
    }

    const left = Math.max(0, limits.answersPerTrial - session.answers);
    const guestEvent = { type: 'guest', ...(issued ? { token: issued } : {}), left };
    if (session.claimed_at || left === 0) {
      this.startStream(res);
      this.write(res, { ...guestEvent, left: 0 });
      this.write(res, { type: 'wall', reason: 'limit' });
      this.end(res);
      return;
    }
    if (this.busy.has(session.id)) {
      res.status(409).json({ error: 'busy_trial' });
      return;
    }

    this.busy.add(session.id);
    try {
      const q = await takeGuestQuota(this.redis, answerRules(limits), this.redisTimeoutMs);
      if (!q.counted) {
        this.closedStream(res, q, issued);
        return;
      }
      // Проверка и счёт — синхронно, без await между ними: потолок не проскочить вдвоём.
      if (this.inFlight >= limits.concurrentTurns) {
        this.startStream(res);
        this.write(res, guestEvent);
        this.write(res, { type: 'error', code: 'busy' });
        this.end(res);
        return;
      }
      this.inFlight++;
      this.chat?.beginStream();
      try {
        await this.runTurn(input, res, session, agent, message, guestEvent, limits.answersPerTrial);
      } finally {
        this.inFlight--;
        this.chat?.endStream();
      }
    } finally {
      this.busy.delete(session.id);
    }
  }

  private async runTurn(
    input: GuestTurnInput,
    res: Response,
    session: GuestSessionRow,
    agent: GuestAgent,
    message: string,
    guestEvent: object,
    answersPerTrial: number,
  ): Promise<void> {
    const humanAt = new Date();
    this.startStream(res);
    this.write(res, guestEvent);
    this.write(res, { type: 'begin' });
    const ping = setInterval(() => this.write(res, { type: 'ping' }), PING_MS);
    try {
      const history = session.answers > 0 ? await this.sessions.messages(session.id) : [];
      const system = buildGuestSystemPrompt({
        name: agent.name,
        description: agent.description,
        persona: agent.persona,
        lang: input.lang,
        tz: input.tz,
      });
      let text = '';
      let costUsd = 0;
      try {
        const r = await this.claudeCli.textWithCost(buildGuestPrompt(history, message), {
          system,
          model: CHAT_MODEL,
          // Запасной Qwen гостям не положен: его квота — для платящих.
          noFallback: true,
          timeoutMs: GUEST_TURN_TIMEOUT_MS,
          onTextDelta: (t) => this.write(res, { type: 'item', content: t }),
        });
        text = (r.text || '').trim();
        costUsd = r.costUsd || 0;
      } catch (e: any) {
        this.log.warn(`guest turn failed (assistant ${agent.id}): ${String(e?.message ?? e).slice(0, 200)}`);
      }
      // Отказ CLI («лимит», «не вошёл») приходит обычным текстом — это не ответ ассистента.
      if (!text || looksLikeCliRefusal(text)) {
        this.write(res, { type: 'error', code: 'model' });
        return;
      }
      const answers = await this.sessions.recordExchange(session.id, message, text, humanAt, costUsd);
      this.write(res, { type: 'end', content: text });
      this.events?.track('guest_trial_answer', {
        sessionId: input.sid,
        source: input.source,
        props: { n: answers, trial: session.id, assistant_id: String(agent.id), lang: input.lang, cost_usd: Number(costUsd.toFixed(4)) },
      });
      if (answers >= answersPerTrial) this.write(res, { type: 'wall', reason: 'limit' });
    } finally {
      clearInterval(ping);
      this.end(res);
    }
  }

  /** Ассистент для пробы: тот же набор, что видит экран выбора (AgentsService.getAgents). */
  private async loadAgent(id: string, lang: string): Promise<GuestAgent | null> {
    if (!/^\d{1,6}$/.test(id)) return null;
    const r = await this.pg.query(
      `SELECT a.id,
              COALESCE(NULLIF(t.display_name, ''), NULLIF(a.display_name, ''), a.name) AS name,
              COALESCE(NULLIF(t.description, ''), a.description, '')                  AS description,
              COALESCE(a.system_prompt, '')                                            AS persona
         FROM agents a
         LEFT JOIN agent_translations t
                ON t.entity_type = 'agent' AND t.entity_id = a.id::text AND t.locale = $2
        WHERE a.id = $1 AND a.is_active AND a.name <> ALL($3::text[])`,
      [Number(id), lang, AgentsService.SERVICE_AGENTS],
    );
    const row = r.rows[0];
    return row ? { id: Number(row.id), name: row.name, description: row.description, persona: row.persona } : null;
  }

  private startStream(res: Response): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
  }

  /** Строка потока. Клиент ушёл — ход доводим: ответ ляжет в пробу и вернётся после перезагрузки. */
  private write(res: Response, ev: object): void {
    if (res.writableEnded || (res as any).destroyed) return;
    try { res.write(JSON.stringify(ev) + '\n'); } catch { /* клиент ушёл */ }
  }

  private end(res: Response): void {
    if (res.writableEnded) return;
    try { res.end(); } catch { /* клиент ушёл */ }
  }

  private closedStream(res: Response, q: GuestQuotaReply | null, token: string | null = null): void {
    if (q) void this.reportClosed(q);
    this.startStream(res);
    this.write(res, { type: 'guest', ...(token ? { token } : {}), left: 0 });
    this.write(res, { type: 'wall', reason: 'closed' });
    this.end(res);
  }

  /** Событие на каждое закрытие; владельцу — раз за окно (как у лимитов SMS). */
  private async reportClosed(q: GuestQuotaReply): Promise<void> {
    if (q.redisDown) {
      this.events?.track('guest_trial_closed', { props: { scope: 'redis' } });
      if (Date.now() - this.lastRedisAlertAt < REDIS_ALERT_EVERY_MS) return;
      this.lastRedisAlertAt = Date.now();
      this.log.error('guest trial closed: Redis не ответил');
      await sendTelegramAlert(
        `<b>Linkeon: проба без входа закрыта</b>\n` +
          `Redis не ответил за ${Math.round(this.redisTimeoutMs / 1000)} с. Пока он не оживёт, новым посетителям сразу показывается вход.`,
      ).catch(() => undefined);
      return;
    }
    for (const hit of q.full) {
      this.events?.track('guest_trial_closed', { props: { scope: hit.scope } });
      let first = false;
      try {
        first = await withTimeout(firstInWindow(this.redis, `guest-lim:alerted:${hit.scope}`, hit.leftMs), this.redisTimeoutMs);
      } catch {
        continue;
      }
      if (!first) continue;
      this.log.error(`guest trial closed: ${hit.scope} (${hit.max})`);
      await sendTelegramAlert(
        `<b>Linkeon: проба без входа закрыта</b>\n` +
          `Потолок: <b>${hit.max} ${SCOPE_TEXT[hit.scope] ?? hit.scope}</b>\n` +
          `Откроется через ${humanLeft(hit.leftMs)}, в ${opensAtMsk(hit.leftMs)}.\n` +
          `Пока закрыто, новым посетителям сразу показывается вход. Поднять потолок — POST /webhook/admin/guest-trial {"action":"set"}.`,
      ).catch(() => undefined);
    }
  }
}
```

Сверено по origin/main 30.10: `sendTelegramAlert(text, extra = {})` — второй аргумент необязателен; `looksLikeCliRefusal` (`src/common/llm-error.ts`, `CLI_REFUSAL_RE`) ловит `You've hit your weekly limit`.

- [ ] **Шаг 4: прогнать — PASS**

```bash
git add src/guest-trial/guest-turn.service.ts
git commit -q -m "feat(guest-trial): ход гостя — лимиты, поток, запись пары

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern=src/guest-trial/guest-turn 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✕"'
```
Ожидание: `PASS`, все кейсы.

### Задача A8: приписка о пробе и перенос в аккаунт

**Files:**
- Create: `src/guest-trial/guest-carry.ts`, `src/guest-trial/guest-carry.spec.ts`
- Create: `src/guest-trial/guest-claim.service.ts`, `src/guest-trial/guest-claim.pg.spec.ts`

- [ ] **Шаг 1: тесты**

```ts
// src/guest-trial/guest-carry.spec.ts
import { clockRedis } from '../auth/fake-redis.forspec';
import { GUEST_CARRY_MAX_CHARS, guestCarryKey, putGuestCarry, renderGuestCarry, takeGuestCarry } from './guest-carry';

describe('приписка о пробе', () => {
  it('кладётся на 7 дней и забирается один раз', async () => {
    const r = clockRedis();
    await putGuestCarry(r, 'u1', '12', 'текст');
    expect(await r.ttl(guestCarryKey('u1', '12'))).toBe(7 * 24 * 3600);
    expect(await takeGuestCarry(r, 'u1', '12')).toBe('текст');
    expect(await takeGuestCarry(r, 'u1', '12')).toBeNull();
  });

  it('пересказ: кто что сказал, без повторного приветствия', () => {
    const t = renderGuestCarry([
      { sender_type: 'human', content: 'Как поднять цены?' },
      { sender_type: 'ai', content: 'Начнём с сегментов.' },
    ]);
    expect(t).toContain('Человек: Как поднять цены?');
    expect(t).toContain('Ты: Начнём с сегментов.');
    expect(t).toContain('не здоровайся заново');
  });

  it('длинный разговор — хвост, а не начало', () => {
    const long = 'а'.repeat(GUEST_CARRY_MAX_CHARS);
    const t = renderGuestCarry([
      { sender_type: 'human', content: 'НАЧАЛО' },
      { sender_type: 'ai', content: long },
      { sender_type: 'human', content: 'КОНЕЦ' },
    ]);
    expect(t).not.toContain('НАЧАЛО');
    expect(t).toContain('КОНЕЦ');
  });
});
```

```ts
// src/guest-trial/guest-claim.pg.spec.ts
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { clockRedis } from '../auth/fake-redis.forspec';
import { GUEST_TRIAL_MIGRATIONS } from './guest-trial-store.service';
import { GuestSessionsService } from './guest-sessions.service';
import { GuestClaimService } from './guest-claim.service';
import { guestCarryKey } from './guest-carry';
import { hashGuestToken, newGuestToken } from './guest-token';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('перенос пробы в аккаунт против живого Postgres', () => {
  let pool: Pool;
  let sessions: GuestSessionsService;
  let redis: ReturnType<typeof clockRedis>;
  let neo4j: { consolidateFromChat: jest.Mock };
  let events: { track: jest.Mock };
  let svc: GuestClaimService;
  const pgShim = () => ({
    query: (s: string, p?: any[]) => pool.query(s, p),
    getClient: () => pool.connect(),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    for (const f of GUEST_TRIAL_MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    // Схема custom_chat_history — как на проде (\d custom_chat_history, 30.10.2026).
    await pool.query(`CREATE TABLE IF NOT EXISTS custom_chat_history (
      id serial PRIMARY KEY,
      session_id text NOT NULL,
      sender_type varchar(10) NOT NULL CHECK (sender_type IN ('ai', 'human')),
      agent integer,
      content text NOT NULL,
      created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
      message_type varchar(20) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image')),
      tokens_used integer DEFAULT 0)`);
    sessions = new GuestSessionsService(pgShim() as any);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE guest_trial_sessions CASCADE; TRUNCATE custom_chat_history');
    redis = clockRedis();
    neo4j = { consolidateFromChat: jest.fn(async () => {}) };
    events = { track: jest.fn() };
    svc = new GuestClaimService(pgShim() as any, redis as any, neo4j as any, events as any);
  });
  afterAll(async () => { await pool.end(); });

  async function trial(assistantId: number, pairs: number) {
    const token = newGuestToken();
    const row = await sessions.create({ tokenHash: hashGuestToken(token), assistantId, lang: 'ru', source: null, campaign: null });
    for (let i = 1; i <= pairs; i++) await sessions.recordExchange(row.id, `Вопрос ${i}`, `Ответ ${i}`, new Date(Date.now() - (10 - i) * 1000), 0.01);
    return { token, row };
  }
  const history = (sid: string) =>
    pool.query('SELECT sender_type, content, agent FROM custom_chat_history WHERE session_id = $1 ORDER BY created_at, id', [sid]).then((r) => r.rows);

  it('новый аккаунт: пары в истории по порядку, гостевые сообщения стёрты, приписки нет', async () => {
    const { token, row } = await trial(12, 2);
    const r = await svc.claim('u-new', token);
    expect(r).toEqual({ status: 200, body: { assistantId: '12', moved: 4 } });
    expect(await history('u-new_12')).toEqual([
      { sender_type: 'human', content: 'Вопрос 1', agent: 12 },
      { sender_type: 'ai', content: 'Ответ 1', agent: 12 },
      { sender_type: 'human', content: 'Вопрос 2', agent: 12 },
      { sender_type: 'ai', content: 'Ответ 2', agent: 12 },
    ]);
    expect(await sessions.messages(row.id)).toEqual([]);
    expect(redis.peek(guestCarryKey('u-new', '12'))).toBeNull();
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(neo4j.consolidateFromChat).toHaveBeenCalledWith('u-new', '12', 'Вопрос 1', 'Ответ 1');
    expect(events.track).toHaveBeenCalledWith('guest_trial_claimed', { userId: 'u-new', props: { assistant_id: '12', answers: 2, existing: false } });
  });

  it('повтор тем же — moved 0, другим — 409', async () => {
    const { token } = await trial(12, 1);
    await svc.claim('u1', token);
    expect(await svc.claim('u1', token)).toEqual({ status: 200, body: { assistantId: '12', moved: 0 } });
    expect((await svc.claim('u2', token)).status).toBe(409);
    expect(await history('u1_12')).toHaveLength(2);
  });

  it('одновременные переносы тем же — история не двоится', async () => {
    const { token } = await trial(12, 2);
    await Promise.all([svc.claim('u1', token), svc.claim('u1', token), svc.claim('u1', token)]);
    expect(await history('u1_12')).toHaveLength(4);
  });

  it('просроченная, пустая и незнакомая — 404', async () => {
    const old = await trial(12, 1);
    await pool.query(`UPDATE guest_trial_sessions SET last_message_at = now() - interval '8 days' WHERE id = $1`, [old.row.id]);
    expect((await svc.claim('u1', old.token)).status).toBe(404);
    const empty = await trial(12, 0);
    expect((await svc.claim('u1', empty.token)).status).toBe(404);
    expect((await svc.claim('u1', newGuestToken())).status).toBe(404);
    expect((await svc.claim('u1', 'короткий')).status).toBe(404);
  });

  it('аккаунт с прошлым разговором у ассистента — приписка для релея; у Маши — нет', async () => {
    await pool.query(`INSERT INTO custom_chat_history (session_id, sender_type, agent, content) VALUES ('u-old_12', 'human', 12, 'давнее'), ('u-old_3', 'human', 3, 'давнее')`);
    const roman = await trial(12, 1);
    expect((await svc.claim('u-old', roman.token)).status).toBe(200);
    expect(redis.peek(guestCarryKey('u-old', '12'))).toContain('Человек: Вопрос 1');
    const masha = await trial(3, 1);
    expect((await svc.claim('u-old', masha.token)).status).toBe(200);
    expect(redis.peek(guestCarryKey('u-old', '3'))).toBeNull();
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/guest-trial/guest-carry.spec.ts src/guest-trial/guest-claim.pg.spec.ts
git commit -q -m "test(guest-trial): приписка и перенос в аккаунт — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'PROVISIONING_PG_URL="postgres:///gt_test?host=/var/run/postgresql" npx jest --runInBand --testPathPattern="src/guest-trial/(guest-carry|guest-claim)" 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

- [ ] **Шаг 3: реализация**

```ts
// src/guest-trial/guest-carry.ts
import { GUEST_TRIAL_TTL_DAYS, GuestHistoryMessage } from './guest-trial.types';

/** Сколько пересказа пробы помещается в приписку: хвост разговора важнее начала. */
export const GUEST_CARRY_MAX_CHARS = 6000;

/** Те методы RedisService, что нужны приписке. */
export interface CarryStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

export const guestCarryKey = (userId: string, assistantId: string): string => `guest-carry:${userId}:${assistantId}`;

/**
 * Пересказ пробы для хода через релей. Нужен только аккаунту, у которого с этим
 * ассистентом уже была сессия на релее: она возобновится (--resume) без пробы.
 * Новому аккаунту хватает хвоста истории, который релей вставляет сам.
 */
export function renderGuestCarry(msgs: GuestHistoryMessage[]): string {
  const lines = msgs.map((m) => `${m.sender_type === 'human' ? 'Человек' : 'Ты'}: ${m.content}`).join('\n\n');
  const body = lines.length > GUEST_CARRY_MAX_CHARS ? `…${lines.slice(-GUEST_CARRY_MAX_CHARS)}` : lines;
  return (
    `--- Разговор до входа ---\n` +
    `До входа в аккаунт человек говорил с тобой в пробном режиме. Это начало вашего разговора — продолжай его, не здоровайся заново:\n\n` +
    body
  );
}

export async function putGuestCarry(store: CarryStore, userId: string, assistantId: string, text: string): Promise<void> {
  await store.set(guestCarryKey(userId, assistantId), text, GUEST_TRIAL_TTL_DAYS * 24 * 60 * 60);
}

/** Забрать приписку: один раз — следующий ход её уже не получит. */
export async function takeGuestCarry(store: CarryStore, userId: string, assistantId: string): Promise<string | null> {
  const key = guestCarryKey(userId, assistantId);
  const value = await store.get(key);
  if (value) await store.del(key);
  return value || null;
}
```

```ts
// src/guest-trial/guest-claim.service.ts
import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { EventsService } from '../events/events.service';
import { putGuestCarry, renderGuestCarry } from './guest-carry';
import { hashClaimer, hashGuestToken, isGuestTokenShape } from './guest-token';
import { GUEST_REDIS_TIMEOUT_MS, GUEST_TRIAL_TTL_DAYS, GuestHistoryMessage, MASHA_AGENT_ID } from './guest-trial.types';
import { withTimeout } from './with-timeout';

export interface ClaimResult {
  status: number;
  body: Record<string, unknown>;
}

const TTL_MS = GUEST_TRIAL_TTL_DAYS * 24 * 60 * 60 * 1000;

@Injectable()
export class GuestClaimService {
  private readonly log = new Logger('GuestClaim');

  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    @Optional() private readonly neo4j?: Neo4jService,
    @Optional() private readonly events?: EventsService,
  ) {}

  /**
   * Перенести пробу в аккаунт userId. Одна транзакция с FOR UPDATE: одновременные
   * переносы той же пробы не задвоят историю. Повтор тем же человеком безвреден.
   */
  async claim(userId: string, token: string): Promise<ClaimResult> {
    if (!userId || !isGuestTokenShape(token)) return { status: 404, body: { error: 'trial' } };
    const claimer = hashClaimer(userId);
    const client = await this.pg.getClient();
    let assistantId = 0;
    let answers = 0;
    let moved: GuestHistoryMessage[] = [];
    let hadHistory = false;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT id::text AS id, assistant_id, answers, claimed_by_hash, last_message_at
           FROM guest_trial_sessions WHERE token_hash = $1 FOR UPDATE`,
        [hashGuestToken(token)],
      );
      const row = r.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { status: 404, body: { error: 'trial' } };
      }
      if (row.claimed_by_hash) {
        await client.query('ROLLBACK');
        return row.claimed_by_hash === claimer
          ? { status: 200, body: { assistantId: String(row.assistant_id), moved: 0 } }
          : { status: 409, body: { error: 'claimed' } };
      }
      if (row.answers < 1 || Date.now() - new Date(row.last_message_at).getTime() > TTL_MS) {
        await client.query('ROLLBACK');
        return { status: 404, body: { error: 'trial' } };
      }
      assistantId = Number(row.assistant_id);
      answers = Number(row.answers);
      const sessionKey = `${userId}_${assistantId}`;
      const h = await client.query(`SELECT 1 FROM custom_chat_history WHERE session_id = $1 LIMIT 1`, [sessionKey]);
      hadHistory = h.rows.length > 0;
      const m = await client.query(
        `SELECT sender_type, content FROM guest_trial_messages WHERE session_id = $1::uuid ORDER BY id`,
        [row.id],
      );
      moved = m.rows;
      // Исходное время сообщений: в ленте проба встанет туда, где она была.
      await client.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used, created_at)
         SELECT $1, sender_type, $2, content, 'text', 0, created_at
           FROM guest_trial_messages WHERE session_id = $3::uuid ORDER BY id`,
        [sessionKey, assistantId, row.id],
      );
      await client.query(`UPDATE guest_trial_sessions SET claimed_by_hash = $2, claimed_at = now() WHERE id = $1::uuid`, [row.id, claimer]);
      await client.query(`DELETE FROM guest_trial_messages WHERE session_id = $1::uuid`, [row.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    await this.afterClaim(userId, assistantId, moved, hadHistory, answers);
    return { status: 200, body: { assistantId: String(assistantId), moved: moved.length } };
  }

  private async afterClaim(userId: string, assistantId: number, moved: GuestHistoryMessage[], hadHistory: boolean, answers: number): Promise<void> {
    if (hadHistory && assistantId !== MASHA_AGENT_ID && moved.length > 0) {
      try {
        await withTimeout(putGuestCarry(this.redis, userId, String(assistantId), renderGuestCarry(moved)), GUEST_REDIS_TIMEOUT_MS);
      } catch (e: any) {
        this.log.warn(`guest carry not stored (assistant ${assistantId}): ${e?.message}`);
      }
    }
    this.events?.track('guest_trial_claimed', { userId, props: { assistant_id: String(assistantId), answers, existing: hadHistory } });
    const neo4j = this.neo4j;
    if (!neo4j) return;
    // Профиль — тем же разбором, что после обычных ходов; сбоку, ответ ручки не ждёт.
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i + 1 < moved.length; i++) {
      if (moved[i].sender_type === 'human' && moved[i + 1].sender_type === 'ai') pairs.push([moved[i].content, moved[i + 1].content]);
    }
    setImmediate(async () => {
      for (const [q, a] of pairs) {
        try {
          await neo4j.consolidateFromChat(userId, String(assistantId), q, a);
        } catch (e: any) {
          this.log.warn(`guest claim consolidate failed: ${e?.message}`);
        }
      }
    });
  }
}
```

- [ ] **Шаг 4: прогнать — PASS**

```bash
git add src/guest-trial/guest-carry.ts src/guest-trial/guest-claim.service.ts
git commit -q -m "feat(guest-trial): перенос пробы в аккаунт и приписка для релея

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'PROVISIONING_PG_URL="postgres:///gt_test?host=/var/run/postgresql" npx jest --runInBand --testPathPattern="src/guest-trial/(guest-carry|guest-claim)" 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

### Задача A9: приписка в ходе через релей

**Files:**
- Modify: `src/chat/chat.service.ts` (импорты; конструктор; `streamUniversalAgent` после блока `balanceBlock`)
- Create: `src/chat/chat.service.guest-carry.spec.ts`

- [ ] **Шаг 1: тест** — по образцу `chat.service.llm-provider.spec.ts` (настоящий `streamUniversalAgent`, замоканные axios/pg/res):

```ts
// src/chat/chat.service.guest-carry.spec.ts
import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { clockRedis } from '../auth/fake-redis.forspec';
import { guestCarryKey } from '../guest-trial/guest-carry';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

/**
 * Проба без входа (spec 2026-10-30-guest-trial): аккаунту с прошлой сессией у
 * ассистента пересказ пробы уходит ОДИН раз — в тело реплики к релею.
 */

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

function fieldsOf(fd: any): Record<string, string> {
  const boundary = fd.getBoundary();
  const raw = fd.getBuffer().toString('utf8');
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part);
    const head = part.indexOf('\r\n\r\n');
    if (!name || head < 0) continue;
    out[name[1]] = part.slice(head + 4).replace(/\r\n$/, '');
  }
  return out;
}

const OLD_SECRET = process.env.JWT_SECRET;
const realSetTimeout = global.setTimeout;
beforeAll(() => {
  process.env.JWT_SECRET = 'guest-carry-spec';
  (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
    const t: any = (realSetTimeout as any)(fn, ms, ...a);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
});
afterAll(() => {
  (global as any).setTimeout = realSetTimeout;
  if (OLD_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_SECRET;
});
beforeEach(() => jest.clearAllMocks());

function harness(withRedis = true) {
  const pg = { query: jest.fn(async (sql: string) => (/AS spent/.test(sql) ? { rows: [{ spent: 0 }] } : { rows: [] })) };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const ev = { track: jest.fn() };
  const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined, undefined, ev as any, undefined);
  const redis = clockRedis();
  // Позиционная сборка до последнего параметра не доходит — подставляем полем.
  if (withRedis) (svc as any).redis = redis;
  const post = axios.post as jest.Mock;
  post.mockImplementation(async () => ({ data: sseStream([{ type: 'delta', text: 'ок' }, { type: 'done' }]) }));
  (axios.get as jest.Mock).mockImplementation(async () => ({ data: [] }));
  const run = async (message: string, fresh = false) => {
    post.mockClear();
    const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
    await (svc as any).streamUniversalAgent(
      'u-test', message, '12', '12', [], '', res, 'Роман', '', '', undefined, fresh,
      fresh ? 'u-test_12_fresh_1' : undefined,
    );
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    return fieldsOf(post.mock.calls[0][1]).message;
  };
  return { run, redis };
}

describe('streamUniversalAgent: приписка о пробе', () => {
  it('уходит в реплику один раз и стирается', async () => {
    const h = harness();
    await h.redis.set(guestCarryKey('u-test', '12'), '--- Разговор до входа ---\nЧеловек: Как поднять цены?', 3600);
    const first = await h.run('Продолжим?');
    expect(first).toContain('Человек: Как поднять цены?');
    expect(first.endsWith('Продолжим?')).toBe(true);
    expect(h.redis.peek(guestCarryKey('u-test', '12'))).toBeNull();
    expect(await h.run('И ещё')).not.toContain('Разговор до входа');
  });

  it('«чистый лист» приписку не забирает', async () => {
    const h = harness();
    await h.redis.set(guestCarryKey('u-test', '12'), 'ПРИПИСКА', 3600);
    expect(await h.run('Новая тема', true)).not.toContain('ПРИПИСКА');
    expect(h.redis.peek(guestCarryKey('u-test', '12'))).toBe('ПРИПИСКА');
  });

  it('без Redis (спеки и урезанные сборки) ход идёт как раньше', async () => {
    const h = harness(false);
    const message = await h.run('Привет');
    expect(message.endsWith('Привет')).toBe(true);
    expect(message).not.toContain('Разговор до входа');
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL** (приписки в реплике нет)

```bash
git add src/chat/chat.service.guest-carry.spec.ts
git commit -q -m "test(chat): приписка о пробе в реплике к релею — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern=src/chat/chat.service.guest-carry 2>&1 | grep -E "^(PASS|FAIL)|Tests:|✕"'
```

- [ ] **Шаг 3: реализация в `src/chat/chat.service.ts`**

3a. Импорты (рядом с остальными):
```ts
import { RedisService } from '../common/services/redis.service';
import { takeGuestCarry } from '../guest-trial/guest-carry';
import { withTimeout } from '../guest-trial/with-timeout';
```

3b. Конструктор — после `@Optional() private readonly llmProvider?: UserLlmProviderService,` добавить:
```ts
    // Приписка пробы без входа (src/guest-trial/guest-carry.ts). Последним и
    // @Optional по той же причине, что chatFiles: спеки собирают ChatService позиционно.
    @Optional() private readonly redis?: RedisService,
```

3c. В `streamUniversalAgent` сразу после
```ts
    if (balanceBlock) {
      contextPrefix += balanceBlock + '\n';
    }
```
вставить:
```ts
    // Проба без входа (src/guest-trial): с этим ассистентом человек говорил до
    // входа, а сессия релея возобновится без той переписки. Приписка разовая и
    // в историю не пишется. Redis при недоступности висит — ждём не дольше 1,5 с.
    if (this.redis && !fresh) {
      const carry = await withTimeout(takeGuestCarry(this.redis, userId, assistantId), 1500).catch(() => null);
      if (carry) contextPrefix += carry + '\n\n';
    }
```

- [ ] **Шаг 4: прогнать — PASS, соседи по чату зелёные**

```bash
git add src/chat/chat.service.ts
git commit -q -m "feat(chat): разовая приписка о пробе без входа в реплике к релею

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern="src/chat/" 2>&1 | grep -E "^(FAIL)|^Tests:|^Test Suites:"'
```
Ожидание: список `FAIL` не длиннее базового из Задачи 0 (сверить с `baseline.txt`).

### Задача A10: ручки, уборка, модуль

**Files:**
- Create: `src/guest-trial/guest-trial.controller.ts`, `src/guest-trial/guest-trial.controller.spec.ts`
- Create: `src/guest-trial/guest-trial.cron.ts`, `src/guest-trial/guest-trial.cron.spec.ts`
- Create: `src/guest-trial/guest-trial.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Шаг 1: тесты**

```ts
// src/guest-trial/guest-trial.controller.spec.ts
import { GuestTrialController } from './guest-trial.controller';
import { DEFAULT_GUEST_LIMITS } from './guest-trial.types';
import { hashGuestToken, newGuestToken } from './guest-token';

function makeRes() {
  const res: any = { statusCode: 0, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
  return res;
}

function harness() {
  const turns = { handle: jest.fn(async () => {}) };
  const claims = { claim: jest.fn(async () => ({ status: 200, body: { assistantId: '12', moved: 4 } })) };
  const store = {
    settings: jest.fn(async () => ({ mode: 'on', limits: DEFAULT_GUEST_LIMITS })),
    setMode: jest.fn(async () => {}),
    setLimits: jest.fn(async () => ({ limits: DEFAULT_GUEST_LIMITS, ignored: [] })),
  };
  const sessions = {
    findLive: jest.fn(async (): Promise<any> => null),
    messages: jest.fn(async () => [{ sender_type: 'human', content: 'В' }, { sender_type: 'ai', content: 'О' }]),
    status: jest.fn(async () => ({ trials_day: 1 })),
  };
  const redis = { get: jest.fn(async () => '5') };
  const c = new GuestTrialController(turns as any, claims as any, store as any, sessions as any, redis as any);
  return { c, turns, claims, store, sessions, redis };
}

describe('ручки пробы', () => {
  it('config — режим и два числа, без остальных лимитов', async () => {
    const h = harness();
    const res = makeRes();
    await h.c.config(res);
    expect(res.body).toEqual({ mode: 'on', answersPerTrial: 3, maxChars: 2000 });
  });

  it('session: кривой ключ — 404 без похода в базу; найденная — роли и остаток', async () => {
    const h = harness();
    let res = makeRes();
    await h.c.session({ token: 'x' }, res);
    expect(res.statusCode).toBe(404);
    expect(h.sessions.findLive).not.toHaveBeenCalled();

    const token = newGuestToken();
    h.sessions.findLive.mockImplementation(async (hash: string) =>
      hash === hashGuestToken(token) ? { id: 's1', assistant_id: 14, answers: 1, claimed_at: null } : null);
    res = makeRes();
    await h.c.session({ token }, res);
    expect(res.body).toEqual({ assistantId: '14', messages: [{ role: 'user', content: 'В' }, { role: 'assistant', content: 'О' }], left: 2 });
  });

  it('session: перенесённая — 404', async () => {
    const h = harness();
    h.sessions.findLive.mockImplementation(async () => ({ id: 's1', assistant_id: 14, answers: 1, claimed_at: new Date() }));
    const res = makeRes();
    await h.c.session({ token: newGuestToken() }, res);
    expect(res.statusCode).toBe(404);
  });

  it('claim — userId из JWT, ответ как есть', async () => {
    const h = harness();
    const res = makeRes();
    await h.c.claim({ userId: 'u1' }, { token: 'T' }, res);
    expect(h.claims.claim).toHaveBeenCalledWith('u1', 'T');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ assistantId: '12', moved: 4 });
  });

  it('админ: режимы, лимиты, статус, незнакомое действие', async () => {
    const h = harness();
    for (const [action, mode] of [['enable', 'on'], ['preview', 'preview'], ['disable', 'off']] as const) {
      const res = makeRes();
      await h.c.admin({ action }, res);
      expect(h.store.setMode).toHaveBeenLastCalledWith(mode);
      expect(res.body).toEqual({ mode });
    }
    let res = makeRes();
    await h.c.admin({ action: 'set', limits: { answersPerDay: 500 } }, res);
    expect(h.store.setLimits).toHaveBeenCalledWith({ answersPerDay: 500 });
    res = makeRes();
    await h.c.admin({ action: 'status' }, res);
    expect(res.body).toMatchObject({ mode: 'on', counts: { trials_day: 1 }, windows: { 'guest-lim:answers:d': 5 } });
    res = makeRes();
    await h.c.admin({ action: 'nope' }, res);
    expect(res.statusCode).toBe(400);
  });
});
```

```ts
// src/guest-trial/guest-trial.cron.spec.ts
import { GuestTrialCron } from './guest-trial.cron';

describe('уборка проб', () => {
  it('зовёт purge', async () => {
    const sessions = { purge: jest.fn(async () => 3) };
    await new GuestTrialCron(sessions as any).purge();
    expect(sessions.purge).toHaveBeenCalled();
  });
  it('сбой базы не роняет планировщик', async () => {
    const sessions = { purge: jest.fn(async () => { throw new Error('нет базы'); }) };
    await expect(new GuestTrialCron(sessions as any).purge()).resolves.toBeUndefined();
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/guest-trial/guest-trial.controller.spec.ts src/guest-trial/guest-trial.cron.spec.ts
git commit -q -m "test(guest-trial): ручки и уборка — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx jest --testPathPattern="src/guest-trial/guest-trial.(controller|cron)" 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```

- [ ] **Шаг 3: реализация**

```ts
// src/guest-trial/guest-trial.controller.ts
import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { RedisService } from '../common/services/redis.service';
import { GuestTurnService, parseGuestTurnInput } from './guest-turn.service';
import { GuestClaimService } from './guest-claim.service';
import { GuestTrialStore } from './guest-trial-store.service';
import { GuestSessionsService } from './guest-sessions.service';
import { hashGuestToken, isGuestTokenShape } from './guest-token';
import { GUEST_REDIS_TIMEOUT_MS } from './guest-trial.types';
import { withTimeout } from './with-timeout';

const WINDOW_KEYS = ['guest-lim:trials:h', 'guest-lim:trials:d', 'guest-lim:answers:h', 'guest-lim:answers:d'];

/**
 * Проба ассистента без регистрации (spec 2026-10-30-guest-trial-design.md).
 * Ключ гостя ходит только в теле запроса: адреса оседают в журналах nginx и прокси.
 */
@Controller('')
export class GuestTrialController {
  constructor(
    private readonly turns: GuestTurnService,
    private readonly claims: GuestClaimService,
    private readonly store: GuestTrialStore,
    private readonly sessions: GuestSessionsService,
    private readonly redis: RedisService,
  ) {}

  /** Открыта: кабинет без входа решает, показывать ли пробу. */
  @Get('guest/config')
  async config(@Res() res: Response) {
    const { mode, limits } = await this.store.settings();
    return res.status(200).json({ mode, answersPerTrial: limits.answersPerTrial, maxChars: limits.maxChars });
  }

  @Post('guest/chat')
  async chat(@Body() body: any, @Res() res: Response) {
    await this.turns.handle(parseGuestTurnInput(body), res);
  }

  /** Разговор пробы после перезагрузки страницы. */
  @Post('guest/session')
  async session(@Body() body: any, @Res() res: Response) {
    const token = body?.token;
    if (!isGuestTokenShape(token)) return res.status(404).json({ error: 'trial' });
    const row = await this.sessions.findLive(hashGuestToken(token));
    if (!row || row.claimed_at) return res.status(404).json({ error: 'trial' });
    const { limits } = await this.store.settings();
    const messages = await this.sessions.messages(row.id);
    return res.status(200).json({
      assistantId: String(row.assistant_id),
      messages: messages.map((m) => ({ role: m.sender_type === 'human' ? 'user' : 'assistant', content: m.content })),
      left: Math.max(0, limits.answersPerTrial - row.answers),
    });
  }

  @Post('guest/claim')
  @UseGuards(JwtGuard)
  async claim(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const r = await this.claims.claim(String(user?.userId ?? ''), String(body?.token ?? ''));
    return res.status(r.status).json(r.body);
  }

  /** Как у остальной админки: status, enable, preview, disable, set (лимиты). */
  @Post('admin/guest-trial')
  @UseGuards(JwtGuard, AdminGuard)
  async admin(@Body() body: any, @Res() res: Response) {
    switch (body?.action) {
      case 'status': {
        const settings = await this.store.settings();
        return res.status(200).json({ ...settings, counts: await this.sessions.status(), windows: await this.windows() });
      }
      case 'enable':
        await this.store.setMode('on');
        return res.status(200).json({ mode: 'on' });
      case 'preview':
        await this.store.setMode('preview');
        return res.status(200).json({ mode: 'preview' });
      case 'disable':
        await this.store.setMode('off');
        return res.status(200).json({ mode: 'off' });
      case 'set':
        return res.status(200).json(await this.store.setLimits(body?.limits));
      default:
        return res.status(400).json({ error: `Unknown action: ${body?.action}` });
    }
  }

  private async windows(): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {};
    for (const key of WINDOW_KEYS) {
      try {
        const v = await withTimeout(this.redis.get(key), GUEST_REDIS_TIMEOUT_MS);
        out[key] = v === null ? 0 : Number(v);
      } catch {
        out[key] = null;
      }
    }
    return out;
  }
}
```

```ts
// src/guest-trial/guest-trial.cron.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GuestSessionsService } from './guest-sessions.service';

/** Уборка проб раз в час: обещание политики — 7 дней для неперенесённых. */
@Injectable()
export class GuestTrialCron {
  private readonly log = new Logger('GuestTrialCron');

  constructor(private readonly sessions: GuestSessionsService) {}

  @Cron('0 17 * * * *')
  async purge(): Promise<void> {
    try {
      const n = await this.sessions.purge();
      if (n > 0) this.log.log(`guest trials purged: ${n}`);
    } catch (e: any) {
      this.log.warn(`guest trial purge failed: ${e?.message}`);
    }
  }
}
```

```ts
// src/guest-trial/guest-trial.module.ts
import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { GuestTrialController } from './guest-trial.controller';
import { GuestTrialStore } from './guest-trial-store.service';
import { GuestSessionsService } from './guest-sessions.service';
import { GuestTurnService } from './guest-turn.service';
import { GuestClaimService } from './guest-claim.service';
import { GuestTrialCron } from './guest-trial.cron';

/**
 * Проба ассистента без регистрации. ChatModule — ради ChatService.beginStream/
 * endStream: deploy.sh перед рестартом ждёт и гостевые ходы. Pg, Redis, CLI,
 * события и Neo4j — из глобальных модулей.
 */
@Module({
  imports: [ChatModule],
  controllers: [GuestTrialController],
  providers: [GuestTrialStore, GuestSessionsService, GuestTurnService, GuestClaimService, GuestTrialCron],
})
export class GuestTrialModule {}
```

`src/app.module.ts`: импорт `import { GuestTrialModule } from './guest-trial/guest-trial.module';` рядом с остальными и `GuestTrialModule,` последним элементом массива `imports` (после `IntegrationsModule,`).

- [ ] **Шаг 4: прогнать — PASS, сборка типов чистая**

```bash
git add src/guest-trial/guest-trial.controller.ts src/guest-trial/guest-trial.cron.ts src/guest-trial/guest-trial.module.ts src/app.module.ts
git commit -q -m "feat(guest-trial): ручки /webhook/guest/*, админ-ручка, уборка, модуль

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'npx tsc --noEmit -p tsconfig.build.json; echo tsc_build=$?; npx jest --testPathPattern="src/(guest-trial|common/guards)" 2>&1 | grep -E "^(PASS|FAIL)|Tests:"'
```
Ожидание: `tsc_build=0`; `admin-routes.spec.ts` (сторож гардов админ-ручек) — `PASS`.

### Задача A11: браузерный smoke заходит «устройством, где уже входили»

**Files:**
- Modify: `tests/playwright/login-ui.spec.js` (`openLogin`)

После включения пробы новый браузер на `/` видит чат, а не форму входа, и `login-ui.spec.js` в `deploy.sh` покраснел бы на каждом следующем выкате.

- [ ] **Шаг 1: правка** — в `openLogin` внутри `page.addInitScript(() => { … })` после `localStorage.setItem('i18nextLng', 'ru');` добавить:
```js
    // Экран входа видит устройство, где уже входили: новому при включённой
    // пробе без входа (spec 2026-10-30-guest-trial) кабинет откроет чат.
    localStorage.setItem('linkeon_has_account', '1');
```

- [ ] **Шаг 2: проверить синтаксис и закоммитить**

```bash
node --check tests/playwright/login-ui.spec.js && echo syntax_ok
git add tests/playwright/login-ui.spec.js
git commit -q -m "test(smoke): экран входа — устройством, где уже входили

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Живьём этот файл гоняет smoke `deploy.sh` (Часть D).

### Задача A12: гейты бэка

- [ ] **Шаг 1: типы, тесты модуля, полный прогон дельтой, обе половины jest**

```bash
bash .superpowers/node-run.sh 'npx tsc --noEmit -p tsconfig.build.json; echo tsc_build=$?;
PROVISIONING_PG_URL="postgres:///gt_test?host=/var/run/postgresql" npx jest --runInBand --testPathPattern="src/(guest-trial|chat/(answer-first-rule|chat.service.(guest-carry|masha-prompt|llm-provider))|common/services/claude-cli)" 2>&1 | grep -E "^(PASS|FAIL)|^Tests:";
npx jest src/ --silent 2>&1 | grep -E "^FAIL|^Tests:|^Test Suites:";
npm run build >/tmp/gt-build.log 2>&1; echo build=$?; (cd tests && npx jest unit/ --silent 2>&1 | grep -E "^FAIL|^Tests:")'
```
Ожидание: `tsc_build=0`; все наборы модуля `PASS` (pg-спеки не `skipped`); список `FAIL` полного прогона совпадает с базовым из `baseline.txt`; `build=0`; `tests/unit` без новых `FAIL`.

- [ ] **Шаг 2: запушить ветку в GitHub** (для ревью; не в main)

```bash
git push -q -u origin feat/guest-trial
```

---

## Часть B. Кабинет (spirits_front, воркдерево `.worktrees/guest-trial`)

Все команды Части B — из `~/Downloads/spirits_front/.worktrees/guest-trial`. Тесты: `bash .superpowers/node-run.sh 'pnpm test <файлы> 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'`.

### Задача B1: типы и хранилище пробы в браузере

**Files:**
- Create: `src/components/guest/guestTypes.ts`, `src/components/guest/guestStorage.ts`, `src/components/guest/guestStorage.test.ts`
- Modify: `src/utils/clearAppStorage.ts`

- [ ] **Шаг 1: тест**

```ts
// src/components/guest/guestStorage.test.ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAppStorage } from '../../utils/clearAppStorage';
import {
  forgetTrial, hasAccount, markHasAccount, previewRequested, readTrial, rememberPreviewFromUrl, saveTrial,
} from './guestStorage';

const TOKEN = 'A'.repeat(43);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('проба в браузере', () => {
  it('ключ и ассистент сохраняются и читаются', () => {
    saveTrial({ token: TOKEN, assistantId: '12' });
    expect(readTrial()).toEqual({ token: TOKEN, assistantId: '12' });
    forgetTrial();
    expect(readTrial()).toBeNull();
  });

  it('битая запись стирается', () => {
    localStorage.setItem('guest_trial', JSON.stringify({ token: 'короткий', assistantId: '12' }));
    expect(readTrial()).toBeNull();
    expect(localStorage.getItem('guest_trial')).toBeNull();
  });

  it('выход из аккаунта стирает ключ пробы, но не отметку «входили»', () => {
    saveTrial({ token: TOKEN, assistantId: '12' });
    markHasAccount();
    clearAppStorage();
    expect(readTrial()).toBeNull();
    expect(hasAccount()).toBe(true);
  });

  it('предпросмотр — только из ?trial=1 и только в этой вкладке', () => {
    rememberPreviewFromUrl('?assistant=12');
    expect(previewRequested()).toBe(false);
    rememberPreviewFromUrl('?assistant=12&trial=1');
    expect(previewRequested()).toBe(true);
    expect(localStorage.getItem('guest_trial_preview')).toBeNull();
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/components/guest/guestStorage.test.ts
git commit -q -m "test(guest): хранилище пробы — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/guestStorage.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 3: реализация**

```ts
// src/components/guest/guestTypes.ts
/** Проба ассистента без регистрации (spec 2026-10-30-guest-trial). */
export type GuestMode = 'off' | 'preview' | 'on';

export interface GuestConfig {
  mode: GuestMode;
  answersPerTrial: number;
  maxChars: number;
}

export interface GuestMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GuestAgent {
  id: string;
  name: string;
}

export type GuestEvent =
  | { type: 'guest'; token?: string; left: number }
  | { type: 'begin' }
  | { type: 'ping' }
  | { type: 'item'; content: string }
  | { type: 'end'; content: string }
  | { type: 'wall'; reason: 'limit' | 'closed' }
  | { type: 'error'; code: 'model' | 'busy' };
```

```ts
// src/components/guest/guestStorage.ts
/**
 * Что проба без входа держит в браузере (spec 2026-10-30-guest-trial).
 *
 * guest_trial — ключ пробы и её ассистент. Ключ выдаёт сервер; без него
 * разговор нельзя ни продолжить, ни перенести в аккаунт. Стирается после
 * переноса и при выходе из аккаунта (clearAppStorage): следующий на этом
 * устройстве не должен забрать чужую пробу.
 *
 * linkeon_has_account — «с этого устройства уже входили». Такому устройству
 * кабинет показывает экран входа, а не пробу. clearAppStorage его НЕ стирает:
 * в этом его смысл.
 *
 * guest_trial_preview — в sessionStorage: вкладка открыта с ?trial=1, и режим
 * «предпросмотр» показывает пробу только ей.
 */
const TRIAL_KEY = 'guest_trial';
const HAS_ACCOUNT_KEY = 'linkeon_has_account';
const PREVIEW_KEY = 'guest_trial_preview';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface StoredTrial {
  token: string;
  assistantId: string;
}

export function readTrial(): StoredTrial | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(TRIAL_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<StoredTrial>;
    if (typeof p.token === 'string' && TOKEN_RE.test(p.token) && typeof p.assistantId === 'string' && /^\d{1,6}$/.test(p.assistantId)) {
      return { token: p.token, assistantId: p.assistantId };
    }
  } catch {
    /* не JSON — стираем ниже */
  }
  forgetTrial();
  return null;
}

export function saveTrial(trial: StoredTrial): void {
  try { localStorage.setItem(TRIAL_KEY, JSON.stringify(trial)); } catch { /* приватный режим: проба живёт до перезагрузки */ }
}

export function forgetTrial(): void {
  try { localStorage.removeItem(TRIAL_KEY); } catch { /* хранилище недоступно — забывать нечего */ }
}

export function markHasAccount(): void {
  try { localStorage.setItem(HAS_ACCOUNT_KEY, '1'); } catch { /* приватный режим */ }
}

export function hasAccount(): boolean {
  try { return localStorage.getItem(HAS_ACCOUNT_KEY) === '1'; } catch { return false; }
}

export function rememberPreviewFromUrl(search: string): void {
  try {
    if (new URLSearchParams(search).get('trial') === '1') sessionStorage.setItem(PREVIEW_KEY, '1');
  } catch { /* приватный режим */ }
}

export function previewRequested(): boolean {
  try { return sessionStorage.getItem(PREVIEW_KEY) === '1'; } catch { return false; }
}
```

`src/utils/clearAppStorage.ts`: импорт `import { forgetTrial } from '../components/guest/guestStorage';` и в конце `clearAppStorage()` после `forgetPendingDraft();`:
```ts
  // ключ пробы без входа: не оставлять следующему, кто войдёт с этого устройства.
  // Отметку linkeon_has_account не трогаем — устройство «входило».
  forgetTrial();
```

- [ ] **Шаг 4: прогнать — PASS**

```bash
git add src/components/guest/guestTypes.ts src/components/guest/guestStorage.ts src/utils/clearAppStorage.ts
git commit -q -m "feat(guest): ключ пробы и отметка «входили» в браузере

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/guestStorage.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

### Задача B2: правило «проба или вход»

**Files:**
- Create: `src/components/guest/decideUnauthEntry.ts`, `src/components/guest/decideUnauthEntry.test.ts`

- [ ] **Шаг 1: тест**

```ts
// src/components/guest/decideUnauthEntry.test.ts
import { describe, expect, it } from 'vitest';
import { decideUnauthEntry } from './decideUnauthEntry';

const guest = { native: false, mode: 'on' as const, preview: false, hasAccount: false, pathname: '/chat' };

describe('проба или экран входа', () => {
  it('новое устройство, режим «вкл», / или /chat — проба', () => {
    expect(decideUnauthEntry(guest)).toBe('guest');
    expect(decideUnauthEntry({ ...guest, pathname: '/' })).toBe('guest');
  });
  it('устройство, где входили, — вход', () => {
    expect(decideUnauthEntry({ ...guest, hasAccount: true })).toBe('login');
  });
  it('нативная сборка — вход', () => {
    expect(decideUnauthEntry({ ...guest, native: true })).toBe('login');
  });
  it('другие разделы кабинета — вход', () => {
    expect(decideUnauthEntry({ ...guest, pathname: '/studio' })).toBe('login');
    expect(decideUnauthEntry({ ...guest, pathname: '/image-gen' })).toBe('login');
  });
  it('«предпросмотр» — только с ?trial=1, «выкл» и неизвестно — вход', () => {
    expect(decideUnauthEntry({ ...guest, mode: 'preview' })).toBe('login');
    expect(decideUnauthEntry({ ...guest, mode: 'preview', preview: true })).toBe('guest');
    expect(decideUnauthEntry({ ...guest, mode: 'off', preview: true })).toBe('login');
    expect(decideUnauthEntry({ ...guest, mode: null })).toBe('login');
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/components/guest/decideUnauthEntry.test.ts
git commit -q -m "test(guest): правило «проба или вход» — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/decideUnauthEntry.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 3: реализация**

```ts
// src/components/guest/decideUnauthEntry.ts
import type { GuestMode } from './guestTypes';

export type UnauthEntry = 'guest' | 'login';

export interface EntryInput {
  /** Нативная сборка (Capacitor): там вход открывается из лаунчера, проба не нужна. */
  native: boolean;
  /** Режим с сервера; null — сервер не ответил. */
  mode: GuestMode | null;
  /** Вкладка открыта с ?trial=1. */
  preview: boolean;
  /** С этого устройства уже входили. */
  hasAccount: boolean;
  pathname: string;
}

/**
 * Кого кабинет без входа встречает пробой (spec 2026-10-30-guest-trial):
 * новое устройство на / или /chat в вебе. Все остальные — экраном входа, как раньше.
 */
export function decideUnauthEntry(i: EntryInput): UnauthEntry {
  if (i.native || i.hasAccount) return 'login';
  if (i.pathname !== '/' && i.pathname !== '/chat') return 'login';
  if (i.mode === 'on') return 'guest';
  if (i.mode === 'preview' && i.preview) return 'guest';
  return 'login';
}
```

- [ ] **Шаг 4: прогнать — PASS и закоммитить**

```bash
git add src/components/guest/decideUnauthEntry.ts
git commit -q -m "feat(guest): правило «проба или экран входа»

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/decideUnauthEntry.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

### Задача B3: разбор потока хода

**Files:**
- Create: `src/components/guest/guestStream.ts`, `src/components/guest/guestStream.test.ts`

- [ ] **Шаг 1: тест**

```ts
// src/components/guest/guestStream.test.ts
import { describe, expect, it } from 'vitest';
import { createLineSplitter, parseGuestEvent, readGuestStream } from './guestStream';
import type { GuestEvent } from './guestTypes';

describe('поток хода гостя', () => {
  it('строки склеиваются через границы кусков', () => {
    const split = createLineSplitter();
    expect(split('{"type":"be')).toEqual([]);
    expect(split('gin"}\n{"type":"item","content":"а"}\n{"ty')).toEqual(['{"type":"begin"}', '{"type":"item","content":"а"}']);
    expect(split('pe":"ping"}\n')).toEqual(['{"type":"ping"}']);
  });

  it('незнакомое, битое и без полей — пропускается; код ошибки по умолчанию — model', () => {
    expect(parseGuestEvent('не json')).toBeNull();
    expect(parseGuestEvent('{"type":"what"}')).toBeNull();
    expect(parseGuestEvent('{"type":"item"}')).toBeNull();
    expect(parseGuestEvent('{"type":"wall","reason":"x"}')).toBeNull();
    expect(parseGuestEvent('{"type":"error","code":"x"}')).toEqual({ type: 'error', code: 'model' });
    expect(parseGuestEvent('{"type":"guest","left":2,"token":"T"}')).toEqual({ type: 'guest', left: 2, token: 'T' });
  });

  it('многобайтный знак на границе кусков не ломается', async () => {
    const bytes = new TextEncoder().encode('{"type":"item","content":"Привет"}\n{"type":"end","content":"Привет"}\n');
    const cut = 30; // посреди кириллицы
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close(); },
    });
    const got: GuestEvent[] = [];
    await readGuestStream(stream.getReader(), (e) => got.push(e));
    expect(got).toEqual([{ type: 'item', content: 'Привет' }, { type: 'end', content: 'Привет' }]);
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/components/guest/guestStream.test.ts
git commit -q -m "test(guest): разбор потока хода — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/guestStream.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 3: реализация**

```ts
// src/components/guest/guestStream.ts
import type { GuestEvent } from './guestTypes';

/** Склейка NDJSON: куски потока режутся где угодно, событие — только целая строка. */
export function createLineSplitter(): (chunk: string) => string[] {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    return lines.map((l) => l.trim()).filter(Boolean);
  };
}

export function parseGuestEvent(line: string): GuestEvent | null {
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  switch (raw?.type) {
    case 'guest':
      return { type: 'guest', left: Number(raw.left) || 0, ...(typeof raw.token === 'string' ? { token: raw.token } : {}) };
    case 'begin':
      return { type: 'begin' };
    case 'ping':
      return { type: 'ping' };
    case 'item':
      return typeof raw.content === 'string' ? { type: 'item', content: raw.content } : null;
    case 'end':
      return typeof raw.content === 'string' ? { type: 'end', content: raw.content } : null;
    case 'wall':
      return raw.reason === 'limit' || raw.reason === 'closed' ? { type: 'wall', reason: raw.reason } : null;
    case 'error':
      return { type: 'error', code: raw.code === 'busy' ? 'busy' : 'model' };
    default:
      return null;
  }
}

export async function readGuestStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (e: GuestEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const split = createLineSplitter();
  const emit = (text: string) => {
    for (const line of split(text)) {
      const ev = parseGuestEvent(line);
      if (ev) onEvent(ev);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    emit(decoder.decode(value, { stream: true }));
  }
  emit(decoder.decode() + '\n');
}
```

- [ ] **Шаг 4: прогнать — PASS и закоммитить**

```bash
git add src/components/guest/guestStream.ts
git commit -q -m "feat(guest): разбор потока хода

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/guestStream.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

### Задача B4: клиент ручек пробы

**Files:**
- Create: `src/components/guest/guestApi.ts`, `src/components/guest/guestApi.test.ts`
- Modify: `src/services/eventsClient.ts` (экспорт `getSessionId`)

- [ ] **Шаг 1: тест**

```ts
// src/components/guest/guestApi.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/apiClient', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
import { apiClient } from '../../services/apiClient';
import { claimGuestTrial, fetchGuestAgents, fetchGuestConfig, loadGuestSession, sendGuestMessage } from './guestApi';
import type { GuestEvent } from './guestTypes';

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ndjson = (lines: object[]) => new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200 });

const INPUT = { token: null, assistantId: '12', message: 'Привет', lang: 'ru', tz: 'Europe/Moscow', preview: false, source: null, campaign: null, sid: 's_1' };

beforeEach(() => { get.mockReset(); post.mockReset(); });

describe('config', () => {
  it('режим с сервера; мусор — «выкл»; сбой — null; без авторизации', async () => {
    get.mockResolvedValueOnce(json(200, { mode: 'on', answersPerTrial: 3, maxChars: 2000 }));
    expect(await fetchGuestConfig()).toEqual({ mode: 'on', answersPerTrial: 3, maxChars: 2000 });
    expect(get).toHaveBeenCalledWith('/webhook/guest/config', { skipAuth: true });
    get.mockResolvedValueOnce(json(200, { mode: 'всё' }));
    expect((await fetchGuestConfig())?.mode).toBe('off');
    get.mockRejectedValueOnce(new Error('сеть'));
    expect(await fetchGuestConfig()).toBeNull();
  });
});

describe('ассистенты', () => {
  it('имя — displayName, без числового id — отбрасывается', async () => {
    get.mockResolvedValueOnce(json(200, [{ id: 12, name: 'Роман', displayName: 'Roman' }, { id: 'custom:x', name: 'Мой' }]));
    expect(await fetchGuestAgents('en')).toEqual([{ id: '12', name: 'Roman' }]);
    expect(get).toHaveBeenCalledWith('/webhook/agents?lang=en', { skipAuth: true });
  });
});

describe('ход', () => {
  it('события по порядку, ok', async () => {
    post.mockResolvedValueOnce(ndjson([{ type: 'guest', left: 3 }, { type: 'begin' }, { type: 'item', content: 'При' }, { type: 'end', content: 'Привет' }]));
    const got: GuestEvent[] = [];
    expect(await sendGuestMessage(INPUT, (e) => got.push(e))).toBe('ok');
    expect(got.map((e) => e.type)).toEqual(['guest', 'begin', 'item', 'end']);
    expect(post).toHaveBeenCalledWith('/webhook/guest/chat', INPUT, { skipAuth: true });
  });

  it('404 и чужой ассистент — проба пропала; занята — busy_trial; 400; сеть', async () => {
    post.mockResolvedValueOnce(json(404, { error: 'trial' }));
    expect(await sendGuestMessage(INPUT, () => {})).toBe('trial_gone');
    post.mockResolvedValueOnce(json(409, { error: 'assistant_mismatch' }));
    expect(await sendGuestMessage(INPUT, () => {})).toBe('trial_gone');
    post.mockResolvedValueOnce(json(409, { error: 'busy_trial' }));
    expect(await sendGuestMessage(INPUT, () => {})).toBe('busy_trial');
    post.mockResolvedValueOnce(json(400, { error: 'message' }));
    expect(await sendGuestMessage(INPUT, () => {})).toBe('bad_request');
    post.mockRejectedValueOnce(new Error('сеть'));
    expect(await sendGuestMessage(INPUT, () => {})).toBe('network');
  });
});

describe('разговор после перезагрузки и перенос', () => {
  it('session — роли и остаток; 404 — null', async () => {
    post.mockResolvedValueOnce(json(200, { assistantId: '14', messages: [{ role: 'user', content: 'В' }, { role: 'x', content: 'мусор' }], left: 2 }));
    expect(await loadGuestSession('T')).toEqual({ assistantId: '14', messages: [{ role: 'user', content: 'В' }], left: 2 });
    post.mockResolvedValueOnce(json(404, { error: 'trial' }));
    expect(await loadGuestSession('T')).toBeNull();
  });

  it('claim: 200 — перенесено; 404/409 — пробы нет; 500 и сеть — повторить позже', async () => {
    post.mockResolvedValueOnce(json(200, { assistantId: '12', moved: 4 }));
    expect(await claimGuestTrial('T')).toEqual({ status: 'claimed', assistantId: '12' });
    expect(post).toHaveBeenLastCalledWith('/webhook/guest/claim', { token: 'T' });
    post.mockResolvedValueOnce(json(404, {}));
    expect(await claimGuestTrial('T')).toEqual({ status: 'gone' });
    post.mockResolvedValueOnce(json(409, {}));
    expect(await claimGuestTrial('T')).toEqual({ status: 'gone' });
    post.mockResolvedValueOnce(json(500, {}));
    expect(await claimGuestTrial('T')).toEqual({ status: 'retry' });
    post.mockRejectedValueOnce(new Error('сеть'));
    expect(await claimGuestTrial('T')).toEqual({ status: 'retry' });
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/components/guest/guestApi.test.ts
git commit -q -m "test(guest): клиент ручек пробы — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/guestApi.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 3: реализация**

В `src/services/eventsClient.ts` строку `const getSessionId = (): string => {` заменить на `export const getSessionId = (): string => {` (проба шлёт его серверу, чтобы склеить события).

```ts
// src/components/guest/guestApi.ts
import { apiClient } from '../../services/apiClient';
import { readGuestStream } from './guestStream';
import type { GuestAgent, GuestConfig, GuestEvent, GuestMessage } from './guestTypes';

/** Режим пробы с сервера. null — сервер не ответил: кабинет покажет экран входа, как раньше. */
export async function fetchGuestConfig(): Promise<GuestConfig | null> {
  try {
    const r = await apiClient.get('/webhook/guest/config', { skipAuth: true });
    if (!r.ok) return null;
    const j = await r.json();
    const mode = j?.mode === 'on' || j?.mode === 'preview' ? j.mode : 'off';
    return { mode, answersPerTrial: Number(j?.answersPerTrial) || 3, maxChars: Number(j?.maxChars) || 2000 };
  } catch {
    return null;
  }
}

/** Ассистенты экрана выбора — публичная ручка, имена на языке гостя. */
export async function fetchGuestAgents(lang: string): Promise<GuestAgent[]> {
  try {
    const r = await apiClient.get(`/webhook/agents?lang=${encodeURIComponent(lang)}`, { skipAuth: true });
    if (!r.ok) return [];
    const list = await r.json();
    if (!Array.isArray(list)) return [];
    return list
      .map((a: any) => ({ id: String(a?.id ?? ''), name: String(a?.displayName || a?.name || '') }))
      .filter((a) => /^\d+$/.test(a.id) && a.name !== '');
  } catch {
    return [];
  }
}

export interface GuestSendInput {
  token: string | null;
  assistantId: string;
  message: string;
  lang: string;
  tz: string;
  preview: boolean;
  source: string | null;
  campaign: string | null;
  sid: string | null;
}

export type GuestSendResult = 'ok' | 'trial_gone' | 'busy_trial' | 'bad_request' | 'network';

export async function sendGuestMessage(input: GuestSendInput, onEvent: (e: GuestEvent) => void): Promise<GuestSendResult> {
  let r: Response;
  try {
    r = await apiClient.post('/webhook/guest/chat', input, { skipAuth: true });
  } catch {
    return 'network';
  }
  if (r.status === 404) return 'trial_gone';
  if (r.status === 409) {
    const j = await r.json().catch(() => ({}));
    return j?.error === 'assistant_mismatch' ? 'trial_gone' : 'busy_trial';
  }
  if (r.status === 400) return 'bad_request';
  if (!r.ok || !r.body) return 'network';
  try {
    await readGuestStream(r.body.getReader(), onEvent);
  } catch {
    return 'network';
  }
  return 'ok';
}

export async function loadGuestSession(token: string): Promise<{ assistantId: string; messages: GuestMessage[]; left: number } | null> {
  try {
    const r = await apiClient.post('/webhook/guest/session', { token }, { skipAuth: true });
    if (!r.ok) return null;
    const j = await r.json();
    const messages: GuestMessage[] = Array.isArray(j?.messages)
      ? j.messages
          .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string')
          .map((m: any) => ({ role: m.role, content: m.content }))
      : [];
    return { assistantId: String(j?.assistantId ?? ''), messages, left: Math.max(0, Number(j?.left) || 0) };
  } catch {
    return null;
  }
}

export type GuestClaimResult = { status: 'claimed'; assistantId: string } | { status: 'gone' } | { status: 'retry' };

/** Перенос пробы в аккаунт, в который только что вошли (запрос — с токеном входа). */
export async function claimGuestTrial(token: string): Promise<GuestClaimResult> {
  try {
    const r = await apiClient.post('/webhook/guest/claim', { token });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const id = String(j?.assistantId ?? '');
      return /^\d+$/.test(id) ? { status: 'claimed', assistantId: id } : { status: 'gone' };
    }
    return r.status === 404 || r.status === 409 ? { status: 'gone' } : { status: 'retry' };
  } catch {
    return { status: 'retry' };
  }
}
```

- [ ] **Шаг 4: прогнать — PASS и закоммитить**

```bash
git add src/components/guest/guestApi.ts src/services/eventsClient.ts
git commit -q -m "feat(guest): клиент ручек пробы

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/guestApi.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

### Задача B5: вопрос с лендинга (`#ask=`)

**Files:**
- Modify: `index.html` (скрипт `data-draft-capture`), `src/utils/pendingDraft.ts`
- Create: `src/utils/draftCaptureAsk.test.ts`, `src/utils/pendingDraft.entry.test.ts`

- [ ] **Шаг 1: тесты**

```ts
// src/utils/draftCaptureAsk.test.ts
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { takePendingDraftEntry, takePendingDraftFor } from './pendingDraft';

/** Исполняется НАСТОЯЩИЙ скрипт из index.html — как в draftCapture.test.ts. */
const HTML = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');
const SCRIPT = HTML.match(/<script data-draft-capture>([\s\S]*?)<\/script>/)?.[1] ?? '';

function open(url: string): void {
  window.history.replaceState(null, '', url);
  new Function(SCRIPT)();
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('вопрос с поля на linkeon.io (#ask=)', () => {
  it('забирается с пометкой «отправить» и стирается из адреса', () => {
    open(`/chat?assistant=12&utm_content=hero-ask#ask=${encodeURIComponent('Как поднять цены?')}`);
    expect(window.location.hash).toBe('');
    expect(takePendingDraftEntry(12)).toEqual({ text: 'Как поднять цены?', auto: true });
  });

  it('черновик #draft= — без пометки', () => {
    open(`/chat?assistant=14#draft=${encodeURIComponent('Мои данные рождения')}`);
    expect(takePendingDraftEntry(14)).toEqual({ text: 'Мои данные рождения', auto: false });
  });

  it('для чата после входа вопрос — обычный черновик: только текст', () => {
    open(`/chat?assistant=12#ask=${encodeURIComponent('Вопрос')}`);
    expect(takePendingDraftFor(12)).toBe('Вопрос');
  });
});
```

```ts
// src/utils/pendingDraft.entry.test.ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { DRAFT_MAX_LENGTH, savePendingDraft, takePendingDraftEntry } from './pendingDraft';

beforeEach(() => localStorage.clear());

describe('черновик пробы', () => {
  it('сохранённый пробой — подставляется после входа один раз и без пометки', () => {
    savePendingDraft('  Вопрос  ', 12);
    expect(takePendingDraftEntry(13)).toBeNull();
    expect(takePendingDraftEntry(12)).toEqual({ text: 'Вопрос', auto: false });
    expect(takePendingDraftEntry(12)).toBeNull();
  });

  it('пустой и длиннее предела — не сохраняется', () => {
    savePendingDraft('   ', 12);
    savePendingDraft('я'.repeat(DRAFT_MAX_LENGTH + 1), 12);
    expect(localStorage.getItem('pending_draft')).toBeNull();
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/utils/draftCaptureAsk.test.ts src/utils/pendingDraft.entry.test.ts
git commit -q -m "test(draft): вопрос с лендинга #ask= — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/utils/draftCaptureAsk.test.ts src/utils/pendingDraft.entry.test.ts src/utils/draftCapture.test.ts src/utils/pendingDraft.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 3: реализация**

3a. `index.html`, в скрипте `data-draft-capture` заменить
```js
          var hash = location.hash;
          if (hash.indexOf('#draft=') !== 0) return;
          // Сначала стереть: битый или длинный черновик тоже не должен
          // остаться в адресе.
          history.replaceState(history.state, '', location.pathname + location.search);
          var text = decodeURIComponent(hash.slice(7)).trim();
```
на
```js
          var hash = location.hash;
          // #ask= — вопрос с поля на linkeon.io: проба без входа отправит его
          // сама (spec 2026-10-30-guest-trial). #draft= — только подставить.
          var auto = hash.indexOf('#ask=') === 0;
          if (!auto && hash.indexOf('#draft=') !== 0) return;
          // Сначала стереть: битый или длинный черновик тоже не должен
          // остаться в адресе.
          history.replaceState(history.state, '', location.pathname + location.search);
          var text = decodeURIComponent(hash.slice(auto ? 5 : 7)).trim();
```
и в записи
```js
            expires: Date.now() + 3600000
```
на
```js
            expires: Date.now() + 3600000,
            auto: auto
```
В комментарии над скриптом после `(#draft=…)` дописать ` и вопрос с поля (#ask=…)`.

3b. `src/utils/pendingDraft.ts`:
- в `interface Stored` добавить поле с комментарием:
```ts
  /** Вопрос с поля лендинга (#ask=): проба без входа отправит его сама. */
  auto?: boolean;
```
- в `read()` строку `return { text: p.text, assistant: p.assistant, expires: p.expires };` заменить на
```ts
      return { text: p.text, assistant: p.assistant, expires: p.expires, auto: p.auto === true };
```
- в конец файла:
```ts
export interface PendingDraftEntry {
  text: string;
  auto: boolean;
}

/**
 * То же, что takePendingDraftFor, но с пометкой «отправить» — для пробы без
 * входа. Чат после входа пользуется takePendingDraftFor и только подставляет.
 */
export function takePendingDraftEntry(assistantId: string | number, now = Date.now()): PendingDraftEntry | null {
  const stored = read(now);
  if (!stored || stored.assistant !== String(assistantId)) return null;
  forget();
  return { text: stored.text, auto: stored.auto === true };
}

/**
 * Положить черновик самому: проба закрылась раньше, чем пришёл ответ, — текст
 * дождётся входа и встанет в поле чата с тем же ассистентом.
 */
export function savePendingDraft(text: string, assistantId: string | number, now = Date.now()): void {
  const t = text.trim();
  if (!t || t.length > DRAFT_MAX_LENGTH) return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: t, assistant: String(assistantId), expires: now + DRAFT_TTL_MS }));
  } catch {
    /* хранилище недоступно — черновик не переживёт вход */
  }
}
```

- [ ] **Шаг 4: прогнать — PASS (старые тесты черновика тоже) и закоммитить**

```bash
git add index.html src/utils/pendingDraft.ts
git commit -q -m "feat(draft): вопрос с лендинга #ask= — с пометкой «отправить» для пробы

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/utils/draftCaptureAsk.test.ts src/utils/pendingDraft.entry.test.ts src/utils/draftCapture.test.ts src/utils/pendingDraft.test.ts src/components/chat/draftWiring.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

### Задача B6: общий хук «что делает экран входа при открытии»

**Files:**
- Create: `src/components/onboarding/useEntryParams.ts`, `src/components/onboarding/useEntryParams.test.tsx`
- Modify: `src/pages/OnboardingPage.tsx`

- [ ] **Шаг 1: тест**

```tsx
// src/components/onboarding/useEntryParams.test.tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { flush, mount, type Mounted } from '../../test/dom';
import { useEntryParams } from './useEntryParams';

const Probe = () => { useEntryParams(); return null; };

let view: Mounted | null = null;
beforeEach(() => localStorage.clear());
afterEach(() => { view?.unmount(); view = null; });

describe('параметры входа', () => {
  it('рефссылка запоминается на 7 дней', async () => {
    view = mount(<MemoryRouter initialEntries={['/chat?ref=abc']}><Probe /></MemoryRouter>);
    await flush();
    expect(localStorage.getItem('referral_slug')).toBe('abc');
    expect(Number(localStorage.getItem('referral_slug_expires'))).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
  });

  it('ассистент из адреса — намерение', async () => {
    view = mount(<MemoryRouter initialEntries={['/chat?assistant=14']}><Probe /></MemoryRouter>);
    await flush();
    expect(JSON.parse(localStorage.getItem('pending_assistant') ?? 'null')?.value).toBe('14');
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/components/onboarding/useEntryParams.test.tsx
git commit -q -m "test(onboarding): общий хук параметров входа — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/onboarding/useEntryParams.test.tsx 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 3: реализация**

```ts
// src/components/onboarding/useEntryParams.ts
import { useEffect } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { rememberLoginIntent } from '../../utils/loginIntent';

const REFERRAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

/**
 * Что экран входа делал при открытии — общее у него и у пробы без входа
 * (spec 2026-10-30-guest-trial): рефссылка (?ref=) и намерение (?assistant=,
 * раздел кабинета) запоминаются, чтобы пережить вход. Без этого гость,
 * пришедший по реферальной ссылке, потерял бы привязку: экран входа он больше
 * не открывает.
 */
export function useEntryParams(): void {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  useEffect(() => {
    const refSlug = searchParams.get('ref');
    if (refSlug) {
      localStorage.setItem('referral_slug', refSlug);
      localStorage.setItem('referral_slug_expires', String(Date.now() + REFERRAL_TTL_MS));
    }
    // Последнее намерение побеждает (utils/loginIntent.ts).
    rememberLoginIntent(location.pathname, location.search);
  }, [searchParams, location.pathname, location.search]);
}
```

`src/pages/OnboardingPage.tsx`:
- `import React, { useEffect } from 'react';` → `import React from 'react';`
- `import { useLocation, useSearchParams } from 'react-router-dom';` → `import { useSearchParams } from 'react-router-dom';`
- `import { rememberLoginIntent } from '../utils/loginIntent';` → `import { useEntryParams } from '../components/onboarding/useEntryParams';`
- удалить строку `const REFERRAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней`
- блок от `  const location = useLocation();` до `  }, [searchParams, location.pathname, location.search]);` включительно заменить одной строкой `  useEntryParams();` (строка `const [searchParams] = useSearchParams();` остаётся — её читает сегмент `seg`).

- [ ] **Шаг 4: прогнать — PASS, старый тест экрана входа зелёный**

```bash
git add src/components/onboarding/useEntryParams.ts src/pages/OnboardingPage.tsx
git commit -q -m "refactor(onboarding): параметры входа — общим хуком для экрана входа и пробы

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/onboarding/useEntryParams.test.tsx src/pages/OnboardingPage.intent.test.tsx 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

### Задача B7: тексты `guest.*` на семи языках

**Files:**
- Create: `.superpowers/add-guest-keys.mjs` (не коммитится)
- Modify: `src/i18n/locales/{ru,en,es,de,fr,zh,pt}.json`

- [ ] **Шаг 1: скрипт** — `.superpowers/add-guest-keys.mjs`:

```js
// Добавляет блок guest.* в семь локалей. Файлы переписываются целиком через
// JSON.stringify(…, null, 2) — до правки проверяется, что это ничего не меняет
// в остальных строках (на 30.10.2026 все семь файлов так и записаны).
import { readFileSync, writeFileSync } from 'node:fs';

const KEYS = {
  ru: {
    login: 'Войти',
    backToChat: '← Вернуться к разговору',
    pickAssistant: 'Выбрать ассистента',
    pickLocked: 'Чтобы поговорить с другими ассистентами, войдите',
    empty: '{{name}} ответит сразу, без регистрации. Расскажите, с чем пришли.',
    inputPlaceholder: 'Ваше сообщение…',
    send: 'Отправить',
    typing: '{{name}} печатает…',
    trialNote: 'Первые ответы — без входа. Потом попросим войти, чтобы сохранить разговор.',
    wall: {
      title: 'Чтобы продолжить и сохранить разговор, войдите',
      text: 'Это бесплатно — 25 000 токенов в подарок. Разговор сохранится в вашем аккаунте.',
      closedTitle: 'Пробный режим сейчас недоступен',
      closedText: 'Войдите — это бесплатно, 25 000 токенов в подарок, — и {{name}} ответит сразу.',
    },
    errors: {
      model: 'Не получилось ответить. Отправьте сообщение ещё раз.',
      busy: 'Сейчас много желающих. Попробуйте через минуту.',
      network: 'Нет связи с сервером. Проверьте интернет и отправьте ещё раз.',
    },
  },
  en: {
    login: 'Sign in',
    backToChat: '← Back to the conversation',
    pickAssistant: 'Choose an assistant',
    pickLocked: 'Sign in to talk to other assistants',
    empty: '{{name}} will answer right away, no sign-up needed. Tell us what brought you here.',
    inputPlaceholder: 'Your message…',
    send: 'Send',
    typing: '{{name}} is typing…',
    trialNote: 'Your first answers come without signing in. Then we will ask you to sign in to save the conversation.',
    wall: {
      title: 'Sign in to continue and save the conversation',
      text: "It's free — 25,000 tokens as a gift. The conversation will be saved in your account.",
      closedTitle: 'Trial mode is unavailable right now',
      closedText: "Sign in — it's free, with 25,000 tokens as a gift — and {{name}} will answer right away.",
    },
    errors: {
      model: "Couldn't answer. Please send the message again.",
      busy: 'Lots of people right now. Please try again in a minute.',
      network: 'No connection to the server. Check your internet and send again.',
    },
  },
  es: {
    login: 'Iniciar sesión',
    backToChat: '← Volver a la conversación',
    pickAssistant: 'Elegir asistente',
    pickLocked: 'Inicia sesión para hablar con otros asistentes',
    empty: '{{name}} responderá enseguida, sin registro. Cuenta qué te trae por aquí.',
    inputPlaceholder: 'Tu mensaje…',
    send: 'Enviar',
    typing: '{{name}} está escribiendo…',
    trialNote: 'Las primeras respuestas llegan sin iniciar sesión. Después te pediremos que inicies sesión para guardar la conversación.',
    wall: {
      title: 'Inicia sesión para continuar y guardar la conversación',
      text: 'Es gratis: 25.000 tokens de regalo. La conversación se guardará en tu cuenta.',
      closedTitle: 'El modo de prueba no está disponible ahora mismo',
      closedText: 'Inicia sesión (es gratis y te regalamos 25.000 tokens) y {{name}} te responderá enseguida.',
    },
    errors: {
      model: 'No se pudo responder. Envía el mensaje de nuevo.',
      busy: 'Ahora mismo hay mucha gente. Inténtalo dentro de un minuto.',
      network: 'Sin conexión con el servidor. Revisa tu internet y envía de nuevo.',
    },
  },
  de: {
    login: 'Anmelden',
    backToChat: '← Zurück zum Gespräch',
    pickAssistant: 'Assistenten wählen',
    pickLocked: 'Melde dich an, um mit anderen Assistenten zu sprechen',
    empty: '{{name}} antwortet sofort, ohne Registrierung. Erzähl, worum es geht.',
    inputPlaceholder: 'Deine Nachricht…',
    send: 'Senden',
    typing: '{{name}} schreibt…',
    trialNote: 'Die ersten Antworten bekommst du ohne Anmeldung. Danach bitten wir dich, dich anzumelden, damit das Gespräch gespeichert wird.',
    wall: {
      title: 'Melde dich an, um weiterzumachen und das Gespräch zu speichern',
      text: 'Das ist kostenlos — 25.000 Tokens geschenkt. Das Gespräch wird in deinem Konto gespeichert.',
      closedTitle: 'Der Probemodus ist gerade nicht verfügbar',
      closedText: 'Melde dich an — kostenlos, mit 25.000 Tokens geschenkt — und {{name}} antwortet sofort.',
    },
    errors: {
      model: 'Das hat nicht geklappt. Schick die Nachricht bitte noch einmal.',
      busy: 'Gerade ist viel los. Versuch es in einer Minute noch einmal.',
      network: 'Keine Verbindung zum Server. Prüf dein Internet und schick die Nachricht noch einmal.',
    },
  },
  fr: {
    login: 'Se connecter',
    backToChat: '← Revenir à la conversation',
    pickAssistant: 'Choisir un assistant',
    pickLocked: "Connecte-toi pour parler à d'autres assistants",
    empty: "{{name}} répond tout de suite, sans inscription. Dis ce qui t'amène.",
    inputPlaceholder: 'Ton message…',
    send: 'Envoyer',
    typing: '{{name}} écrit…',
    trialNote: 'Les premières réponses arrivent sans connexion. Ensuite, on te demandera de te connecter pour enregistrer la conversation.',
    wall: {
      title: 'Connecte-toi pour continuer et enregistrer la conversation',
      text: "C'est gratuit : 25 000 jetons offerts. La conversation sera enregistrée dans ton compte.",
      closedTitle: "Le mode d'essai n'est pas disponible pour le moment",
      closedText: "Connecte-toi — c'est gratuit, avec 25 000 jetons offerts — et {{name}} te répondra tout de suite.",
    },
    errors: {
      model: "La réponse n'a pas pu être générée. Renvoie le message.",
      busy: 'Il y a beaucoup de monde en ce moment. Réessaie dans une minute.',
      network: 'Pas de connexion au serveur. Vérifie ta connexion internet et renvoie le message.',
    },
  },
  zh: {
    login: '登录',
    backToChat: '← 返回对话',
    pickAssistant: '选择助手',
    pickLocked: '登录后即可与其他助手交谈',
    empty: '{{name}}会立即回答，无需注册。说说你遇到的问题吧。',
    inputPlaceholder: '输入你的消息…',
    send: '发送',
    typing: '{{name}}正在输入…',
    trialNote: '前几条回答无需登录。之后我们会请你登录，以保存对话。',
    wall: {
      title: '登录即可继续并保存对话',
      text: '完全免费——赠送25,000代币。对话将保存在你的账户中。',
      closedTitle: '试用模式暂时不可用',
      closedText: '登录即可——免费，赠送25,000代币——{{name}}会立即回答。',
    },
    errors: {
      model: '未能生成回答。请重新发送消息。',
      busy: '当前人数较多，请一分钟后再试。',
      network: '无法连接服务器。请检查网络后重新发送。',
    },
  },
  pt: {
    login: 'Iniciar sessão',
    backToChat: '← Voltar à conversa',
    pickAssistant: 'Escolher assistente',
    pickLocked: 'Inicie sessão para falar com outros assistentes',
    empty: '{{name}} responde de imediato, sem registo. Escreva o que precisa.',
    inputPlaceholder: 'A sua mensagem…',
    send: 'Enviar',
    typing: '{{name}} está a escrever…',
    trialNote: 'As primeiras respostas chegam sem iniciar sessão. Depois pedimos que inicie sessão para guardar a conversa.',
    wall: {
      title: 'Inicie sessão para continuar e guardar a conversa',
      text: 'É gratuito: 25 000 tokens de oferta. A conversa fica guardada na sua conta.',
      closedTitle: 'O modo de experiência não está disponível neste momento',
      closedText: 'Inicie sessão — é gratuito, com 25 000 tokens de oferta — e {{name}} responde de imediato.',
    },
    errors: {
      model: 'Não foi possível responder. Envie a mensagem novamente.',
      busy: 'Há muita procura neste momento. Tente dentro de um minuto.',
      network: 'Sem ligação ao servidor. Verifique a internet e envie novamente.',
    },
  },
};

for (const [lang, block] of Object.entries(KEYS)) {
  const file = `src/i18n/locales/${lang}.json`;
  const src = readFileSync(file, 'utf8');
  const data = JSON.parse(src);
  if (JSON.stringify(data, null, 2) + '\n' !== src) throw new Error(`${file}: формат не совпадает с JSON.stringify — добавить ключи руками`);
  if (data.guest) throw new Error(`${file}: блок guest уже есть`);
  data.guest = block;
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`${file}: guest.* добавлен`);
}
```

- [ ] **Шаг 2: прогнать скрипт, проверить паритет**

```bash
node .superpowers/add-guest-keys.mjs
git diff --stat -- src/i18n/locales
git add src/i18n/locales/ru.json src/i18n/locales/en.json src/i18n/locales/es.json src/i18n/locales/de.json src/i18n/locales/fr.json src/i18n/locales/zh.json src/i18n/locales/pt.json
git commit -q -m "i18n(guest): тексты пробы без входа на семи языках

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'node scripts/check-locales.mjs | tail -3'
```
Ожидание: в diff только добавленные строки в конце каждого файла; `check-locales` зелёный.

### Задача B8: чат пробы

**Files:**
- Create: `src/components/guest/GuestChat.tsx`, `src/components/guest/GuestChat.test.tsx`

- [ ] **Шаг 1: тест**

```tsx
// src/components/guest/GuestChat.test.tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byButton, click, clickAsync, flush, mount, type, visibleText, type Mounted } from '../../test/dom';

vi.mock('react-i18next', async () => {
  const { tRu: t } = await import('../../test/dom');
  return { useTranslation: () => ({ t, i18n: { language: 'ru' } }) };
});
vi.mock('../onboarding/LoginTabs', () => ({ default: () => <div>форма входа</div> }));
vi.mock('../onboarding/LoginConsentBlock', () => ({
  default: ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
    <input type="checkbox" data-testid="consent-checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  ),
}));
vi.mock('../../services/eventsClient', () => ({ track: vi.fn(), getSource: () => null, getCampaign: () => null, getSessionId: () => 's_test' }));
vi.mock('./guestApi', () => ({ sendGuestMessage: vi.fn() }));

import { track } from '../../services/eventsClient';
import { sendGuestMessage } from './guestApi';
import GuestChat, { type GuestChatProps } from './GuestChat';

const send = sendGuestMessage as unknown as ReturnType<typeof vi.fn>;
const TOKEN = 'T'.repeat(43);

const answer = (text: string, extra: object[] = []) => async (_i: unknown, on: (e: any) => void) => {
  on({ type: 'guest', token: TOKEN, left: 3 });
  on({ type: 'begin' });
  on({ type: 'item', content: text.slice(0, 3) });
  on({ type: 'end', content: text });
  extra.forEach(on);
  return 'ok';
};

let view: Mounted | null = null;
function open(over: Partial<GuestChatProps> = {}) {
  const props: GuestChatProps = {
    assistantId: '12', assistantName: 'Роман', config: { mode: 'on', answersPerTrial: 3, maxChars: 2000 },
    token: null, initialMessages: [], initialLeft: null, draft: null, preview: false,
    onToken: vi.fn(), onStarted: vi.fn(), onTrialGone: vi.fn(), ...over,
  };
  view = mount(<GuestChat {...props} />);
  return props;
}
const input = () => view!.container.querySelector('[data-testid="guest-chat-input"]') as HTMLTextAreaElement;

beforeEach(() => { localStorage.clear(); send.mockReset(); (track as any).mockClear(); });
afterEach(() => { view?.unmount(); view = null; });

describe('чат пробы', () => {
  it('без согласия отправить нельзя; галочка открывает кнопку', async () => {
    open();
    type(input(), 'Привет');
    expect(byButton(view!.container, /Отправить/)!.disabled).toBe(true);
    click(view!.container.querySelector('[data-testid="consent-checkbox"]')!);
    expect(byButton(view!.container, /Отправить/)!.disabled).toBe(false);
    expect(localStorage.getItem('loginConsent')).toBe('true');
  });

  it('ответ печатается и встаёт в ленту; ключ уходит наверх', async () => {
    localStorage.setItem('loginConsent', 'true');
    send.mockImplementation(answer('Здравствуйте'));
    const p = open();
    type(input(), 'Привет');
    await clickAsync(byButton(view!.container, /Отправить/)!);
    await flush();
    expect(visibleText(view!.container)).toContain('Привет');
    expect(visibleText(view!.container)).toContain('Здравствуйте');
    expect(p.onToken).toHaveBeenCalledWith(TOKEN);
    expect(p.onStarted).toHaveBeenCalled();
  });

  it('стена после ответа: форма входа, поле убрано, событие', async () => {
    localStorage.setItem('loginConsent', 'true');
    send.mockImplementation(answer('Третий ответ', [{ type: 'wall', reason: 'limit' }]));
    open();
    type(input(), 'Вопрос');
    await clickAsync(byButton(view!.container, /Отправить/)!);
    await flush();
    expect(visibleText(view!.container)).toContain('Третий ответ');
    expect(visibleText(view!.container)).toContain('Чтобы продолжить и сохранить разговор, войдите');
    expect(visibleText(view!.container)).toContain('форма входа');
    expect(input()).toBeNull();
    expect(track).toHaveBeenCalledWith('guest_trial_wall', { reason: 'limit', assistant_id: '12' });
  });

  it('проба закрыта до ответа: текст ждёт входа черновиком', async () => {
    localStorage.setItem('loginConsent', 'true');
    send.mockImplementation(async (_i: unknown, on: (e: any) => void) => {
      on({ type: 'guest', left: 0 });
      on({ type: 'wall', reason: 'closed' });
      return 'ok';
    });
    open();
    type(input(), 'Мой вопрос');
    await clickAsync(byButton(view!.container, /Отправить/)!);
    await flush();
    expect(visibleText(view!.container)).toContain('Пробный режим сейчас недоступен');
    expect(JSON.parse(localStorage.getItem('pending_draft') ?? 'null')).toMatchObject({ text: 'Мой вопрос', assistant: '12' });
  });

  it('сбой модели: ошибка, сообщение вернулось в поле', async () => {
    localStorage.setItem('loginConsent', 'true');
    send.mockImplementation(async (_i: unknown, on: (e: any) => void) => {
      on({ type: 'guest', left: 3 });
      on({ type: 'error', code: 'model' });
      return 'ok';
    });
    open();
    type(input(), 'Вопрос');
    await clickAsync(byButton(view!.container, /Отправить/)!);
    await flush();
    expect(visibleText(view!.container)).toContain('Не получилось ответить');
    expect(input().value).toBe('Вопрос');
  });

  it('вопрос с лендинга при данном согласии уходит сам; черновик без пометки — только в поле', async () => {
    localStorage.setItem('loginConsent', 'true');
    send.mockImplementation(answer('Ответ'));
    open({ draft: { text: 'Как поднять цены?', auto: true } });
    await flush();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ message: 'Как поднять цены?', assistantId: '12', sid: 's_test' });
    view!.unmount();
    send.mockClear();
    open({ draft: { text: 'Данные рождения', auto: false } });
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(input().value).toBe('Данные рождения');
  });

  it('проба пропала — наверх уходит неотправленный текст', async () => {
    localStorage.setItem('loginConsent', 'true');
    send.mockResolvedValue('trial_gone');
    const p = open({ token: TOKEN, initialMessages: [{ role: 'user', content: 'В' }, { role: 'assistant', content: 'О' }], initialLeft: 2 });
    type(input(), 'Ещё вопрос');
    await clickAsync(byButton(view!.container, /Отправить/)!);
    await flush();
    expect(p.onTrialGone).toHaveBeenCalledWith('Ещё вопрос');
  });

  it('восстановленная проба без остатка — сразу стена', () => {
    open({ token: TOKEN, initialMessages: [{ role: 'user', content: 'В' }, { role: 'assistant', content: 'О' }], initialLeft: 0 });
    expect(visibleText(view!.container)).toContain('форма входа');
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/components/guest/GuestChat.test.tsx
git commit -q -m "test(guest): чат пробы — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/GuestChat.test.tsx 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 3: реализация**

```tsx
// src/components/guest/GuestChat.tsx
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import LoginTabs from '../onboarding/LoginTabs';
import LoginConsentBlock from '../onboarding/LoginConsentBlock';
import { parseCustomMarkdown } from '../../utils/customMarkdown';
import { savePendingDraft } from '../../utils/pendingDraft';
import { getCampaign, getSessionId, getSource, track } from '../../services/eventsClient';
import { sendGuestMessage } from './guestApi';
import type { GuestConfig, GuestEvent, GuestMessage } from './guestTypes';

export interface GuestChatProps {
  assistantId: string;
  assistantName: string;
  config: GuestConfig;
  /** Ключ начатой пробы (после перезагрузки страницы); null — проба новая. */
  token: string | null;
  initialMessages: GuestMessage[];
  /** Сколько ответов осталось у начатой пробы; null — проба новая. */
  initialLeft: number | null;
  /** Черновик: вопрос с лендинга (auto) или текст, который только подставить. */
  draft: { text: string; auto: boolean } | null;
  preview: boolean;
  onToken: (token: string) => void;
  onStarted: () => void;
  /** Проба на сервере пропала (7 дней, другой ассистент) — начать новую с этим текстом. */
  onTrialGone: (unsent: string) => void;
}

type Wall = 'limit' | 'closed';
type ErrorKind = 'model' | 'busy' | 'network';

/** Та же отметка, что у галочки на экране входа: дал согласие здесь — там она уже стоит. */
const CONSENT_KEY = 'loginConsent';

function readConsent(): boolean {
  try { return localStorage.getItem(CONSENT_KEY) === 'true'; } catch { return false; }
}

/** Ответ без кнопок и медиа из разметки ассистента: в пробе их нечем исполнить. */
const GuestAnswer: React.FC<{ content: string }> = ({ content }) => {
  const { content: text } = parseCustomMarkdown(content, { streaming: true });
  return (
    <div className="prose prose-sm max-w-none text-gray-800">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
};

/**
 * Чат пробы без входа (spec 2026-10-30-guest-trial). Лента и поле скрыты от
 * Вебвизора, как и обычный чат (webvisorPrivacy.test.ts).
 */
const GuestChat: React.FC<GuestChatProps> = (props) => {
  const { assistantId, assistantName, config, preview } = props;
  const { t, i18n } = useTranslation();
  const [messages, setMessages] = useState<GuestMessage[]>(props.initialMessages);
  const [partial, setPartial] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [wall, setWall] = useState<Wall | null>(props.initialLeft === 0 ? 'limit' : null);
  const [error, setError] = useState<ErrorKind | null>(null);
  const [consent, setConsent] = useState<boolean>(readConsent);
  const tokenRef = useRef<string | null>(props.token);
  const draftTaken = useRef(false);

  const changeConsent = (value: boolean) => {
    setConsent(value);
    try { localStorage.setItem(CONSENT_KEY, value ? 'true' : 'false'); } catch { /* приватный режим */ }
  };

  const send = async (raw: string) => {
    const message = raw.trim();
    if (!message || sending || wall || !consent || message.length > config.maxChars) return;
    const first = messages.length === 0;
    setSending(true);
    setError(null);
    setPartial('');
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: message }]);
    if (first) props.onStarted();

    let answer = null as string | null;
    let gotWall = null as Wall | null;
    let gotError = null as ErrorKind | null;
    const result = await sendGuestMessage(
      {
        token: tokenRef.current,
        assistantId,
        message,
        lang: i18n.language,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        preview,
        source: getSource(),
        campaign: getCampaign(),
        sid: getSessionId(),
      },
      (ev: GuestEvent) => {
        if (ev.type === 'guest' && ev.token) {
          tokenRef.current = ev.token;
          props.onToken(ev.token);
        } else if (ev.type === 'item') {
          setPartial((s) => (s ?? '') + ev.content);
        } else if (ev.type === 'end') {
          answer = ev.content;
        } else if (ev.type === 'wall') {
          gotWall = ev.reason;
        } else if (ev.type === 'error') {
          gotError = ev.code;
        }
      },
    );
    setPartial(null);

    if (result === 'trial_gone') {
      setMessages((m) => m.slice(0, -1));
      setSending(false);
      props.onTrialGone(message);
      return;
    }
    if (answer !== null) {
      const text = answer;
      setMessages((m) => [...m, { role: 'assistant', content: text }]);
    } else {
      // Ответа нет — сообщение возвращается в поле: отправить ещё раз или, если
      // проба закрыта, дождаться входа черновиком в чате с тем же ассистентом.
      setMessages((m) => m.slice(0, -1));
      setInput(message);
      if (gotWall) savePendingDraft(message, assistantId);
    }
    if (gotWall) {
      setWall(gotWall);
      track('guest_trial_wall', { reason: gotWall, assistant_id: assistantId });
    } else if (answer === null) {
      setError(gotError ?? (result === 'busy_trial' ? 'busy' : result === 'network' ? 'network' : 'model'));
    }
    setSending(false);
  };

  useEffect(() => {
    if (draftTaken.current || !props.draft) return;
    draftTaken.current = true;
    if (props.draft.auto && consent && messages.length === 0 && !wall) void send(props.draft.text);
    else setInput(props.draft.text);
    // Только при первом показе: черновик подставляется один раз.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const locked = sending || wall !== null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div data-testid="guest-messages-list" className="flex-1 space-y-4 overflow-y-auto px-4 py-6 ym-hide-content">
        {messages.length === 0 && partial === null && !wall && (
          <p className="text-center text-sm text-gray-500">{t('guest.empty', { name: assistantName })}</p>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-forest-700 px-4 py-3 text-white">
              {m.content}
            </div>
          ) : (
            <div key={i} className="max-w-[90%] rounded-2xl rounded-bl-md border border-gray-100 bg-white px-4 py-3">
              <GuestAnswer content={m.content} />
            </div>
          ),
        )}
        {partial !== null && (
          <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-gray-100 bg-white px-4 py-3">
            {partial ? (
              <GuestAnswer content={partial} />
            ) : (
              <span className="text-sm text-gray-500">{t('guest.typing', { name: assistantName })}</span>
            )}
          </div>
        )}
        {wall && (
          <div data-testid="guest-wall" className="rounded-2xl border border-forest-100 bg-white p-5 shadow-sm">
            <p className="font-semibold text-gray-900">{wall === 'limit' ? t('guest.wall.title') : t('guest.wall.closedTitle')}</p>
            <p className="mt-1 text-sm text-gray-600">
              {wall === 'limit' ? t('guest.wall.text') : t('guest.wall.closedText', { name: assistantName })}
            </p>
            <div className="mt-4">
              <LoginTabs />
            </div>
          </div>
        )}
      </div>
      {!wall && (
        <div className="space-y-2 border-t border-gray-100 bg-white px-4 py-3">
          {error && <p role="alert" className="text-sm text-red-600">{t(`guest.errors.${error}`)}</p>}
          {!consent && <LoginConsentBlock checked={consent} onChange={changeConsent} />}
          <div className="flex items-end gap-2">
            <textarea
              data-testid="guest-chat-input"
              className="flex-1 resize-none rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-forest-600 ym-disable-keys"
              rows={2}
              maxLength={config.maxChars}
              value={input}
              disabled={locked}
              placeholder={t('guest.inputPlaceholder')}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            <button
              type="button"
              disabled={locked || !consent || !input.trim()}
              onClick={() => void send(input)}
              className="rounded-xl bg-forest-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {t('guest.send')}
            </button>
          </div>
          <p className="text-xs text-gray-500">{t('guest.trialNote')}</p>
        </div>
      )}
    </div>
  );
};

export default GuestChat;
```

- [ ] **Шаг 4: прогнать — PASS и закоммитить**

```bash
git add src/components/guest/GuestChat.tsx
git commit -q -m "feat(guest): чат пробы — поток, согласие, стена с формой входа

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/GuestChat.test.tsx 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

### Задача B9: страница пробы

**Files:**
- Create: `src/components/guest/GuestChatPage.tsx`, `src/components/guest/GuestChatPage.test.tsx`

- [ ] **Шаг 1: тест**

```tsx
// src/components/guest/GuestChatPage.test.tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { byButton, click, flush, mount, visibleText, type Mounted } from '../../test/dom';

vi.mock('react-i18next', async () => {
  const { tRu: t } = await import('../../test/dom');
  return { useTranslation: () => ({ t, i18n: { language: 'ru' } }) };
});
vi.mock('../../pages/OnboardingPage', () => ({ default: () => <div>экран входа</div> }));
vi.mock('../../services/avatarService', () => ({ avatarService: { getAvatarUrl: vi.fn(async () => '') } }));
vi.mock('../../services/eventsClient', () => ({ track: vi.fn() }));
vi.mock('./GuestChat', () => ({
  default: (p: any) => <div>чат:{p.assistantId}:{p.assistantName}:{p.initialMessages.length}:{p.draft?.text ?? ''}</div>,
}));
vi.mock('./guestApi', () => ({ fetchGuestAgents: vi.fn(), loadGuestSession: vi.fn() }));

import { fetchGuestAgents, loadGuestSession } from './guestApi';
import GuestChatPage from './GuestChatPage';

const agents = fetchGuestAgents as unknown as ReturnType<typeof vi.fn>;
const session = loadGuestSession as unknown as ReturnType<typeof vi.fn>;
const TOKEN = 'T'.repeat(43);
const CONFIG = { mode: 'on' as const, answersPerTrial: 3, maxChars: 2000 };

let view: Mounted | null = null;
async function open(url: string) {
  view = mount(<MemoryRouter initialEntries={[url]}><GuestChatPage config={CONFIG} preview={false} /></MemoryRouter>);
  await flush();
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  agents.mockResolvedValue([{ id: '12', name: 'Роман' }, { id: '14', name: 'Райя' }]);
  session.mockResolvedValue(null);
});
afterEach(() => { view?.unmount(); view = null; });

describe('страница пробы', () => {
  it('ассистент из адреса', async () => {
    await open('/chat?assistant=14');
    expect(visibleText(view!.container)).toContain('чат:14:Райя:0');
  });

  it('без адреса — Роман', async () => {
    await open('/chat');
    expect(visibleText(view!.container)).toContain('чат:12:Роман:0');
  });

  it('начатая проба восстанавливается, выбор ассистента закрыт', async () => {
    localStorage.setItem('guest_trial', JSON.stringify({ token: TOKEN, assistantId: '14' }));
    session.mockResolvedValue({ assistantId: '14', messages: [{ role: 'user', content: 'В' }, { role: 'assistant', content: 'О' }], left: 2 });
    await open('/chat?assistant=12');
    expect(visibleText(view!.container)).toContain('чат:14:Райя:2');
    expect(view!.container.querySelector('select')).toBeNull();
    expect(visibleText(view!.container)).toContain('Чтобы поговорить с другими ассистентами, войдите');
  });

  it('проба на сервере пропала — ключ забыт, новая проба', async () => {
    localStorage.setItem('guest_trial', JSON.stringify({ token: TOKEN, assistantId: '14' }));
    await open('/chat');
    expect(localStorage.getItem('guest_trial')).toBeNull();
    expect(visibleText(view!.container)).toContain('чат:12:Роман:0');
  });

  it('вопрос с лендинга доходит до чата', async () => {
    localStorage.setItem('pending_draft', JSON.stringify({ text: 'Как поднять цены?', assistant: '12', expires: Date.now() + 60000, auto: true }));
    await open('/chat?assistant=12');
    expect(visibleText(view!.container)).toContain('чат:12:Роман:0:Как поднять цены?');
  });

  it('ассистенты не загрузились — экран входа', async () => {
    agents.mockResolvedValue([]);
    await open('/chat');
    expect(visibleText(view!.container)).toContain('экран входа');
  });

  it('«Войти» открывает экран входа, «Вернуться» — обратно в чат', async () => {
    await open('/chat');
    click(byButton(view!.container, /^Войти$/)!);
    expect(visibleText(view!.container)).toContain('экран входа');
    click(byButton(view!.container, /Вернуться к разговору/)!);
    expect(visibleText(view!.container)).toContain('чат:12:Роман:0');
  });

  it('рефссылка запоминается и в пробе', async () => {
    await open('/chat?ref=abc');
    expect(localStorage.getItem('referral_slug')).toBe('abc');
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/components/guest/GuestChatPage.test.tsx
git commit -q -m "test(guest): страница пробы — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/GuestChatPage.test.tsx 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 3: реализация**

```tsx
// src/components/guest/GuestChatPage.tsx
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import OnboardingPage from '../../pages/OnboardingPage';
import { avatarService } from '../../services/avatarService';
import { track } from '../../services/eventsClient';
import { rememberPendingAssistant } from '../../utils/pendingAssistant';
import { takePendingDraftEntry } from '../../utils/pendingDraft';
import { useEntryParams } from '../onboarding/useEntryParams';
import GuestChat from './GuestChat';
import { fetchGuestAgents, loadGuestSession } from './guestApi';
import { forgetTrial, readTrial, saveTrial } from './guestStorage';
import type { GuestAgent, GuestConfig, GuestMessage } from './guestTypes';

/** Роман — универсальный ассистент: к нему ведёт и поле в первом экране лендинга. */
const DEFAULT_ASSISTANT = '12';

interface Props {
  config: GuestConfig;
  preview: boolean;
}

interface Restored {
  token: string;
  messages: GuestMessage[];
  left: number;
}

const Spinner: React.FC = () => (
  <div className="flex min-h-screen items-center justify-center bg-gray-50">
    <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
  </div>
);

/** Кабинет без входа: проба с ассистентом (spec 2026-10-30-guest-trial). */
const GuestChatPage: React.FC<Props> = ({ config, preview }) => {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  useEntryParams();
  const [agents, setAgents] = useState<GuestAgent[] | null>(null);
  const [assistantId, setAssistantId] = useState<string>(DEFAULT_ASSISTANT);
  const [restored, setRestored] = useState<Restored | null>(null);
  const [draft, setDraft] = useState<{ text: string; auto: boolean } | null>(null);
  const [started, setStarted] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [showLogin, setShowLogin] = useState(false);
  const [avatar, setAvatar] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await fetchGuestAgents(i18n.language);
      const stored = readTrial();
      let chosen: string | null = null;
      let rest: Restored | null = null;
      if (stored) {
        const s = await loadGuestSession(stored.token);
        if (s && list.some((a) => a.id === s.assistantId)) {
          chosen = s.assistantId;
          rest = { token: stored.token, messages: s.messages, left: s.left };
        } else {
          forgetTrial();
        }
      }
      if (!chosen) {
        const fromUrl = (searchParams.get('assistant') || '').trim();
        if (list.some((a) => a.id === fromUrl)) chosen = fromUrl;
        else if (list.some((a) => a.id === DEFAULT_ASSISTANT)) chosen = DEFAULT_ASSISTANT;
        else chosen = list[0]?.id ?? DEFAULT_ASSISTANT;
      }
      if (!alive) return;
      setAgents(list);
      setAssistantId(chosen);
      setRestored(rest);
      setStarted(!!rest && rest.messages.length > 0);
      setDraft(rest ? null : takePendingDraftEntry(chosen));
      track('guest_trial_view', { assistant_id: chosen, restored: !!rest });
    })();
    return () => { alive = false; };
    // Один раз при открытии: дальше состояние ведёт сама страница.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    setAvatar(null);
    avatarService
      .getAvatarUrl(Number(assistantId))
      .then((url) => { if (alive && url) setAvatar(url); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [assistantId]);

  if (showLogin) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowLogin(false)}
          className="absolute left-4 top-4 z-20 text-sm font-medium text-forest-800 hover:underline"
        >
          {t('guest.backToChat')}
        </button>
        <OnboardingPage />
      </div>
    );
  }
  if (agents === null) return <Spinner />;
  if (agents.length === 0) return <OnboardingPage />;

  const name = agents.find((a) => a.id === assistantId)?.name ?? '';
  const onToken = (token: string) => {
    saveTrial({ token, assistantId });
    // После входа кабинет откроет этого ассистента.
    rememberPendingAssistant(assistantId);
  };
  const onTrialGone = (unsent: string) => {
    forgetTrial();
    setRestored(null);
    setStarted(false);
    setDraft({ text: unsent, auto: false });
    setGeneration((g) => g + 1);
  };

  return (
    <div className="flex h-screen flex-col bg-gray-50">
      <header className="flex items-center gap-3 border-b border-gray-100 bg-white px-4 py-3">
        {avatar ? (
          <img src={avatar} alt="" className="h-9 w-9 rounded-full object-cover" />
        ) : (
          <div className="h-9 w-9 rounded-full bg-forest-100" />
        )}
        <div className="min-w-0 flex-1">
          {started ? (
            <>
              <p className="truncate font-semibold text-gray-900">{name}</p>
              <p className="truncate text-xs text-gray-500">{t('guest.pickLocked')}</p>
            </>
          ) : (
            <select
              aria-label={t('guest.pickAssistant')}
              value={assistantId}
              onChange={(e) => {
                setAssistantId(e.target.value);
                setDraft(null);
                setGeneration((g) => g + 1);
              }}
              className="max-w-full rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm font-semibold text-gray-900"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowLogin(true)}
          className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-semibold text-gray-800 hover:bg-gray-50"
        >
          {t('guest.login')}
        </button>
      </header>
      <main className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <GuestChat
          key={`${assistantId}:${generation}`}
          assistantId={assistantId}
          assistantName={name}
          config={config}
          token={restored?.token ?? null}
          initialMessages={restored?.messages ?? []}
          initialLeft={restored ? restored.left : null}
          draft={draft}
          preview={preview}
          onToken={onToken}
          onStarted={() => setStarted(true)}
          onTrialGone={onTrialGone}
        />
      </main>
    </div>
  );
};

export default GuestChatPage;
```

- [ ] **Шаг 4: прогнать — PASS и закоммитить**

```bash
git add src/components/guest/GuestChatPage.tsx
git commit -q -m "feat(guest): страница пробы — выбор ассистента, восстановление, вход

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/GuestChatPage.test.tsx 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

### Задача B10: точка входа без аккаунта

**Files:**
- Create: `src/components/guest/UnauthenticatedEntry.tsx`, `src/components/guest/UnauthenticatedEntry.test.tsx`
- Modify: `src/App.tsx` (строки 10 и 215 по origin/main)

- [ ] **Шаг 1: тест**

```tsx
// src/components/guest/UnauthenticatedEntry.test.tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { flush, mount, visibleText, type Mounted } from '../../test/dom';

vi.mock('../../pages/OnboardingPage', () => ({ default: () => <div>экран входа</div> }));
vi.mock('./GuestChatPage', () => ({ default: (p: any) => <div>проба:{p.config.mode}:{String(p.preview)}</div> }));
vi.mock('./guestApi', () => ({ fetchGuestConfig: vi.fn() }));

import { fetchGuestConfig } from './guestApi';
import UnauthenticatedEntry from './UnauthenticatedEntry';

const config = fetchGuestConfig as unknown as ReturnType<typeof vi.fn>;
let view: Mounted | null = null;
async function open(url: string) {
  view = mount(<MemoryRouter initialEntries={[url]}><UnauthenticatedEntry /></MemoryRouter>);
  for (let i = 0; i < 5; i++) await flush();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  config.mockReset();
  delete (window as any).Capacitor;
});
afterEach(() => { view?.unmount(); view = null; });

describe('кабинет без входа', () => {
  it('режим «вкл», новое устройство — проба', async () => {
    config.mockResolvedValue({ mode: 'on', answersPerTrial: 3, maxChars: 2000 });
    await open('/chat');
    expect(visibleText(view!.container)).toContain('проба:on:false');
  });

  it('устройство, где входили, — экран входа без запроса к серверу', async () => {
    localStorage.setItem('linkeon_has_account', '1');
    await open('/chat');
    expect(visibleText(view!.container)).toContain('экран входа');
    expect(config).not.toHaveBeenCalled();
  });

  it('другой раздел и нативная сборка — экран входа без запроса', async () => {
    await open('/studio');
    expect(visibleText(view!.container)).toContain('экран входа');
    view!.unmount();
    (window as any).Capacitor = { isNativePlatform: () => true };
    await open('/chat');
    expect(visibleText(view!.container)).toContain('экран входа');
    expect(config).not.toHaveBeenCalled();
  });

  it('«предпросмотр» — только с ?trial=1', async () => {
    config.mockResolvedValue({ mode: 'preview', answersPerTrial: 3, maxChars: 2000 });
    await open('/chat');
    expect(visibleText(view!.container)).toContain('экран входа');
    view!.unmount();
    await open('/chat?trial=1');
    expect(visibleText(view!.container)).toContain('проба:preview:true');
  });

  it('сервер не ответил — экран входа', async () => {
    config.mockResolvedValue(null);
    await open('/');
    expect(visibleText(view!.container)).toContain('экран входа');
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/components/guest/UnauthenticatedEntry.test.tsx
git commit -q -m "test(guest): кабинет без входа — проба или экран входа — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/UnauthenticatedEntry.test.tsx 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 3: реализация**

```tsx
// src/components/guest/UnauthenticatedEntry.tsx
import React, { Suspense, lazy, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import OnboardingPage from '../../pages/OnboardingPage';
import { decideUnauthEntry } from './decideUnauthEntry';
import { fetchGuestConfig } from './guestApi';
import { hasAccount, previewRequested, rememberPreviewFromUrl } from './guestStorage';
import type { GuestConfig } from './guestTypes';

// Отдельным чанком: устройству, где уже входили, чат пробы не нужен вовсе, а
// экран входа должен открываться так же быстро, как раньше.
const GuestChatPage = lazy(() => import('./GuestChatPage'));

const isNative = (): boolean =>
  typeof window !== 'undefined' && !!(window as any).Capacitor?.isNativePlatform?.();

const Spinner: React.FC = () => (
  <div className="min-h-screen flex items-center justify-center bg-gray-50">
    <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
  </div>
);

/**
 * Кабинет без входа (spec 2026-10-30-guest-trial): проба с ассистентом или
 * экран входа. Правило — в decideUnauthEntry. Сервер спрашиваем, только когда
 * проба вообще возможна: иначе экран входа показывается сразу, без ожидания.
 */
const UnauthenticatedEntry: React.FC = () => {
  const location = useLocation();
  // До чтения previewRequested(): вкладка с ?trial=1 запоминается сразу.
  rememberPreviewFromUrl(location.search);
  const base = { native: isNative(), hasAccount: hasAccount(), pathname: location.pathname };
  const possible = decideUnauthEntry({ ...base, mode: 'on', preview: true }) === 'guest';
  const [config, setConfig] = useState<GuestConfig | null | undefined>(undefined);

  useEffect(() => {
    if (!possible) return;
    let alive = true;
    void fetchGuestConfig().then((c) => { if (alive) setConfig(c); });
    return () => { alive = false; };
  }, [possible]);

  if (!possible) return <OnboardingPage />;
  if (config === undefined) return <Spinner />;
  const preview = previewRequested();
  if (!config || decideUnauthEntry({ ...base, mode: config.mode, preview }) !== 'guest') return <OnboardingPage />;
  return (
    <Suspense fallback={<Spinner />}>
      <GuestChatPage config={config} preview={preview} />
    </Suspense>
  );
};

export default UnauthenticatedEntry;
```

`src/App.tsx`:
- строку `import OnboardingPage from './pages/OnboardingPage';            // eager: первый экран нового юзера — критичный путь к регистрации, грузим мгновенно` заменить на
```ts
import UnauthenticatedEntry from './components/guest/UnauthenticatedEntry'; // eager: первый экран без входа — проба или экран входа (spec 2026-10-30-guest-trial)
```
- в `AppContent` `return <OnboardingPage />;` заменить на `return <UnauthenticatedEntry />;`.

- [ ] **Шаг 4: прогнать — PASS, тесты App/онбординга зелёные**

```bash
git add src/components/guest/UnauthenticatedEntry.tsx src/App.tsx
git commit -q -m "feat(guest): кабинет без входа — проба для нового устройства

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest src/pages src/components/RootRedirect.test.tsx 2>&1 | grep -E "×|FAIL|Test Files|Tests  "'
```

### Задача B11: перенос при входе

**Files:**
- Create: `src/components/guest/guestClaim.ts`, `src/components/guest/guestClaim.test.ts`, `src/contexts/guestTrialWiring.test.ts`
- Modify: `src/contexts/AuthContext.tsx`

- [ ] **Шаг 1: тесты**

```ts
// src/components/guest/guestClaim.test.ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./guestApi', () => ({ claimGuestTrial: vi.fn() }));
import { claimGuestTrial } from './guestApi';
import { claimPendingGuestTrial } from './guestClaim';
import { readTrial, saveTrial } from './guestStorage';

const claim = claimGuestTrial as unknown as ReturnType<typeof vi.fn>;
const TOKEN = 'T'.repeat(43);

beforeEach(() => {
  localStorage.clear();
  claim.mockReset();
  saveTrial({ token: TOKEN, assistantId: '14' });
});

describe('перенос пробы при входе', () => {
  it('перенесено — ключ забыт, кабинет откроет ассистента', async () => {
    claim.mockResolvedValue({ status: 'claimed', assistantId: '14' });
    await claimPendingGuestTrial();
    expect(claim).toHaveBeenCalledWith(TOKEN);
    expect(readTrial()).toBeNull();
    expect(JSON.parse(localStorage.getItem('pending_assistant') ?? 'null')?.value).toBe('14');
  });

  it('пробы нет — ключ забыт', async () => {
    claim.mockResolvedValue({ status: 'gone' });
    await claimPendingGuestTrial();
    expect(readTrial()).toBeNull();
  });

  it('сбой и таймаут — ключ остаётся для следующей попытки', async () => {
    claim.mockResolvedValue({ status: 'retry' });
    await claimPendingGuestTrial();
    expect(readTrial()).not.toBeNull();
    claim.mockImplementation(() => new Promise(() => {}));
    await claimPendingGuestTrial(20);
    expect(readTrial()).not.toBeNull();
  });

  it('без пробы — ни одного запроса', async () => {
    localStorage.clear();
    await claimPendingGuestTrial();
    expect(claim).not.toHaveBeenCalled();
  });
});
```

```ts
// src/contexts/guestTrialWiring.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Проводка пробы без входа в AuthContext (spec 2026-10-30-guest-trial):
 * перенос — ДО setUser, иначе чат откроется и загрузит историю без пробы.
 */
const SRC = readFileSync(join(__dirname, 'AuthContext.tsx'), 'utf8');

describe('AuthContext: проба без входа', () => {
  it('вход: отметка устройства и перенос пробы — до setUser(newUser)', () => {
    const login = SRC.slice(SRC.indexOf('const login = useCallback'), SRC.indexOf('const logout'));
    const claimAt = login.indexOf('await claimPendingGuestTrial()');
    expect(login).toContain('markHasAccount()');
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(login.indexOf('setUser(newUser)'));
  });

  it('восстановление сессии тоже отмечает устройство и добирает перенос', () => {
    const init = SRC.slice(SRC.indexOf('const initAuth = async'), SRC.indexOf('initAuth();'));
    expect(init).toContain('markHasAccount()');
    expect(init).toContain('claimPendingGuestTrial()');
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/components/guest/guestClaim.test.ts src/contexts/guestTrialWiring.test.ts
git commit -q -m "test(guest): перенос пробы при входе — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest/guestClaim.test.ts src/contexts/guestTrialWiring.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 3: реализация**

```ts
// src/components/guest/guestClaim.ts
import { rememberPendingAssistant } from '../../utils/pendingAssistant';
import { claimGuestTrial, type GuestClaimResult } from './guestApi';
import { forgetTrial, readTrial } from './guestStorage';

/**
 * Перенести пробу этого устройства в аккаунт, в который только что вошли.
 * Не бросает и ждёт не дольше timeoutMs: вход важнее переноса. Сбой и таймаут
 * оставляют ключ — перенос повторится при следующем открытии кабинета (initAuth).
 */
export async function claimPendingGuestTrial(timeoutMs = 5000): Promise<void> {
  const trial = readTrial();
  if (!trial) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<GuestClaimResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'retry' }), timeoutMs);
  });
  try {
    const r = await Promise.race([claimGuestTrial(trial.token), timeout]);
    if (r.status === 'claimed') {
      rememberPendingAssistant(r.assistantId);
      forgetTrial();
    } else if (r.status === 'gone') {
      forgetTrial();
    }
  } catch {
    /* сеть — как retry */
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

`src/contexts/AuthContext.tsx`:
- импорты после `import { attributeSource } from '../services/eventsClient';`:
```ts
import { markHasAccount } from '../components/guest/guestStorage';
import { claimPendingGuestTrial } from '../components/guest/guestClaim';
```
- в `initAuth` блок
```ts
          if (isMounted) {
            setUser(parsedUser);
            persistUser(parsedUser);
          }
```
заменить на
```ts
          if (isMounted) {
            // Проба без входа: устройство «входило» — дальше ему экран входа, а
            // не проба; несостоявшийся при входе перенос добирается здесь.
            markHasAccount();
            void claimPendingGuestTrial();
            setUser(parsedUser);
            persistUser(parsedUser);
          }
```
- в `login` между `authService.registerReferral();` и `const tokens = await fetchUserTokens();` вставить
```ts
    // Проба без входа (spec 2026-10-30-guest-trial): устройство отныне «входило»,
    // а разговор пробы переезжает в аккаунт ДО того, как откроется чат, — иначе
    // чат загрузил бы историю без него. Не дольше 5 с; сбой входу не мешает.
    markHasAccount();
    await claimPendingGuestTrial();
```

- [ ] **Шаг 4: прогнать — PASS и закоммитить**

```bash
git add src/components/guest/guestClaim.ts src/contexts/AuthContext.tsx
git commit -q -m "feat(guest): перенос пробы в аккаунт при входе

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/guest src/contexts 2>&1 | grep -E "×|FAIL|Test Files|Tests  "'
```

### Задача B12: Вебвизор, сторож кириллицы, политика в кабинете

**Files:**
- Modify: `src/components/webvisorPrivacy.test.ts`, `scripts/check-no-hardcoded.mjs`, `src/components/onboarding/LegalModal.tsx`

- [ ] **Шаг 1: сторож Вебвизора** — в `src/components/webvisorPrivacy.test.ts`:
- рядом с остальными чтениями исходников:
```ts
const GuestChatSrc = readFileSync(join(__dirname, 'guest', 'GuestChat.tsx'), 'utf8');
```
- в конец файла:
```ts
describe('проба без входа скрыта от Вебвизора', () => {
  it('лента пробы — ym-hide-content', () => {
    expect(classesOf(GuestChatSrc, 'guest-messages-list', 'div')).toContain('ym-hide-content');
  });

  it('поле пробы — ym-disable-keys', () => {
    expect(classesOf(GuestChatSrc, 'guest-chat-input', 'textarea')).toContain('ym-disable-keys');
  });
});
```

- [ ] **Шаг 2: сторож кириллицы** — в `scripts/check-no-hardcoded.mjs` в массив `MIGRATED` после `'src/components/support',` добавить `'src/components/guest',`.

- [ ] **Шаг 3: политика в кабинете** — `src/components/onboarding/LegalModal.tsx`:
- RU, «1. Сбор информации»: после `<li>История сообщений и взаимодействий в Приложении</li>` добавить
```tsx
          <li>Сообщения пробного разговора с ассистентом до входа в Приложение</li>
```
- RU, «7. Хранение данных»: после `<li><strong>Логи безопасности:</strong> 6 месяцев</li>` добавить
```tsx
          <li><strong>Пробный разговор до входа:</strong> 7 дней после последнего сообщения, если его не перенесли в аккаунт; после переноса — как остальная переписка аккаунта</li>
```
- EN, «1. Information collected»: после `<li>History of messages and interactions in the Application</li>` добавить
```tsx
          <li>Messages of a trial conversation with an assistant before signing in to the Application</li>
```
- EN, «7. Data retention»: после `<li><strong>Security logs:</strong> 6 months</li>` добавить
```tsx
          <li><strong>Trial conversation before sign-in:</strong> 7 days after the last message unless it is moved to an account; once moved, like the rest of the account's conversations</li>
```

- [ ] **Шаг 4: прогнать и закоммитить**

```bash
git add src/components/webvisorPrivacy.test.ts scripts/check-no-hardcoded.mjs src/components/onboarding/LegalModal.tsx
git commit -q -m "feat(guest): проба скрыта от Вебвизора, каталог под сторожем кириллицы, политика

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test src/components/webvisorPrivacy.test.ts 2>&1 | grep -E "×|FAIL|Test Files|Tests  "; node scripts/check-no-hardcoded.mjs | tail -2; node scripts/check-keys-exist.mjs | tail -2'
```
Ожидание: Вебвизор — зелёный; `check-no-hardcoded` и `check-keys-exist` — зелёные (на main с 14.10 оба зелёные, красный = своя дыра).

### Задача B13: гейты кабинета

- [ ] **Шаг 1: полный прогон, типы дельтой, проверки локалей, сборка**

```bash
bash .superpowers/node-run.sh 'pnpm typecheck 2>&1 | grep -c "error TS"; pnpm typecheck 2>&1 | grep -E "src/components/guest|useEntryParams|guestClaim|pendingDraft|AuthContext|App.tsx" | head; pnpm test 2>&1 | grep -E "×|FAIL|Test Files|Tests  "; node scripts/check-locales.mjs | tail -1; node scripts/check-keys-exist.mjs | tail -1; node scripts/check-no-hardcoded.mjs | tail -1; node scripts/check-no-hardcoded-locale.mjs | tail -1; pnpm build >/tmp/gt-front-build.log 2>&1; echo build=$?'
```
Ожидание: число ошибок TS не выросло относительно базы, и ни одной в своих файлах (вторая команда пуста); `vitest` без новых падений; `check-locales`, `check-keys`, `check-no-hardcoded` — зелёные; `check-no-hardcoded-locale` — тот же вывод, что на базе (красный на main известен); `build=0`.

- [ ] **Шаг 2 (по желанию): посмотреть экран глазами** — стенд из `project_front_visual_preview_harness.md`: временная `preview-guest.html` + `src/__preview__/guest.tsx` с `GuestChatPage` и подменёнными `fetchGuestAgents`/`loadGuestSession`/`sendGuestMessage`; ширины 390 и 1280, языки `ru` и `de`. Стенд не коммитить, после проверки удалить и сверить `git status`.

- [ ] **Шаг 3: запушить ветку** (для ревью; не в main)

```bash
git push -q -u origin feat/guest-trial
```

---

## Часть C. Лендинг (land_linkeon)

Задачи C1–C3 и C5 — в воркдереве `~/Downloads/land_linkeon/.worktrees/guest-trial`; C4 — в своём воркдереве (там же указано). Тесты: `bash .superpowers/node-run.sh 'pnpm test:unit <файлы> 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'`.

### Задача C1: адрес с вопросом

**Files:**
- Modify: `src/lib/chatDraft.ts`, `src/lib/chatDraft.test.ts`

- [ ] **Шаг 1: тест** — в конец `src/lib/chatDraft.test.ts`, а в его импорт добавить `chatUrlWithAsk, askTarget`:

```ts
describe('ссылка с вопросом (#ask=)', () => {
  const askOf = (url: string) => decodeURIComponent(new URL(url).hash.slice('#ask='.length));

  it('вопрос — во фрагменте #ask=, ассистент и метка — в адресе', () => {
    const url = chatUrlWithAsk(12, 'hero-ask', 'Как поднять цены? 100%');
    expect(new URL(url).searchParams.get('assistant')).toBe('12');
    expect(new URL(url).searchParams.get('utm_content')).toBe('hero-ask');
    expect(askOf(url)).toBe('Как поднять цены? 100%');
  });

  it('длиннее лимита — обрезка по границе символа', () => {
    const text = 'я'.repeat(DRAFT_MAX_LENGTH - 1) + String.fromCodePoint(0x1f600);
    expect(askOf(chatUrlWithAsk(12, 'hero-ask', text))).toBe('я'.repeat(DRAFT_MAX_LENGTH - 1));
  });

  it('пустое поле — обычный переход в чат, без фрагмента', () => {
    expect(askTarget(12, 'hero-ask', '   ')).toBe(chatHref(12, 'hero-ask'));
    expect(askTarget(12, 'hero-ask', ' Вопрос ')).toBe(chatUrlWithAsk(12, 'hero-ask', 'Вопрос'));
  });
});
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/lib/chatDraft.test.ts
git commit -q -m "test(ask): ссылка с вопросом — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test:unit src/lib/chatDraft.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 3: реализация** — в конец `src/lib/chatDraft.ts`:

```ts
/**
 * Ссылка с вопросом во фрагменте (#ask=…): кабинет отправит его сам, как только
 * человек отметит согласие (проба без входа, spec 2026-10-30-guest-trial).
 * Строится, как и chatUrlWithDraft, только в момент нажатия.
 */
export function chatUrlWithAsk(assistantId: number, utmContent: string, message: string): string {
  return `${chatHref(assistantId, utmContent)}#ask=${encodeURIComponent(cut(message, DRAFT_MAX_LENGTH))}`;
}

/** Куда вести по кнопке «Спросить»: с вопросом — во фрагменте, без него — просто в чат. */
export function askTarget(assistantId: number, utmContent: string, message: string): string {
  const text = message.trim();
  return text ? chatUrlWithAsk(assistantId, utmContent, text) : chatHref(assistantId, utmContent);
}
```

- [ ] **Шаг 4: прогнать — PASS и закоммитить**

```bash
git add src/lib/chatDraft.ts
git commit -q -m "feat(ask): ссылка в чат с вопросом во фрагменте

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test:unit src/lib/chatDraft.test.ts 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

### Задача C2: поле вопроса и его тексты

**Files:**
- Create: `src/components/ui/AskBox.tsx`, `src/components/ui/AskBox.test.tsx`, `.superpowers/add-ask-keys.mjs` (не коммитится)
- Modify: `src/i18n/locales/{ru,en,es,de,fr,zh,pt}.json`

- [ ] **Шаг 1: тексты** — `.superpowers/add-ask-keys.mjs` (добавляет `ask.*` и `hero.askPlaceholder` с сегментами; формат файлов проверяется так же, как в Задаче B7):

```js
import { readFileSync, writeFileSync } from 'node:fs';

const ASK = {
  ru: { label: 'Ваш вопрос ассистенту', button: 'Спросить', note: 'Ответ сразу — без регистрации и карты', placeholderAssistant: 'Опишите ситуацию своими словами — {{name}} ответит сразу' },
  en: { label: 'Your question to the assistant', button: 'Ask', note: 'Answer right away — no sign-up, no card', placeholderAssistant: 'Describe your situation in your own words — {{name}} will answer right away' },
  de: { label: 'Frage an den Assistenten', button: 'Fragen', note: 'Antwort sofort — ohne Registrierung und ohne Karte', placeholderAssistant: 'Situation in eigenen Worten beschreiben — {{name}} antwortet sofort' },
  es: { label: 'Pregunta al asistente', button: 'Preguntar', note: 'Respuesta al instante, sin registro ni tarjeta', placeholderAssistant: 'Describa su situación con sus propias palabras: {{name}} responde al instante' },
  fr: { label: "Question à l'assistant", button: 'Demander', note: 'Réponse immédiate, sans inscription ni carte', placeholderAssistant: 'Décrire la situation avec ses propres mots — {{name}} répond tout de suite' },
  pt: { label: 'Pergunta ao assistente', button: 'Perguntar', note: 'Resposta imediata, sem registo nem cartão', placeholderAssistant: 'Descreva a situação por palavras suas — {{name}} responde de imediato' },
  zh: { label: '向助手提问', button: '提问', note: '立即回答——无需注册，无需绑卡', placeholderAssistant: '用自己的话描述情况——{{name}}会立即回答' },
};

// Подсказки поля в первом экране: базовая и под сегменты рекламы (?seg=).
// Сегмент video берёт базовую (heroT падает на неё сам).
const HERO = {
  ru: { base: 'Расскажите своими словами, с чем пришли, — ассистент ответит сразу', biz: 'Договор, налоги, текст для клиентов — опишите задачу', creator: 'Идея поста или ролика — расскажите, что задумали', assistant: 'Письмо, документ, пост — опишите, что нужно' },
  en: { base: 'Say in your own words what you need — the assistant answers right away', biz: 'A contract, taxes, copy for clients — describe the task', creator: 'An idea for a post or a video — tell us what you have in mind', assistant: 'A letter, a document, a post — describe what you need' },
  de: { base: 'In eigenen Worten erzählen, worum es geht — der Assistent antwortet sofort', biz: 'Vertrag, Steuern, Text für Kunden — Aufgabe beschreiben', creator: 'Idee für einen Post oder ein Video — erzählen, was geplant ist', assistant: 'Brief, Dokument, Post — beschreiben, was gebraucht wird' },
  es: { base: 'Cuente con sus palabras qué necesita: el asistente responde al instante', biz: 'Un contrato, impuestos, un texto para clientes: describa la tarea', creator: 'La idea de un post o un vídeo: cuente qué tiene en mente', assistant: 'Una carta, un documento, un post: describa lo que necesita' },
  fr: { base: "Dire avec ses mots ce dont on a besoin — l'assistant répond tout de suite", biz: 'Contrat, impôts, texte pour les clients — décrire la tâche', creator: "L'idée d'un post ou d'une vidéo — dire ce qu'on a en tête", assistant: 'Une lettre, un document, un post — décrire ce qu’il faut' },
  pt: { base: 'Conte por palavras suas o que precisa — o assistente responde de imediato', biz: 'Contrato, impostos, texto para clientes — descreva a tarefa', creator: 'A ideia de uma publicação ou de um vídeo — conte o que tem em mente', assistant: 'Uma carta, um documento, uma publicação — descreva o que precisa' },
  zh: { base: '用自己的话说说你需要什么——助手会立即回答', biz: '合同、税务、给客户的文案——描述一下你的任务', creator: '帖子或视频的想法——说说你的打算', assistant: '信件、文件、帖子——说说你需要什么' },
};

for (const lang of Object.keys(ASK)) {
  const file = `src/i18n/locales/${lang}.json`;
  const src = readFileSync(file, 'utf8');
  const data = JSON.parse(src);
  if (JSON.stringify(data, null, 2) + '\n' !== src) throw new Error(`${file}: формат не совпадает с JSON.stringify — добавить ключи руками`);
  if (data.ask) throw new Error(`${file}: блок ask уже есть`);
  data.ask = ASK[lang];
  data.hero.askPlaceholder = HERO[lang].base;
  for (const seg of ['biz', 'creator', 'assistant']) data.hero[seg].askPlaceholder = HERO[lang][seg];
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`${file}: ask.* и hero.*askPlaceholder добавлены`);
}
```

```bash
node .superpowers/add-ask-keys.mjs
git add src/i18n/locales/ru.json src/i18n/locales/en.json src/i18n/locales/es.json src/i18n/locales/de.json src/i18n/locales/fr.json src/i18n/locales/zh.json src/i18n/locales/pt.json
git commit -q -m "i18n(ask): поле вопроса — тексты на семи языках

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm check-locales 2>&1 | tail -2; pnpm test:unit src/i18n 2>&1 | grep -E "×|FAIL|Test Files|Tests  "'
```
Ожидание: `check-locales` и `locales.structure.test.ts` зелёные. Если у какого-то сегмента (`hero.biz` и т.п.) в локали нет объекта — скрипт упадёт на `data.hero[seg]`; тогда проверить `ru.json` и добавить сегмент руками во все семь файлов одинаково.

- [ ] **Шаг 2: тест компонента**

```tsx
// src/components/ui/AskBox.test.tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { createServerI18n } from '../../i18n/server';
import AskBox from './AskBox';

const render = (lang = 'ru') =>
  renderToStaticMarkup(
    <I18nextProvider i18n={createServerI18n(lang)}>
      <AskBox assistantId={12} cta="hero-ask" utmContent="hero-ask" placeholder="Подсказка" />
    </I18nextProvider>,
  );

describe('поле вопроса', () => {
  it('подпись, кнопка и строка под полем — из локали', () => {
    const html = render();
    expect(html).toContain('Ваш вопрос ассистенту');
    expect(html).toContain('Спросить');
    expect(html).toContain('Ответ сразу — без регистрации и карты');
  });

  it('поле скрыто от Вебвизора и ограничено 600 знаками', () => {
    const tag = render().match(/<textarea[^>]*>/)?.[0] ?? '';
    expect(tag).toContain('ym-disable-keys');
    expect(tag).toContain('maxLength="600"');
  });

  it('кнопка — цель воронки; в разметке нет ни адреса с вопросом, ни ссылок', () => {
    const html = render();
    expect(html).toContain('data-cta="hero-ask"');
    expect(html).toContain('data-ask-box');
    expect(html).not.toContain('#ask=');
    expect(html).not.toContain('href=');
  });
});
```

- [ ] **Шаг 3: закоммитить и прогнать — FAIL**

```bash
git add src/components/ui/AskBox.test.tsx
git commit -q -m "test(ask): поле вопроса — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test:unit src/components/ui/AskBox.test.tsx 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 4: реализация**

```tsx
// src/components/ui/AskBox.tsx
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import { DRAFT_MAX_LENGTH, askTarget } from '../../lib/chatDraft';

interface Props {
  assistantId: number;
  /** Цель воронки (landing_cta_click) — её пишет общий обработчик кликов по [data-cta] в main.tsx. */
  cta: string;
  utmContent: string;
  placeholder: string;
  className?: string;
}

/**
 * Поле вопроса ассистенту (проба без входа, spec 2026-10-30-guest-trial). Вопрос
 * уезжает в кабинет фрагментом #ask=…, кабинет отправляет его сам — первые
 * ответы приходят без регистрации.
 *
 * Поле скрыто от Вебвизора (ym-disable-keys): Метрика лендинга пишет сессии. В
 * разметке и в пререндере текста вопроса нет — адрес строится по нажатию.
 * Enter нажимает кнопку, а не отправляет форму напрямую: так цель воронки
 * засчитывается тем же обработчиком кликов, что и у остальных кнопок, и ровно один раз.
 */
export default function AskBox({ assistantId, cta, utmContent, placeholder, className = '' }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [text, setText] = useState('');
  const button = useRef<HTMLButtonElement>(null);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    window.location.assign(askTarget(assistantId, utmContent, text));
  };

  return (
    <form onSubmit={onSubmit} className={`w-full max-w-xl ${className}`} data-ask-box>
      <label htmlFor={id} className="sr-only">{t('ask.label')}</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <textarea
          id={id}
          name="question"
          rows={2}
          maxLength={DRAFT_MAX_LENGTH}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              button.current?.click();
            }
          }}
          className="ym-disable-keys min-h-11 flex-1 resize-none rounded-lg border border-paper-300 bg-paper-50 px-4 py-3 text-base text-paper-900 placeholder:text-paper-600 focus:outline-none focus:ring-2 focus:ring-brand-800"
        />
        <button
          ref={button}
          type="submit"
          data-cta={cta}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand-800 px-6 py-3.5 text-base font-semibold text-white shadow-lg shadow-brand-800/20 transition-all hover:bg-brand-900 focus:outline-none focus:ring-2 focus:ring-brand-800 focus:ring-offset-2"
        >
          {t('ask.button')} <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-2 text-sm text-paper-600">{t('ask.note')}</p>
    </form>
  );
}
```

- [ ] **Шаг 5: прогнать — PASS и закоммитить**

```bash
git add src/components/ui/AskBox.tsx
git commit -q -m "feat(ask): поле вопроса ассистенту

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test:unit src/components/ui/AskBox.test.tsx 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

### Задача C3: поле в первом экране и на страницах ассистентов

**Files:**
- Modify: `src/components/sections/Hero.tsx`, `src/pages/AssistantPage.tsx`, `src/pages/AssistantPage.test.tsx`
- Create: `src/components/sections/HeroAsk.test.tsx`

- [ ] **Шаг 1: тесты**

```tsx
// src/components/sections/HeroAsk.test.tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import { createServerI18n } from '../../i18n/server';
import Hero from './Hero';

const html = renderToStaticMarkup(<I18nextProvider i18n={createServerI18n('ru')}><Hero /></I18nextProvider>);

describe('первый экран: поле вопроса вместо кнопки «Начать»', () => {
  it('поле к Роману есть, кнопки hero-start нет', () => {
    expect(html).toContain('data-ask-box');
    expect(html).toContain('data-cta="hero-ask"');
    expect(html).not.toContain('data-cta="hero-start"');
  });

  it('подсказка — из локали первого экрана', () => {
    expect(html).toContain('Расскажите своими словами, с чем пришли, — ассистент ответит сразу');
  });
});
```

В `src/pages/AssistantPage.test.tsx` заменить кейс `it('обе кнопки ведут в чат с этим ассистентом', …)` целиком на:
```tsx
  // Главное действие наверху — поле вопроса (проба без входа, spec
  // 2026-10-30-guest-trial); внизу осталась кнопка в чат. Обе — к этому ассистенту.
  it('наверху поле вопроса к этому ассистенту, внизу кнопка в чат', () => {
    const situationsAt = html.indexOf('id="situations-heading"');
    const hero = html.slice(0, situationsAt);
    expect(hero).toContain('data-ask-box');
    expect(hero).toContain('data-cta="assistant-ask"');
    expect(hero).toContain('Опишите ситуацию своими словами — Райя ответит сразу');
    expect(hero).not.toContain('data-cta="assistant-start"');
    const ctas = [...html.matchAll(/<a[^>]*data-cta="assistant-start"[^>]*>/g)].map((m) => m[0]);
    expect(ctas).toHaveLength(1);
    expect(ctas[0]).toContain('href="https://my.linkeon.io/chat?assistant=14&amp;utm_content=assistant-raya');
  });
```

- [ ] **Шаг 2: закоммитить и прогнать — FAIL**

```bash
git add src/components/sections/HeroAsk.test.tsx src/pages/AssistantPage.test.tsx
git commit -q -m "test(ask): поле в первом экране и на страницах ассистентов — красный

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test:unit src/components/sections/HeroAsk.test.tsx src/pages/AssistantPage.test.tsx 2>&1 | grep -E "✓|×|FAIL|Test Files|Tests  "'
```

- [ ] **Шаг 3: реализация**

`src/components/sections/Hero.tsx`:
- импорты: убрать `import Button from '../ui/Button';` и `import { appUrl } from '../../lib/appUrl';` — по origin/main оба используются только в заменяемой кнопке (в комментарии про язык упоминается файл `lib/appUrl.ts`, это не использование); добавить `import AskBox from '../ui/AskBox';`;
- над `export default function Hero()`:
```tsx
/** Роман — универсальный ассистент (roster.data.js, slug 'roman'). */
const ROMAN_ID = 12;
```
- блок
```tsx
            <div className="flex flex-col sm:flex-row gap-3 mb-3">
              <Button variant="primary" size="lg" href={appUrl()} dataCta="hero-start">{heroT('ctaStart')}</Button>
            </div>
```
заменить на
```tsx
            {/* Поле вопроса вместо кнопки «Начать» (проба без входа, spec
                2026-10-30-guest-trial): первые ответы — без регистрации. */}
            <div className="mb-3">
              <AskBox assistantId={ROMAN_ID} cta="hero-ask" utmContent="hero-ask" placeholder={heroT('askPlaceholder')} />
            </div>
```
Комментарий над блоком («Один основной CTA для холодного трафика…») — оставить: главное действие по-прежнему одно.

`src/pages/AssistantPage.tsx`:
- импорт `import AskBox from '../components/ui/AskBox';`;
- в верхней секции перед `<div className="mt-8 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3">` вставить
```tsx
            <AskBox
              className="mt-8"
              assistantId={entry.id}
              cta="assistant-ask"
              utmContent={`assistant-${entry.slug}`}
              placeholder={t('ask.placeholderAssistant', { name })}
            />
```
- в этом же `div` убрать `{cta}` (первое вхождение, ~стр. 86) и поменять у `div` отступ `mt-8` на `mt-4`; нижнее `{cta}` (после `finalTitle`) остаётся.

- [ ] **Шаг 4: прогнать все unit-тесты лендинга — PASS и закоммитить**

```bash
git add src/components/sections/Hero.tsx src/pages/AssistantPage.tsx
git commit -q -m "feat(ask): поле вопроса в первом экране и на страницах ассистентов

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test:unit 2>&1 | grep -E "×|FAIL|Test Files|Tests  "'
```

### Задача C4: юридические тексты лендинга (отдельная ветка)

**Files:** `src/content/legal/{ru,en,de,es,fr,pt,zh}.tsx` в воркдереве `~/Downloads/land_linkeon/.worktrees/guest-trial-legal`

Выкатываются раньше поля вопроса (Часть D, шаг D5), поэтому — своя ветка от `origin/main`.

- [ ] **Шаг 1: воркдерево и помощник прогона**

```bash
git -C ~/Downloads/land_linkeon worktree add -q .worktrees/guest-trial-legal -b feat/guest-trial-legal origin/main
mkdir -p ~/Downloads/land_linkeon/.worktrees/guest-trial-legal/.superpowers
sed -e 's#land_linkeon/.worktrees/guest-trial$#land_linkeon/.worktrees/guest-trial-legal#' \
    -e 's#ci/wt/guest-trial-land#ci/wt/guest-trial-land-legal#' \
    -e 's#tmp/guest-trial#tmp/guest-trial-legal#' \
    ~/Downloads/land_linkeon/.worktrees/guest-trial/.superpowers/node-run.sh \
    > ~/Downloads/land_linkeon/.worktrees/guest-trial-legal/.superpowers/node-run.sh
grep -nE "^WT=|^NODE_WT=|^BRANCH=" ~/Downloads/land_linkeon/.worktrees/guest-trial-legal/.superpowers/node-run.sh
```
Ожидание: три строки указывают на `guest-trial-legal`.

- [ ] **Шаг 2: две строки в каждом языке** — в политике, раздел «Хранение данных», сразу после строки «логи безопасности», и в согласии, раздел «Состав персональных данных», сразу после строки «история взаимодействий с ассистентами». Якоря и вставки:

| Файл | После строки (якорь) | Вставить |
|---|---|---|
| `ru.tsx` | `<li><strong>Логи безопасности:</strong> 6 месяцев</li>` | `<li><strong>Пробный разговор до входа:</strong> 7 дней после последнего сообщения, если его не перенесли в аккаунт; после переноса — как остальная переписка аккаунта</li>` |
| `ru.tsx` | `<li>История взаимодействий с AI-ассистентами, журналы сессий</li>` | `<li>Сообщения пробного разговора с AI-ассистентом до входа в Приложение</li>` |
| `en.tsx` | `<li><strong>Security logs:</strong> 6 months</li>` | `<li><strong>Trial conversation before sign-in:</strong> 7 days after the last message unless it is moved to an account; once moved, like the rest of the account's conversations</li>` |
| `en.tsx` | `<li>History of interactions with AI assistants, session logs</li>` | `<li>Messages of a trial conversation with an AI assistant before signing in to the Application</li>` |
| `de.tsx` | `<li><strong>Sicherheitsprotokolle:</strong> 6 Monate</li>` | `<li><strong>Probegespräch vor der Anmeldung:</strong> 7 Tage nach der letzten Nachricht, sofern es nicht in ein Konto übernommen wird; nach der Übernahme wie die übrigen Gespräche des Kontos</li>` |
| `de.tsx` | `<li>Verlauf der Interaktionen mit den KI-Assistenten, Protokolle der Sitzungen</li>` | `<li>Nachrichten eines Probegesprächs mit einem KI-Assistenten vor der Anmeldung in der Anwendung</li>` |
| `es.tsx` | `<li><strong>Registros de seguridad:</strong> 6 meses</li>` | `<li><strong>Conversación de prueba antes de iniciar sesión:</strong> 7 días después del último mensaje, salvo que se traslade a una cuenta; tras el traslado, como el resto de las conversaciones de la cuenta</li>` |
| `es.tsx` | `<li>Historial de interacciones con los asistentes de IA y registros de sesión</li>` | `<li>Mensajes de una conversación de prueba con un asistente de IA antes de iniciar sesión en la Aplicación</li>` |
| `fr.tsx` | `<li><strong>Journaux de sécurité :</strong> 6 mois</li>` | `<li><strong>Conversation d'essai avant la connexion :</strong> 7 jours après le dernier message, sauf si elle est transférée vers un compte ; après le transfert, comme les autres conversations du compte</li>` |
| `fr.tsx` | `<li>Historique des interactions avec les assistants IA, journaux de session</li>` | `<li>Messages d'une conversation d'essai avec un assistant IA avant la connexion à l'Application</li>` |
| `pt.tsx` | `<li><strong>Registos de segurança:</strong> 6 meses</li>` | `<li><strong>Conversa de experiência antes de iniciar sessão:</strong> 7 dias após a última mensagem, salvo se for transferida para uma conta; após a transferência, como as restantes conversas da conta</li>` |
| `pt.tsx` | `<li>Histórico de interações com os assistentes de IA e registos de sessão</li>` | `<li>Mensagens de uma conversa de experiência com um assistente de IA antes de iniciar sessão na Aplicação</li>` |
| `zh.tsx` | `<li><strong>安全日志：</strong>6 个月</li>` | `<li><strong>登录前的试用对话：</strong>最后一条消息后保留 7 天，除非已转入账户；转入后与账户中的其他对话相同</li>` |
| `zh.tsx` | `<li>与 AI 助手的交互记录、会话日志</li>` | `<li>登录本应用前与 AI 助手试用对话中的消息</li>` |

Отступ вставляемой строки — как у якоря. В `fr.tsx` пробел перед двоеточием — как в соседних строках файла. Если якорь в файле встречается дважды — вставка после каждого вхождения в нужном документе (политика / согласие) по смыслу раздела.

- [ ] **Шаг 3: проверить и закоммитить**

```bash
cd ~/Downloads/land_linkeon/.worktrees/guest-trial-legal
for l in ru en de es fr pt zh; do printf '%s: ' $l; grep -cE "Пробный разговор до входа|Сообщения пробного|Trial conversation before|trial conversation with|Probegespräch|conversación de prueba|Conversación de prueba|conversation d'essai|Conversation d'essai|conversa de experiência|Conversa de experiência|试用对话" src/content/legal/$l.tsx; done
git add src/content/legal/ru.tsx src/content/legal/en.tsx src/content/legal/de.tsx src/content/legal/es.tsx src/content/legal/fr.tsx src/content/legal/pt.tsx src/content/legal/zh.tsx
git commit -q -m "legal: пробный разговор до входа — состав данных и срок хранения

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash .superpowers/node-run.sh 'pnpm test:unit src/pages/LegalPage.test.tsx 2>&1 | grep -E "×|FAIL|Test Files|Tests  "; pnpm build >/tmp/gt-legal-build.log 2>&1; echo build=$?'
git push -q -u origin feat/guest-trial-legal
```
Ожидание: по `2` на каждый язык; тесты юридической страницы зелёные; `build=0` (пререндер со своими проверками ИНН и почты поддержки прошёл).

### Задача C5: гейты лендинга

- [ ] **Шаг 1: из воркдерева `guest-trial`**

```bash
cd ~/Downloads/land_linkeon/.worktrees/guest-trial
bash .superpowers/node-run.sh 'pnpm typecheck 2>&1 | grep -c "error TS"; pnpm typecheck 2>&1 | grep -E "AskBox|chatDraft|Hero|AssistantPage" | head; pnpm test:unit 2>&1 | grep -E "×|FAIL|Test Files|Tests  "; pnpm check-locales 2>&1 | tail -2; pnpm build >/tmp/gt-land-build.log 2>&1; echo build=$?; grep -c "data-ask-box" dist/index.html'
git push -q -u origin feat/guest-trial
```
Ожидание: ошибок TS не больше базы и ни одной в своих файлах; unit-тесты и `check-locales` зелёные; `build=0`; в пререндеренной главной поле есть (`1` и больше).

---

## Часть D. Выкат (только с OK владельца на каждом шаге)

Перед Частью D прочитать заметки `feedback_deploy_rules.md`, `project_deploy_sh_pitfalls.md`, `feedback_verify_deploys.md`, `feedback_no_restart_during_live_sessions.md`.

### Задача D1: ревью

- [ ] Ревью трёх веток скиллом `superpowers:requesting-code-review` (субагент `code-reviewer` на каждую: `feat/guest-trial` бэка, `feat/guest-trial` кабинета, `feat/guest-trial` и `feat/guest-trial-legal` лендинга) против спеки. Замечания — исправить в ветках (с тестами), гейты A12 / B13 / C5 — заново.

### Задача D2: вычитка юридических текстов

- [ ] Показать владельцу четыре вставки в кабинете (Задача B12, шаг 3) и русские строки лендинга (Задача C4); переводы — для сведения. Ждать OK. Правки текста — в ветках, гейты заново.

### Задача D3: слияние бэка и кабинета в main (OK)

- [ ] Для каждого из двух репозиториев, из его воркдерева `guest-trial`:

```bash
git fetch -q origin
git rebase origin/main              # конфликты — разрешить, гейты A12 / B13 заново
git push -q -f origin feat/guest-trial
git push origin feat/guest-trial:main
git ls-remote origin main           # хеш совпадает с git rev-parse HEAD
```
Отказ `git push … :main` (non-fast-forward) значит, что в main кто-то успел запушить: повторить `fetch` → `rebase` → гейты → push. Порядок: сначала бэк, потом кабинет. Кабинет со старым бэком безопасен: `/webhook/guest/config` ответит 404 → экран входа, как сегодня.

### Задача D4: выкат бэка и кабинета (OK)

- [ ] `bash ~/Downloads/spirits_back/scripts/deploy.sh` — без флагов, из main, отвязанно (`run_in_background`), без `tail` (правила из `feedback_deploy_rules.md`). Дождаться окончания и прочитать лог целиком: обе фазы и оба smoke — зелёные, включая `tests/playwright/login-ui.spec.js`.
- [ ] Проверка выката:
```bash
curl -s https://my.linkeon.io/webhook/guest/config; echo
```
Ожидание: `{"mode":"off","answersPerTrial":3,"maxChars":2000}`. Хеш входного бандла кабинета на проде совпадает со свежей сборкой main (`feedback_verify_deploys.md`); content-type ответа `/webhook/guest/config` — `application/json` (SPA-фолбэк тоже отдаёт 200, но HTML).
- [ ] Стенд test (Basic Auth из `~/Downloads/spirits_back/scripts/test-server.env.local`): `/webhook/guest/config` → `"mode":"off"`; ход с `"preview":true` при режиме «выкл» → стена `closed`. Ответа модели на стенде не будет (локальный CLI там без входа) — это ожидаемо.
- [ ] Миграция прошла:
```bash
ssh dvolkov@212.113.106.202 'PGOPTIONS="-c default_transaction_read_only=on" psql "$(sed -n "s/^DATABASE_URL=//p" ~/spirits_back/.env | tail -n 1)" -X -q -Atc "SELECT to_regclass('"'"'guest_trial_sessions'"'"'), to_regclass('"'"'guest_trial_settings'"'"')"'
```
Ожидание: `guest_trial_sessions|guest_trial_settings`.

### Задача D5: юридические тексты лендинга (OK)

- [ ] Слить `feat/guest-trial-legal` в main лендинга — из `~/Downloads/land_linkeon/.worktrees/guest-trial-legal`:
```bash
git fetch -q origin
git rebase origin/main
git push -q -f origin feat/guest-trial-legal
git push origin feat/guest-trial-legal:main
git ls-remote origin main   # хеш совпадает с git rev-parse HEAD
```
- [ ] `LANDING_ONLY=1 bash ~/Downloads/spirits_back/scripts/deploy.sh` (отвязанно, лог — целиком). Проверить: на `https://linkeon.io/` в окне «Политика конфиденциальности» есть строка «Пробный разговор до входа». Этот шаг — раньше «вкл»: документ должен описывать пробу до того, как её увидят все.

### Задача D6: предпросмотр и живая проверка на проде (OK на запись в базу)

- [ ] Включить «предпросмотр» (кэш режима — 15 с):
```bash
ssh dvolkov@212.113.106.202 'psql "$(sed -n "s/^DATABASE_URL=//p" ~/spirits_back/.env | tail -n 1)" -X -q' <<'SQL'
INSERT INTO guest_trial_settings (key, value) VALUES ('mode', '"preview"'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
SELECT key, value FROM guest_trial_settings;
SQL
```
- [ ] Ход через API (три хода одной пробы). С мака прод может не открываться — тогда с ноды; если и с ноды не видно — обход через релей по `project_prod_route_outage_relay_jump.md`, с OK и уборкой после:
```bash
curl -sN https://my.linkeon.io/webhook/guest/chat -H 'Content-Type: application/json' \
  -d '{"assistantId":"12","message":"Привет! Коротко: чем ты можешь помочь с продажами?","lang":"ru","tz":"Europe/Moscow","preview":true}'
```
Ожидание: строки `guest` (с `token`, `left:3`), `begin`, несколько `item`, `end`. Взять `token`, повторить ещё два хода с `"token":"…"` — третий заканчивается `{"type":"wall","reason":"limit"}`, четвёртый сразу отдаёт стену. Без `"preview":true` — стена `closed`.
- [ ] Перенос: получить токен входа тестового аккаунта (debug-OTP с `X-Debug-Secret` из `.env` прода — `project_debug_endpoints_need_secret.md`; номер — из CLAUDE.md), затем
```bash
curl -s https://my.linkeon.io/webhook/guest/claim -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}"
```
Ожидание: `{"assistantId":"12","moved":6}`; повтор — `"moved":0`. Следующее обычное сообщение Роману этим аккаунтом («О чём мы только что говорили?») — ответ про пробу (у тестового аккаунта история с Романом есть — это путь с припиской).
- [ ] Владелец проходит пробу в браузере в окне инкогнито: `https://my.linkeon.io/chat?trial=1` → согласие → три ответа → стена → вход новой почтой → разговор на месте, ассистент продолжает. Ждать его подтверждения.

### Задача D7: «вкл» (OK)

- [ ] Тот же SQL, что в D6, с `'"on"'::jsonb`. Через 15 с: `curl -s https://my.linkeon.io/webhook/guest/config` → `"mode":"on"`. Окно инкогнито без `?trial=1` на `https://my.linkeon.io/` — открывается проба. Откат — тот же SQL с `'"off"'`.

### Задача D8: поле вопроса на лендинге (OK)

- [ ] Слить `feat/guest-trial` лендинга в main — из `~/Downloads/land_linkeon/.worktrees/guest-trial` (после rebase — гейт C5 заново):
```bash
git fetch -q origin
git rebase origin/main
git push -q -f origin feat/guest-trial
git push origin feat/guest-trial:main
git ls-remote origin main   # хеш совпадает с git rev-parse HEAD
```
- [ ] `LANDING_ONLY=1 bash ~/Downloads/spirits_back/scripts/deploy.sh` (отвязанно, лог — целиком). Проверить в инкогнито: `https://linkeon.io/` → вопрос в поле → «Спросить» → кабинет открыл пробу с Романом, вопрос в поле (или ушёл сам, если согласие уже отмечено); страница ассистента — то же с этим ассистентом.

### Задача D9: после запуска

- [ ] Через сутки и через неделю — сводка (только чтение):
```bash
ssh dvolkov@212.113.106.202 'PGOPTIONS="-c default_transaction_read_only=on" psql "$(sed -n "s/^DATABASE_URL=//p" ~/spirits_back/.env | tail -n 1)" -X -q' <<'SQL'
SELECT count(*) FILTER (WHERE created_at > now() - interval '1 day') AS trials_day,
       coalesce(sum(answers) FILTER (WHERE created_at > now() - interval '1 day'), 0) AS answers_day,
       count(*) FILTER (WHERE claimed_at > now() - interval '1 day') AS claims_day,
       round(coalesce(sum(cost_usd) FILTER (WHERE created_at > now() - interval '1 day'), 0), 2) AS cost_usd_day
  FROM guest_trial_sessions;
SELECT name, count(*) FROM events WHERE name LIKE 'guest_trial_%' AND ts > now() - interval '1 day' GROUP BY 1 ORDER BY 1;
SQL
```
- [ ] Справка ассистентов (`spirits_back/src/platform-kb/articles/start.ts`, раздел «Как»): строка «До входа можно задать ассистенту несколько вопросов: первые ответы приходят без регистрации, потом кабинет попросит войти — разговор переедет в аккаунт, и ассистент продолжит с того же места.» — отдельной маленькой веткой, с ближайшим выкатом бэка (до «вкл» справка о пробе молчит — это безопасно).
- [ ] `CLAUDE.md` кабинета (раздел «Роутинг»: без входа — `UnauthenticatedEntry`, проба или экран входа) и бэка (ручки `/webhook/guest/*`, `/webhook/admin/guest-trial`, выключатель в `guest_trial_settings`) — той же маленькой веткой.
- [ ] Заметка памяти о пробе: где выключатель, как смотреть сводку, когда сравнивать воронку (через 4 недели после «вкл»).
- [ ] Снять CI-воркдеревья на ноде (`git -C ~/ci/<репо> worktree remove ~/ci/wt/guest-trial-*`) и локальные воркдеревья после слияния; удалить базу `gt_test` (`dropdb -h /var/run/postgresql gt_test`).
