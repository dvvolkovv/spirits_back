# Ассистенты сообщают о сбоях в «Поддержку linkeon» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** когда у ассистента ломается инструмент Linkeon или он сам видит поломку, в Telegram-группу «Поддержка linkeon» сразу уходит сообщение; эскалации ИИ-поддержки снова доходят до группы.

**Architecture:** новый модуль `src/problem-report/` — классификатор «виноват ли сервис», тексты, склейка и лимиты в памяти, отправка через существующий `sendTelegramAlert`. Путь А — `McpController` (`/mcp`) после `executeTool` сообщает о сбое и кладёт ассистенту в результат `supportNotified` + `supportNote`. Путь Б — инструмент `report_problem` на точке продуктов `/webhook/mcp/products` (все ассистенты релея, Маша, TG-боты). Плюс обход для `notifyEscalation`, когда нет `TELEGRAM_SUPPORT_CHAT_ID`.

**Tech Stack:** NestJS 10, TypeScript (`strictNullChecks: false`, `target ES2021`), jest + ts-jest (типы НЕ проверяет), MCP SDK (stateless HTTP), Telegram Bot API через `src/common/telegram-alert.ts`.

**Спека:** `docs/superpowers/specs/2026-10-24-assistant-problem-reports-design.md` (согласована владельцем 24.10.2026).

---

## Как работать (прочитать до задачи 0)

- **Код — в воркдереве на маке:** `WT=/Users/dmitry/Downloads/spirits_back/.worktrees/problem-report`, ветка `feat/problem-report`. Общий чекаут `~/Downloads/spirits_back` и чужие воркдеревья не трогать: там работают параллельные сессии. Перед каждым коммитом: `git -C $WT branch --show-current` → `feat/problem-report`.
- **Тесты и сборка — только на тестовой ноде** `dv@85.192.61.231` (решение владельца: мак не тянет). Код туда идёт через git: `ntest.sh` (задача 0) пушит закоммиченный HEAD воркдерева в `origin/feat/problem-report`, ставит воркдерево ноды `~/ci/wt/problem-report` на тот же sha и гоняет команду. **Прогон видит только закоммиченное** — перед каждым прогоном коммит.
- **Состояние оболочки между вызовами не сохраняется** (ни `cd`, ни переменные). В начале каждого блока команд задавать `WT=/Users/dmitry/Downloads/spirits_back/.worktrees/problem-report` и `SCRATCH=<папка scratchpad сессии>`; пути — абсолютные.
- **`strictNullChecks: false`:** дискриминированный союз сужается только через `x.ok === false`, не через `!x.ok`.
- **jest типы не проверяет.** Гейт типов — `ntest.sh tsc` (`tsc --noEmit -p tsconfig.build.json`).
- **Не трогать** видео (`src/video/*`, `src/misc/veo.service.ts`) — их вела другая сессия (переход на Gemini Omni, `838887d`).
- **Репозиторий публичный:** номера телефонов, chat id и секреты не коммитить. В тестах — `u1`, `u-1`; в командах плана — плейсхолдер `<номер Test user>` (он есть в `CLAUDE.md`).
- Текст коммита завершать строкой `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (второй `-m`).

## Карта файлов

Создаются:

| Файл | Ответственность |
|---|---|
| `src/problem-report/problem-classify.ts` | виноват ли сервис (`isUserSideToolError`), подпись сбоя для склейки (`failureSignature`) |
| `src/problem-report/problem-format.ts` | тексты сообщений в группу: экранирование, обрезка, согласование |
| `src/problem-report/problem-report.service.ts` | `ProblemReportService`: склейка, лимиты, имя ассистента, отправка |
| `src/problem-report/report-problem.tool.ts` | определение инструмента `report_problem` |
| `src/problem-report/problem-report.module.ts` | модуль (зависит только от `CommonModule`) |
| `src/problem-report/*.spec.ts` | тесты модуля |
| `src/chat/chat.service.active-assistant.spec.ts` | тест `ChatService.activeAssistantFor` |
| `src/mcp/mcp.controller.problem-report.spec.ts` | тест пути А |
| `src/mcp/products-mcp.report-problem.spec.ts` | тест пути Б на точке продуктов |
| `src/support/telegram-notifier.escalation.spec.ts` | тест обхода для эскалаций |
| `tests/problem-report.e2e.mjs` | живая проверка через ассистента (вручную) |

Меняются: `src/chat/chat.service.ts` (`activeAssistantFor`, `allowedTools` Маши), `src/mcp/mcp.controller.ts`, `src/mcp/mcp.module.ts`, `src/mcp/products-mcp.controller.ts`, `src/mcp/products-mcp.controller.spec.ts`, `src/mcp/find-files-event.spec.ts`, `src/products/products-cli-tool.ts` (+spec), `src/chat/chat.service.masha-products.spec.ts`, `src/tg-bot/tg-router.service.ts`, `src/tg-bot/tg-bot.products-tool.spec.ts`, `src/support/telegram-notifier.service.ts`, `relay-agent/server.mjs` (копия релея), спека.

Вне репозитория: `~/file-agent/server.mjs` на релее `dv@5.101.115.184` (задачи 11 и 15).

---

## Задача 0. Окружение на ноде и базовая линия

**Files:** нет (служебное).

- [ ] **Шаг 1: проверить воркдерево**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/problem-report
git -C $WT status -sb | head -3
git -C $WT branch --show-current
```
Expected: `## feat/problem-report...origin/feat/problem-report` без изменённых файлов; ветка `feat/problem-report`.

- [ ] **Шаг 2: мастер-соединение с нодой** (sshd ноды рвёт пачки новых подключений — MaxStartups; путь сокета на macOS короче 104 байт)

```bash
ssh -S ~/.ssh/cm-lnode -O check dv@85.192.61.231 2>/dev/null || ssh -M -S ~/.ssh/cm-lnode -o ControlPersist=4h -fN dv@85.192.61.231
ssh -S ~/.ssh/cm-lnode dv@85.192.61.231 hostname
```
Expected: `ugliest-salmon…`.

- [ ] **Шаг 3: своё воркдерево на ноде и зависимости** (общий `~/ci/spirits_back` не переключать — только свой worktree; `npm ci`, не pnpm)

```bash
SHA=$(git -C $WT rev-parse HEAD)
ssh -S ~/.ssh/cm-lnode dv@85.192.61.231 "set -e
git -C ~/ci/spirits_back fetch -q origin
test -d ~/ci/wt/problem-report || git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/problem-report $SHA
cd ~/ci/wt/problem-report && git checkout -q --detach $SHA
source ~/.nvm/nvm.sh
npm ci --no-audit --no-fund > ~/ci/wt/problem-report-npm-ci.log 2>&1 || { tail -20 ~/ci/wt/problem-report-npm-ci.log; exit 1; }
cd tests && npm ci --no-audit --no-fund > ~/ci/wt/problem-report-npm-ci-tests.log 2>&1 || { tail -20 ~/ci/wt/problem-report-npm-ci-tests.log; exit 1; }
echo OK"
```
Expected: `OK`.

- [ ] **Шаг 4: скрипт прогона `ntest.sh`** — в папку scratchpad сессии (`$SCRATCH`; в этой сессии `/private/tmp/claude-501/-Users-dmitry-Downloads-spirits-front/b48c55fc-ec71-434a-8e35-1852c74e3d21/scratchpad`)

```bash
cat > "$SCRATCH/ntest.sh" <<'EOF'
#!/usr/bin/env bash
# Прогон для ветки feat/problem-report на тестовой ноде.
#   ntest.sh jest '<регулярка --testPathPattern>'
#   ntest.sh tsc      — гейт типов сборки
#   ntest.sh build    — nest build + tests/unit (грузят dist/)
# Пушит закоммиченный HEAD воркдерева и ставит воркдерево ноды на тот же sha.
set -euo pipefail
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/problem-report
SOCK=~/.ssh/cm-lnode
MODE=${1:?jest|tsc|build}
PATTERN=${2:-}
case "$MODE" in
  jest)  [ -n "$PATTERN" ] || { echo "нужна регулярка"; exit 2; }
         CMD="npx jest --testPathPattern='$PATTERN' --maxWorkers=2 2>&1 | tail -80" ;;
  tsc)   CMD="npx tsc --noEmit -p tsconfig.build.json 2>&1 | tail -40; echo TSC_EXIT=\${PIPESTATUS[0]}" ;;
  build) CMD="npm run build 2>&1 | tail -15 && cd tests && npx jest unit/ --silent --maxWorkers=2 2>&1 | tail -25" ;;
  *) echo "режим: jest|tsc|build"; exit 2 ;;
esac
ssh -S "$SOCK" -O check dv@85.192.61.231 2>/dev/null || ssh -M -S "$SOCK" -o ControlPersist=4h -fN dv@85.192.61.231
test "$(git -C "$WT" branch --show-current)" = feat/problem-report
git -C "$WT" push -q origin HEAD:feat/problem-report
SHA=$(git -C "$WT" rev-parse HEAD)
ssh -S "$SOCK" dv@85.192.61.231 "set -eo pipefail
cd ~/ci/wt/problem-report
git fetch -q origin
git checkout -q --detach $SHA
test \"\$(git rev-parse HEAD)\" = $SHA
echo \"sha \$(git rev-parse --short HEAD)\"
source ~/.nvm/nvm.sh
$CMD"
EOF
chmod +x "$SCRATCH/ntest.sh"
```

- [ ] **Шаг 5: базовая линия ДО правок** — записать результаты в заметку задачи (с ними сравнивать в задаче 13)

```bash
"$SCRATCH/ntest.sh" tsc
"$SCRATCH/ntest.sh" jest 'src/(mcp|products/products-cli-tool|chat/chat.service.masha-products|tg-bot/(tg-bot.products-tool|tg-router.web-tools)|support)/?'
"$SCRATCH/ntest.sh" jest 'src/'
"$SCRATCH/ntest.sh" build
```
Expected: `tsc` — `TSC_EXIT=0` без строк ошибок (если есть — записать как базу). Во втором прогоне строка `Tests: N passed` с N > 0 — **не** `0 matches` (иначе jest ничего не нашёл, и прогон врёт). Для `src/` и `build` записать число упавших сюит и их имена — это база, мерить будем дельтой.

---

## Задача 1. Классификатор сбоев

**Files:**
- Create: `src/problem-report/problem-classify.ts`
- Test: `src/problem-report/problem-classify.spec.ts`

- [ ] **Шаг 1: тест**

`src/problem-report/problem-classify.spec.ts`:

```ts
import { failureSignature, isUserSideToolError } from './problem-classify';

/**
 * Каждая строка — настоящее сообщение инструментов Linkeon (chat-tools.ts,
 * misc.service.ts, video.service.ts, speech.service.ts, calendar.service.ts,
 * routine-store.service.ts, hd-tool.service.ts) или провайдера.
 */
describe('isUserSideToolError: виноват ли не сервис', () => {
  // Сбои — о них команда должна узнать.
  it.each([
    'Veo generate failed: This model models/veo-3.1-fast-generate-preview is no longer available. Please update your code to use models/gemini-omni-1.1-flash for the latest features and improvements.',
    'Модель не вернула изображений (IMAGE_RECITATION). Попробуйте ещё раз или измените промпт.',
    'Модель не вернула изображение',
    'Google не успел обработать картинку за 5 минут. Попробуйте повторить — обычно помогает.',
    'tts failed',
    'tts_failed',
    'Инструмент расчёта временно недоступен — посчитайте прежним способом.',
    'Veo is not configured (GOOGLE_AI_API_KEY)',
    'Google AI API key not configured',
    'Veo: на сегодня исчерпан дневной лимит генераций видео. Лимит обновляется раз в сутки около 10:00–11:00 МСК — попробуйте позже. (админу: повысить квоту Veo для ключа в Google AI Studio / Cloud Console.)',
    'tool execution failed',
    'unknown tool: generate_kling',
    'image generation failed',
    'не удалось прочитать календарь',
    'connect ECONNREFUSED 127.0.0.1:5433',
    'timeout of 30000ms exceeded',
  ])('сбой: %s', (error) => {
    expect(isUserSideToolError(error)).toBe(false);
  });

  // Виноват не сервис — в группу не идёт.
  it.each([
    'insufficient_tokens',
    'empty prompt',
    'empty text',
    'empty_text',
    'text_too_long',
    'rate_limited',
    'Missing prompt',
    'Missing sourceImageUrl',
    'sourceImageUrl required',
    'banner requires at least title, subtitle or cta',
    'compose_image requires at least 2 sourceImageUrls',
    'compose_image supports at most 3 sourceImageUrls',
    'Veo requires a prompt',
    'image2video requires sourceImageUrl(s)',
    'Veo supports mode text2video or image2video',
    'Veo length must be 4–60 seconds',
    'unsupported video model: kling-v1-6 (only veo-3.1-fast, veo-3.1)',
    'too many concurrent jobs — wait for one to finish',
    'own voice not ready — upload a voice sample first',
    'title обязателен',
    'from и to обязательны (период чтения календаря)',
    'Укажи ровно один способ времени для события: datetime (разово), recurrence (регулярный повтор) или dates (набор дат)',
    'Укажи assistant — своё имя ассистента (например "Райя"), чтобы привязать рутину к тебе.',
    'recurrence требует datetime — время первого вхождения серии',
    'recurrence.count должен быть целым числом от 1 до 100',
    'dates не должен быть пустым',
    'dates: максимум 100 элементов',
    'некорректные даты периода',
    'конец периода должен быть позже начала',
    'период слишком большой (максимум 366 дней)',
    'Нужен город рождения.',
    'Нужен хотя бы заголовок, подзаголовок или CTA',
    'Проверьте дату рождения: формат ГГГГ-ММ-ДД, существующий день.',
    'Проверьте время рождения: формат ЧЧ:ММ.',
    'Дата рождения в будущем — проверьте год.',
    'cityId не из вариантов прошлого ответа — вызовите без cityId.',
    'Город «Куйбышев» не найден в базе. Передайте нынешнее официальное название',
    'ссылка не принята: адрес ведёт во внутреннюю сеть',
    'Invalid data URL',
    'URL did not return an image',
    'bad mime type for image: text/html',
    'file too large (max 10 MB)',
    'Запрос отклонён модерацией — попробуйте переформулировать',
    'limit reached: не больше 10 рутин',
    'job not found',
    'not your job',
  ])('не сбой: %s', (error) => {
    expect(isUserSideToolError(error)).toBe(true);
  });

  it('пустая или отсутствующая ошибка — сбой: неизвестное не глушим', () => {
    expect(isUserSideToolError('')).toBe(false);
    expect(isUserSideToolError(undefined)).toBe(false);
  });
});

