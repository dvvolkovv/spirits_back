# Пять находок «Затыков недели» (02.11) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (или superpowers:executing-plans). Шаги — чекбоксы.

**Goal:** закрыть пять находок бэклога (bfc4c3ad, 350f10bf, 5c25674d, a3da5a2b, 2ff1a026) правками бэка и кабинета, без выката релея и без изменений биллинга.

**Spec:** `docs/superpowers/specs/2026-11-02-insights-backlog-fixes-design.md` (в этой же ветке бэка) — читать первым.

**Architecture:** правила для ассистентов — новый блок в стабильной части промпта релея (бэк); учёт идущих ходов — метка хода вместо безусловного удаления; баланс — новые тексты блока и «бережное завершение»; Telegram — картинка по `{{file:}}` уходит фотографией; кабинет — миниатюра картинки-вложения в ленте и честная кнопка «Прервать и отправить».

**Tech Stack:** бэк — NestJS 10, jest/ts-jest, Node 22; фронт — React 18, Vite 5, vitest, i18next (7 языков).

---

## Где что делается (обязательно)

- Бэк: воркдерево `~/Downloads/spirits_back/.worktrees/insights-fixes`, ветка `feat/insights-fixes-1102` от `origin/main` `ef3fb676`.
- Фронт: воркдерево `~/Downloads/spirits_front/.worktrees/insights-fixes`, ветка `feat/insights-fixes-1102` от `origin/main` `73cf5d1`.
- Общие чекауты (`~/Downloads/spirits_back`, `~/Downloads/spirits_front`) не трогать — там работают другие сессии.
- **Тесты, tsc, сборки — только на ноде** `dv@85.192.61.231`: бэк — `~/ci/wt/ins-back`, фронт — `~/ci/wt/ins-front` (Task 0). В каждой ssh-команде — `source ~/.nvm/nvm.sh`; `ssh -n`, если команда не читает stdin. Исключение: точечный `pnpm vitest run <один файл>` фронта можно и на маке, если Node там 22 (`node -v`); на Node 26 jsdom ломает localStorage — тогда тоже на ноде.
- **На ноде не трогать** `~/spirits_back`, `~/spirits_front`, `~/dev`, сами `~/ci/spirits_back` и `~/ci/spirits_front` (только `git -C … fetch` и `worktree add/remove`).
- Коммиты при TDD: падающий тест — отдельным коммитом с пушем (`test(<область>): … — красный`), реализация — следующим. **Никаких `--amend`, `push --force`, rebase.** Коммитить с явным pathspec. Пушить только свою ветку: `git push -u origin feat/insights-fixes-1102` (не из detached HEAD).
- Комментарии в коде — по-русски, в стиле соседнего кода. Репозитории публичные: ни телефонов, ни имён пользователей, ни цитат из разговоров; пользователи в тестах — `u1`, `u-1`.
- В бэке `strictNullChecks: false`. jest типы не проверяет — гейт `npx tsc -p tsconfig.build.json --noEmit`.

Шаблон прогона бэка («прогон бэка: <файлы>»):

```bash
cd ~/Downloads/spirits_back/.worktrees/insights-fixes && git push -q -u origin feat/insights-fixes-1102 && SHA=$(git rev-parse HEAD)
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins-back && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest <файлы> 2>&1 | tail -30"
```

«tsc бэка» — та же схема, команда `npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK`.

Шаблон прогона фронта («прогон фронта: <файлы>»):

```bash
cd ~/Downloads/spirits_front/.worktrees/insights-fixes && git push -q -u origin feat/insights-fixes-1102 && SHA=$(git rev-parse HEAD)
ssh -n dv@85.192.61.231 "cd ~/ci/wt/ins-front && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && pnpm vitest run <файлы> 2>&1 | tail -30"
```

`Cannot find module` — добавить `npm ci --no-audit --no-fund && ` (бэк) или `pnpm install --frozen-lockfile && ` (фронт) перед командой.

---

## Карта файлов

| Файл | Что |
|---|---|
| бэк `src/chat/work-rules.ts` (+ `work-rules.spec.ts`) | блок `WORK_RULES` — пять правил длинной работы |
| бэк `src/chat/chat.service.ts` | `WORK_RULES` в `buildRelayStablePrefix`; `openTurn/closeTurn` + `beginUploadTurn/endUploadTurn`; строка о прерывании; `noTokensReply` и шлагбаум нуля |
| бэк `src/chat/interrupted-turn.ts` (+ `interrupted-turn.spec.ts`) | `INTERRUPTED_TURN_NOTE` |
| бэк `src/chat/chat.service.turn-marks.spec.ts` (новый) | гонка меток, upload-ход, строка о прерывании |
| бэк `src/chat/no-tokens-message.ts` (+ `.spec.ts`) | текст остановки на нуле, 7 языков |
| бэк `src/chat/chat.controller.ts` | upload-ход в учёте ходов; текст остановки из сервиса |
| бэк `src/tokens/balance-context.service.ts` (+ `balance-context.spec.ts`) | новое предупреждение, бережное завершение |
| бэк `src/tg-bot/tg-bot.service.ts` (+ `tg-bot.file-photo.spec.ts`) | `{{file:}}` с картинкой → `sendPhoto` |
| бэк `src/tg-bot/tg-router.service.ts` (+ `tg-router.web-tools.spec.ts`) | правило «покажи саму картинку» |
| бэк `src/platform-kb/articles/tokens.ts` | справка про предупреждение и ноль |
| фронт `src/components/chat/attachmentPreview.ts` (+ `.test.ts`) | распознать ссылку на картинку файла чата → миниатюра и оригинал |
| фронт `src/components/chat/ChatImageAttachment.tsx` (+ `.test.tsx`) | миниатюра с откатом на оригинал и ссылкой «Скачать» |
| фронт `src/components/chat/ChatInterface.tsx` | рендер ссылки-картинки; кнопка «Прервать и отправить» с подсказкой |
| фронт `src/i18n/locales/{ru,en,es,de,fr,pt,zh}.json` | `chat.send_anyway`, `chat.send_anyway_hint` |
| фронт `src/components/webvisorPrivacy.test.ts` | новая ссылка — с `ym-disable-tracklink` |

---

## Task 0: воркдеревья на ноде и база

- [ ] **Step 1: бэк**

```bash
cd ~/Downloads/spirits_back/.worktrees/insights-fixes && git push -q -u origin feat/insights-fixes-1102
ssh -n dv@85.192.61.231 "git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/ins-back origin/feat/insights-fixes-1102 && cd ~/ci/wt/ins-back && source ~/.nvm/nvm.sh && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK"
```

Ожидание: `TSC_OK`. Если `~/ci/wt/ins-back` уже есть — не удалять чужое, взять имя `ins-back2` и сказать контролёру.

- [ ] **Step 2: фронт и база tsc**

```bash
cd ~/Downloads/spirits_front/.worktrees/insights-fixes && git push -q -u origin feat/insights-fixes-1102
ssh -n dv@85.192.61.231 "git -C ~/ci/spirits_front fetch -q origin && git -C ~/ci/spirits_front worktree add -q --detach ~/ci/wt/ins-front origin/feat/insights-fixes-1102 && cd ~/ci/wt/ins-front && source ~/.nvm/nvm.sh && pnpm install --frozen-lockfile >/dev/null 2>&1 && npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c 'error TS'"
```

Записать число ошибок tsc — это база (ожидается около 42). После изменений число не должно вырасти.

---

## Бэк

### Task Б1: блок правил длинной работы

**Files:**
- Create: `src/chat/work-rules.ts`, `src/chat/work-rules.spec.ts`
- Modify: `src/chat/chat.service.ts` (`buildRelayStablePrefix`, импорт)

- [ ] **Step 1: падающий тест** — `src/chat/work-rules.spec.ts`:

```ts
import { ChatService } from './chat.service';
import { WORK_RULES } from './work-rules';

/** Стабильная часть промпта релея — то, что уходит в --system-prompt. */
async function stablePrefix(agentId: string, agentName = 'Роман'): Promise<string> {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined as any);
  return (svc as any).buildRelayStablePrefix({
    agentId,
    agentName,
    agentDescription: '',
    agentSystemPrompt: 'Ты ассистент.',
    userId: 'u1',
    userLanguage: 'ru',
  });
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('WORK_RULES — правила длинной работы с файлами', () => {
  it('рабочий список — файлом с первой порции, без откладывания', () => {
    expect(WORK_RULES).toContain('РАБОЧИЕ СПИСКИ');
    expect(WORK_RULES).toContain('с первой же порции');
    expect(WORK_RULES).toContain('не откладывай файл');
  });

  it('утверждённое — числами в файл, пересборка от утверждённой версии, сверка перед отправкой', () => {
    expect(WORK_RULES).toContain('УТВЕРЖДЁННОЕ НЕИЗМЕННО');
    expect(WORK_RULES).toContain('точными числами');
    expect(WORK_RULES).toContain('от утверждённой версии');
    expect(WORK_RULES).toContain('Перед отправкой измерь');
  });

  it('слои — правка исходника в его структуре, проверка после правки', () => {
    expect(WORK_RULES).toContain('СЛОИ И СТРУКТУРА');
    expect(WORK_RULES).toContain('не пересобирай из картинки');
  });

  it('длинная работа — промежуточное сохраняется файлами по ходу', () => {
    expect(WORK_RULES).toContain('ДЛИННАЯ РАБОТА');
    expect(WORK_RULES).toContain('продолжит с них');
  });

  it('картинка из сети — сама картинка, а не одни ссылки; перевод надписей только по просьбе', () => {
    expect(WORK_RULES).toContain('КАРТИНКА ИЗ СЕТИ');
    expect(WORK_RULES).toContain('не отвечай одними ссылками');
    expect(WORK_RULES).toContain('только если человек просит');
  });

  it('короткий: системный промпт релея уходит одним аргументом CLI (предел 128 КБ)', () => {
    expect(Buffer.byteLength(WORK_RULES, 'utf8')).toBeLessThanOrEqual(4096);
  });
});

describe('WORK_RULES в стабильной части промпта релея', () => {
  it('штатному ассистенту — ровно один раз', async () => {
    const prefix = await stablePrefix('12');
    expect(count(prefix, WORK_RULES)).toBe(1);
  });

  it('пользовательскому ассистенту — тоже, ровно один раз', async () => {
    const prefix = await stablePrefix('custom:6f1c2b9e-0000-4000-8000-000000000000', 'Мой помощник');
    expect(count(prefix, WORK_RULES)).toBe(1);
  });

  it('стоит до профиля: профиль меняется, правила — нет (кэш релея)', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined as any);
    const prefix: string = await (svc as any).buildRelayStablePrefix({
      agentId: '12', agentName: 'Роман', agentDescription: '', agentSystemPrompt: 'Ты ассистент.',
      userId: 'u1', userLanguage: 'ru', profileText: 'ПРОФИЛЬ-МАРКЕР',
    });
    expect(prefix.indexOf(WORK_RULES)).toBeGreaterThan(-1);
    expect(prefix.indexOf(WORK_RULES)).toBeLessThan(prefix.indexOf('ПРОФИЛЬ-МАРКЕР'));
  });
});
```