describe('failureSignature: подпись для склейки', () => {
  it('числа, id и адреса не плодят подписей', () => {
    const a = failureSignature('generate_video', 'job 3f2b9c1e-1111-4a2b-9c3d-123456789abc failed after 37s, see https://x.y/op/123');
    const b = failureSignature('generate_video', 'job 9a8b7c6d-2222-4b3c-8d4e-abcdefabcdef failed after 41s, see https://x.y/op/987');
    expect(a).toBe(b);
  });

  it('разные инструменты — разные подписи', () => {
    expect(failureSignature('generate_video', 'boom')).not.toBe(failureSignature('generate_image', 'boom'));
  });

  it('разные ошибки — разные подписи', () => {
    expect(failureSignature('generate_video', 'quota exceeded'))
      .not.toBe(failureSignature('generate_video', 'model is no longer available'));
  });

  it('регистр и пробелы не важны', () => {
    expect(failureSignature('t', 'Model  Is\nGone')).toBe(failureSignature('t', 'model is gone'));
  });

  it('длинная ошибка обрезается: подпись — инструмент и не больше 160 символов', () => {
    expect(failureSignature('t', 'x'.repeat(1000)).length).toBeLessThanOrEqual('t|'.length + 160);
  });
});
```

- [ ] **Шаг 2: коммит и прогон — должен упасть**

```bash
git -C $WT add src/problem-report/problem-classify.spec.ts
git -C $WT commit -q -m "test(problem-report): классификатор сбоев — красный" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/problem-report'
```
Expected: FAIL — `Cannot find module './problem-classify'`.

- [ ] **Шаг 3: реализация**

`src/problem-report/problem-classify.ts`:

```ts
/**
 * Сбой инструмента ассистента: виноват ли сервис.
 *
 * «Виноват не сервис» — нехватка токенов, неверные аргументы модели, лимиты
 * самого пользователя, чужое или несуществующее. Всё остальное — сбой, о
 * котором надо сказать команде (спека 2026-10-24-assistant-problem-reports).
 *
 * Неизвестное считается сбоем сознательно: лишнее сообщение склеится и
 * стоит дёшево, молчание — дорого. 24.10.2026 Кира дважды не смогла сделать
 * видео (Google снял модель), и команда не узнала.
 *
 * Список — точные коды и подстроки сообщений проверки ввода ИЗ НАШЕГО кода.
 * Текстов провайдеров здесь нет. Каждая строка закреплена тестом в
 * problem-classify.spec.ts; новая проверка ввода в инструменте — сюда и туда.
 */

/** Ответы-коды целиком. */
const USER_SIDE_CODES = new Set([
  'insufficient_tokens',
  'text_too_long',
  'empty_text',
  'empty text',
  'empty prompt',
  'rate_limited',
]);

/** Подстроки в нижнем регистре. */
const USER_SIDE_PHRASES = [
  // нет обязательного аргумента
  'missing prompt',
  'missing sourceimageurl',
  'sourceimageurl required',
  'requires at least',
  'requires a prompt',
  'requires sourceimageurl',
  'обязател',
  'укажи ',
  'нужен ',
  'требует datetime',
  // значение вне правил
  'supports at most',
  'supports mode',
  'length must be',
  'unsupported video model',
  'должен быть',
  'максимум',
  'некорректные даты',
  'проверьте ',
  'cityid не из вариантов',
  'не найден в базе',
  // ссылки и файлы от модели
  'ссылка не принята',
  'invalid data url',
  'did not return an image',
  'bad mime type',
  'file too large',
  // модерация запроса
  'отклонён модерацией',
  // лимиты самого пользователя
  'too many concurrent jobs',
  'own voice not ready',
  'limit reached',
  // чужое или несуществующее
  'job not found',
  'not your job',
];

export function isUserSideToolError(error: unknown): boolean {
  const e = String(error ?? '').trim().toLowerCase();
  if (!e) return false;
  if (USER_SIDE_CODES.has(e)) return true;
  return USER_SIDE_PHRASES.some((p) => e.includes(p));
}

/**
 * Подпись сбоя для склейки: инструмент плюс ошибка без того, что меняется от
 * вызова к вызову (адреса, id, числа). Ассистента в подписи нет: снятая
 * модель у Киры и у Романа — один сбой.
 */
export function failureSignature(tool: string, error: unknown): string {
  const norm = String(error ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/g, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return `${tool}|${norm}`;
}
```

- [ ] **Шаг 4: сверить список с текущим кодом инструментов** (после перехода видео на Omni в `video.service.ts` могли появиться новые проверки ввода)

```bash
grep -n -E "throw new (BadRequestException|ConflictException)\(" $WT/src/video/video.service.ts | cut -c1-200
grep -n -E "return \{ ok: false, error: '" $WT/src/chat/chat-tools.ts | cut -c1-200
```
Каждое сообщение проверки ввода из вывода должно давать `true` в `isUserSideToolError`. Если есть сообщение, которое не покрыто, — добавить подстроку в `USER_SIDE_PHRASES` и строку в второй `it.each` теста. Сообщения о сбое провайдера (`Veo …failed`, `… not configured`) — не трогать.

- [ ] **Шаг 5: коммит и прогон — зелёный**

```bash
git -C $WT add src/problem-report/problem-classify.ts src/problem-report/problem-classify.spec.ts
git -C $WT commit -q -m "feat(problem-report): классификатор сбоев инструментов и подпись для склейки" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/problem-report'
```
Expected: PASS, все тесты `problem-classify.spec.ts` зелёные (больше 60).

---

## Задача 2. Тексты сообщений

**Files:**
- Create: `src/problem-report/problem-format.ts`
- Test: `src/problem-report/problem-format.spec.ts`

- [ ] **Шаг 1: тест**

`src/problem-report/problem-format.spec.ts`:

```ts
import {
  clip, escapeHtml, formatAssistantReport, formatToolFailure, timesRu, toolAction, usersRu,
} from './problem-format';
import { CHAT_TOOLS } from '../chat/chat-tools';

describe('тексты в группу «Поддержка linkeon»', () => {
  it('сбой инструмента: ассистент, что не вышло, ошибка, пользователь', () => {
    const t = formatToolFailure({
      assistant: 'Кира', tool: 'generate_video', userId: 'u1',
      error: 'Veo generate failed: model is no longer available',
    });
    expect(t.split('\n')).toEqual([
      '🛠 <b>Кира: не получилось создать видео</b>',
      'Ошибка: <code>Veo generate failed: model is no longer available</code>',
      'Пользователь: <code>u1</code>',
    ]);
  });

  it('повторы — отдельной строкой, с согласованием', () => {
    const t = formatToolFailure({ assistant: 'Кира', tool: 'generate_video', error: 'x', userId: 'u1', repeats: { count: 4, users: 3 } });
    expect(t.split('\n')[3]).toBe('С прошлого сообщения: ещё 4 раза у 3 пользователей');
  });

  it('без повторов строки нет', () => {
    expect(formatToolFailure({ assistant: 'Кира', tool: 'generate_video', error: 'x', userId: 'u1', repeats: null }))
      .not.toContain('С прошлого сообщения');
    expect(formatToolFailure({ assistant: 'Кира', tool: 'generate_video', error: 'x', userId: 'u1', repeats: { count: 0, users: 0 } }))
      .not.toContain('С прошлого сообщения');
  });

  it('HTML экранируется везде', () => {
    const t = formatToolFailure({ assistant: '<b>Ки&ра</b>', tool: 'generate_image', error: '<script>&', userId: '<u>' });
    expect(t).toContain('&lt;b&gt;Ки&amp;ра&lt;/b&gt;');
    expect(t).toContain('<code>&lt;script&gt;&amp;</code>');
    expect(t).toContain('<code>&lt;u&gt;</code>');
  });

  it('ошибка обрезается до 300 символов с многоточием', () => {
    const t = formatToolFailure({ assistant: 'Кира', tool: 'generate_image', error: 'e'.repeat(1000), userId: 'u1' });
    const code = t.split('\n')[1].replace(/^Ошибка: <code>/, '').replace(/<\/code>$/, '');
    expect(code.length).toBe(300);
    expect(code.endsWith('…')).toBe(true);
  });

  it('незнакомый инструмент — «выполнить <имя>»', () => {
    expect(toolAction('do_magic')).toBe('выполнить do_magic');
    expect(toolAction('generate_speech')).toBe('озвучить текст');
  });

  // Новый инструмент в CHAT_TOOLS без человеческого названия здесь — красный тест.
  it('у каждого инструмента Linkeon своё действие', () => {
    for (const t of CHAT_TOOLS) expect(toolAction(t.name)).not.toMatch(/^выполнить /);
  });

  it('согласование «раз» и «пользователей»', () => {
    expect([1, 2, 5, 21, 22].map(timesRu)).toEqual(['1 раз', '2 раза', '5 раз', '21 раз', '22 раза']);
    expect([1, 2, 5, 21].map(usersRu)).toEqual([
      'у 1 пользователя', 'у 2 пользователей', 'у 5 пользователей', 'у 21 пользователя',
    ]);
  });

  it('сообщение ассистента: свой сбой и жалоба пользователя, канал', () => {
    expect(formatAssistantReport({ assistant: 'Кира', kind: 'my_failure', summary: 'LibreOffice падает', userId: 'u1', channel: 'web' }).split('\n'))
      .toEqual(['🙋 <b>Кира: у меня не работает</b>', '«LibreOffice падает»', 'Пользователь: <code>u1</code> · веб']);
    expect(formatAssistantReport({ assistant: 'Кира', kind: 'user_report', summary: 'не проходит оплата', userId: 'u1', channel: 'telegram' }).split('\n'))
      .toEqual(['🙋 <b>Кира передаёт жалобу пользователя</b>', '«не проходит оплата»', 'Пользователь: <code>u1</code> · Telegram']);
  });

  it('пересказ ассистента экранируется и обрезается', () => {
    const line = formatAssistantReport({ assistant: 'Кира', kind: 'my_failure', summary: '<i>' + 'x'.repeat(900), userId: 'u1', channel: 'web' })
      .split('\n')[1];
    expect(line.startsWith('«&lt;i&gt;')).toBe(true);
    expect(line.endsWith('…»')).toBe(true);
    expect(line.length).toBeLessThan(520);
  });

  it('имя ассистента не длиннее 40 символов', () => {
    const head = formatAssistantReport({ assistant: 'А'.repeat(100), kind: 'my_failure', summary: 's', userId: 'u1', channel: 'web' }).split('\n')[0];
    expect(head).toBe(`🙋 <b>${'А'.repeat(39)}…: у меня не работает</b>`);
  });

  it('clip и escapeHtml', () => {
    expect(clip('  abc  ', 10)).toBe('abc');
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });
});
```

- [ ] **Шаг 2: коммит и прогон — должен упасть**

```bash
git -C $WT add src/problem-report/problem-format.spec.ts
git -C $WT commit -q -m "test(problem-report): тексты сообщений — красный" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/problem-report/problem-format'
```
Expected: FAIL — `Cannot find module './problem-format'`.

- [ ] **Шаг 3: реализация**

`src/problem-report/problem-format.ts`:

```ts
/**
 * Тексты сообщений в группу «Поддержка linkeon» (parse_mode HTML).
 *
 * Чистые функции: всё, что приходит снаружи, экранируется и обрезается.
 * Аргументов инструмента (промпт видео, текст озвучки) здесь нет и быть не
 * должно — решение владельца 24.10.2026: в группу уходит только служебное.
 */

/** Что не получилось — по инструменту из CHAT_TOOLS (src/chat/chat-tools.ts). */
const TOOL_ACTIONS: Record<string, string> = {
  generate_image: 'создать картинку',
  generate_banner: 'сделать баннер',
  edit_image: 'изменить картинку',
  compose_image: 'совместить картинки',
  upscale_image: 'улучшить картинку',
  generate_video: 'создать видео',
  generate_speech: 'озвучить текст',
  manage_routine: 'настроить рутину',
  propose_calendar_event: 'предложить событие в календарь',
  read_calendar: 'прочитать календарь',
  calculate_human_design: 'рассчитать бодиграф',
};

export function toolAction(tool: string): string {
  return TOOL_ACTIONS[tool] ?? `выполнить ${tool}`;
}

export function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Обрезает до max символов вместе с многоточием. */
export function clip(s: string, max: number): string {
  const t = String(s ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const RU = new Intl.PluralRules('ru');

/** «1 раз», «2 раза», «5 раз». */
export function timesRu(n: number): string {
  return `${n} ${RU.select(n) === 'few' ? 'раза' : 'раз'}`;
}

/** «у 1 пользователя», «у 2 пользователей», «у 21 пользователя». */
export function usersRu(n: number): string {
  return `у ${n} ${RU.select(n) === 'one' ? 'пользователя' : 'пользователей'}`;
}

export interface Repeats {
  count: number;
  users: number;
}

export function formatToolFailure(p: {
  assistant: string;
  tool: string;
  error: string;
  userId: string;
  repeats?: Repeats | null;
}): string {
  const lines = [
    `🛠 <b>${escapeHtml(clip(p.assistant, 40))}: не получилось ${escapeHtml(toolAction(p.tool))}</b>`,
    `Ошибка: <code>${escapeHtml(clip(p.error, 300))}</code>`,
    `Пользователь: <code>${escapeHtml(p.userId)}</code>`,
  ];
  if (p.repeats && p.repeats.count > 0) {
    lines.push(`С прошлого сообщения: ещё ${timesRu(p.repeats.count)} ${usersRu(p.repeats.users)}`);
  }
  return lines.join('\n');
}

export type ProblemKind = 'my_failure' | 'user_report';
export type ProblemChannel = 'web' | 'telegram';

export function formatAssistantReport(p: {
  assistant: string;
  kind: ProblemKind;
  summary: string;
  userId: string;
  channel: ProblemChannel;
}): string {
  const who = escapeHtml(clip(p.assistant, 40));
  const head = p.kind === 'user_report'
    ? `🙋 <b>${who} передаёт жалобу пользователя</b>`
    : `🙋 <b>${who}: у меня не работает</b>`;
  return [
    head,
    `«${escapeHtml(clip(p.summary, 500))}»`,
    `Пользователь: <code>${escapeHtml(p.userId)}</code> · ${p.channel === 'telegram' ? 'Telegram' : 'веб'}`,
  ].join('\n');
}
```

- [ ] **Шаг 4: коммит и прогон — зелёный**

```bash
git -C $WT add src/problem-report/problem-format.ts
git -C $WT commit -q -m "feat(problem-report): тексты сообщений в группу поддержки" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/problem-report'
```
Expected: PASS (классификатор и тексты).

---

## Задача 3. `ProblemReportService`: путь А (сбой инструмента)

**Files:**
- Create: `src/problem-report/problem-report.service.ts`
- Test: `src/problem-report/problem-report.service.spec.ts`

- [ ] **Шаг 1: тест пути А**

`src/problem-report/problem-report.service.spec.ts`:

```ts
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  telegramConfigured: jest.fn(() => true),
}));

import { Logger } from '@nestjs/common';
import { sendTelegramAlert, telegramConfigured } from '../common/telegram-alert';
import { ProblemReportService } from './problem-report.service';

const sent = sendTelegramAlert as jest.Mock;
const configured = telegramConfigured as jest.Mock;
/** setImmediate срабатывает после всех микрозадач — отправка без ожидания успевает. */
const flush = () => new Promise((r) => setImmediate(r));
const KIRA_ERROR = 'Veo generate failed: This model models/veo-3.1-fast-generate-preview is no longer available.';
const MIN = 60_000;
const ENV = ['PROBLEM_REPORT_COOLDOWN_MIN', 'PROBLEM_REPORT_USER_HOURLY', 'PROBLEM_REPORT_USER_DAILY', 'PROBLEM_REPORT_GLOBAL_DAILY'];

const pgWith = (rows: any[] = [{ display_name: 'Кира', name: 'Кира' }]) => ({ query: jest.fn(async () => ({ rows })) });

let now = 0;
let clock: jest.SpyInstance;
beforeEach(() => {
  sent.mockReset();
  sent.mockImplementation(async () => {});
  configured.mockReset();
  configured.mockReturnValue(true);
  for (const k of ENV) delete process.env[k];
  now = Date.UTC(2026, 9, 24, 11, 12);
  clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => clock.mockRestore());

const failure = (over: Partial<{ userId: string; assistantId: string | null; tool: string; error: string }> = {}) => ({
  userId: 'u1', assistantId: '22', tool: 'generate_video', error: KIRA_ERROR, ...over,
});

describe('reportToolFailure — путь А', () => {
  it('сбой Киры: сообщение в группу, ассистенту — supportNotified', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    expect(svc.reportToolFailure(failure())).toEqual({ supportNotified: true });
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
    const [text, extra] = sent.mock.calls[0];
    expect(text).toContain('🛠 <b>Кира: не получилось создать видео</b>');
    expect(text).toContain('no longer available');
    expect(text).toContain('<code>u1</code>');
    expect(extra).toEqual({ disable_web_page_preview: true });
  });

  it('виноват не сервис — тишина и без supportNotified', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    expect(svc.reportToolFailure(failure({ error: 'insufficient_tokens' }))).toEqual({ supportNotified: false });
    await flush();
    expect(sent).not.toHaveBeenCalled();
  });

  it('повтор в паузе — без сообщения, но команда в курсе', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure({ userId: 'u1' }));
    now += MIN;
    expect(svc.reportToolFailure(failure({ userId: 'u2' }))).toEqual({ supportNotified: true });
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('после паузы — новое сообщение со счётчиком повторов', async () => {
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure({ userId: 'u1' }));
    now = t0 + MIN;
    svc.reportToolFailure(failure({ userId: 'u2' }));
    now = t0 + 5 * MIN;
    svc.reportToolFailure(failure({ userId: 'u2' }));
    now = t0 + 61 * MIN;
    svc.reportToolFailure(failure({ userId: 'u3' }));
    await flush();
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1][0]).toContain('С прошлого сообщения: ещё 2 раза у 1 пользователя');
  });

  it('пауза — из PROBLEM_REPORT_COOLDOWN_MIN', async () => {
    process.env.PROBLEM_REPORT_COOLDOWN_MIN = '5';
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure());
    now += 6 * MIN;
    svc.reportToolFailure(failure());
    await flush();
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('разные инструменты не склеиваются', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure({ tool: 'generate_video', error: 'boom' }));
    svc.reportToolFailure(failure({ tool: 'generate_image', error: 'boom' }));
    await flush();
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('подписи старше суток забываются: после них нет «С прошлого сообщения»', async () => {
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure());
    now = t0 + 30 * MIN;
    svc.reportToolFailure(failure());
    now = t0 + 25 * 60 * MIN;
    svc.reportToolFailure(failure());
    await flush();
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1][0]).not.toContain('С прошлого сообщения');
  });

  it('Telegram не настроен: supportNotified=false, в группу ничего, текст — в лог', async () => {
    configured.mockReturnValue(false);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = new ProblemReportService(pgWith() as any);
    expect(svc.reportToolFailure(failure())).toEqual({ supportNotified: false });
    await flush();
    expect(sent).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('не получилось создать видео');
    log.mockRestore();
  });

  it('хода нет — «Ассистент», в базу не ходим', async () => {
    const pg = pgWith();
    const svc = new ProblemReportService(pg as any);
    svc.reportToolFailure(failure({ assistantId: null }));
    await flush();
    expect(sent.mock.calls[0][0]).toContain('🛠 <b>Ассистент: не получилось создать видео</b>');
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('кастомный ассистент — имя из custom_agents', async () => {
    const pg = pgWith([{ name: 'Мой юрист' }]);
    const svc = new ProblemReportService(pg as any);
    svc.reportToolFailure(failure({ assistantId: 'custom:3f2b9c1e-1111-4a2b-9c3d-123456789abc' }));
    await flush();
    expect(pg.query.mock.calls[0][0]).toContain('custom_agents');
    expect(pg.query.mock.calls[0][1]).toEqual(['3f2b9c1e-1111-4a2b-9c3d-123456789abc']);
    expect(sent.mock.calls[0][0]).toContain('Мой юрист: не получилось');
  });

  it('база упала — «Ассистент», сообщение всё равно уходит', async () => {
    const pg = { query: jest.fn(async () => { throw new Error('db down'); }) };
    const svc = new ProblemReportService(pg as any);
    svc.reportToolFailure(failure());
    await flush();
    expect(sent.mock.calls[0][0]).toContain('Ассистент: не получилось');
  });

  it('отправка упала — вызов не бросает', async () => {
    sent.mockRejectedValueOnce(new Error('telegram down'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const svc = new ProblemReportService(pgWith() as any);
    expect(() => svc.reportToolFailure(failure())).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Шаг 2: коммит и прогон — должен упасть**

```bash
git -C $WT add src/problem-report/problem-report.service.spec.ts
git -C $WT commit -q -m "test(problem-report): путь А — сбой инструмента — красный" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/problem-report/problem-report.service'
```
Expected: FAIL — `Cannot find module './problem-report.service'`.

- [ ] **Шаг 3: реализация пути А**

`src/problem-report/problem-report.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { sendTelegramAlert, telegramConfigured } from '../common/telegram-alert';
import { failureSignature, isUserSideToolError } from './problem-classify';
import { formatToolFailure, Repeats } from './problem-format';

/** Подсказка ассистенту в результате инструмента, когда команда уже знает о сбое. */
export const SUPPORT_NOTE =
  'Команда Linkeon уже получила сообщение об этом сбое. Скажи пользователю простыми словами, ' +
  'что не получилось и что команда в курсе. Срок починки не обещай.';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FALLBACK_NAME = 'Ассистент';

interface Incident {
  lastSentAt: number;
  lastSeenAt: number;
  repeats: number;
  users: Set<string>;
}

/** Положительное число из .env или значение по умолчанию. */
function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Сообщения о сбоях ассистентов в группу «Поддержка linkeon».
 * Спека: docs/superpowers/specs/2026-10-24-assistant-problem-reports-design.md.
 *
 * Состояние (склейка, счётчики, лимиты) — в памяти процесса: linkeon-api —
 * один экземпляр, так же живут QualityMonitorService и activeTurns. Рестарт
 * его обнуляет; худшее последствие — одно лишнее сообщение после выката.
 *
 * Отправка никогда не задерживает и не роняет ответ инструмента: решение
 * синхронное, имя ассистента и Telegram — без ожидания.
 */
@Injectable()
export class ProblemReportService {
  private readonly logger = new Logger(ProblemReportService.name);
  private readonly incidents = new Map<string, Incident>();

  constructor(private readonly pg: PgService) {}

  private cooldownMs(): number {
    return envNumber('PROBLEM_REPORT_COOLDOWN_MIN', 60) * 60_000;
  }

  /**
   * Путь А: инструмент Linkeon ответил ok:false.
   *
   * supportNotified — сказать ли ассистенту «команда в курсе»: да для любого
   * сбоя (и отправленного, и склеенного с уже отправленным), но только если
   * Telegram настроен — иначе команде сообщить нечем.
   */
  reportToolFailure(p: { userId: string; assistantId: string | null; tool: string; error: string }): { supportNotified: boolean } {
    if (isUserSideToolError(p.error)) return { supportNotified: false };
    try {
      const now = Date.now();
      this.forgetOld(now);
      const sig = failureSignature(p.tool, p.error);
      const inc = this.incidents.get(sig);
      if (inc && now - inc.lastSentAt < this.cooldownMs()) {
        inc.repeats++;
        inc.users.add(p.userId);
        inc.lastSeenAt = now;
      } else {
        const repeats: Repeats | null = inc && inc.repeats > 0 ? { count: inc.repeats, users: inc.users.size } : null;
        this.incidents.set(sig, { lastSentAt: now, lastSeenAt: now, repeats: 0, users: new Set() });
        void this.deliver('tool_failure', async () =>
          formatToolFailure({
            assistant: await this.assistantName(p.assistantId),
            tool: p.tool,
            error: p.error,
            userId: p.userId,
            repeats,
          }),
        );
      }
    } catch (e: any) {
      this.logger.warn(`problem-report: сбой ${p.tool} не обработан: ${e?.message}`);
    }
    return { supportNotified: telegramConfigured() };
  }

  /** Имя ассистента: agents по числовому id или по имени, custom_agents — по custom:<uuid>. */
  async assistantName(assistantId: string | null): Promise<string> {
    if (!assistantId || !this.pg) return FALLBACK_NAME;
    try {
      if (assistantId.startsWith('custom:')) {
        const r = await this.pg.query('SELECT name FROM custom_agents WHERE id = $1 LIMIT 1', [assistantId.slice('custom:'.length)]);
        return r.rows[0]?.name || FALLBACK_NAME;
      }
      const r = /^\d+$/.test(assistantId)
        ? await this.pg.query('SELECT display_name, name FROM agents WHERE id = $1 LIMIT 1', [parseInt(assistantId, 10)])
        : await this.pg.query('SELECT display_name, name FROM agents WHERE name = $1 LIMIT 1', [assistantId]);
      return r.rows[0]?.display_name || r.rows[0]?.name || FALLBACK_NAME;
    } catch {
      return FALLBACK_NAME;
    }
  }

  /** Собирает текст и шлёт. Не бросает; без Telegram — пишет текст в лог (так на test). */
  private async deliver(kind: 'tool_failure' | 'assistant_report', build: () => Promise<string>): Promise<void> {
    try {
      const text = await build();
      if (!telegramConfigured()) {
        this.logger.log(`problem-report: ${text.replace(/\n/g, ' | ')}`);
        return;
      }
      await sendTelegramAlert(text, { disable_web_page_preview: true });
      this.logger.log(`problem-report: отправлено (${kind})`);
    } catch (e: any) {
      this.logger.warn(`problem-report: не отправлено (${kind}): ${e?.message}`);
    }
  }

  /** Подписи, по которым ничего не было больше суток, — из памяти. */
  private forgetOld(now: number): void {
    for (const [sig, inc] of this.incidents) {
      if (now - inc.lastSeenAt > DAY) this.incidents.delete(sig);
    }
  }
}
```

- [ ] **Шаг 4: коммит и прогон — зелёный**

```bash
git -C $WT add src/problem-report/problem-report.service.ts
git -C $WT commit -q -m "feat(problem-report): путь А — сбой инструмента в группу поддержки, склейка" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/problem-report'
```
Expected: PASS, все тесты модуля зелёные.

---

## Задача 4. `ProblemReportService`: путь Б (`reportFromAssistant`)

**Files:**
- Modify: `src/problem-report/problem-report.service.ts`
- Modify (дописать): `src/problem-report/problem-report.service.spec.ts`

- [ ] **Шаг 1: дописать тесты пути Б в конец `problem-report.service.spec.ts`**

Сначала дополнить импорт сервиса в начале файла:

```ts
import {
  BAD_INPUT_SAY, NOT_CONFIGURED_SAY, ProblemReportService, RATE_LIMITED_SAY, REPORTED_SAY,
} from './problem-report.service';
```

(строку `import { ProblemReportService } from './problem-report.service';` заменить этой). Затем в конец файла:

```ts
const report = (over: Record<string, unknown> = {}) => ({
  userId: 'u1', channel: 'web' as const, assistantId: '22', assistantArg: 'Кира',
  kind: 'my_failure', summary: 'LibreOffice падает при конвертации', ...over,
});

describe('reportFromAssistant — путь Б', () => {
  it('сообщение уходит, ассистенту — что сказать', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    expect(await svc.reportFromAssistant(report())).toEqual({ ok: true, reported: true, say: REPORTED_SAY });
    await flush();
    expect(sent.mock.calls[0][0]).toBe(
      '🙋 <b>Кира: у меня не работает</b>\n«LibreOffice падает при конвертации»\nПользователь: <code>u1</code> · веб',
    );
  });

  it('жалоба пользователя из Telegram, хода нет — имя из аргумента, в базу не ходим', async () => {
    const pg = pgWith();
    const svc = new ProblemReportService(pg as any);
    await svc.reportFromAssistant(report({ channel: 'telegram', assistantId: null, assistantArg: 'Райя', kind: 'user_report', summary: 'не проходит оплата' }));
    await flush();
    expect(sent.mock.calls[0][0]).toBe(
      '🙋 <b>Райя передаёт жалобу пользователя</b>\n«не проходит оплата»\nПользователь: <code>u1</code> · Telegram',
    );
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('имя из хода главнее аргумента', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    await svc.reportFromAssistant(report({ assistantArg: 'Самозванец' }));
    await flush();
    expect(sent.mock.calls[0][0]).toContain('Кира: у меня не работает');
  });

  it('аргумент имени обрезается до 40, пустой — «Ассистент»', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    await svc.reportFromAssistant(report({ assistantId: null, assistantArg: 'Б'.repeat(60) }));
    await svc.reportFromAssistant(report({ assistantId: null, assistantArg: '   ', userId: 'u2' }));
    await flush();
    expect(sent.mock.calls[0][0]).toContain(`🙋 <b>${'Б'.repeat(39)}…: у меня не работает</b>`);
    expect(sent.mock.calls[1][0]).toContain('🙋 <b>Ассистент: у меня не работает</b>');
  });

  it('bad_input: пустой summary или неизвестный kind — в группу ничего', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    expect(await svc.reportFromAssistant(report({ summary: '  ' }))).toEqual({ ok: false, error: 'bad_input', say: BAD_INPUT_SAY });
    expect(await svc.reportFromAssistant(report({ kind: 'panic' }))).toEqual({ ok: false, error: 'bad_input', say: BAD_INPUT_SAY });
    await flush();
    expect(sent).not.toHaveBeenCalled();
  });

  it('Telegram не настроен — not_configured, ассистент не скажет «передал»', async () => {
    configured.mockReturnValue(false);
    const svc = new ProblemReportService(pgWith() as any);
    expect(await svc.reportFromAssistant(report())).toEqual({ ok: false, error: 'not_configured', say: NOT_CONFIGURED_SAY });
    await flush();
    expect(sent).not.toHaveBeenCalled();
  });

  it('3 в час на пользователя: четвёртое — rate_limited; другой пользователь не задет; через час снова можно', async () => {
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    for (let i = 0; i < 3; i++) expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    expect(await svc.reportFromAssistant(report())).toEqual({ ok: false, error: 'rate_limited', say: RATE_LIMITED_SAY });
    expect((await svc.reportFromAssistant(report({ userId: 'u2' }))).ok).toBe(true);
    now = t0 + 61 * MIN;
    expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    await flush();
    expect(sent).toHaveBeenCalledTimes(5);
  });

  it('сутки на пользователя — из PROBLEM_REPORT_USER_DAILY', async () => {
    process.env.PROBLEM_REPORT_USER_HOURLY = '100';
    process.env.PROBLEM_REPORT_USER_DAILY = '2';
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    expect((await svc.reportFromAssistant(report())).ok).toBe(false);
    now = t0 + 25 * 60 * MIN;
    expect((await svc.reportFromAssistant(report())).ok).toBe(true);
  });

  it('общий лимит в сутки — из PROBLEM_REPORT_GLOBAL_DAILY', async () => {
    process.env.PROBLEM_REPORT_GLOBAL_DAILY = '2';
    const svc = new ProblemReportService(pgWith() as any);
    expect((await svc.reportFromAssistant(report({ userId: 'u1' }))).ok).toBe(true);
    expect((await svc.reportFromAssistant(report({ userId: 'u2' }))).ok).toBe(true);
    expect(await svc.reportFromAssistant(report({ userId: 'u3' }))).toEqual({ ok: false, error: 'rate_limited', say: RATE_LIMITED_SAY });
  });
});
```

- [ ] **Шаг 2: коммит и прогон — должен упасть**

```bash
git -C $WT add src/problem-report/problem-report.service.spec.ts
git -C $WT commit -q -m "test(problem-report): путь Б — сообщение ассистента — красный" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/problem-report/problem-report.service'
```
Expected: FAIL — `svc.reportFromAssistant is not a function` (и `REPORTED_SAY` undefined).

- [ ] **Шаг 3: реализация пути Б**

В `src/problem-report/problem-report.service.ts`:

1) В существующий импорт из `./problem-format` ДОБАВИТЬ `formatAssistantReport`, `ProblemChannel`, `ProblemKind` (не заменять: после ревью задачи 3 там уже `clip`, `FALLBACK_NAME`, `formatToolCapNotice`, `head`, `isKnownTool`, `oneLine` — без них сервис упадёт в рантайме, а jest типы не проверяет).

> После ревью задач 1–3 код сервиса отличается от блоков этого плана (общий потолок пути А, копии вместо срезов, хэш-ключ склейки, таймаут имени ассистента) — источник правды: код ветки и спека, раздел «Склейка».

2) После `SUPPORT_NOTE` добавить:

```ts
/** Поле say в ответе report_problem — что сказать пользователю (как у инструмента продуктов). */
export const REPORTED_SAY =
  'Передано команде Linkeon. Скажи пользователю, что передал(а) проблему команде; срок починки не обещай.';
export const RATE_LIMITED_SAY =
  'Сообщений в поддержку сейчас слишком много. Предложи пользователю написать во вкладку «Поддержка».';
export const BAD_INPUT_SAY =
  'Опиши проблему в summary (1–3 предложения) и укажи kind: my_failure или user_report.';
export const NOT_CONFIGURED_SAY =
  'Передать команде сейчас нечем. Предложи пользователю написать во вкладку «Поддержка».';

export type AssistantReportResult =
  | { ok: true; reported: true; say: string }
  | { ok: false; error: 'bad_input' | 'not_configured' | 'rate_limited'; say: string };
```

3) В класс, рядом с `incidents`, добавить поля:

```ts
  private readonly userReports = new Map<string, number[]>();
  private globalReports: number[] = [];
```

4) После метода `reportToolFailure` добавить:

```ts
  /**
   * Путь Б: инструмент report_problem — ассистент сообщает сам.
   * userId и channel — из подписанного токена точки продуктов, assistantId —
   * из хода (нет у TG-бота), остальное пишет модель.
   */
  async reportFromAssistant(p: {
    userId: string;
    channel: ProblemChannel;
    assistantId: string | null;
    assistantArg: unknown;
    kind: unknown;
    summary: unknown;
  }): Promise<AssistantReportResult> {
    const summary = typeof p.summary === 'string' ? p.summary.trim() : '';
    const kind: ProblemKind | null = p.kind === 'my_failure' || p.kind === 'user_report' ? p.kind : null;
    if (!summary || !kind) return { ok: false, error: 'bad_input', say: BAD_INPUT_SAY };
    if (!telegramConfigured()) return { ok: false, error: 'not_configured', say: NOT_CONFIGURED_SAY };
    if (!this.takeQuota(p.userId, Date.now())) return { ok: false, error: 'rate_limited', say: RATE_LIMITED_SAY };
    // До 40 символов имя обрежет форматтер (с многоточием), здесь — только пробелы.
    const arg = typeof p.assistantArg === 'string' ? p.assistantArg.trim() : '';
    void this.deliver('assistant_report', async () => {
      const fromTurn = p.assistantId ? await this.assistantName(p.assistantId) : FALLBACK_NAME;
      const assistant = fromTurn !== FALLBACK_NAME ? fromTurn : arg || FALLBACK_NAME;
      return formatAssistantReport({ assistant, kind, summary, userId: p.userId, channel: p.channel });
    });
    return { ok: true, reported: true, say: REPORTED_SAY };
  }

  /** Скользящие окна: час и сутки на пользователя, сутки на всех. Отказ квоту не тратит. */
  private takeQuota(userId: string, now: number): boolean {
    this.globalReports = this.globalReports.filter((t) => now - t < DAY);
    const mine = (this.userReports.get(userId) ?? []).filter((t) => now - t < DAY);
    const lastHour = mine.filter((t) => now - t < HOUR).length;
    if (
      lastHour >= envNumber('PROBLEM_REPORT_USER_HOURLY', 3) ||
      mine.length >= envNumber('PROBLEM_REPORT_USER_DAILY', 10) ||
      this.globalReports.length >= envNumber('PROBLEM_REPORT_GLOBAL_DAILY', 50)
    ) {
      this.userReports.set(userId, mine);
      return false;
    }
    mine.push(now);
    this.userReports.set(userId, mine);
    this.globalReports.push(now);
    return true;
  }
```

5) В `forgetOld` дописать в конец тела:

```ts
    for (const [userId, times] of this.userReports) {
      if (!times.some((t) => now - t < DAY)) this.userReports.delete(userId);
    }
```

- [ ] **Шаг 4: коммит и прогон — зелёный**

```bash
git -C $WT add src/problem-report/problem-report.service.ts
git -C $WT commit -q -m "feat(problem-report): путь Б — сообщение ассистента с лимитами" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/problem-report'
```
Expected: PASS.

---

## Задача 5. Инструмент `report_problem` и модуль

**Files:**
- Create: `src/problem-report/report-problem.tool.ts`
- Create: `src/problem-report/problem-report.module.ts`
- Test: `src/problem-report/report-problem.tool.spec.ts`

- [ ] **Шаг 1: тест**

`src/problem-report/report-problem.tool.spec.ts`:

```ts
import { REPORT_PROBLEM_TOOL, REPORT_PROBLEM_TOOL_NAME } from './report-problem.tool';

describe('инструмент report_problem', () => {
  it('имя и обязательные поля', () => {
    expect(REPORT_PROBLEM_TOOL.name).toBe('report_problem');
    expect(REPORT_PROBLEM_TOOL_NAME).toBe(REPORT_PROBLEM_TOOL.name);
    expect(REPORT_PROBLEM_TOOL.input_schema.required).toEqual(['assistant', 'kind', 'summary']);
    expect(REPORT_PROBLEM_TOOL.input_schema.properties.kind.enum).toEqual(['my_failure', 'user_report']);
  });

  // Владелец — из подписи токена точки продуктов; поле userId значило бы, что его пишет модель.
  it('аргумента userId нет', () => {
    expect(Object.keys(REPORT_PROBLEM_TOOL.input_schema.properties)).not.toContain('userId');
    expect(REPORT_PROBLEM_TOOL.input_schema.additionalProperties).toBe(false);
  });

  it('описание держит главные правила', () => {
    const d = REPORT_PROBLEM_TOOL.description;
    expect(d).toMatch(/supportNotified/);       // сбои инструментов Linkeon уходят сами
    expect(d).toMatch(/нехватке токенов/);
    expect(d).toMatch(/Без имени, телефона/);   // приватность
    expect(d).toMatch(/поле say/);
    expect(d).toMatch(/userId и телефон не передавай/);
  });
});
```

- [ ] **Шаг 2: коммит и прогон — должен упасть**

```bash
git -C $WT add src/problem-report/report-problem.tool.spec.ts
git -C $WT commit -q -m "test(problem-report): инструмент report_problem — красный" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/problem-report/report-problem'
```
Expected: FAIL — `Cannot find module './report-problem.tool'`.

- [ ] **Шаг 3: реализация**

`src/problem-report/report-problem.tool.ts`:

```ts
/**
 * Инструмент report_problem — ассистент сам сообщает команде о поломке.
 * Живёт на защищённой точке /webhook/mcp/products (products-mcp.controller.ts):
 * пользователь и канал берутся из подписи токена сессии, аргумента userId нет.
 *
 * Полное имя у модели — mcp__products__report_problem: ключ сервера
 * `products` общий с manage_product и find_files (relay-agent/server.mjs:
 * PRODUCTS_TOOLS; products-cli-tool.ts: REPORT_PROBLEM_CLI_TOOL_NAME).
 * Спека: docs/superpowers/specs/2026-10-24-assistant-problem-reports-design.md.
 */
export const REPORT_PROBLEM_TOOL_NAME = 'report_problem';

export const REPORT_PROBLEM_TOOL = {
  name: REPORT_PROBLEM_TOOL_NAME,
  description:
    'Сообщить команде Linkeon о поломке, которую ты сам не можешь исправить. Сообщение сразу уходит в рабочий чат поддержки.\n' +
    'Зови, когда не можешь выполнить просьбу пользователя из-за поломки:\n' +
    '• kind="my_failure" — сломалось у тебя: программа или конвертация падает раз за разом, файл не обрабатывается из-за ошибки окружения, нужного модуля нет, инструмент вернул бессмыслицу;\n' +
    '• kind="user_report" — пользователь говорит, что в Linkeon что-то не работает: оплата, кнопка, экран, не пришло видео.\n' +
    'НЕ зови: если инструмент Linkeon вернул ошибку с supportNotified=true — команда уже знает; при нехватке токенов; ' +
    'если ошибся сам пользователь; при отказе по соображениям безопасности; повторно о той же проблеме в этом разговоре.\n' +
    'summary — 1–3 предложения своими словами: что сломалось и что ты уже пробовал. Без имени, телефона, почты и адресов ' +
    'пользователя и без пересказа разговора.\n' +
    'Ответ несёт поле say — что сказать пользователю; следуй ему. Срок починки не обещай.\n' +
    'userId и телефон не передавай: сервер уже знает, чей это разговор.',
  input_schema: {
    type: 'object' as const,
    properties: {
      assistant: { type: 'string', description: 'Твоё имя как ассистента, например «Кира».' },
      kind: {
        type: 'string',
        enum: ['my_failure', 'user_report'],
        description: 'my_failure — сломалось у тебя; user_report — пользователь говорит, что в Linkeon что-то не работает.',
      },
      summary: {
        type: 'string',
        maxLength: 500,
        description: 'Что сломалось и что ты пробовал: 1–3 предложения, без личных данных пользователя.',
      },
    },
    required: ['assistant', 'kind', 'summary'],
    additionalProperties: false,
  },
};
```

`src/problem-report/problem-report.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ProblemReportService } from './problem-report.service';

/**
 * Сообщения о сбоях ассистентов в «Поддержку linkeon».
 * Зависит только от CommonModule: сюда ходят контроллеры MCP, а не наоборот,
 * поэтому цикла с ChatModule нет.
 */
@Module({
  imports: [CommonModule],
  providers: [ProblemReportService],
  exports: [ProblemReportService],
})
export class ProblemReportModule {}
```

- [ ] **Шаг 4: коммит и прогон — зелёный**

```bash
git -C $WT add src/problem-report/report-problem.tool.ts src/problem-report/problem-report.module.ts
git -C $WT commit -q -m "feat(problem-report): инструмент report_problem и модуль" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/problem-report'
```
Expected: PASS.

---

## Задача 6. `ChatService.activeAssistantFor`

**Files:**
- Modify: `src/chat/chat.service.ts` (после метода `getActiveTurn`, ~строка 384)
- Test: `src/chat/chat.service.active-assistant.spec.ts`

- [ ] **Шаг 1: тест**

`src/chat/chat.service.active-assistant.spec.ts`:

```ts
import { ChatService } from './chat.service';

/** Конструктор ChatService тянет 26 зависимостей — для метода над activeTurns он не нужен. */
const withTurns = (turns: Array<[string, number]>) => {
  const svc = Object.create(ChatService.prototype) as ChatService;
  (svc as any).activeTurns = new Map(turns);
  return svc;
};

describe('ChatService.activeAssistantFor — чей ход сейчас идёт', () => {
  it('ассистент самого свежего хода этого пользователя', () => {
    expect(withTurns([['u1_12', 100], ['u1_22', 200], ['u2_13', 300]]).activeAssistantFor('u1')).toBe('22');
  });

  it('кастомный ассистент — id целиком, с двоеточием', () => {
    expect(withTurns([['u1_custom:3f2b9c1e-1111-4a2b-9c3d-123456789abc', 5]]).activeAssistantFor('u1'))
      .toBe('custom:3f2b9c1e-1111-4a2b-9c3d-123456789abc');
  });

  it('хода нет — null', () => {
    expect(withTurns([['u2_13', 300]]).activeAssistantFor('u1')).toBeNull();
  });

  it('префикс не путает пользователей: u1 и u11', () => {
    expect(withTurns([['u11_12', 500]]).activeAssistantFor('u1')).toBeNull();
  });
});
```

- [ ] **Шаг 2: коммит и прогон — должен упасть**

```bash
git -C $WT add src/chat/chat.service.active-assistant.spec.ts
git -C $WT commit -q -m "test(chat): activeAssistantFor — красный" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/chat/chat.service.active-assistant'
```
Expected: FAIL — `svc.activeAssistantFor is not a function`.

- [ ] **Шаг 3: реализация** — в `src/chat/chat.service.ts` сразу после метода `getActiveTurn(...) { … }`:

```ts
  /**
   * Ассистент самого свежего хода этого пользователя — для подписи сообщений
   * в поддержку (src/problem-report). Ход открыт и в пути релея, и у Маши;
   * ключ activeTurns — `${userId}_${assistantId}`, а в userId подчёркиваний не
   * бывает (телефон или UUID). Хода нет — null.
   */
  activeAssistantFor(userId: string): string | null {
    const prefix = `${userId}_`;
    let best: { id: string; at: number } | null = null;
    for (const [key, at] of this.activeTurns) {
      if (!key.startsWith(prefix)) continue;
      if (!best || at > best.at) best = { id: key.slice(prefix.length), at };
    }
    return best ? best.id : null;
  }
```

- [ ] **Шаг 4: коммит и прогон — зелёный**

```bash
git -C $WT add src/chat/chat.service.ts
git -C $WT commit -q -m "feat(chat): activeAssistantFor — ассистент текущего хода пользователя" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/chat/chat.service.active-assistant'
```
Expected: PASS, 4 теста.

---

## Задача 7. Путь А в `McpController` и подключение модуля

**Files:**
- Modify: `src/mcp/mcp.controller.ts`
- Modify: `src/mcp/mcp.module.ts`
- Test: `src/mcp/mcp.controller.problem-report.spec.ts`

- [ ] **Шаг 1: тест**

`src/mcp/mcp.controller.problem-report.spec.ts`:

```ts
import { McpController } from './mcp.controller';
import { SUPPORT_NOTE } from '../problem-report/problem-report.service';

const KIRA_ERROR = 'Veo generate failed: This model models/veo-3.1-fast-generate-preview is no longer available.';

const make = (result: any, supportNotified = true) => {
  const tools = { executeTool: jest.fn(async () => result) };
  const problems = { reportToolFailure: jest.fn(() => ({ supportNotified })) };
  const chat = { activeAssistantFor: jest.fn(() => '22') };
  const ctrl = new McpController(tools as any, problems as any, chat as any);
  return { ctrl, tools, problems, chat };
};
const payload = (r: any) => JSON.parse(r.content[0].text);

describe('/mcp: сбой инструмента — в поддержку', () => {
  it('сбой: отправка с ассистентом хода; в результате supportNotified и supportNote; ошибка и isError прежние', async () => {
    const { ctrl, problems, chat, tools } = make({ ok: false, error: KIRA_ERROR });
    const r = await ctrl.callTool('generate_video', { userId: 'u1', mode: 'text2video', prompt: 'тайный промпт' });
    expect(tools.executeTool).toHaveBeenCalledWith('u1', 'generate_video', { mode: 'text2video', prompt: 'тайный промпт' });
    expect(chat.activeAssistantFor).toHaveBeenCalledWith('u1');
    expect(problems.reportToolFailure).toHaveBeenCalledWith({ userId: 'u1', assistantId: '22', tool: 'generate_video', error: KIRA_ERROR });
    expect(r.isError).toBe(true);
    expect(payload(r)).toEqual({ ok: false, error: KIRA_ERROR, supportNotified: true, supportNote: SUPPORT_NOTE });
  });

  // Решение владельца 24.10: в группу — только служебное, аргументы инструмента не уходят.
  it('аргументы инструмента в отправку не попадают', async () => {
    const { ctrl, problems } = make({ ok: false, error: KIRA_ERROR });
    await ctrl.callTool('generate_video', { userId: 'u1', prompt: 'тайный промпт' });
    expect(JSON.stringify(problems.reportToolFailure.mock.calls)).not.toContain('тайный промпт');
  });

  it('сервис сказал «не сбой» — полей нет', async () => {
    const { ctrl } = make({ ok: false, error: 'insufficient_tokens' }, false);
    const p = payload(await ctrl.callTool('generate_image', { userId: 'u1', prompt: 'x' }));
    expect(p.supportNotified).toBeUndefined();
    expect(p.supportNote).toBeUndefined();
  });

  it('успех — в поддержку не ходим', async () => {
    const { ctrl, problems } = make({ ok: true, kind: 'image', imageUrl: 'https://x/y.png', tokensSpent: 5000 });
    const r = await ctrl.callTool('generate_image', { userId: 'u1', prompt: 'x' });
    expect(problems.reportToolFailure).not.toHaveBeenCalled();
    expect(r.isError).toBe(false);
  });

  it('сообщение о сбое упало — ответ инструмента всё равно уходит как был', async () => {
    const { ctrl, problems } = make({ ok: false, error: KIRA_ERROR });
    problems.reportToolFailure.mockImplementation(() => { throw new Error('boom'); });
    const r = await ctrl.callTool('generate_video', { userId: 'u1' });
    expect(payload(r)).toEqual({ ok: false, error: KIRA_ERROR });
    expect(r.isError).toBe(true);
  });

  it('без userId — отказ; инструмент и поддержка не зовутся', async () => {
    const { ctrl, tools, problems } = make({ ok: true });
    const r = await ctrl.callTool('generate_video', { prompt: 'x' });
    expect(r.isError).toBe(true);
    expect(payload(r)).toEqual({ ok: false, error: 'userId argument required' });
    expect(tools.executeTool).not.toHaveBeenCalled();
    expect(problems.reportToolFailure).not.toHaveBeenCalled();
  });
});
```

- [ ] **Шаг 2: коммит и прогон — должен упасть**

```bash
git -C $WT add src/mcp/mcp.controller.problem-report.spec.ts
git -C $WT commit -q -m "test(mcp): сбой инструмента — в поддержку — красный" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/mcp/mcp.controller.problem-report'
```
Expected: FAIL — `ctrl.callTool is not a function`.

- [ ] **Шаг 3: реализация в `src/mcp/mcp.controller.ts`**

1) После строки `import { CHAT_TOOLS, ChatToolsService } from '../chat/chat-tools';` добавить:

```ts
import { ChatService } from '../chat/chat.service';
import { ProblemReportService, SUPPORT_NOTE } from '../problem-report/problem-report.service';
```

2) Конструктор `constructor(private readonly tools: ChatToolsService) {}` заменить на:

```ts
  constructor(
    private readonly tools: ChatToolsService,
    // Без @Optional сознательно: модуль, выпавший из McpModule, должен ронять
    // старт, а не молча выключать сообщения о сбоях — тихий отказ и был
    // поводом для этой работы (Кира, 24.10.2026).
    private readonly problems: ProblemReportService,
    private readonly chat: ChatService,
  ) {}
```

3) Обработчик `tools/call` внутри `makeServer()` (блок от комментария `// tools/call — pop userId, delegate to ChatToolsService.executeTool` до `});` перед `return server;`) заменить на:

```ts
    // tools/call — см. callTool.
    server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
      const { name, arguments: args } = req.params ?? {};
      return this.callTool(name, args);
    });
```

4) После метода `makeServer()` (перед `@Post()`) добавить:

```ts
  /**
   * tools/call: pop userId, delegate to ChatToolsService.executeTool.
   * Вынесено из makeServer ради проверяемости — как в products-mcp.controller.ts.
   */
  async callTool(name: string, args: any) {
    const userId = args?.userId;
    if (!userId) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'userId argument required' }) }],
        isError: true,
      };
    }
    const { userId: _omit, ...toolArgs } = args;
    this.logger.log(`tools/call ${name} userId=${userId}`);
    const result: any = await this.tools.executeTool(userId, name, toolArgs);
    if (result && result.ok === false) this.reportFailure(String(userId), String(name), result);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      isError: !result.ok,
    };
  }

  /**
   * Сбой инструмента — в «Поддержку linkeon» (src/problem-report), а
   * ассистенту — что команда в курсе. Подсказка едет в результате, а не в
   * промпте релея: так она не зависит от ручного выката релея. Ни ошибка, ни
   * isError не меняются. Никогда не бросает.
   */
  private reportFailure(userId: string, tool: string, result: any): void {
    try {
      const { supportNotified } = this.problems.reportToolFailure({
        userId,
        assistantId: this.chat.activeAssistantFor(userId),
        tool,
        error: String(result.error ?? ''),
      });
      if (supportNotified) {
        result.supportNotified = true;
        result.supportNote = SUPPORT_NOTE;
      }
    } catch (e: any) {
      this.logger.warn(`сообщение о сбое ${tool} не обработано: ${e?.message}`);
    }
  }
```