- [ ] **Step 2: прогон бэка: `src/chat/work-rules.spec.ts`** — FAIL (`Cannot find module './work-rules'`). Коммит `test(chat): правила длинной работы с файлами — красный` + пуш.

- [ ] **Step 3: реализация** — `src/chat/work-rules.ts`:

```ts
/**
 * Правила длинной работы с файлами — всем ассистентам релея (штатным и
 * пользовательским), в стабильной части системного промпта.
 *
 * Откуда (находки «Затыков недели», бэклог 02.11.2026):
 *  - 350f10bf — рабочий список держали в переписке и отложили файл «до
 *    последней порции», человеку пришлось спрашивать, где список;
 *  - 5c25674d — знак пересобрали от старой версии, вектор строили «на глаз»,
 *    выверенный сдвиг пропал;
 *  - 2ff1a026 — длинная работа оборвалась, промежуточное не было сохранено,
 *    начинать пришлось заново;
 *  - bfc4c3ad — на просьбу показать схему зала пришли одни ссылки.
 *
 * Блок — в системном промпте, а не в реплике: релей резюмит сессию, и копия в
 * каждой реплике оседала бы в истории (тот же довод, что у ask-rule.ts).
 * Промпт уходит в CLI одним аргументом (предел 128 КБ на аргумент) — блок
 * держим коротким, размер сторожит work-rules.spec.ts.
 *
 * Файлы в папке результата прикладываются к ответу (релей, turn-files.mjs),
 * поэтому и файл утверждённого, и рабочие материалы человек увидит — это
 * сознательно: они его, а не кухня.
 */
export const WORK_RULES = `--- Как вести работу с файлами ---
1. РАБОЧИЕ СПИСКИ. Человек собирает список или таблицу, которую будет пополнять и использовать дальше (адресаты, контакты, позиции, реестр), — заведи файл с первой же порции (Excel или Word, что удобнее для дела) и веди его: каждую новую порцию добавляй в этот же файл и прикладывай обновлённую версию. В ответе коротко: сколько записей, что добавлено, что уточнить. Не держи список только в переписке и не откладывай файл до последней порции.
2. УТВЕРЖДЁННОЕ НЕИЗМЕННО. Человек утвердил параметр макета (положение, размер, отступ, цвет, шрифт элемента) — запиши его точными числами в файл утверждённых параметров в папке результата и отметь, какая версия утверждена. Любую следующую правку и пересборку (в вектор, в другой формат или размер) делай от утверждённой версии, а не заново на глаз. Перед отправкой измерь утверждённые параметры на результате и сверь; расхождение исправь сам. В ответе скажи, что утверждённое сохранено.
3. СЛОИ И СТРУКТУРА. Просят сохранить слои, группы, редактируемый текст или шрифты — правь исходный файл в его структуре, не пересобирай из картинки. После правки проверь, что слои и группы на месте, и назови их в ответе. Если сохранить структуру нельзя — скажи, что потеряется, до того как отправлять.
4. ДЛИННАЯ РАБОТА. Многошаговую работу (сбор данных, расчёты, серия правок) сохраняй по ходу: промежуточные результаты — файлами в папке результата, в ответе назови их рабочими материалами. Если ход прервётся, следующий продолжит с них, а не начнёт заново.
5. КАРТИНКА ИЗ СЕТИ. Просят показать схему, карту, план, фото места или вещи — пришли саму картинку: скачай изображение со страницы, которую открыл в этом ходе, в папку результата (оно приложится к ответу), и не отвечай одними ссылками. Подписи на картинке на другом языке — объясни текстом на языке человека, что где. Перевести надписи на самой картинке — инструментом правки картинок, только если человек просит, и с оговоркой, что надписи перерисованы нейросетью и сверять стоит с оригиналом.`;
```

В `src/chat/chat.service.ts`: импорт рядом с `import { ASK_RULE } from './ask-rule';`:

```ts
import { WORK_RULES } from './work-rules';
```

В `buildRelayStablePrefix` — сразу после закрывающей скобки блока `if (!isCustom) { … }` (там, где стоит `stablePrefix += \`${platformGuide(...)}…\``) и ПЕРЕД комментарием «Профиль и бизнес-карточка — в СТАБИЛЬНУЮ часть»:

```ts
    // Правила длинной работы с файлами — всем ассистентам релея, и штатным, и
    // пользовательским (work-rules.ts; находки «Затыков недели» 02.11.2026).
    // До профиля: профиль меняется от консолидации, правила — нет, и начало
    // префикса остаётся кэшируемым.
    stablePrefix += `${WORK_RULES}\n\n`;
```

- [ ] **Step 4: прогон бэка: `src/chat/work-rules.spec.ts src/chat/coworkers.spec.ts src/chat/colleagues-rule.spec.ts src/chat/platform-guide.spec.ts src/chat/crisis-rule.spec.ts`** — PASS. Если соседний спек сверял префикс целиком (снимок) — обновить ожидание, не трогая смысл.

- [ ] **Step 5: коммит** `feat(chat): правила длинной работы с файлами в промпте релея` + пуш.

### Task Б2: учёт идущих ходов без гонки

**Files:**
- Create: `src/chat/chat.service.turn-marks.spec.ts`
- Modify: `src/chat/chat.service.ts` (поля и методы учёта; путь релея; путь Маши), `src/chat/chat.controller.ts` (upload-ход)

Суть: `finally` прерванного хода сейчас безусловно делает `this.activeTurns.delete(key)` — и стирает отметку НОВОГО хода, который уже поставил её поверх. Дальше `GET /webhook/chat/active-turn` отвечает «хода нет», кабинет шлёт следующее сообщение сразу, и релей пре-эмптит и новый ход. Ход с вложениями в учёт не попадает совсем.

- [ ] **Step 1: падающий тест** — `src/chat/chat.service.turn-marks.spec.ts`:

```ts
import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');

/**
 * Учёт идущих ходов (activeTurns) — по нему кабинет решает «слать сразу или
 * копить» (GET /webhook/chat/active-turn). Находка 2ff1a026: сообщение посреди
 * длинного хода пре-эмптит его на релее, а finally прерванного хода стирал
 * отметку нового — следующее «?» снова пре-эмптило уже новый ход.
 */

const DELTA = 'data: ' + JSON.stringify({ type: 'delta', text: 'ответ' }) + '\n';
const DONE = 'data: ' + JSON.stringify({ type: 'done', costUsd: 0.1 }) + '\n';

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  return new ChatService(
    pg as any, null as any,
    null as any, null as any, language as any, undefined /* balanceCtx */,
    undefined, undefined, undefined,
  );
}

function startTurn(svc: ChatService, userId: string, message = 'привет') {
  const upstream = new Readable({ read() {} });
  (axios.post as jest.Mock).mockResolvedValueOnce({ data: upstream });
  const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
  const done = (svc as any).streamUniversalAgent(
    userId, message, '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
  );
  return { upstream, done };
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Текст реплики, ушедшей в релей последним вызовом axios.post. */
function lastRelayMessage(): string {
  const calls = (axios.post as jest.Mock).mock.calls;
  const fd = calls[calls.length - 1][1];
  // form-data: поле message лежит в _streams строкой после заголовка поля.
  const parts: any[] = (fd as any)._streams || [];
  const idx = parts.findIndex((p) => typeof p === 'string' && /name="message"/.test(p));
  return String(parts[idx + 1] ?? '');
}

describe('метки идущих ходов', () => {
  afterEach(() => jest.clearAllMocks());

  it('прерванный ход не снимает отметку нового', async () => {
    const svc = makeService();
    const first = startTurn(svc, 'u1');
    first.upstream.push(DELTA);
    await settle();
    expect(svc.getActiveTurn('u1', '7').active).toBe(true);

    const second = startTurn(svc, 'u1', 'ещё раз');
    second.upstream.push(DELTA);
    await settle();

    // Релей убил первый процесс — его поток закрылся, ход дошёл до finally.
    first.upstream.push(null);
    await first.done;

    expect(svc.getActiveTurn('u1', '7').active).toBe(true);

    second.upstream.push(DONE);
    second.upstream.push(null);
    await second.done;
    expect(svc.getActiveTurn('u1', '7').active).toBe(false);
  });

  it('ход с вложениями виден в учёте и снимает только свою отметку', () => {
    const svc = makeService();
    const mark = svc.beginUploadTurn('u1', '7');
    expect(svc.getActiveTurn('u1', '7').active).toBe(true);

    const newer = svc.beginUploadTurn('u1', '7');
    expect(newer).not.toBe(mark);
    svc.endUploadTurn('u1', '7', mark);
    expect(svc.getActiveTurn('u1', '7').active).toBe(true);

    svc.endUploadTurn('u1', '7', newer);
    expect(svc.getActiveTurn('u1', '7').active).toBe(false);
  });

  it('метки одной пары различаются, даже если ходы начались в одну миллисекунду', () => {
    const svc = makeService();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const a = svc.beginUploadTurn('u1', '7');
      const b = svc.beginUploadTurn('u1', '7');
      expect(b).not.toBe(a);
    } finally {
      (Date.now as jest.Mock).mockRestore();
    }
  });
});

describe('строка о прерывании в реплике релея', () => {
  afterEach(() => jest.clearAllMocks());

  it('ход по паре уже идёт — в реплике есть строка о прерванном ходе', async () => {
    const svc = makeService();
    const first = startTurn(svc, 'u1');
    first.upstream.push(DELTA);
    await settle();

    const second = startTurn(svc, 'u1', 'ты работаешь?');
    second.upstream.push(DELTA);
    await settle();

    expect(lastRelayMessage()).toContain('тот ход прерван');

    first.upstream.push(null);
    second.upstream.push(DONE);
    second.upstream.push(null);
    await Promise.all([first.done, second.done]);
  });

  it('хода нет — строки нет', async () => {
    const svc = makeService();
    const t = startTurn(svc, 'u1');
    t.upstream.push(DELTA);
    await settle();

    expect(lastRelayMessage()).not.toContain('тот ход прерван');

    t.upstream.push(DONE);
    t.upstream.push(null);
    await t.done;
  });

  it('ход другого ассистента строку не включает', async () => {
    const svc = makeService();
    svc.beginUploadTurn('u1', '12');
    const t = startTurn(svc, 'u1');
    t.upstream.push(DELTA);
    await settle();

    expect(lastRelayMessage()).not.toContain('тот ход прерван');

    t.upstream.push(DONE);
    t.upstream.push(null);
    await t.done;
  });
});
```

Если разбор `form-data` в `lastRelayMessage` не находит поле (у установленной версии `form-data` другое внутреннее устройство) — заменить на `jest.spyOn(require('form-data').prototype, 'append')` и брать значение из вызова с первым аргументом `'message'`. Смысл проверки не менять.

- [ ] **Step 2: прогон бэка: `src/chat/chat.service.turn-marks.spec.ts`** — FAIL (`beginUploadTurn is not a function`, отметка снята). Коммит `test(chat): метки идущих ходов и строка о прерывании — красный` + пуш.

- [ ] **Step 3: реализация учёта** — `src/chat/chat.service.ts`.

Сразу после метода `endStream()` добавить:

```ts
  /**
   * Отметка «ход идёт» для пары пользователь+ассистент. Возвращает метку хода:
   * снять отметку может только её хозяин (closeTurn).
   *
   * Метка обязана отличаться от прежней: прерванный ход (релей пре-эмптит
   * процесс сессии, когда приходит новое сообщение) доходит до finally ПОЗЖЕ,
   * чем новый ход поставил свою отметку, и безусловный delete стирал её.
   * Кабинет после этого считал, что хода нет, слал следующее «?» сразу — и
   * релей пре-эмптил уже новый ход (находка 2ff1a026).
   */
  private openTurn(key: string, startedAt: number = Date.now()): number {
    const prev = this.activeTurns.get(key);
    const mark = prev !== undefined && startedAt <= prev ? prev + 1 : startedAt;
    this.activeTurns.set(key, mark);
    return mark;
  }

  /** Снимает отметку, только если она этого хода: новый ход мог её уже переписать. */
  private closeTurn(key: string, mark: number): void {
    if (this.activeTurns.get(key) === mark) this.activeTurns.delete(key);
  }

  /**
   * Ход с вложениями (ChatController.uploadAndChat) — в тот же учёт, что и
   * текстовый: иначе посреди долгого разбора файла кабинет не видит хода и
   * шлёт «?» сразу, а релей его пре-эмптит.
   */
  beginUploadTurn(userId: string, assistantId: string): number {
    return this.openTurn(`${userId}_${assistantId}`);
  }

  endUploadTurn(userId: string, assistantId: string, mark: number): void {
    this.closeTurn(`${userId}_${assistantId}`, mark);
  }
```

Путь Маши (`turnKey`): перед `try {` с `this.activeStreams++;` объявить `let turnMark: number | null = null;`; строку `this.activeTurns.set(turnKey, turnStartedAt);` заменить на `turnMark = this.openTurn(turnKey, turnStartedAt);`; в его `finally` строку `this.activeTurns.delete(turnKey);` заменить на `if (turnMark !== null) this.closeTurn(turnKey, turnMark);`.

Путь релея (`streamUniversalAgent`): перед `try {`, внутри которого `this.activeStreams++; this.activeTurns.set(\`${userId}_${assistantId}\`, streamStartTime);`, объявить `let turnMark: number | null = null;`; `set` заменить на `turnMark = this.openTurn(\`${userId}_${assistantId}\`, streamStartTime);`; в его `finally` строку `this.activeTurns.delete(\`${userId}_${assistantId}\`);` заменить на `if (turnMark !== null) this.closeTurn(\`${userId}_${assistantId}\`, turnMark);`.

После правки `grep -n "activeTurns\.\(set\|delete\)" src/chat/chat.service.ts` должен находить только строки внутри `openTurn`/`closeTurn`.

- [ ] **Step 4: строка о прерывании** — создать `src/chat/interrupted-turn.ts`:

```ts
/**
 * Служебная строка в реплику, пришедшую посреди идущего хода той же пары.
 *
 * Такая реплика пре-эмптит ход на релее: процесс сессии убивается, начатая
 * работа до человека не доходит. Чаще всего это не новая задача, а «ты
 * работаешь?», «ещё раз», «?» — человек не дождался. Без этой строки модель
 * отвечала статусом «нет, сейчас ничего не идёт» и ждала «запускай», либо
 * начинала всё заново (находка «Затыков недели» 2ff1a026).
 *
 * Только текстовый ход релея и не «чистый лист»: у fresh-сессии на релее свой
 * ключ, и чужой ход она не прерывает.
 */
export const INTERRUPTED_TURN_NOTE =
  '[Служебно: это сообщение пришло, пока ты ещё выполнял прошлый запрос, и тот ход прерван — ' +
  'его результат до человека не дошёл. Если сообщение не меняет задачу (вопрос о статусе, ' +
  '«ещё раз», «?», «ну что там») — сразу продолжи прерванную работу: возьми то, что уже ' +
  'сохранено в папке результата, и доведи до результата; не отвечай одним статусом и не ' +
  'начинай заново. Если сообщение меняет задачу — делай новое.]';
```

И `src/chat/interrupted-turn.spec.ts`:

```ts
import { INTERRUPTED_TURN_NOTE } from './interrupted-turn';

describe('INTERRUPTED_TURN_NOTE', () => {
  it('говорит, что прошлый ход прерван и результат не дошёл', () => {
    expect(INTERRUPTED_TURN_NOTE).toContain('тот ход прерван');
    expect(INTERRUPTED_TURN_NOTE).toContain('до человека не дошёл');
  });

  it('статус-вопрос — продолжить работу, а не отвечать статусом и не начинать заново', () => {
    expect(INTERRUPTED_TURN_NOTE).toContain('продолжи прерванную работу');
    expect(INTERRUPTED_TURN_NOTE).toContain('не отвечай одним статусом');
    expect(INTERRUPTED_TURN_NOTE).toContain('не начинай заново');
  });

  it('новая задача — делать новое', () => {
    expect(INTERRUPTED_TURN_NOTE).toContain('делай новое');
  });
});
```

В `src/chat/chat.service.ts` импорт: `import { INTERRUPTED_TURN_NOTE } from './interrupted-turn';`. В `streamUniversalAgent`, перед строкой `contextPrefix += \`${MEETING_HONESTY_RULE}\n\n\`;`:

```ts
    // Сообщение посреди идущего хода той же пары пре-эмптит его на релее —
    // скажем модели, что прошлая работа прервана и что с ней делать
    // (interrupted-turn.ts). Проверка — до того, как этот ход поставит свою
    // отметку (openTurn ниже). Пинги мониторинга и «чистый лист» — мимо: у
    // fresh-сессии на релее свой ключ, и чужой ход она не прерывает.
    if (!probe && !fresh && this.activeTurns.has(`${userId}_${assistantId}`)) {
      contextPrefix += `${INTERRUPTED_TURN_NOTE}\n\n`;
    }
```

Если переменная пинга в `streamUniversalAgent` называется иначе, чем `probe`, — взять ту, что там есть (параметр «пинг мониторинга»).

- [ ] **Step 5: upload-ход в контроллере** — `src/chat/chat.controller.ts`, рядом с `this.chatService.beginStream();`:

```ts
    this.chatService.beginStream();
    // Ход с вложениями — и в учёт идущих ходов (active-turn): иначе посреди
    // долгого разбора файла кабинет не видит хода, а «?» его пре-эмптит.
    const turnMark = this.chatService.beginUploadTurn(userId, String(assistantId));
```

И в `closeStream`:

```ts
    const closeStream = () => {
      if (streamClosed) return;
      streamClosed = true;
      this.chatService.endStream();
      this.chatService.endUploadTurn(userId, String(assistantId), turnMark);
    };
```

Если в спеках контроллера (`chat.upload-*.spec.ts`) `chatService` подменён объектом без этих методов — добавить в подмену `beginUploadTurn: jest.fn(() => 1), endUploadTurn: jest.fn()`.

**Поправка по ревью (выполнено, 94386ddc):** `closeStream` зовётся из `setImmediate` уже после `persistUploadTurn` и `consolidateAfterChatPublic` (до 120 с) — метка висела после доставки ответа. Основное снятие — сразу после `res.end()` в общем `finally` потока; вызов в `closeStream` остаётся страховкой (повторный `endUploadTurn` с той же меткой — no-op). Тест в `chat.upload-chat-files.spec.ts`: во время потока метка есть, после `end` при подвешенном `persistUploadTurn` — уже нет.

- [ ] **Step 6: прогон бэка: `src/chat/chat.service.turn-marks.spec.ts src/chat/interrupted-turn.spec.ts src/chat/chat.service.active-streams.spec.ts src/chat/chat.service.failed-turn.spec.ts src/chat/chat.service.masha-products.spec.ts src/chat/chat.service.active-assistant.spec.ts src/chat/chat.upload-billing.spec.ts src/chat/chat.upload-chat-files.spec.ts src/chat/chat.upload-session.spec.ts src/chat/chat.upload-llm-provider.spec.ts`** — PASS. tsc бэка — `TSC_OK`.

- [ ] **Step 7: коммит** `fix(chat): метка хода вместо безусловного удаления, upload в учёте, строка о прерывании` + пуш.

### Task Б3: баланс без обрыва смыслового блока

**Files:**
- Modify: `src/tokens/balance-context.service.ts`, `src/tokens/balance-context.spec.ts`

- [ ] **Step 1: падающие тесты** — дописать в конец `src/tokens/balance-context.spec.ts`:

```ts
describe('BalanceContextService — когда предупреждать (находка a3da5a2b)', () => {
  it('предупреждение не посреди практики: до начала или в конце мысли', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 8000);
    expect(block).toContain('Баланс на исходе');
    expect(block).toContain('до её начала');
    expect(block).toContain('не вставляй это посреди');
    expect(block).toContain('Никогда не прерывай упражнение');
  });
});

describe('BalanceContextService — бережное завершение на остатке', () => {
  it('прогноз ≤ 2 ответов — инструкция завершить смысловой блок', async () => {
    const block = await svc(fakePg({ spends: [400, 400, 400, 400, 400] })).buildContextForPrompt('u1', 800);
    expect(block).toContain('хватит примерно на 2');
    expect(block).toContain('бережно завершить текущий смысловой блок');
    expect(block).toContain('Пополнить баланс');
  });

  it('на остатке отдельного предупреждения нет — одна инструкция, не две', async () => {
    const block = await svc(fakePg({ spends: [400, 400, 400, 400, 400] })).buildContextForPrompt('u1', 800);
    expect(block).not.toContain('Баланс на исходе');
  });

  it('на остатке разрешение предупредить всё равно расходуется — отметка ставится', async () => {
    const pg = fakePg({ spends: [400, 400, 400, 400, 400] });
    await svc(pg).buildContextForPrompt('u1', 800);
    expect(pg.calls.some((c: any) => /^\s*UPDATE/i.test(c.sql))).toBe(true);
  });

  it('прогноз 3 ответа и больше — обычный блок, без завершения', async () => {
    const block = await svc(fakePg({ spends: [400, 400, 400, 400, 400] })).buildContextForPrompt('u1', 1200);
    expect(block).not.toContain('бережно завершить');
  });

  it('прогноза нет, но баланс ниже 2000 — завершение по запасному порогу', async () => {
    const block = await svc(fakePg({ spends: [300] })).buildContextForPrompt('u1', 1500);
    expect(block).toContain('бережно завершить текущий смысловой блок');
    expect(block).toContain('почти закончился');
  });

  it('приветствие — без инструкции завершения', async () => {
    const block = await svc(fakePg({ spends: [400, 400, 400, 400, 400] }))
      .buildContextForPrompt('u1', 800, { isGreeting: true });
    expect(block).not.toContain('бережно завершить');
  });

  it('если уже говорил — не повторять', async () => {
    const block = await svc(fakePg({ spends: [400, 400, 400, 400, 400] })).buildContextForPrompt('u1', 800);
    expect(block).toContain('не повторяй');
  });
});
```

Проверить по `src/tokens/balance-context.store-build.spec.ts`, что магазинная сборка по-прежнему пустая (`''`) — там ничего не менять.

- [ ] **Step 2: прогон бэка: `src/tokens/balance-context.spec.ts`** — новые FAIL. Коммит `test(tokens): когда предупреждать и бережное завершение — красный` + пуш.

- [ ] **Step 3: реализация** — `src/tokens/balance-context.service.ts`.

Рядом с `FORECAST_WINDOW_DAYS`:

```ts
/**
 * Остаток «на один-два ответа»: дальше шлагбаум нуля оборвёт разговор, и
 * ассистенту пора бережно закрывать смысловой блок (находка a3da5a2b —
 * психологическую практику свернули на остатке в один ответ).
 */
const NEAR_EMPTY_ANSWERS = 2;

/** Без прогноза (мало замеров) — тот же смысл по сумме: «красный» порог витрины. */
const NEAR_EMPTY_FALLBACK_TOKENS = 2000;
```

В `buildContextForPrompt` после постоянной части (после строки `\`Не пробуй тот же инструмент повторно.\n\``) заменить блок `if (await this.grantWarning(...)) { … }` на:

```ts
      const nearEmpty = !opts.isGreeting && (forecast == null
        ? balance < NEAR_EMPTY_FALLBACK_TOKENS
        : forecast <= NEAR_EMPTY_ANSWERS);

      if (nearEmpty) {
        // Одна инструкция вместо двух: завершение само говорит про пополнение.
        // Разрешение предупредить расходуем тут же — иначе следующим ходом
        // пришло бы ещё и обычное предупреждение.
        await this.grantWarning(userId, balance, opts.isGreeting);
        const left = forecast == null
          ? `Баланс почти закончился — меньше ${NEAR_EMPTY_FALLBACK_TOKENS} токенов.`
          : `Баланса хватит примерно на ${forecast} ${answersWord(forecast)}.`;
        block +=
          `${left} Не начинай новый длинный этап. Если идёт практика, упражнение или ` +
          `работа по шагам — в этом ответе помоги бережно завершить текущий смысловой блок: ` +
          `подведи итог, дай опору или следующий шаг на потом. Один раз мягко скажи, что ` +
          `продолжить можно после пополнения: [Пополнить баланс](${TOP_UP_URL}). ` +
          `Если уже говорил об этом в разговоре — не повторяй.\n`;
      } else if (await this.grantWarning(userId, balance, opts.isGreeting)) {
        block +=
          `Баланс на исходе, и пользователя об этом ещё не предупреждали. Скажи один раз, в ` +
          `этом ответе, коротко и без давления, что токены заканчиваются, и дай ссылку: ` +
          `[Пополнить баланс](${TOP_UP_URL}).\n` +
          `Выбери место бережно: если вы начинаете практику, упражнение или длинную задачу — ` +
          `скажи до её начала, сколько примерно ответов хватит, чтобы человек решил, успеете ли; ` +
          `если человек делится переживаниями или упражнение уже идёт — не вставляй это ` +
          `посреди, а скажи одной мягкой фразой в самом конце ответа, когда мысль закончена. ` +
          `Никогда не прерывай упражнение ради этого.\n` +
          `Не выноси это в отдельное сообщение и не повторяй в следующих ответах.\n`;
      }
```

Ветку `opts.storeBuild` внутри старого текста предупреждения убрать: в магазинной сборке метод выходит раньше (`if (opts.storeBuild) return '';`), до этого места она не доходит. Рядом с `messagesWord` добавить:

```ts
const ANSWER_FORMS: Record<string, string> = {
  one: 'ответ',
  few: 'ответа',
  many: 'ответов',
  other: 'ответа',
};
function answersWord(n: number): string {
  return ANSWER_FORMS[RU_PLURALS.select(n)] ?? 'ответов';
}
```

Тест «хватит примерно на 2» проверяет число; форма слова для 2 — «ответа».

- [ ] **Step 4: прогон бэка: `src/tokens/balance-context.spec.ts src/tokens/balance-context.store-build.spec.ts src/tokens/consumption-rate.spec.ts src/chat/balance-context-delivery.spec.ts`** — PASS. Старые тесты, сверявшие прежнюю фразу «Один раз, в конце этого ответа», — привести к новому тексту (смысл: одно предупреждение, ссылка, не повторять).

- [ ] **Step 5: коммит** `feat(tokens): предупреждение о балансе не посреди практики, бережное завершение на остатке` + пуш.

### Task Б4: текст остановки на нуле — мягче и на языке пользователя

**Files:**
- Create: `src/chat/no-tokens-message.ts`, `src/chat/no-tokens-message.spec.ts`
- Modify: `src/chat/chat.service.ts` (шлагбаум и метод `noTokensReply`), `src/chat/chat.controller.ts` (upload-шлагбаум)