5) `src/mcp/mcp.module.ts` целиком:

```ts
import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { ProductsMcpController } from './products-mcp.controller';
import { ChatModule } from '../chat/chat.module';
import { ProductsModule } from '../products/products.module';
import { ProblemReportModule } from '../problem-report/problem-report.module';

@Module({
  imports: [ChatModule, ProductsModule, ProblemReportModule],
  controllers: [McpController, ProductsMcpController],
})
export class McpModule {}
```

- [ ] **Шаг 4: коммит и прогон — зелёный**

```bash
git -C $WT add src/mcp/mcp.controller.ts src/mcp/mcp.module.ts
git -C $WT commit -q -m "feat(mcp): сбой инструмента Linkeon — в «Поддержку linkeon», ассистенту supportNotified" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/mcp/mcp.controller.problem-report'
```
Expected: PASS, 6 тестов.

---

## Задача 8. Путь Б на точке продуктов

**Files:**
- Modify: `src/mcp/products-mcp.controller.ts`
- Modify: `src/mcp/products-mcp.controller.spec.ts` (конструктор и списки инструментов)
- Modify: `src/mcp/find-files-event.spec.ts` (конструктор)
- Test: `src/mcp/products-mcp.report-problem.spec.ts`

- [ ] **Шаг 1: новый тест**

`src/mcp/products-mcp.report-problem.spec.ts`:

```ts
import { ProductsMcpController } from './products-mcp.controller';
import { signProductToolToken } from '../products/product-tool.token';

process.env.JWT_SECRET = 'report-problem-spec';

const make = (assistantId: string | null = '22') => {
  const tool = { execute: jest.fn(async () => ({ ok: true })) };
  const files = { searchForUser: jest.fn(async () => ({ ok: true, total: 0, files: [] })) };
  const problems = { reportFromAssistant: jest.fn(async (): Promise<any> => ({ ok: true, reported: true, say: 'Передано' })) };
  const chat = { activeAssistantFor: jest.fn(() => assistantId) };
  const ctrl = new ProductsMcpController(tool as any, files as any, problems as any, chat as any);
  return { ctrl, tool, files, problems, chat };
};

describe('report_problem на точке продуктов', () => {
  it('пользователь и канал — из токена, ассистент — из хода; userId/channel из аргументов не значат ничего', async () => {
    const { ctrl, problems, chat, tool, files } = make('22');
    const r: any = await ctrl.callTool(
      `Bearer ${signProductToolToken('u-1', 'web')}`,
      { assistant: 'Кира', kind: 'my_failure', summary: 'LibreOffice падает', userId: 'чужой', channel: 'telegram' },
      'report_problem',
    );
    expect(r).toEqual({ ok: true, reported: true, say: 'Передано' });
    expect(chat.activeAssistantFor).toHaveBeenCalledWith('u-1');
    expect(problems.reportFromAssistant).toHaveBeenCalledWith({
      userId: 'u-1', channel: 'web', assistantId: '22',
      assistantArg: 'Кира', kind: 'my_failure', summary: 'LibreOffice падает',
    });
    expect(tool.execute).not.toHaveBeenCalled();
    expect(files.searchForUser).not.toHaveBeenCalled();
  });

  it('Telegram: инструмент есть, канал telegram, хода нет', async () => {
    const { ctrl, problems } = make(null);
    await ctrl.callTool(
      `Bearer ${signProductToolToken('u-1', 'telegram')}`,
      { assistant: 'Райя', kind: 'user_report', summary: 'не проходит оплата' },
      'report_problem',
    );
    expect(problems.reportFromAssistant).toHaveBeenCalledWith(expect.objectContaining({ channel: 'telegram', assistantId: null }));
  });

  it('отказ сервиса доходит до модели как есть', async () => {
    const { ctrl, problems } = make();
    problems.reportFromAssistant.mockResolvedValueOnce({ ok: false, error: 'rate_limited', say: 'Много' });
    const r: any = await ctrl.callTool(`Bearer ${signProductToolToken('u-1')}`, { assistant: 'Кира', kind: 'my_failure', summary: 'x' }, 'report_problem');
    expect(r).toEqual({ ok: false, error: 'rate_limited', say: 'Много' });
  });

  it('другие инструменты точки report_problem не задевают', async () => {
    const { ctrl, problems, tool } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('u-1')}`, { action: 'list' }, 'manage_product');
    expect(tool.execute).toHaveBeenCalled();
    expect(problems.reportFromAssistant).not.toHaveBeenCalled();
  });
});
```

- [ ] **Шаг 2: обновить существующие тесты под новый конструктор и список**

В `src/mcp/products-mcp.controller.spec.ts`, функция `make`, строку
`return { ctrl: new ProductsMcpController(tool as any, files as any), calls, tool, files };`
заменить на:

```ts
    const problems = { reportFromAssistant: jest.fn(async () => ({ ok: true, reported: true, say: 'ok' })) };
    const chat = { activeAssistantFor: jest.fn(() => null) };
    return { ctrl: new ProductsMcpController(tool as any, files as any, problems as any, chat as any), calls, tool, files };
```

Там же тест `'веб: продукты и поиск файлов, у обоих нет аргумента userId'` заменить на:

```ts
  it('веб: продукты, поиск файлов и сообщение в поддержку, ни у одного нет аргумента userId', () => {
    const { ctrl } = make();
    const tools = ctrl.listTools('web');
    expect(tools.map((t: any) => t.name)).toEqual(['manage_product', 'find_files', 'report_problem']);
    for (const t of tools as any[]) expect(Object.keys(t.inputSchema.properties)).not.toContain('userId');
  });
```

и тест `'Telegram: только продукты — поиск файлов в боте не включён'` — на:

```ts
  it('Telegram: продукты и сообщение в поддержку — поиск файлов в боте не включён', () => {
    const { ctrl } = make();
    expect(ctrl.listTools('telegram').map((t: any) => t.name)).toEqual(['manage_product', 'report_problem']);
  });
```

В `src/mcp/find-files-event.spec.ts` обе строки создания контроллера:

```ts
    const ctrl = new ProductsMcpController({} as any, files as any, {} as any, {} as any, events as any);
```

```ts
    const ctrl = new ProductsMcpController(tool as any, {} as any, {} as any, {} as any, events as any);
```

- [ ] **Шаг 3: коммит и прогон — должен упасть**

```bash
git -C $WT add src/mcp/products-mcp.report-problem.spec.ts src/mcp/products-mcp.controller.spec.ts src/mcp/find-files-event.spec.ts
git -C $WT commit -q -m "test(mcp): report_problem на точке продуктов — красный" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/mcp/'
```
Expected: FAIL — списки инструментов без `report_problem`; `find-files-event` красный (events попал в чужой параметр); `report_problem` — «Неизвестный инструмент».

- [ ] **Шаг 4: реализация в `src/mcp/products-mcp.controller.ts`**

1) После строки `import { EventsService } from '../events/events.service';` добавить:

```ts
import { ChatService } from '../chat/chat.service';
import { ProblemReportService } from '../problem-report/problem-report.service';
import { REPORT_PROBLEM_TOOL, REPORT_PROBLEM_TOOL_NAME } from '../problem-report/report-problem.tool';
```

2) Конструктор заменить на:

```ts
  constructor(
    private readonly tool: ProductToolService,
    private readonly files: ChatFilesService,
    // Без @Optional — по той же причине, что в mcp.controller.ts: выпавший
    // модуль должен ронять старт, а не молча выключать инструмент.
    private readonly problems: ProblemReportService,
    private readonly chat: ChatService,
    @Optional() private readonly events?: EventsService,
  ) {}
```

3) Метод `toolsFor` заменить на:

```ts
  /**
   * Инструменты по каналу токена: поиск файлов — только в вебе (TG-бот в эту
   * фичу не входит); сообщить в поддержку — в обоих каналах.
   */
  private toolsFor(channel: ProductToolChannel) {
    return channel === 'telegram'
      ? [...PRODUCT_TOOLS, REPORT_PROBLEM_TOOL]
      : [...PRODUCT_TOOLS, FIND_FILES_TOOL, REPORT_PROBLEM_TOOL];
  }
```

4) В `callTool`, сразу перед последней строкой `return this.tool.execute(userId, input, channel);`, добавить:

```ts
    if (name === REPORT_PROBLEM_TOOL_NAME) {
      // Пользователь и канал — из подписи, как у остальных инструментов точки;
      // ассистент — из хода (у TG-бота хода в ChatService нет — тогда имя из аргумента).
      return this.problems.reportFromAssistant({
        userId,
        channel,
        assistantId: channel === 'web' ? this.chat.activeAssistantFor(userId) : null, // у TG хода нет; чужой веб-ход подписал бы чужим именем
        assistantArg: input.assistant,
        kind: input.kind,
        summary: input.summary,
      });
    }
```

- [ ] **Шаг 5: коммит и прогон — зелёный**

```bash
git -C $WT add src/mcp/products-mcp.controller.ts
git -C $WT commit -q -m "feat(mcp): report_problem на точке продуктов — ассистент сам сообщает в поддержку" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/mcp/'
```
Expected: PASS — все сюиты `src/mcp/` зелёные.

---

## Задача 9. Разрешение вызова у Маши и TG-бота

**Files:**
- Modify: `src/products/products-cli-tool.ts`, `src/products/products-cli-tool.spec.ts`
- Modify: `src/chat/chat.service.ts` (импорт и `allowedTools` Маши, ~строки 26 и 1199–1202)
- Modify: `src/chat/chat.service.masha-products.spec.ts:107-109`
- Modify: `src/tg-bot/tg-router.service.ts` (импорт ~строка 12 и `allowedTools` ~строка 654)
- Modify: `src/tg-bot/tg-bot.products-tool.spec.ts:27-28, 78-86`

- [ ] **Шаг 1: тесты**

В `src/products/products-cli-tool.spec.ts`: строку импорта
`import { productsCliMcp, PRODUCTS_CLI_TOOL_NAME } from './products-cli-tool';`
заменить на

```ts
import { productsCliMcp, PRODUCTS_CLI_TOOL_NAME, REPORT_PROBLEM_CLI_TOOL_NAME } from './products-cli-tool';
import { REPORT_PROBLEM_TOOL_NAME } from '../problem-report/report-problem.tool';
```

и после теста `'имя инструмента совпадает с тем, что CLI сложит из ключа и контракта'` добавить:

```ts
  // Разъедется с контрактом точки — allowedTools не совпадёт, и вызов молча отклонится.
  it('имя «сообщить в поддержку» CLI сложит из того же ключа и контракта', () => {
    expect(REPORT_PROBLEM_CLI_TOOL_NAME).toBe(`mcp__products__${REPORT_PROBLEM_TOOL_NAME}`);
    expect(REPORT_PROBLEM_CLI_TOOL_NAME).toBe('mcp__products__report_problem');
  });
```

В `src/chat/chat.service.masha-products.spec.ts` тест на строках 107–109 заменить на:

```ts
  it('автоодобрены ровно продукты, поиск файлов и сообщение в поддержку, встроенные тулы не включаются', async () => {
    const { opts } = await runMasha();
    expect(opts.allowedTools).toBe('mcp__products__manage_product,mcp__products__find_files,mcp__products__report_problem');
```

(остальные строки теста — без изменений).

В `src/tg-bot/tg-bot.products-tool.spec.ts` после строки `const WEB = ['WebSearch', 'WebFetch'];` добавить

```ts
const REPORT = 'mcp__products__report_problem';
```

и тест `'с productsOwner: инструмент добавлен в allowedTools, веб сохранён, встроенный набор прежний'` заменить на:

```ts
  it('с productsOwner: продукты и сообщение в поддержку в allowedTools, веб сохранён, встроенный набор прежний', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(GROUP_CFG, 'Дмитрий', undefined, undefined, '/tmp/sandbox-x', { productsOwner: OWNER });

    const opts = optsOf(claudeCli);
    expect(String(opts.allowedTools).split(',').sort()).toEqual([...WEB, TOOL, REPORT].sort());
    // --tools — только встроенные: MCP-инструмент доступен и без него (проба CLI 2.1.280).
    expect(opts.tools).toBe('Read,WebSearch,WebFetch');
  });
```

- [ ] **Шаг 2: коммит и прогон — должен упасть**

```bash
git -C $WT add src/products/products-cli-tool.spec.ts src/chat/chat.service.masha-products.spec.ts src/tg-bot/tg-bot.products-tool.spec.ts
git -C $WT commit -q -m "test: report_problem в allowedTools Маши и TG-бота — красный" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/(products/products-cli-tool|chat/chat.service.masha-products|tg-bot/tg-bot.products-tool|tg-bot/tg-router.web-tools)'
```
Expected: FAIL в трёх изменённых тестах; `tg-router.web-tools` — зелёный (без продуктов набор не меняется).

- [ ] **Шаг 3: реализация**

`src/products/products-cli-tool.ts`, после `FIND_FILES_CLI_TOOL_NAME`:

```ts
/** Сообщить в поддержку (problem-report/report-problem.tool.ts) — тот же сервер `products`; и Маше, и TG-боту. */
export const REPORT_PROBLEM_CLI_TOOL_NAME = `mcp__${SERVER_KEY}__report_problem`;
```

`src/chat/chat.service.ts`: в импорте из `'../products/products-cli-tool'` добавить `REPORT_PROBLEM_CLI_TOOL_NAME`:

```ts
import { FIND_FILES_CLI_PROMPT, FIND_FILES_CLI_TOOL_NAME, productsCliMcp, REPORT_PROBLEM_CLI_TOOL_NAME } from '../products/products-cli-tool';
```

и в ходе Маши строки

```ts
          // + поиск файлов прошлых разговоров (find-files.tool.ts). У TG-бота
          // его нет: там allowedTools собирается из одного products.toolName.
          allowedTools: `${products.toolName},${FIND_FILES_CLI_TOOL_NAME}`,
```

заменить на

```ts
          // + поиск файлов прошлых разговоров (find-files.tool.ts) — у TG-бота
          // его нет; + сообщить в поддержку (src/problem-report) — есть у обоих.
          allowedTools: `${products.toolName},${FIND_FILES_CLI_TOOL_NAME},${REPORT_PROBLEM_CLI_TOOL_NAME}`,
```

`src/tg-bot/tg-router.service.ts`: импорт

```ts
import { productsCliMcp, REPORT_PROBLEM_CLI_TOOL_NAME } from '../products/products-cli-tool';
```

и строку `const allowedTools = products ? \`${WEB_TOOLS},${products.toolName}\` : WEB_TOOLS;` вместе с комментарием над ней заменить на:

```ts
    // Инструмент продуктов — только автоодобрением: `--tools` задаёт встроенный
    // набор и MCP не режет (проба CLI 2.1.280), а без имени в allowedTools вызов
    // в -p отклоняется. С ним же — «сообщить в поддержку» (src/problem-report):
    // тот же сервер products, выдаётся вместе с ним.
    const allowedTools = products ? `${WEB_TOOLS},${products.toolName},${REPORT_PROBLEM_CLI_TOOL_NAME}` : WEB_TOOLS;
```

- [ ] **Шаг 4: коммит и прогон — зелёный**

```bash
git -C $WT add src/products/products-cli-tool.ts src/chat/chat.service.ts src/tg-bot/tg-router.service.ts
git -C $WT commit -q -m "feat: Маша и TG-бот могут сообщить в поддержку (report_problem в allowedTools)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/(products/products-cli-tool|chat/chat.service.masha-products|tg-bot/tg-bot.products-tool|tg-bot/tg-router.web-tools|common/sdk-tools-lockdown)'
```
Expected: PASS (включая страж `sdk-tools-lockdown`: новых Bash/Write/Edit в allowedTools нет).

---

## Задача 10. Эскалации ИИ-поддержки — снова в группе

**Files:**
- Modify: `src/support/telegram-notifier.service.ts`
- Test: `src/support/telegram-notifier.escalation.spec.ts`

- [ ] **Шаг 1: тест**

`src/support/telegram-notifier.escalation.spec.ts`:

```ts
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../common/telegram-alert', () => ({ sendTelegramPayload: jest.fn(async () => {}) }));

import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import { TelegramNotifierService } from './telegram-notifier.service';

const post = axios.post as jest.Mock;
const fanout = sendTelegramPayload as jest.Mock;
const ESCALATION = {
  ticketId: 'e86dc43d-c45c-4583-9f97-1d11db821a1b',
  userId: 'u1',
  urgency: 'high',
  reason: 'не может пополнить токены',
  summary: 'проверка',
};

describe('эскалация ИИ-поддержки', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    post.mockReset();
    fanout.mockReset();
    process.env.TELEGRAM_BOT_TOKEN = 'token';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('без TELEGRAM_SUPPORT_CHAT_ID — фанаутом по TELEGRAM_CHAT_ID, с кнопкой тикета', async () => {
    delete process.env.TELEGRAM_SUPPORT_CHAT_ID;
    await new TelegramNotifierService().notifyEscalation(ESCALATION);
    expect(post).not.toHaveBeenCalled();
    expect(fanout).toHaveBeenCalledTimes(1);
    const payload = fanout.mock.calls[0][0];
    expect(payload.parse_mode).toBe('HTML');
    expect(payload.text).toContain('Escalation');
    expect(payload.text).toContain('#e86dc43d');
    expect(payload.reply_markup.inline_keyboard[0][0].url).toContain('ticket=e86dc43d-c45c-4583-9f97-1d11db821a1b');
  });

  it('с TELEGRAM_SUPPORT_CHAT_ID — прежний путь в свой чат, без фанаута', async () => {
    process.env.TELEGRAM_SUPPORT_CHAT_ID = '-100500';
    post.mockResolvedValue({ data: { result: { message_id: 1 } } });
    await new TelegramNotifierService().notifyEscalation(ESCALATION);
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({ chat_id: '-100500' }),
      expect.anything(),
    );
    expect(fanout).not.toHaveBeenCalled();
  });

  // ~4 ложных сообщения в день о плановом обновлении OAuth — здоровье так не шлём.
  it('здоровье сервисов без TELEGRAM_SUPPORT_CHAT_ID по-прежнему не шлётся', async () => {
    delete process.env.TELEGRAM_SUPPORT_CHAT_ID;
    await new TelegramNotifierService().notifyHealthAlert({ service: 'anthropic', prevStatus: 'healthy', newStatus: 'degraded' });
    expect(fanout).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
```

- [ ] **Шаг 2: коммит и прогон — должен упасть**

```bash
git -C $WT add src/support/telegram-notifier.escalation.spec.ts
git -C $WT commit -q -m "test(support): эскалация без своего чата — красный" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/support/telegram-notifier'
```
Expected: FAIL в первом тесте (`fanout` не вызывался).

- [ ] **Шаг 3: реализация в `src/support/telegram-notifier.service.ts`**

После `import axios from 'axios';` добавить:

```ts
import { sendTelegramPayload } from '../common/telegram-alert';
```

В `notifyEscalation` строку `await this.send(text, replyMarkup);` (последняя строка метода) заменить на:

```ts
    // TELEGRAM_SUPPORT_CHAT_ID пропал из .env прода 18.05.2026, и эскалации
    // ИИ-поддержки с тех пор молча оседали в логе («telegram not configured —
    // skipping»), в том числе 15.08 — «не может пополнить токены». Без своего
    // чата эскалация уходит тем же путём, что и все алерты (TELEGRAM_CHAT_ID →
    // группа «Поддержка linkeon»), — как ответ пользователя в тикете
    // (SupportService.notifyOwnerOfUserReply). Здоровье сервисов так не шлём:
    // там ~4 ложных сообщения в день о плановом обновлении OAuth.
    if (!this.isConfigured()) {
      await sendTelegramPayload({ text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: replyMarkup });
      return;
    }
    await this.send(text, replyMarkup);
```

- [ ] **Шаг 4: коммит и прогон — зелёный**

```bash
git -C $WT add src/support/telegram-notifier.service.ts
git -C $WT commit -q -m "fix(support): эскалации ИИ-поддержки снова доходят до группы без TELEGRAM_SUPPORT_CHAT_ID" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$SCRATCH/ntest.sh" jest 'src/support/'
```
Expected: PASS — все сюиты `src/support/`.

---

> **Ревью задач 9–10 (24.10) добавило:** ход Маши с `report_problem` — без метафорической карты (`usedProductsTool`); в TG свой статус `tool_support` («📨 Сообщаю в поддержку...», семь языков) вместо «Работаю с продуктом»; поля эскалации и превью `support_events` режутся по кодовым точкам (`clip`); эскалация при не настроенном Telegram пишет в лог; точный комментарий к `reportFailure`. Поэтому в задачах 13 и 14 прогоняется весь `src/tg-bot/` (там проверки каталогов).

## Задача 11. Копия релея с правкой (ещё не выкатывать)

Новая строка в `PRODUCTS_TOOLS` и явное исключение в `PRODUCTS_PROMPT`. В промпте релея действует правило «только `mcp__linkeon__*`», и для `manage_product` и `find_files` там прописано «ЯВНОЕ исключение»; без такой строки модель может счесть `report_problem` запрещённым. Файл готовим здесь (копия в репозитории = то, что поедет на релей), выкатываем в задаче 15 — после бэкенда.

**Files:**
- Modify: `relay-agent/server.mjs` (копия живого файла + правка)

- [ ] **Шаг 1: снять живой файл и записать, с какого он коммита**

```bash
SCRATCH=<папка scratchpad сессии>
ssh dv@5.101.115.184 'cd ~/file-agent && git status --short && git log --oneline -1'
ssh dv@5.101.115.184 'cd ~/file-agent && echo "$(git rev-parse --short HEAD) $(sha256sum server.mjs | cut -d" " -f1)"' > "$SCRATCH/relay-base.txt"
scp -q dv@5.101.115.184:file-agent/server.mjs "$SCRATCH/relay-server.live.mjs"
cat "$SCRATCH/relay-base.txt"; shasum -a 256 "$SCRATCH/relay-server.live.mjs"
```
Expected: в `git status` — только `?? sessions.json.bak-…`; HEAD — `8c50fc0` или новее; сумма в `relay-base.txt` совпадает с `shasum`.

- [ ] **Шаг 2: правка скриптом — каждая замена ровно один раз**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/problem-report
SCRATCH=<папка scratchpad сессии>
node - "$SCRATCH/relay-server.live.mjs" "$WT/relay-agent/server.mjs" <<'EOF'
const fs = require('fs');
const [src, dst] = process.argv.slice(2);
let s = fs.readFileSync(src, 'utf8');
const once = (from, to) => {
  const n = s.split(from).length - 1;
  if (n !== 1) { console.error(`ожидалось одно вхождение, найдено ${n}: ${from.slice(0, 80)}`); process.exit(1); }
  s = s.replace(from, to);
};
once(
  'const PRODUCTS_TOOLS = "mcp__products__manage_product,mcp__products__find_files";',
  'const PRODUCTS_TOOLS = "mcp__products__manage_product,mcp__products__find_files,mcp__products__report_problem";',
);
once(
  'Если у файла stored=false — честно скажи, что он не сохранился. НЕ передавай в инструмент userId/телефон.\n`;',
  'Если у файла stored=false — честно скажи, что он не сохранился. НЕ передавай в инструмент userId/телефон.\n' +
  '\n' +
  'СООБЩИТЬ В ПОДДЕРЖКУ. Тебе доступен инструмент mcp__products__report_problem — тоже ЯВНОЕ исключение к правилу «только mcp__linkeon__*».\n' +
  'Когда звать и что писать — в его описании. Если инструмент mcp__linkeon__* вернул ошибку с supportNotified=true — команда уже знает: report_problem не зови, скажи пользователю, что команда в курсе. НЕ передавай в инструмент userId/телефон.\n' +
  '`;',
);
fs.writeFileSync(dst, s);
console.log('OK');
EOF
node --check "$WT/relay-agent/server.mjs" && echo SYNTAX_OK
diff "$SCRATCH/relay-server.live.mjs" "$WT/relay-agent/server.mjs"
grep -n -E '[A-Za-z0-9]{32,}' "$WT/relay-agent/server.mjs" | head -5
```
Expected: `OK`, `SYNTAX_OK`; `diff` — ровно строка `PRODUCTS_TOOLS` и три новые строки в конце `PRODUCTS_PROMPT`; последний `grep` пуст (строк, похожих на секрет, нет: репозиторий публичный). Если `grep` что-то нашёл — остановиться и сообщить, файл не коммитить.

- [ ] **Шаг 3: коммит** (в сообщении — коммит релея и начало суммы: по ним задача 15 проверит, что живой файл не менялся)

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/problem-report
SCRATCH=<папка scratchpad сессии>
RELAY_SHA=$(cut -d' ' -f1 "$SCRATCH/relay-base.txt")
RELAY_SUM12=$(cut -d' ' -f2 "$SCRATCH/relay-base.txt" | cut -c1-12)
git -C $WT add relay-agent/server.mjs
git -C $WT commit -q -m "relay-agent: копия server.mjs = релей $RELAY_SHA (sha256 $RELAY_SUM12) + report_problem, ещё не выкачено" \
  -m "PRODUCTS_TOOLS и явное исключение в PRODUCTS_PROMPT: без него правило «только mcp__linkeon__*» запрещает модели новый инструмент." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Задача 12. Скрипт живой проверки через ассистента

**Files:**
- Create: `tests/problem-report.e2e.mjs`

- [ ] **Шаг 1: скрипт**

`tests/problem-report.e2e.mjs`:

```js
/**
 * Живая проверка «сообщить в поддержку» через ассистента релея (Кира, id 22).
 * Спека: docs/superpowers/specs/2026-10-24-assistant-problem-reports-design.md.
 *
 * Вручную, на проде, тестовым аккаунтом (не админом): один ход с просьбой
 * сообщить о выдуманной поломке. Скрипт проверяет, что ход дошёл и ответ
 * говорит о передаче команде. Что сообщение ушло в группу — строка
 * «problem-report: отправлено (assistant_report)» в логе прода.
 *
 *   BASE_URL=https://my.linkeon.io TEST_PHONE=… DEBUG_SECRET=… node tests/problem-report.e2e.mjs
 */
import debugSecret from './debug-secret.js';

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`задай ${k}`);
  return v;
};
const BASE = need('BASE_URL').replace(/\/$/, '');
const PHONE = need('TEST_PHONE');
debugSecret.debugSecret(); // без DEBUG_SECRET — ошибка сразу, до платного хода
const SMS_WH = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WH = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';
const KIRA = '22';
const TURN_TIMEOUT_MS = 700_000; // ход на бэке — до 600 с к релею плюс копирование файлов
const CALL_TIMEOUT_MS = 30_000;
const MESSAGE =
  'Это техническая проверка выката (24.10). Пожалуйста, вызови инструмент report_problem: ' +
  'kind="my_failure", summary="Проверка выката 24.10: тестовое сообщение, ничего делать не нужно". ' +
  'Потом одной фразой скажи, передал(а) ли.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  for (let attempt = 1; ; attempt++) {
    try {
      await fetch(`${BASE}/webhook/${SMS_WH}/sms/${PHONE}`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      await sleep(1200);
      const codeRes = await fetch(`${BASE}/webhook/debug/sms-code/${PHONE}`, {
        headers: debugSecret.debugHeaders(),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!codeRes.ok) throw new Error(`debug-код: HTTP ${codeRes.status}`);
      const code = await codeRes.json();
      if (!code.code) throw new Error('debug-код не выдан');
      const r = await (await fetch(`${BASE}/webhook/${CHECK_WH}/check-code/${PHONE}/${code.code}`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })).json();
      if (!r['access-token']) throw new Error('вход не прошёл');
      return r['access-token'];
    } catch (e) {
      if (attempt >= 2) throw e; // код могла перехватить параллельная проверка (smoke) — один повтор
      await sleep(5000);
    }
  }
}