- [ ] **Step 1: падающий тест** — `src/chat/no-tokens-message.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { noTokensMessage } from './no-tokens-message';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

describe('noTokensMessage — остановка на нулевом балансе', () => {
  it.each(SUPPORTED_LANGUAGES.map((l) => [l]))('%s: есть текст и ссылка на пополнение', (lang) => {
    const msg = noTokensMessage(lang);
    expect(msg).toMatch(/^⚠️ \*\*.+\*\*/);
    expect(msg).toContain('](/chat?view=tokens)');
  });

  it('русский: разговор сохранён, продолжить можно с того же места', () => {
    const msg = noTokensMessage('ru');
    expect(msg).toContain('Разговор сохранён');
    expect(msg).toContain('с того же места');
  });

  it('незнакомый язык — русский', () => {
    expect(noTokensMessage('xx')).toBe(noTokensMessage('ru'));
  });

  it('языки различаются — английскому не уходит русский текст', () => {
    expect(noTokensMessage('en')).not.toBe(noTokensMessage('ru'));
    expect(noTokensMessage('en')).not.toMatch(/[а-яё]/i);
  });
});

/** Сторож: обе точки шлагбаума — через одну функцию, без своей копии текста. */
describe('шлагбаум нуля без копий текста', () => {
  const live = (file: string) =>
    fs.readFileSync(path.join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  it.each([['chat.service.ts'], ['chat.controller.ts']])('%s не держит старый текст', (file) => {
    expect(live(file)).not.toContain('Недостаточно токенов');
  });
});
```

- [ ] **Step 2: прогон бэка: `src/chat/no-tokens-message.spec.ts`** — FAIL. Коммит `test(chat): мягкий текст остановки на нуле — красный` + пуш.

- [ ] **Step 3: реализация** — `src/chat/no-tokens-message.ts`:

```ts
import { DEFAULT_LANGUAGE } from '../common/services/language.service';

/**
 * Что видит человек, когда на нулевом балансе отправил сообщение.
 *
 * Прежний текст («⚠️ Недостаточно токенов. Ваш баланс исчерпан…») был только
 * по-русски и обрывал разговор канцеляритом — в том числе посреди
 * психологической практики (находка «Затыков недели» a3da5a2b). Биллинг не
 * меняется (решение владельца 02.11.2026): ответа на нуле нет, меняется
 * только то, как об этом сказано. Разговор действительно сохранён — история в
 * базе и сессия на релее остаются.
 *
 * Ссылка относительная, как была: её рисует кабинет, и она открывает окно
 * пополнения в той же вкладке.
 */
const TEXTS: Record<string, { title: string; body: string; cta: string }> = {
  ru: {
    title: 'Токены закончились',
    body: 'Ассистент сейчас не сможет ответить. Разговор сохранён — пополните баланс и продолжите с того же места.',
    cta: 'Пополнить баланс',
  },
  en: {
    title: 'Out of tokens',
    body: "The assistant can't reply right now. Your conversation is saved — top up your balance to pick up right where you left off.",
    cta: 'Top up balance',
  },
  es: {
    title: 'Sin tokens',
    body: 'El asistente no puede responder ahora. La conversación está guardada: recarga el saldo para continuar justo donde lo dejaste.',
    cta: 'Recargar saldo',
  },
  de: {
    title: 'Keine Tokens mehr',
    body: 'Der Assistent kann gerade nicht antworten. Das Gespräch ist gespeichert – lade dein Guthaben auf, um genau dort weiterzumachen, wo du aufgehört hast.',
    cta: 'Guthaben aufladen',
  },
  fr: {
    title: 'Plus de jetons',
    body: "L'assistant ne peut pas répondre pour le moment. La conversation est enregistrée : recharge ton solde pour reprendre là où tu t'es arrêté.",
    cta: 'Recharger le solde',
  },
  pt: {
    title: 'Sem tokens',
    body: 'O assistente não consegue responder agora. A conversa ficou guardada — carregue o saldo para continuar exatamente onde parou.',
    cta: 'Carregar saldo',
  },
  zh: {
    title: '代币已用完',
    body: '助手现在无法回复。对话已保存——充值后即可从中断处继续。',
    cta: '充值余额',
  },
};

export function noTokensMessage(lang: string): string {
  const t = TEXTS[lang] || TEXTS[DEFAULT_LANGUAGE];
  return `⚠️ **${t.title}**\n\n${t.body}\n\n👉 [${t.cta}](/chat?view=tokens)`;
}
```

Обращение — как в чате кабинета: fr — «tu», pt — европейский вежливый («carregue», «parou»), de — «du», es — «tú».

`src/chat/chat.service.ts`: импорт `import { noTokensMessage } from './no-tokens-message';`. Публичный метод рядом с `getTokenBalance`:

```ts
  /** Текст остановки на нуле — на языке пользователя (no-tokens-message.ts). */
  async noTokensReply(userId: string, requestLang?: string): Promise<string> {
    const lang = await this.language.resolveUserLanguage(userId, requestLang).catch(() => DEFAULT_LANGUAGE);
    return noTokensMessage(lang);
  }
```

(`DEFAULT_LANGUAGE` — импорт из `../common/services/language.service`, если ещё не импортирован.) В шлагбауме `streamChat` (`if (balance <= 0) {`) строку `const noTokensMsg = '⚠️ **Недостаточно токенов** …';` заменить на:

```ts
        const noTokensMsg = await this.noTokensReply(userId, requestLang);
```

`src/chat/chat.controller.ts`, upload-шлагбаум: `const noTokensMsg = '⚠️ …';` заменить на:

```ts
      const noTokensMsg = await this.chatService.noTokensReply(
        userId,
        typeof body.lang === 'string' ? body.lang : undefined,
      );
```

Если в спеках контроллера `chatService` подменён объектом — добавить туда `noTokensReply: jest.fn(async () => '⚠️ **Токены закончились**')`.

- [ ] **Step 4: прогон бэка: `src/chat/no-tokens-message.spec.ts src/chat/chat.upload-billing.spec.ts src/chat/chat.service.failed-turn.spec.ts`** + `grep -rn "Недостаточно токенов" tests/ src/chat | grep -v spec` (пусто, кроме no-tokens-message.spec.ts) — PASS. tsc бэка — `TSC_OK`.

- [ ] **Step 5: коммит** `feat(chat): остановка на нуле — мягкий текст на языке пользователя` + пуш.

### Task Б5: картинка по `{{file:}}` в Telegram — фотографией

**Files:**
- Create: `src/tg-bot/tg-bot.file-photo.spec.ts`
- Modify: `src/tg-bot/tg-bot.service.ts` (`dispatchOutgoingMarker`, ветка `file`)

- [ ] **Step 1: падающий тест** — `src/tg-bot/tg-bot.file-photo.spec.ts`:

```ts
import { fetchMediaBytes } from '../common/net/own-media';
import { TgBotService } from './tg-bot.service';

jest.mock('../common/net/own-media');

/**
 * {{file: url=…}} с картинкой уходит фотографией: в чате её видно сразу, а
 * документ надо открывать (находка «Затыков недели» bfc4c3ad — схему зала
 * прислали одними ссылками; модель должна присылать саму картинку, и она
 * должна выглядеть как картинка).
 */
describe('маркер {{file:}} с картинкой', () => {
  const grammy = {
    sendPhoto: jest.fn().mockResolvedValue({}),
    sendDocument: jest.fn().mockResolvedValue({}),
    sendMessage: jest.fn().mockResolvedValue({}),
    sendChatAction: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new TgBotService(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, grammy as any, {} as any, {} as any,
  );
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const cfg = { owner_user_id: 'u-1' } as any;
  const msg = { chat: { id: -100777 }, message_id: 9 };
  const media = (contentType: string, size = 1000) => ({
    data: Buffer.alloc(size, 1), contentType, finalUrl: 'https://example.org/x',
  });

  beforeEach(() => jest.clearAllMocks());

  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/jpeg; charset=binary'])('%s → sendPhoto с подписью', async (ct) => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(media(ct));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/seatmap.jpg', caption: 'Схема зала' });
    expect(grammy.sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, buf, opts] = grammy.sendPhoto.mock.calls[0];
    expect(chatId).toBe(-100777);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(opts).toMatchObject({ reply_to_message_id: 9, caption: 'Схема зала' });
    expect(grammy.sendDocument).not.toHaveBeenCalled();
  });

  it('PDF — документом, как раньше', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(media('application/pdf'));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/report.pdf' });
    expect(grammy.sendPhoto).not.toHaveBeenCalled();
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
  });

  it('GIF — документом: фото его обездвижит', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(media('image/gif'));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/a.gif' });
    expect(grammy.sendPhoto).not.toHaveBeenCalled();
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
  });

  it('картинка больше 10 МБ — документом (предел sendPhoto)', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(media('image/png', 10 * 1024 * 1024 + 1));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/big.png' });
    expect(grammy.sendPhoto).not.toHaveBeenCalled();
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
  });

  it('Telegram не принял фото — тот же файл уходит документом', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(media('image/png'));
    grammy.sendPhoto.mockRejectedValueOnce(new Error('PHOTO_INVALID_DIMENSIONS'));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/wide.png', name: 'wide.png' });
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
    expect(grammy.sendDocument.mock.calls[0][2]).toBe('wide.png');
  });
});
```

- [ ] **Step 2: прогон бэка: `src/tg-bot/tg-bot.file-photo.spec.ts`** — FAIL. Коммит `test(tg-bot): картинка по file-маркеру фотографией — красный` + пуш.

- [ ] **Step 3: реализация** — `src/tg-bot/tg-bot.service.ts`. Рядом с `const MAX_ATTACHMENT_BYTES = …`:

```ts
/** Предел sendPhoto у Telegram: больше — только документом. */
const TG_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Скачанное по {{file:}} — фотография для Telegram? JPEG/PNG/WEBP до 10 МБ.
 * GIF — нет: sendPhoto сделал бы из анимации стоп-кадр.
 */
export function isTelegramPhoto(contentType: string | undefined, bytes: number): boolean {
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  return (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp')
    && bytes > 0 && bytes <= TG_PHOTO_MAX_BYTES;
}
```

В `dispatchOutgoingMarker`, ветка file — после `const name = …` и перед `await this.grammy.sendDocument(…)`:

```ts
    // Картинку — фотографией: в чате её видно сразу, без открытия документа
    // (находка bfc4c3ad: просили показать схему зала). Не принял Telegram
    // (размеры, формат) — тот же файл уходит документом, как раньше.
    if (isTelegramPhoto(media.contentType, buf.length)) {
      try {
        await this.grammy.sendPhoto(msg.chat.id, buf, {
          reply_to_message_id: msg.message_id,
          caption: m.caption?.slice(0, 1024),
        });
        return;
      } catch (e: any) {
        this.logger.warn(`file-маркер: sendPhoto не принял картинку (${e?.message}) — отправляю документом`);
      }
    }
```

Комментарий над веткой («file: качаем сами и шлём как document…») поправить: картинки — фотографией, остальное — документом.

- [ ] **Step 4: прогон бэка: `src/tg-bot/tg-bot.file-photo.spec.ts src/tg-bot/tg-bot.file-marker-ssrf.spec.ts src/tg-bot/tg-bot.image-send.spec.ts src/tg-bot/tg-bot.i18n-review.spec.ts`** — PASS. В `tg-bot.file-marker-ssrf.spec.ts` подмена `grammy` без `sendPhoto`: там отдаётся PDF, до фото не доходит — если всё же падает, добавить `sendPhoto: jest.fn()` в подмену.

- [ ] **Step 5: коммит** `feat(tg-bot): картинка по file-маркеру — фотографией, с откатом на документ` + пуш.

### Task Б6: правило «покажи саму картинку» в промпте Telegram

**Files:**
- Modify: `src/tg-bot/tg-router.service.ts` (`ioInstructions`), `src/tg-bot/tg-router.web-tools.spec.ts`

- [ ] **Step 1: падающий тест** — дописать в `src/tg-bot/tg-router.web-tools.spec.ts`:

```ts
describe('TgRouterService.generateReply: картинка из сети (находка bfc4c3ad)', () => {
  it('правило: прислать саму картинку маркером file, а не одни ссылки', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий');
    const system = systemFrom(claudeCli);
    expect(system).toContain('ПОКАЗАТЬ КАРТИНКУ ИЗ СЕТИ');
    expect(system).toContain('{{file: url=<прямой адрес изображения>');
    expect(system).toContain('не одни ссылки');
  });

  it('перевод надписей — image_edit, только по просьбе и с оговоркой', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий');
    const system = systemFrom(claudeCli);
    expect(system).toContain('только по просьбе');
    expect(system).toContain('перерисованы нейросетью');
  });

  it('source у image_edit — и адрес картинки из сети', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий');
    expect(systemFrom(claudeCli)).toContain('или адрес изображения, найденного в сети');
  });
});
```

- [ ] **Step 2: прогон бэка: `src/tg-bot/tg-router.web-tools.spec.ts`** — FAIL. Коммит `test(tg-bot): правило «покажи саму картинку» — красный` + пуш.

- [ ] **Step 3: реализация** — `src/tg-bot/tg-router.service.ts`, в `ioInstructions`:

Строку маркера file заменить на:

```
  • {{file: url=<https://...> | caption=<подпись> | name=<имя>}} — приложит файл по https-URL (картинку — фотографией)
```

Строку `- Маркеры пиши на отдельной строке. Не больше 3 за ответ. source/sources — это URL картинок из предыдущих сообщений в чате.` заменить на:

```
- Маркеры пиши на отдельной строке. Не больше 3 за ответ. source/sources — это URL картинок из предыдущих сообщений в чате или адрес изображения, найденного в сети.
- ПОКАЗАТЬ КАРТИНКУ ИЗ СЕТИ: просят показать схему, карту, план, фото места или вещи — пришли саму картинку маркером {{file: url=<прямой адрес изображения> | caption=<что на ней>}}, не одни ссылки на страницы. Адрес изображения бери со страницы, которую открыл в этом ходе (через WebFetch попроси перечислить адреса картинок на странице). Подписи на картинке на другом языке — объясни в тексте ответа, что где. Перевести надписи на самой картинке можно маркером {{image_edit: source=<адрес изображения> | prompt=<переведи надписи на язык человека, остальное не меняй>}} — только по просьбе и с оговоркой, что надписи перерисованы нейросетью и сверять стоит с оригиналом.
```

(Строки — внутри шаблонной строки `ioInstructions`, с теми же отступами, что соседние; `${…}` в новом тексте нет.)

- [ ] **Step 4: прогон бэка: `src/tg-bot/tg-router.web-tools.spec.ts src/tg-bot`** (весь каталог — `npx jest src/tg-bot`) — PASS.

- [ ] **Step 5: коммит** `feat(tg-bot): правило «покажи саму картинку из сети» в промпте бота` + пуш.

### Task Б7: справка про баланс

**Files:**
- Modify: `src/platform-kb/articles/tokens.ts`

- [ ] **Step 1: правка текста.** Строку

```
- Когда баланс ниже ${V.lowBalance}, ассистент коротко скажет об этом в конце ответа — не чаще раза в ${V.lowBalanceEveryHours} часа.
```

заменить на:

```
- Когда баланс ниже ${V.lowBalance}, ассистент коротко скажет об этом — не чаще раза в ${V.lowBalanceEveryHours} часа и не посреди упражнения: перед началом практики или в конце мысли.
- Когда токенов остаётся на один-два ответа, ассистент поможет бережно завершить текущий шаг и подскажет, что продолжить можно после пополнения.
```

Строку

```
- Баланс на нуле — чат отвечает сообщением о пополнении. Telegram-бот перестаёт отвечать: …
```

заменить на (хвост про Telegram — без изменений):

```
- Баланс на нуле — чат отвечает сообщением о пополнении; разговор сохраняется, после пополнения его можно продолжить с того же места. Telegram-бот перестаёт отвечать: …
```

В комментарии-источнике `// источник: низкий баланс и ноль — …` добавить `src/tokens/balance-context.service.ts (NEAR_EMPTY_ANSWERS); src/chat/no-tokens-message.ts`.

- [ ] **Step 1b: подписи кнопок для справки.** Фронт переименовал `chat.send_anyway` («Прервать и отправить», ветка фронта `feat/insights-fixes-1102`). Справка берёт подписи по ключам (`src/platform-kb/label-keys.json` → `labels.generated.ts`), CLAUDE.md требует перегенерировать в том же изменении:

```bash
cd ~/Downloads/spirits_back/.worktrees/insights-fixes && node scripts/sync-kb-labels.mjs ~/Downloads/spirits_front/.worktrees/insights-fixes
git diff --stat src/platform-kb
```

Путь к фронту — явно (из воркдерева путь по умолчанию неверный). В diff — только подписи `sendAnyway` на 7 языках (и, если скрипт так устроен, сопутствующие поля); посторонние подписи не должны меняться — если меняются, значит фронт-воркдерево отстало от main: остановиться и сообщить.

В `src/platform-kb/articles/chat.ts`, где упоминается `${q('sendAnyway')}` (≈ строка 41), дописать, что кнопка прерывает текущую работу ассистента и он возьмётся за новое сообщение.

- [ ] **Step 2: прогон бэка: `src/platform-kb`** — PASS (если `values.spec`/`kb.spec` сверяет длину или фразы — привести к новому тексту).

- [ ] **Step 3: коммит** `docs(kb): справка — когда ассистент говорит о балансе и что на нуле` + пуш.

### Task Б8: гейты бэка

- [ ] **Step 1:** tsc бэка — `TSC_OK`.
- [ ] **Step 2:** `npx jest src/chat src/tokens src/tg-bot src/platform-kb src/insights 2>&1 | tail -15` — 0 failed. Падение вне наших файлов — сверить с тем же прогоном на `origin/main` (в том же клоне, `git checkout --detach origin/main`) и сообщить разницу.
- [ ] **Step 3:** `npm run build 2>&1 | tail -3` — без ошибок.
- [ ] **Step 4:** `git diff origin/main --stat` и скан публичности: `git diff origin/main | grep -nE '7[0-9]{10}|@[a-z0-9.-]+\.[a-z]{2,}|sk-|BEGIN'` — пусто (кроме уже существующих плейсхолдеров).

---

## Фронт

### Task Ф1: ссылка на картинку файла чата

> **Поправка по ревью качества (02.11, контролёр).** Код Ф1/Ф2 ниже — первая редакция. После ревью: принимаются оба префикса (`/smm-media/` на проде, `/minio/` на test-стенде); `fullUrl` нормализуется (только https, без userinfo/порта/query; относительный — только с одного `/`, от `VITE_BACKEND_URL`); возвращается `name`; `thumbUrl` убран — в ленте сама картинка без обрезки (миниатюра ручки — квадрат 384×384 с обрезкой), клик открывает `MediaViewer` порталом в body (файлы чата отдаются с `Content-Disposition: attachment`, `window.open` скачивал бы); обёртка `not-prose ym-hide-content`; `key={fullUrl}`; у кнопки предохранителя `aria-describedby` вместо `title`. Актуальный код — в ветке фронта.