async function isAdmin(token) {
  const res = await fetch(`${BASE}/webhook/profile`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET /webhook/profile: HTTP ${res.status}`);
  return !!(await res.json())?.[0]?.profileJson?.isadmin;
}

async function say(token, message) {
  const res = await fetch(`${BASE}/webhook/soulmate/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, assistantId: KIRA, fresh: true, freshTs: String(Date.now()), ui: { activity: true, ask: true } }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ход: HTTP ${res.status}`);
  let end = null;
  for (const line of (await res.text()).split('\n')) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'end' && typeof ev.content === 'string') end = ev.content;
    } catch { /* не-JSON строка стрима */ }
  }
  if (!end || !end.trim()) throw new Error('в потоке нет ответа');
  return end.trim();
}

const token = await login();
if (await isAdmin(token)) throw new Error('TEST_PHONE указывает на админа — прогон остановлен');
const reply = await say(token, MESSAGE);
console.log(`Кира: ${reply}`);
const ok = /команд|поддержк|передал/i.test(reply);
console.log(`${ok ? '✓' : '✗'} ответ говорит о передаче команде`);
process.exit(ok ? 0 : 1);
```

- [ ] **Шаг 2: синтаксис** (лёгкая проверка, на маке можно)

```bash
node --check /Users/dmitry/Downloads/spirits_back/.worktrees/problem-report/tests/problem-report.e2e.mjs && echo SYNTAX_OK
```
Expected: `SYNTAX_OK`.

- [ ] **Шаг 3: коммит**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/problem-report
git -C $WT add tests/problem-report.e2e.mjs
git -C $WT commit -q -m "test(e2e): живая проверка «сообщить в поддержку» через Киру" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Задача 13. Полная проверка ветки и ревью

- [ ] **Шаг 1: гейт типов**

```bash
SCRATCH=<папка scratchpad сессии>
"$SCRATCH/ntest.sh" tsc
```
Expected: `TSC_EXIT=0` и тот же вывод, что в базе задачи 0 (новых ошибок нет).

- [ ] **Шаг 2: затронутые каталоги**

```bash
"$SCRATCH/ntest.sh" jest 'src/(problem-report|mcp|support|tg-bot)/|src/products/products-cli-tool|src/chat/chat.service.(masha-products|active-assistant)|src/common/sdk-tools-lockdown'
```
Expected: PASS, ни одной красной сюиты.

- [ ] **Шаг 3: весь `src/` и сборка — дельтой к базе**

```bash
"$SCRATCH/ntest.sh" jest 'src/'
"$SCRATCH/ntest.sh" build
```
Expected: упавшие сюиты — ровно те же, что в базе задачи 0 (новых нет); `nest build` без ошибок; `tests/unit` — как в базе.

- [ ] **Шаг 4: ревью всей ветки** — `superpowers:requesting-code-review` на диапазон `origin/main..origin/feat/problem-report`; замечания исправить отдельными коммитами и повторить шаги 1–3.

---

## Задача 14. Слияние в main

- [ ] **Шаг 1: чужой выкат не идёт** — отдельной командой, решение после чтения вывода

```bash
ssh dv@85.192.61.231 'pgrep -af "^bash scripts/deploy.sh" || echo none'
ps -eo pid,command | grep -E "^\s*[0-9]+ (bash|/bin/bash) .*deploy\.sh" | grep -v grep || echo none
```
Expected: `none` и `none`. Иначе — ждать конца чужого выката.

- [ ] **Шаг 2: слияние в отдельном detached-воркдереве** (общий чекаут не трогаем)

```bash
B=/Users/dmitry/Downloads/spirits_back
M=$B/.worktrees/merge-problem-report
git -C $B fetch -q origin
git -C $B worktree add -q --detach $M origin/main
git -C $M merge -q --no-ff origin/feat/problem-report \
  -m "Merge feat/problem-report: ассистенты сообщают о сбоях в «Поддержку linkeon»" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C $M log --oneline -3
```
Expected: мерж без конфликтов. Конфликт — остановиться и разобрать (чаще всего `chat.service.ts` или `tg-router.service.ts`: там работают и другие сессии).

- [ ] **Шаг 3: прогон на мерж-коммите** (main мог уйти вперёд)

```bash
M=/Users/dmitry/Downloads/spirits_back/.worktrees/merge-problem-report
MSHA=$(git -C $M rev-parse HEAD)
git -C $M push -q origin HEAD:refs/heads/verify/problem-report
ssh -S ~/.ssh/cm-lnode dv@85.192.61.231 "set -eo pipefail; cd ~/ci/wt/problem-report && git fetch -q origin && git checkout -q --detach $MSHA && source ~/.nvm/nvm.sh && npx jest --testPathPattern='src/(problem-report|mcp|support|tg-bot)/|src/products/products-cli-tool|src/chat/chat.service.(masha-products|active-assistant)|src/common/sdk-tools-lockdown' --maxWorkers=2 2>&1 | tail -15 && npx tsc --noEmit -p tsconfig.build.json 2>&1 | tail -5"
```
Expected: PASS, tsc без ошибок.

- [ ] **Шаг 4: ещё раз шаг 1, затем пуш в main**

```bash
B=/Users/dmitry/Downloads/spirits_back
M=$B/.worktrees/merge-problem-report
git -C $M push origin HEAD:main
git -C $M push -q origin --delete verify/problem-report
git -C $B worktree remove $M
```
Expected: пуш прошёл. Отказ non-fast-forward — `origin/main` ушёл вперёд: снять воркдерево и повторить шаги 2–4 на новом `origin/main`.

---

## Задача 15. Выкат бэкенда, релей и живые проверки (только с OK владельца)

- [ ] **Шаг 1: спросить владельца** одним сообщением: выкат бэкенда `BACK_ONLY=1 SKIP_BOTS=1` (фронт не менялся; машина ботов недоступна с ноды), правка релея (`PRODUCTS_TOOLS` + две строки промпта, рестарт `file-agent` в момент без активных ходов), четыре проверочных сообщения в группу с пометкой «проверка выката» (задачи 15–16). Без явного OK дальше не идти.

- [ ] **Шаг 2: свежие клоны на ноде** (не из воркдерева и не из общего чекаута)

```bash
ssh dv@85.192.61.231 'set -e; D=~/deploy-clones/problem-report; rm -rf $D; mkdir -p $D ~/deploy-logs; cd $D
git clone -q --branch main git@github.com:dvvolkovv/spirits_back.git
git clone -q --branch main git@github.com:dvvolkovv/spirits.git spirits_front
install -m 600 ~/dev/spirits_back/scripts/test-server.env.local spirits_back/scripts/
ln -s ~/dev/spirits_back/tests/node_modules spirits_back/tests/node_modules
git -C spirits_back log --oneline -1'
```
Expected: верх — мерж-коммит задачи 14.

- [ ] **Шаг 3: выкат отвязанно** (deploy.sh дольше лимита инструмента; убитый процесс откатывает test). Перед запуском — ещё раз шаг 1 задачи 14.

```bash
ssh dv@85.192.61.231 'cd ~/deploy-clones/problem-report/spirits_back && source ~/.nvm/nvm.sh && BACK_ONLY=1 SKIP_BOTS=1 LOCAL_BACK_DIR=$PWD LOCAL_FRONT_DIR=$HOME/deploy-clones/problem-report/spirits_front setsid -f bash -c "echo \$\$ > ~/deploy-logs/problem-report.pid; exec bash scripts/deploy.sh" > ~/deploy-logs/problem-report.log 2>&1 < /dev/null'
```
Ждать в фоне (Monitor), пока `ssh dv@85.192.61.231 'kill -0 $(cat ~/deploy-logs/problem-report.pid)'` не станет ошибкой. Лог читать отдельно, без `| tail` в команде запуска.

- [ ] **Шаг 4: проверить выкат руками** (в `dist` комментариев нет — `removeComments`, поэтому ищем код)

```bash
ssh dv@85.192.61.231 'grep -E "PHASE|SMOKE|✗|ROLLBACK" ~/deploy-logs/problem-report.log | tail -30'
ssh dvolkov@212.113.106.202 'cd /home/dvolkov/spirits_back && git log --oneline -1 && ls dist/problem-report/ && grep -c "sendTelegramPayload" dist/support/telegram-notifier.service.js; pm2 jlist | python3 -c "import sys,json; [print(p[\"name\"], p[\"pm2_env\"][\"restart_time\"], p[\"pm2_env\"][\"status\"]) for p in json.load(sys.stdin) if p[\"name\"]==\"linkeon-api\"]"'
```
Expected: обе фазы зелёные, `✗`/`ROLLBACK` нет; на проде HEAD — мерж-коммит; в `dist/problem-report/` есть `problem-report.service.js`; `grep -c` ≥ 1; `linkeon-api … online`.

- [ ] **Шаг 5: живая проверка А — полная цепочка через `/mcp`** (незнакомый инструмент: ничего не списывает, классификатор считает сбоем)

```bash
ssh dvolkov@212.113.106.202 'cd /home/dvolkov/spirits_back && S=$(grep -E "^MCP_SECRET=" .env | cut -d= -f2- | tr -d "\"'"'"'"); for i in 1 2; do curl -s -m 20 -X POST http://127.0.0.1:3001/mcp -H "Authorization: Bearer $S" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"tools/call\",\"params\":{\"name\":\"problem_report_probe_check\",\"arguments\":{\"userId\":\"<номер Test user>\"}}}" | grep -o "supportNotified[^,}]*"; done; sleep 2; grep -a "problem-report: отправлено" ~/.pm2/logs/linkeon-api-out-0.log | tail -2'
```
Expected: дважды `supportNotified\":true` (JSON результата внутри SSE экранирован); в логе ровно одна новая строка `problem-report: отправлено (tool_failure)` — второй вызов склеен; в группе — «🛠 Ассистент: не получилось выполнить problem_report_probe_check», ошибка `unknown tool: problem_report_probe_check`.

- [ ] **Шаг 6: живая проверка Б — `report_problem` на точке продуктов**

```bash
ssh dvolkov@212.113.106.202 'cd /home/dvolkov/spirits_back && T=$(node -r dotenv/config -e "process.stdout.write(require(\"./dist/products/product-tool.token\").signProductToolToken(\"<номер Test user>\",\"web\"))") && curl -s -m 20 -X POST http://127.0.0.1:3001/webhook/mcp/products -H "Authorization: Bearer $T" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"report_problem\",\"arguments\":{\"assistant\":\"Проверка\",\"kind\":\"my_failure\",\"summary\":\"Проверка выката 24.10: сообщение ассистента о поломке. Ссылка https://linkeon.io и @problem_report_check должны остаться простым текстом. Ничего делать не нужно.\"}}}" | grep -o "reported[^,}]*"; sleep 2; grep -a "problem-report: отправлено" ~/.pm2/logs/linkeon-api-out-0.log | tail -1'
```
Expected: `reported\":true`; в логе `problem-report: отправлено (assistant_report)`; в группе — «🙋 Проверка: у меня не работает», «Проверка выката 24.10…», «· веб»; ссылка и @упоминание в пересказе — моноширинным текстом, не кликабельны (пересказ в `<code>`).

- [ ] **Шаг 7: живая проверка эскалации** (из `dist`, тикета в базе нет — кнопка ведёт в никуда, это нормально)

```bash
ssh dvolkov@212.113.106.202 'cd /home/dvolkov/spirits_back && node -r dotenv/config -e "
const { TelegramNotifierService } = require(\"./dist/support/telegram-notifier.service\");
new TelegramNotifierService().notifyEscalation({ ticketId: \"00000000-0000-0000-0000-000000000000\", userId: \"<номер Test user>\", urgency: \"low\", reason: \"Проверка выката 24.10: эскалации снова доходят до группы\", summary: \"Ничего делать не нужно.\" }).then(() => console.log(\"sent\"));
"'
```
Expected: `sent`; в группе — «ℹ️ Escalation · low» с кнопкой «Открыть тикет».

- [ ] **Шаг 8: релей — живой файл не менялся с задачи 11**

```bash
ssh dv@5.101.115.184 'cd ~/file-agent && git status --short && echo "$(git rev-parse --short HEAD) $(sha256sum server.mjs | cut -c1-12)"'
git -C /Users/dmitry/Downloads/spirits_back fetch -q origin
git -C /Users/dmitry/Downloads/spirits_back log -1 --format=%s origin/main -- relay-agent/server.mjs
```
Expected: коммит релея и первые 12 знаков суммы совпадают с теми, что в теме коммита копии. Иначе — живой файл правили после задачи 11: повторить задачу 11 на новом файле (новый коммит копии, слияние тем же порядком, что задача 14) и только потом шаг 9.

- [ ] **Шаг 9: залить, проверить, закоммитить на релее** (файл — из `origin/main`, не из общего чекаута: он отстаёт)

```bash
SCRATCH=<папка scratchpad сессии>
git -C /Users/dmitry/Downloads/spirits_back show origin/main:relay-agent/server.mjs > "$SCRATCH/relay-server.new.mjs"
scp -q "$SCRATCH/relay-server.new.mjs" dv@5.101.115.184:file-agent/server.mjs.new
ssh dv@5.101.115.184 'cd ~/file-agent && node --check server.mjs.new && diff <(git show HEAD:server.mjs) server.mjs.new; mv server.mjs.new server.mjs && git add server.mjs && git commit -q -m "промпт и PRODUCTS_TOOLS: report_problem — сообщить в поддержку (spirits_back feat/problem-report)" && git log --oneline -1'
```
Expected: `diff` — те же строки, что в задаче 11; новый коммит на релее.

- [ ] **Шаг 10: рестарт релея в момент без активных ходов**

```bash
ssh dv@5.101.115.184 'P=$(pm2 pid file-agent); echo "активных claude: $(ps --ppid $P -o comm= | grep -c claude)"'
```
Повторять раз в 30 с, пока не `0`. Тогда:

```bash
ssh dv@5.101.115.184 'pm2 restart file-agent >/dev/null && sleep 3 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3033/health'
```
Expected: `200`.

---

## Задача 16. Живая проверка через ассистента релея

- [ ] **Шаг 1: прогон на проде с ноды** (скрипт уже в main и в клоне выката; секрет debug-ручек — прода, не печатать)

```bash
ssh dv@85.192.61.231 'cd ~/deploy-clones/problem-report/spirits_back && source ~/.nvm/nvm.sh && DEBUG_SECRET=$(ssh -o BatchMode=yes dvolkov@212.113.106.202 "sed -n s/^DEBUG_SECRET=//p /home/dvolkov/spirits_back/.env") BASE_URL=https://my.linkeon.io TEST_PHONE=<номер Test user> node tests/problem-report.e2e.mjs'
ssh dvolkov@212.113.106.202 'grep -a "problem-report: отправлено" ~/.pm2/logs/linkeon-api-out-0.log | tail -2'
```
Expected: `✓ ответ говорит о передаче команде`; в логе прода новая строка `problem-report: отправлено (assistant_report)`; в группе — «🙋 Кира: у меня не работает», «Проверка выката 24.10…», «· веб».

- [ ] **Шаг 2: попросить владельца подтвердить**, что в группе видны четыре проверочных сообщения (А, Б, эскалация, Кира).

---

## Задача 17. Итоги

- [ ] **Шаг 1:** в конец спеки — раздел «Итоги выката»: коммиты (мерж бэка, релей), что проверено живьём, что осталось вне рамок. Коммит и слияние в main тем же порядком, что задача 14.
- [ ] **Шаг 2:** память — обновить `project_assistant_problem_reports.md`: статус «на проде», коммиты, как проверять (строки `problem-report: отправлено` в логе прода).
- [ ] **Шаг 3:** убрать за собой: `git -C /Users/dmitry/Downloads/spirits_back worktree remove /Users/dmitry/Downloads/spirits_back/.worktrees/problem-report`; на ноде `git -C ~/ci/spirits_back worktree remove ~/ci/wt/problem-report` и `rm -rf ~/deploy-clones/problem-report`. Ветку `feat/problem-report` удалять — только с OK владельца.