**Files:**
- Create: `src/components/chat/attachmentPreview.ts`, `src/components/chat/attachmentPreview.test.ts`

- [ ] **Step 1: падающий тест** — `src/components/chat/attachmentPreview.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { imageAttachmentPreview } from './attachmentPreview';

const FILE = 'https://my.linkeon.io/smm-media/linkeon-chat-files/8b75c10c-0ddf-41b0-b780-7e54bc1175f9/seatmap.jpg';

describe('imageAttachmentPreview', () => {
  it('картинка файла чата на проде → миниатюра по ключу и оригинал', () => {
    const a = imageAttachmentPreview(FILE);
    expect(a).not.toBeNull();
    expect(a!.fullUrl).toBe(FILE);
    expect(a!.thumbUrl).toBe(
      '/webhook/chat/thumb?src=' +
        encodeURIComponent('linkeon-chat-files/8b75c10c-0ddf-41b0-b780-7e54bc1175f9/seatmap.jpg'),
    );
  });

  it('относительный адрес и тестовый стенд — тоже', () => {
    expect(imageAttachmentPreview('/smm-media/linkeon-chat-files/k/a.png')).not.toBeNull();
    expect(imageAttachmentPreview('https://test.linkeon.io/smm-media/linkeon-chat-files/k/a.webp')).not.toBeNull();
  });

  it('расширение — без учёта регистра; query и hash в ключ не попадают', () => {
    const a = imageAttachmentPreview('https://my.linkeon.io/smm-media/linkeon-chat-files/k/PHOTO.JPEG?x=1#y');
    expect(a!.thumbUrl).toBe('/webhook/chat/thumb?src=' + encodeURIComponent('linkeon-chat-files/k/PHOTO.JPEG'));
  });

  it('закодированное имя раскодируется в ключ (как его ждёт ручка миниатюр)', () => {
    const a = imageAttachmentPreview('https://my.linkeon.io/smm-media/linkeon-chat-files/k/%D1%81%D1%85%D0%B5%D0%BC%D0%B0%20%D0%B7%D0%B0%D0%BB%D0%B0.png');
    expect(a!.thumbUrl).toBe('/webhook/chat/thumb?src=' + encodeURIComponent('linkeon-chat-files/k/схема зала.png'));
  });

  it.each([
    ['не картинка', 'https://my.linkeon.io/smm-media/linkeon-chat-files/k/report.pdf'],
    ['чужой хост с тем же путём', 'https://evil.example/smm-media/linkeon-chat-files/k/a.jpg'],
    ['другой бакет', 'https://my.linkeon.io/smm-media/linkeon-assets/images/a.jpg'],
    ['кабинет', 'https://my.linkeon.io/profile?open=zoom'],
    ['битая кодировка', 'https://my.linkeon.io/smm-media/linkeon-chat-files/k/%E0%A4%A.jpg'],
    ['выход из каталога', 'https://my.linkeon.io/smm-media/linkeon-chat-files/k/../../x.jpg'],
    ['не веб-схема', 'javascript:alert(1)//linkeon-chat-files/a.jpg'],
    ['протокол-относительный чужой хост', '//evil.example/smm-media/linkeon-chat-files/k/a.jpg'],
    ['обратная косая к чужому хосту', '/\\evil.example/smm-media/linkeon-chat-files/k/a.jpg'],
    ['закодированный слэш в имени', 'https://my.linkeon.io/smm-media/linkeon-chat-files/k%2F..%2F..%2Fx.jpg'],
    ['пусто', ''],
  ])('%s → null', (_name, href) => {
    expect(imageAttachmentPreview(href)).toBeNull();
  });
});
```

- [ ] **Step 2: прогон фронта: `src/components/chat/attachmentPreview.test.ts`** — FAIL. Коммит `test(chat): ссылка на картинку файла чата — красный` + пуш.

- [ ] **Step 3: реализация** — `src/components/chat/attachmentPreview.ts`:

```ts
import { thumbUrlFor } from './files/chatFiles';

/**
 * Ссылка «Скачать имя.jpg» на картинку из файлов чата → миниатюра и оригинал.
 *
 * Релей прикладывает созданные ассистентом файлы ссылками «Скачать …», и
 * картинку приходилось скачивать, чтобы увидеть: схему зала, превью правки
 * знака (находка «Затыков недели» bfc4c3ad; просьба «пришли превью картинкой
 * в чат, чтоб не надо было скачивать»). Такую ссылку лента рисует миниатюрой.
 *
 * Только наши хосты и бакет файлов чата: миниатюру ручка строит по КЛЮЧУ в
 * нашем бакете, и чужая ссылка с тем же путём показала бы не тот файл.
 * Ключ — раскодированный путь (как его ждёт parseThumbSrc на бэке).
 */
const OUR_HOSTS = new Set(['my.linkeon.io', 'test.linkeon.io']);
const PREFIX = '/smm-media/linkeon-chat-files/';
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const MAX_SRC_LENGTH = 300;

export interface ImageAttachmentPreview {
  thumbUrl: string;
  fullUrl: string;
}

export function imageAttachmentPreview(href: string): ImageAttachmentPreview | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, 'https://my.linkeon.io');
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // Хост проверяется всегда: относительный путь разрешается от базы выше, а
  // «//чужой-хост/…» и «/\\чужой-хост/…» тоже начинаются с «/», но ведут наружу.
  if (!OUR_HOSTS.has(url.hostname)) return null;
  if (!url.pathname.startsWith(PREFIX)) return null;

  const rawKey = url.pathname.slice(PREFIX.length);
  let segments: string[];
  try {
    segments = rawKey.split('/').map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  // Сегмент с «/» или «\\» после раскодирования (%2F) — попытка выйти из каталога.
  if (segments.some((s) => s === '' || s === '.' || s === '..' || /[\\/]/.test(s))) return null;
  const key = segments.join('/');
  if (!IMAGE_RE.test(key)) return null;
  const src = `linkeon-chat-files/${key}`;
  if (src.length > MAX_SRC_LENGTH) return null;

  return { thumbUrl: thumbUrlFor(`/webhook/chat/thumb?src=${encodeURIComponent(src)}`), fullUrl: href };
}
```

Примечание: `new URL('…/k/../../x.jpg')` нормализует `..` в пути — такая ссылка уходит из `/smm-media/linkeon-chat-files/` и отсеивается проверкой префикса; тест «выход из каталога» это сторожит. `thumbUrlFor` в тестах без `VITE_BACKEND_URL` даёт относительный путь.

- [ ] **Step 4: прогон фронта: `src/components/chat/attachmentPreview.test.ts`** — PASS.

- [ ] **Step 5: коммит** `feat(chat): распознавание ссылки на картинку файла чата` + пуш.

### Task Ф2: миниатюра в ленте

**Files:**
- Create: `src/components/chat/ChatImageAttachment.tsx`, `src/components/chat/ChatImageAttachment.test.tsx`
- Modify: `src/components/chat/ChatInterface.tsx` (`markdownComponents.a`), `src/components/webvisorPrivacy.test.ts`

- [ ] **Step 1: падающий тест** — `src/components/chat/ChatImageAttachment.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChatImageAttachment from './ChatImageAttachment';

const props = {
  thumbUrl: '/webhook/chat/thumb?src=x',
  fullUrl: 'https://my.linkeon.io/smm-media/linkeon-chat-files/k/a.jpg',
  alt: 'a.jpg',
};

describe('ChatImageAttachment', () => {
  it('показывает миниатюру и ссылку на оригинал', () => {
    render(<ChatImageAttachment {...props} onOpen={vi.fn()}>Скачать a.jpg</ChatImageAttachment>);
    expect(screen.getByRole('img').getAttribute('src')).toBe(props.thumbUrl);
    expect(screen.getByText('Скачать a.jpg')).toBeTruthy();
  });

  it('миниатюра не загрузилась — показывает оригинал', () => {
    render(<ChatImageAttachment {...props} onOpen={vi.fn()}>Скачать a.jpg</ChatImageAttachment>);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('img').getAttribute('src')).toBe(props.fullUrl);
  });

  it('и оригинал не загрузился — картинки нет, ссылка остаётся', () => {
    render(<ChatImageAttachment {...props} onOpen={vi.fn()}>Скачать a.jpg</ChatImageAttachment>);
    fireEvent.error(screen.getByRole('img'));
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Скачать a.jpg')).toBeTruthy();
  });

  it('клик по миниатюре и по ссылке — открыть оригинал', () => {
    const onOpen = vi.fn();
    render(<ChatImageAttachment {...props} onOpen={onOpen}>Скачать a.jpg</ChatImageAttachment>);
    fireEvent.click(screen.getByRole('img'));
    fireEvent.click(screen.getByText('Скачать a.jpg'));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('ссылка — мимо «Внешних переходов» Метрики', () => {
    render(<ChatImageAttachment {...props} onOpen={vi.fn()}>Скачать a.jpg</ChatImageAttachment>);
    expect(screen.getByText('Скачать a.jpg').closest('a')!.className).toContain('ym-disable-tracklink');
  });
});
```

- [ ] **Step 2: прогон фронта: `src/components/chat/ChatImageAttachment.test.tsx`** — FAIL. Коммит `test(chat): миниатюра картинки-вложения — красный` + пуш.

- [ ] **Step 3: компонент** — `src/components/chat/ChatImageAttachment.tsx`:

```tsx
import React, { useState } from 'react';

/**
 * Картинка-вложение в ленте: миниатюра над ссылкой «Скачать …».
 *
 * Рисуется внутри <p> markdown-абзаца, поэтому только строчные элементы
 * (span/img/a) — блок даёт класс `block`. Миниатюра с ручки бэка; не
 * загрузилась — оригинал; не загрузился и он — остаётся одна ссылка, как было.
 * Лента целиком под ym-hide-content (webvisorPrivacy.test.ts), ссылка — с
 * ym-disable-tracklink: адреса файлов переписки личные.
 */
const ChatImageAttachment: React.FC<{
  thumbUrl: string;
  fullUrl: string;
  alt: string;
  onOpen: () => void;
  children: React.ReactNode;
}> = ({ thumbUrl, fullUrl, alt, onOpen, children }) => {
  const [src, setSrc] = useState<string | null>(thumbUrl);

  return (
    <span className="block my-2" data-testid="chat-image-attachment">
      {src && (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onError={() => setSrc((cur) => (cur === thumbUrl && thumbUrl !== fullUrl ? fullUrl : null))}
          onClick={onOpen}
          className="block rounded-xl max-w-full w-56 sm:w-72 object-contain cursor-pointer bg-gray-50"
        />
      )}
      <a
        href={fullUrl}
        onClick={(e) => {
          e.preventDefault();
          onOpen();
        }}
        className="ym-disable-tracklink mt-1 inline-block text-forest-600 hover:text-forest-700 underline cursor-pointer"
      >
        {children}
      </a>
    </span>
  );
};

export default ChatImageAttachment;
```

- [ ] **Step 4: прогон фронта: `src/components/chat/ChatImageAttachment.test.tsx`** — PASS. Коммит `feat(chat): компонент миниатюры картинки-вложения` + пуш.

- [ ] **Step 5: подключение в ленту** — `src/components/chat/ChatInterface.tsx`, импорты рядом с прочими из `./`:

```tsx
import ChatImageAttachment from './ChatImageAttachment';
import { imageAttachmentPreview } from './attachmentPreview';
```

В `markdownComponents`, в `a: ({ href, children }: any) => {` — после ветки `isContactLink` и перед общим `return (<a …`:

```tsx
      // Картинка из файлов чата («Скачать схема.jpg») — миниатюрой в ленте,
      // а не одной ссылкой: иначе её приходится скачивать, чтобы увидеть
      // (attachmentPreview.ts). Открывается тем же путём, что и ссылка.
      const attachment = href ? imageAttachmentPreview(href) : null;
      if (attachment) {
        return (
          <ChatImageAttachment
            thumbUrl={attachment.thumbUrl}
            fullUrl={attachment.fullUrl}
            alt={typeof children === 'string' ? children : t('chat.image_alt')}
            onOpen={() => window.open(attachment.fullUrl, '_blank', 'noopener,noreferrer')}
          >
            {children}
          </ChatImageAttachment>
        );
      }
```

Зависимости `useMemo` у `markdownComponents` — `[handleLinkNavigation]`; `t` там уже используется в `img` — массив зависимостей не менять.

- [ ] **Step 6: сторож Вебвизора** — `src/components/webvisorPrivacy.test.ts`: рядом с прочими `readFileSync` добавить

```ts
const ChatImageAttachmentSrc = readFileSync(join(__dirname, 'chat', 'ChatImageAttachment.tsx'), 'utf8');
```

и в `it.each` блока «ссылки переписки мимо «Внешних переходов» Метрики» строку `['ChatImageAttachment.tsx', ChatImageAttachmentSrc],`.

- [ ] **Step 7: прогон фронта: `src/components/chat/ChatImageAttachment.test.tsx src/components/chat/attachmentPreview.test.ts src/components/webvisorPrivacy.test.ts src/utils/customMarkdown.test.ts`** + все тесты `src/components/chat/ChatInterface*.test.tsx` (`ls src/components/chat | grep ChatInterface`) — PASS.

- [ ] **Step 8: коммит** `feat(chat): картинки-вложения в ленте миниатюрой` + пуш.

### Task Ф3: «Прервать и отправить»

**Files:**
- Modify: `src/i18n/locales/{ru,en,es,de,fr,pt,zh}.json`, `src/components/chat/ChatInterface.tsx`

- [ ] **Step 1: тексты** — в каждой локали в объекте `chat` поменять `send_anyway` и добавить `send_anyway_hint` (правка через скрипт node, не руками — Write портит `\uXXXX`):

| язык | send_anyway | send_anyway_hint |
|---|---|---|
| ru | Прервать и отправить | Ассистент остановит текущую работу и возьмётся за новое сообщение. |
| en | Interrupt and send | The assistant will stop its current work and take on your new message. |
| es | Interrumpir y enviar | El asistente detendrá el trabajo en curso y se ocupará de tu nuevo mensaje. |
| de | Unterbrechen und senden | Der Assistent bricht die laufende Arbeit ab und kümmert sich um deine neue Nachricht. |
| fr | Interrompre et envoyer | L'assistant arrêtera son travail en cours et passera à votre nouveau message. |
| pt | Interromper e enviar | O assistente vai parar o trabalho em curso e tratar da tua nova mensagem. |
| zh | 中断并发送 | 助手将停止当前工作，转而处理你的新消息。 |

```bash
cd ~/Downloads/spirits_front/.worktrees/insights-fixes && node -e '
const fs=require("fs");
const T={ru:["Прервать и отправить","Ассистент остановит текущую работу и возьмётся за новое сообщение."],
en:["Interrupt and send","The assistant will stop its current work and take on your new message."],
es:["Interrumpir y enviar","El asistente detendrá el trabajo en curso y se ocupará de tu nuevo mensaje."],
de:["Unterbrechen und senden","Der Assistent bricht die laufende Arbeit ab und kümmert sich um deine neue Nachricht."],
fr:["Interrompre et envoyer","L’assistant arrêtera son travail en cours et passera à votre nouveau message."],
pt:["Interromper e enviar","O assistente vai parar o trabalho em curso e tratar da tua nova mensagem."],
zh:["中断并发送","助手将停止当前工作，转而处理你的新消息。"]};
for (const [l,[a,h]] of Object.entries(T)) {
  const p=`src/i18n/locales/${l}.json`; const j=JSON.parse(fs.readFileSync(p,"utf8"));
  j.chat.send_anyway=a; j.chat.send_anyway_hint=h;
  fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
}'
git diff --stat
```

Если `git diff` показывает переформатирование посторонних строк (другой отступ, экранирование) — откатить файл и вписать два ключа точечной заменой строки `"send_anyway": "…"` через `node`, сохранив исходное форматирование. Апостроф во французском — тот, что принят в `fr.json` (посмотреть соседние строки; если там `'`, взять `'`).

- [ ] **Step 2: кнопка** — `src/components/chat/ChatInterface.tsx`, блок `{overrideOffered && (` в карточке удалённого хода:

```tsx
              {overrideOffered && (
                <>
                  <button
                    onClick={() => setRemoteOverride(true)}
                    title={t('chat.send_anyway_hint')}
                    className="mt-2 text-xs text-forest-700 underline underline-offset-2 hover:text-forest-800"
                  >
                    {t('chat.send_anyway')}
                  </button>
                  {/* Кнопка обходит признак «ход идёт» — и прерывает ход, если он
                      настоящий (релей пре-эмптит процесс сессии). Подпись это
                      говорит прямо: «Отправить всё равно» жали из нетерпения и
                      убивали работу (находка «Затыков недели» 2ff1a026). */}
                  <p className="mt-1 text-xs text-gray-400">{t('chat.send_anyway_hint')}</p>
                </>
              )}
```

(Прежний многострочный комментарий над кнопкой про предохранитель оставить.)

- [ ] **Step 3: прогон фронта** — `node scripts/check-locales.mjs; node scripts/check-keys.mjs; node scripts/check-no-hardcoded.mjs` (точные имена — `ls scripts | grep check`), и тесты чата, где встречается `send_anyway` (`grep -rln send_anyway src`). Ожидание: зелёные, кроме `check-locale-format` (красный на main — база).

- [ ] **Step 4: коммит** `feat(chat): «Прервать и отправить» — кнопка говорит, что прервёт работу` + пуш.

### Task Ф4: гейты фронта

- [ ] **Step 1:** `pnpm test 2>&1 | tail -8` на ноде — 0 failed (падение вне наших файлов — сверить с `origin/main` в том же клоне).
- [ ] **Step 2:** `npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -c 'error TS'` — не больше базы из Task 0.
- [ ] **Step 3:** `pnpm build 2>&1 | tail -3` — без ошибок.
- [ ] **Step 4:** скан публичности: `git diff origin/main | grep -nE '7[0-9]{10}|sk-|BEGIN'` — пусто.

---

## После плана (контролёр)

1. Ревью каждой ветки (code-reviewer), правки.
2. OK владельца → слияние обеих веток в main (сверить `origin/main`, merge без force) → `bash ~/Downloads/spirits_back/scripts/deploy.sh` со свежих клонов на ноде (`SKIP_BOTS=1`), не во время чужого выката.
3. Живая проверка: кабинет (картинка-вложение миниатюрой, «Прервать и отправить»), бот в Telegram (схема зала фотографией), ход Романа с просьбой показать картинку, баланс-блок на тестовом аккаунте, `active-turn` после пре-эмпта.
4. Бэклог: комментарий по каждой задаче (без привязки к людям) и `done`; темы автоблога — по решению владельца.
5. Уборка: воркдеревья на маке, `~/ci/wt/ins-*` на ноде.
