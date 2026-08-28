# Личный чат с ассистентами в боте — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** @LinkeonAgentBot отвечает в личных сообщениях любым из ассистентов, и активный ассистент переключается прямо в переписке — тем же полем `preferred_agent`, что и веб с мини-аппом.

**Architecture:** Переиспользуем машинерию групповых чатов. Личный чат получает обычную строку `tg_bot_configs` (`addressing_mode='always'`), поэтому биллинг, история, голосовые и команды работают без изменений. Единственная развилка — резолвинг ассистента: для приватных конфигов он читает `preferred_agent` владельца, а не `cfg.preset_agent_id`.

**Tech Stack:** NestJS 10, PostgreSQL, grammY, Jest.

**Спек:** `docs/superpowers/specs/2026-08-28-assistants-in-bot-and-tma-panel-design.md`

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `src/tg-bot/tg-chat-kind.ts` (создать) | Одна чистая функция: приватный это конфиг или групповой |
| `src/tg-bot/tg-router.service.ts` (правка, `resolveSystemPrompt` — строка 200) | Развилка резолвинга ассистента + фолбэки |
| `src/tg-bot/tg-config.service.ts` (правка, после `getActiveByTgChatId` — строка 207) | `ensurePrivateConfig` — завести конфиг для лички |
| `src/tg-bot/tg-bot.service.ts` (правка, приватная ветка — строки 110–146) | Обычный текст в личке идёт в общий обработчик |
| `src/tg-bot/tg-assistants-keyboard.ts` (создать) | Сборка инлайн-клавиатуры и пагинация — чистые функции |
| `src/tg-bot/tg-commands.service.ts` (правка) | Команда `/assistants` и обработка нажатий |

Клавиатура и определение вида чата вынесены в отдельные файлы чистыми функциями — их можно тестировать без БД и без grammY, а `tg-bot.service.ts` уже 900+ строк, и дописывать туда ещё логику не стоит.

---

## Task 1: Приватный чат отличается от группового

**Files:**
- Create: `src/tg-bot/tg-chat-kind.ts`
- Test: `src/tg-bot/tg-chat-kind.spec.ts`

Telegram гарантирует: id личного чата положительный, id группы/супергруппы/канала — отрицательный. Отдельную колонку не заводим сознательно: миграции на проде накатываются ненадёжно (см. `docs/` про migrate-runner), а правило про знак стабильно и проверяется тестом.

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/tg-bot/tg-chat-kind.spec.ts
import { isPrivateConfig } from './tg-chat-kind';

describe('isPrivateConfig', () => {
  it('положительный tg_chat_id — личный чат', () => {
    expect(isPrivateConfig({ tg_chat_id: '123456789' } as any)).toBe(true);
  });

  it('отрицательный tg_chat_id — группа', () => {
    expect(isPrivateConfig({ tg_chat_id: '-5218835753' } as any)).toBe(false);
  });

  it('пустой tg_chat_id (pending-конфиг) — не личный', () => {
    expect(isPrivateConfig({ tg_chat_id: null } as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npx jest src/tg-bot/tg-chat-kind.spec.ts`
Expected: FAIL — `Cannot find module './tg-chat-kind'`

- [ ] **Step 3: Реализация**

```typescript
// src/tg-bot/tg-chat-kind.ts
import type { TgBotConfigRow } from './tg-config.service';

/**
 * Личный чат или групповой. Telegram гарантирует знак: id личного чата
 * положительный, группы/супергруппы/канала — отрицательный.
 *
 * Отдельной колонки в tg_bot_configs намеренно нет: она потребовала бы
 * миграции, а они на проде накатываются ненадёжно. Знак — свойство самого
 * Telegram, оно не зависит от нашей схемы и не может разъехаться с данными.
 *
 * tg_chat_id = null бывает у pending-конфигов (созданы в вебе, но ещё не
 * привязаны к чату) — они не приватные.
 */
export function isPrivateConfig(cfg: Pick<TgBotConfigRow, 'tg_chat_id'>): boolean {
  if (!cfg.tg_chat_id) return false;
  return Number(cfg.tg_chat_id) > 0;
}
```

- [ ] **Step 4: Прогнать тест, убедиться что проходит**

Run: `npx jest src/tg-bot/tg-chat-kind.spec.ts`
Expected: PASS, 3 теста

- [ ] **Step 5: Коммит**

```bash
git add src/tg-bot/tg-chat-kind.ts src/tg-bot/tg-chat-kind.spec.ts
git commit -m "feat(tg-bot): отличать личный чат от группового по знаку chat_id"
```

---

## Task 2: В личке отвечает ассистент из preferred_agent

**Files:**
- Modify: `src/tg-bot/tg-router.service.ts:200-214` (`resolveSystemPrompt`)
- Test: `src/tg-bot/tg-router.private-agent.spec.ts`

Это ядро всей задачи: то самое место, где мини-апп и бот перестают расходиться.

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/tg-bot/tg-router.private-agent.spec.ts
import { TgRouterService } from './tg-router.service';

describe('resolveSystemPrompt для личного чата', () => {
  const agents = {
    getAgentById: jest.fn(),
    getAgentByName: jest.fn(),
  };
  const pg = { query: jest.fn() };

  const router = new TgRouterService(
    pg as any, agents as any, {} as any, {} as any, {} as any, {} as any,
  );
  const resolve = (cfg: any) => (router as any).resolveSystemPrompt(cfg);

  beforeEach(() => jest.resetAllMocks());

  it('берёт preferred_agent владельца, а не preset_agent_id из строки', async () => {
    // В строке конфига лежит Роман (id 12) — так его завели при создании.
    // Владелец переключился на Олю в мини-аппе. Отвечать обязана Оля.
    pg.query.mockResolvedValue({ rows: [{ preferred_agent: 'Оля' }] });
    agents.getAgentByName.mockResolvedValue({ name: 'Оля', system_prompt: 'промпт Оли' });

    const r = await resolve({ tg_chat_id: '777', preset_agent_id: '12', owner_user_id: 'u-1' });

    expect(r).toEqual({ name: 'Оля', systemPrompt: 'промпт Оли' });
    expect(agents.getAgentById).not.toHaveBeenCalled();
  });

  it('групповой конфиг по-прежнему читает preset_agent_id', async () => {
    agents.getAgentById.mockResolvedValue({ name: 'Роман', system_prompt: 'промпт Романа' });

    const r = await resolve({ tg_chat_id: '-5218835753', preset_agent_id: '12', owner_user_id: 'u-1' });

    expect(r).toEqual({ name: 'Роман', systemPrompt: 'промпт Романа' });
    expect(agents.getAgentByName).not.toHaveBeenCalled();
  });

  it('preferred_agent пуст — дефолтный ассистент', async () => {
    pg.query.mockResolvedValue({ rows: [{ preferred_agent: null }] });
    agents.getAgentById.mockResolvedValue({ name: 'Роман', system_prompt: 'промпт Романа' });

    const r = await resolve({ tg_chat_id: '777', preset_agent_id: null, owner_user_id: 'u-1' });

    expect(r.name).toBe('Роман');
    expect(agents.getAgentById).toHaveBeenCalledWith('12');
  });

  it('ассистента переименовали — дефолтный, а не падение', async () => {
    pg.query.mockResolvedValue({ rows: [{ preferred_agent: 'Ассистент-которого-нет' }] });
    agents.getAgentByName.mockResolvedValue(null);
    agents.getAgentById.mockResolvedValue({ name: 'Роман', system_prompt: 'промпт Романа' });

    const r = await resolve({ tg_chat_id: '777', preset_agent_id: null, owner_user_id: 'u-1' });

    expect(r.name).toBe('Роман');
  });
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npx jest src/tg-bot/tg-router.private-agent.spec.ts`
Expected: FAIL — первый тест получит Романа вместо Оли (сейчас читается только `preset_agent_id`)

Если конструктор `TgRouterService` требует другое число зависимостей — подставить актуальное; проверить по строкам 25–40 `tg-router.service.ts`.

- [ ] **Step 3: Реализация**

Заменить `resolveSystemPrompt` (строка 200) на:

```typescript
  /**
   * Кто отвечает в этом чате.
   *
   * Для ЛИЧНОГО чата источник правды — preferred_agent владельца, то самое
   * поле, которое пишут веб и мини-апп. cfg.preset_agent_id в приватной
   * строке инертен: он заполнен только чтобы удовлетворить констрейнт
   * tg_bot_configs_check, и намеренно НЕ синхронизируется при переключении —
   * иначе вернулась бы двойная запись, из-за которой мини-апп и бот
   * разъезжались (см. спек 2026-08-28).
   *
   * Для группового чата всё по-прежнему: ассистент привязан к чату, потому
   * что смена одним участником сбивала бы разговор остальных.
   */
  private async resolveSystemPrompt(cfg: TgBotConfigRow): Promise<{ name: string; systemPrompt: string }> {
    if (cfg.custom_agent_id) {
      const r = await this.pg.query(
        `SELECT name, system_prompt FROM custom_agents WHERE id = $1 LIMIT 1`,
        [cfg.custom_agent_id],
      );
      if (r.rows[0]) return { name: r.rows[0].name, systemPrompt: r.rows[0].system_prompt };
    }

    if (isPrivateConfig(cfg)) {
      const prof = await this.pg.query(
        `SELECT preferred_agent FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
        [cfg.owner_user_id],
      );
      const preferred = prof.rows[0]?.preferred_agent;
      if (preferred) {
        const agent = await this.agents.getAgentByName(preferred);
        if (agent) return { name: agent.name, systemPrompt: agent.system_prompt };
        this.logger.warn(
          `preferred_agent "${preferred}" владельца ${cfg.owner_user_id} не найден в agents — откатываюсь на дефолтного`,
        );
      }
      const fallback = await this.agents.getAgentById(DEFAULT_AGENT_ID);
      if (fallback) return { name: fallback.name, systemPrompt: fallback.system_prompt };
    }

    if (cfg.preset_agent_id) {
      const preset = await this.agents.getAgentById(cfg.preset_agent_id);
      if (preset) return { name: preset.name, systemPrompt: preset.system_prompt };
    }
    throw new Error(`Config ${cfg.id} has no resolvable agent`);
  }
```

В начало файла добавить импорт и константу:

```typescript
import { isPrivateConfig } from './tg-chat-kind';

/**
 * Дефолтный ассистент для лички, когда preferred_agent пуст или указывает на
 * несуществующего. 12 — Роман: он стоит у девяти из десяти боевых конфигов,
 * то есть это уже сложившийся выбор, а не новый.
 */
const DEFAULT_AGENT_ID = '12';
```

- [ ] **Step 4: Прогнать тест, убедиться что проходит**

Run: `npx jest src/tg-bot/tg-router.private-agent.spec.ts`
Expected: PASS, 4 теста

- [ ] **Step 5: Прогнать соседние тесты роутера — не сломалось ли групповое поведение**

Run: `npx jest src/tg-bot/tg-router`
Expected: PASS, все существующие сьюты (`tg-router.model`, `tg-router.memory`, `tg-router.answer-expected`, `tg-router.web-tools`)

- [ ] **Step 6: Коммит**

```bash
git add src/tg-bot/tg-router.service.ts src/tg-bot/tg-router.private-agent.spec.ts
git commit -m "feat(tg-bot): в личке отвечает ассистент из preferred_agent

Раньше мини-апп переключал preferred_agent, а бот читал preset_agent_id
своей строки — переключение не действовало ни на что."
```

---

## Task 3: Конфиг для личного чата заводится сам

**Files:**
- Modify: `src/tg-bot/tg-config.service.ts` (добавить метод после `getActiveByTgChatId`, строка 207)
- Test: `src/tg-bot/tg-config.private.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/tg-bot/tg-config.private.spec.ts
import { TgConfigService } from './tg-config.service';

describe('ensurePrivateConfig', () => {
  const pg = { query: jest.fn() };
  const svc = new TgConfigService(pg as any, {} as any);

  beforeEach(() => jest.resetAllMocks());

  it('возвращает существующий конфиг, ничего не вставляя', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: 'cfg-1', tg_chat_id: '777' }] });

    const cfg = await svc.ensurePrivateConfig('u-1', 777);

    expect(cfg.id).toBe('cfg-1');
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('создаёт конфиг с addressing_mode=always и текущим ассистентом владельца', async () => {
    pg.query
      .mockResolvedValueOnce({ rows: [] })                                   // активного нет
      .mockResolvedValueOnce({ rows: [{ preferred_agent: 'Оля' }] })          // профиль
      .mockResolvedValueOnce({ rows: [{ id: '2' }] })                         // id Оли
      .mockResolvedValueOnce({ rows: [{ id: 'cfg-new', tg_chat_id: '777' }] }); // insert

    const cfg = await svc.ensurePrivateConfig('u-1', 777);

    expect(cfg.id).toBe('cfg-new');
    const insert = pg.query.mock.calls[3];
    expect(insert[0]).toContain('INSERT INTO tg_bot_configs');
    expect(insert[1]).toContain('always');
    expect(insert[1]).toContain('2');
  });

  it('профиль без preferred_agent — в строку идёт дефолтный ассистент', async () => {
    pg.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ preferred_agent: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cfg-new', tg_chat_id: '777' }] });

    await svc.ensurePrivateConfig('u-1', 777);

    const insert = pg.query.mock.calls[2];
    expect(insert[1]).toContain('12');
  });
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npx jest src/tg-bot/tg-config.private.spec.ts`
Expected: FAIL — `svc.ensurePrivateConfig is not a function`

- [ ] **Step 3: Реализация**

```typescript
  /**
   * Конфиг для личного чата: находит активный или заводит новый.
   *
   * preset_agent_id заполняется текущим ассистентом владельца только ради
   * констрейнта tg_bot_configs_check (строка без ассистента запрещена). Для
   * приватных конфигов это поле инертно — кто отвечает, решает
   * resolveSystemPrompt по preferred_agent. Специально НЕ обновляем его при
   * переключении: см. комментарий там же.
   *
   * addressing_mode='always' — в личке отвечать на каждое сообщение; strict
   * потребовал бы обращения по имени, что в диалоге один на один абсурдно.
   */
  async ensurePrivateConfig(ownerId: string, tgChatId: number): Promise<TgBotConfigRow> {
    const existing = await this.pg.query(
      `SELECT * FROM tg_bot_configs
        WHERE tg_chat_id = $1 AND status = ANY(ARRAY['active','silent'])
        LIMIT 1`,
      [tgChatId],
    );
    if (existing.rows[0]) return existing.rows[0];

    const prof = await this.pg.query(
      `SELECT preferred_agent FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
      [ownerId],
    );
    let agentId = '12';
    const preferred = prof.rows[0]?.preferred_agent;
    if (preferred) {
      const a = await this.pg.query(`SELECT id FROM agents WHERE name = $1 LIMIT 1`, [preferred]);
      if (a.rows[0]) agentId = String(a.rows[0].id);
    }

    const created = await this.pg.query(
      `INSERT INTO tg_bot_configs (
         owner_user_id, tg_chat_id, display_name, preset_agent_id,
         addressing_mode, voice_reply_mode, status
       ) VALUES ($1, $2, $3, $4, $5, 'mirror', 'active')
       RETURNING *`,
      [ownerId, tgChatId, 'Linkeon', agentId, 'always'],
    );
    this.logger.log(`создан приватный конфиг для чата ${tgChatId} (владелец ${ownerId})`);
    return created.rows[0];
  }
```

- [ ] **Step 4: Прогнать тест, убедиться что проходит**

Run: `npx jest src/tg-bot/tg-config.private.spec.ts`
Expected: PASS, 3 теста

- [ ] **Step 5: Коммит**

```bash
git add src/tg-bot/tg-config.service.ts src/tg-bot/tg-config.private.spec.ts
git commit -m "feat(tg-bot): конфиг личного чата заводится при первом сообщении"
```

---

## Task 4: Обычный текст в личке доходит до ассистента

**Files:**
- Modify: `src/tg-bot/tg-bot.service.ts:110-146` (приватная ветка) и `:307` (`handleGroupMessage` → `handleChatMessage`)
- Test: `src/tg-bot/tg-bot.private-text.spec.ts`

Сейчас в приватном чате обрабатываются только `/start` и команды; обычный текст не попадает никуда. Переиспользуем групповой обработчик целиком — он уже умеет голос, вложения, баланс, историю и биллинг.

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/tg-bot/tg-bot.private-text.spec.ts
import { TgBotService } from './tg-bot.service';

describe('обычный текст в личном чате', () => {
  const identity = { getLinkeonIdByTgUserId: jest.fn() };
  const configs = { ensurePrivateConfig: jest.fn(), getActiveByTgChatId: jest.fn() };
  const grammy = { sendMessage: jest.fn() };

  const svc = new TgBotService(
    {} as any, identity as any, {} as any, configs as any, {} as any,
    {} as any, {} as any, {} as any, grammy as any,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    (svc as any).handleChatMessage = jest.fn();
  });

  const msg = (text: string) => ({
    chat: { id: 777, type: 'private' },
    from: { id: 42 },
    message_id: 1,
    text,
  });

  it('текст от привязанного пользователя уходит в общий обработчик', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue('u-1');
    configs.ensurePrivateConfig.mockResolvedValue({ id: 'cfg-1' });

    await (svc as any).handleUpdate({ message: msg('привет') });

    expect(configs.ensurePrivateConfig).toHaveBeenCalledWith('u-1', 777);
    expect((svc as any).handleChatMessage).toHaveBeenCalled();
  });

  it('непривязанный пользователь получает подсказку, а не молчание', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue(null);

    await (svc as any).handleUpdate({ message: msg('привет') });

    expect((svc as any).handleChatMessage).not.toHaveBeenCalled();
    expect(grammy.sendMessage).toHaveBeenCalledWith(777, expect.stringContaining('/start'));
  });

  it('команды по-прежнему идут своим путём, не в ассистента', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue('u-1');
    (svc as any).handleDmCommand = jest.fn();

    await (svc as any).handleUpdate({ message: msg('/balance') });

    expect((svc as any).handleDmCommand).toHaveBeenCalled();
    expect((svc as any).handleChatMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npx jest src/tg-bot/tg-bot.private-text.spec.ts`
Expected: FAIL — первый тест: `handleChatMessage` не вызван (обычный текст в личке никуда не идёт)

Порядок аргументов конструктора `TgBotService` сверить по строкам 52–60; в тесте важны только `identity`, `configs`, `grammy`.

- [ ] **Step 3: Реализация**

Переименовать `handleGroupMessage` в `handleChatMessage` (строка 307) — обработчик перестал быть только групповым. Внутри метода `getActiveByTgChatId` заменить на приём готового конфига параметром:

```typescript
  private async handleChatMessage(msg: any, cfgIn?: TgBotConfigRow): Promise<void> {
    const cfg = cfgIn ?? (await this.configs.getActiveByTgChatId(msg.chat.id));
    if (!cfg) return;
    // ... остальное тело без изменений
```

В групповой ветке (строка ~215) вызов остаётся `await this.handleChatMessage(msg);`.

В приватной ветке после блока команд (строка ~131) добавить:

```typescript
    // Обычный текст в личке — разговор с ассистентом. Раньше такой ветки не
    // было вовсе: бот молчал на всё, кроме /start и команд.
    if (chatType === 'private') {
      const ownerId = await this.identity.getLinkeonIdByTgUserId(msg.from.id);
      if (!ownerId) {
        await this.grammy.sendMessage(
          msg.chat.id,
          'Telegram не привязан к Linkeon. Нажми /start или зайди в кабинет и нажми «Подключить Telegram».',
        );
        return;
      }
      const cfg = await this.configs.ensurePrivateConfig(ownerId, msg.chat.id);
      await this.handleChatMessage(msg, cfg);
      return;
    }
```

Ветка ставится ПОСЛЕ проверки `msg.text.startsWith('/')` — иначе команды уедут в ассистента.

- [ ] **Step 4: Прогнать тест, убедиться что проходит**

Run: `npx jest src/tg-bot/tg-bot.private-text.spec.ts`
Expected: PASS, 3 теста

- [ ] **Step 5: Прогнать все тесты бота — групповое поведение не задето**

Run: `npx jest src/tg-bot`
Expected: PASS, все сьюты каталога

- [ ] **Step 6: Коммит**

```bash
git add src/tg-bot/tg-bot.service.ts src/tg-bot/tg-bot.private-text.spec.ts
git commit -m "feat(tg-bot): бот отвечает на обычные сообщения в личке"
```

---

## Task 5: Клавиатура выбора ассистента

**Files:**
- Create: `src/tg-bot/tg-assistants-keyboard.ts`
- Test: `src/tg-bot/tg-assistants-keyboard.spec.ts`

19 ассистентов в одно сообщение не влезают — нужна пагинация. Чистые функции, без grammY и БД.

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/tg-bot/tg-assistants-keyboard.spec.ts
import { buildAssistantsKeyboard, PAGE_SIZE } from './tg-assistants-keyboard';

const agents = Array.from({ length: 19 }, (_, i) => ({ id: i + 1, name: `A${i + 1}` }));

describe('buildAssistantsKeyboard', () => {
  it('на первой странице PAGE_SIZE ассистентов и кнопка «дальше»', () => {
    const kb = buildAssistantsKeyboard(agents, 0, 'A3');
    const rows = kb.inline_keyboard;
    expect(rows).toHaveLength(PAGE_SIZE + 1);
    expect(rows[rows.length - 1].map((b: any) => b.text)).toEqual(['Дальше →']);
  });

  it('текущий ассистент помечен галочкой', () => {
    const kb = buildAssistantsKeyboard(agents, 0, 'A3');
    const marked = kb.inline_keyboard.flat().filter((b: any) => b.text.startsWith('✓'));
    expect(marked).toHaveLength(1);
    expect(marked[0].text).toBe('✓ A3');
  });

  it('callback_data несёт имя ассистента', () => {
    const kb = buildAssistantsKeyboard(agents, 0, null);
    expect(kb.inline_keyboard[0][0].callback_data).toBe('agent:A1');
  });

  it('последняя страница — только кнопка «назад»', () => {
    const lastPage = Math.ceil(agents.length / PAGE_SIZE) - 1;
    const kb = buildAssistantsKeyboard(agents, lastPage, null);
    const nav = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    expect(nav.map((b: any) => b.text)).toEqual(['← Назад']);
  });

  it('страница за пределами списка не падает и отдаёт пустой список', () => {
    const kb = buildAssistantsKeyboard(agents, 99, null);
    expect(kb.inline_keyboard.flat().filter((b: any) => b.callback_data?.startsWith('agent:'))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npx jest src/tg-bot/tg-assistants-keyboard.spec.ts`
Expected: FAIL — `Cannot find module './tg-assistants-keyboard'`

- [ ] **Step 3: Реализация**

```typescript
// src/tg-bot/tg-assistants-keyboard.ts

/**
 * Инлайн-клавиатура выбора ассистента.
 *
 * По одному в строке: имена длинные («Екатерина», «Александра»), два в ряд
 * обрезаются на узких экранах. 19 ассистентов не влезают в одно сообщение —
 * отсюда пагинация.
 *
 * callback_data несёт ИМЯ, а не id: preferred_agent хранит имя, и
 * AgentsService.changeAgent принимает тоже имя. Лимит Telegram на
 * callback_data — 64 байта; имена ассистентов заведомо короче.
 */
export const PAGE_SIZE = 8;

export interface KeyboardAgent {
  id: number | string;
  name: string;
}

export function buildAssistantsKeyboard(
  agents: KeyboardAgent[],
  page: number,
  current: string | null,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const start = page * PAGE_SIZE;
  const slice = agents.slice(start, start + PAGE_SIZE);

  const rows = slice.map((a) => [
    {
      text: a.name === current ? `✓ ${a.name}` : a.name,
      callback_data: `agent:${a.name}`,
    },
  ]);

  const nav: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) nav.push({ text: '← Назад', callback_data: `agents_page:${page - 1}` });
  if (start + PAGE_SIZE < agents.length) nav.push({ text: 'Дальше →', callback_data: `agents_page:${page + 1}` });
  if (nav.length) rows.push(nav);

  return { inline_keyboard: rows };
}
```

- [ ] **Step 4: Прогнать тест, убедиться что проходит**

Run: `npx jest src/tg-bot/tg-assistants-keyboard.spec.ts`
Expected: PASS, 5 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/tg-bot/tg-assistants-keyboard.ts src/tg-bot/tg-assistants-keyboard.spec.ts
git commit -m "feat(tg-bot): клавиатура выбора ассистента с пагинацией"
```

---

## Task 6: Команда /assistants и переключение по нажатию

**Files:**
- Modify: `src/tg-bot/tg-commands.service.ts`
- Modify: `src/tg-bot/tg-bot.service.ts` (обработка `callback_query` в `handleUpdate`)
- Test: `src/tg-bot/tg-commands.assistants.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/tg-bot/tg-commands.assistants.spec.ts
import { TgCommandsService } from './tg-commands.service';

describe('/assistants', () => {
  const grammy = { sendMessage: jest.fn(), editMessageReplyMarkup: jest.fn(), answerCallbackQuery: jest.fn() };
  const agents = {
    getAgents: jest.fn(),
    changeAgent: jest.fn(),
  };
  const pg = { query: jest.fn() };
  const svc = new TgCommandsService(pg as any, grammy as any, {} as any, {} as any, agents as any);

  beforeEach(() => {
    jest.resetAllMocks();
    agents.getAgents.mockResolvedValue([{ id: 1, name: 'Миша' }, { id: 2, name: 'Оля' }]);
    pg.query.mockResolvedValue({ rows: [{ preferred_agent: 'Оля' }] });
  });

  it('показывает список с пометкой текущего', async () => {
    await svc.handleAssistants({ chat: { id: 777 }, from: { id: 42 } } as any, 'u-1');

    const [, text, opts] = grammy.sendMessage.mock.calls[0];
    expect(text).toContain('Оля');
    const marked = opts.reply_markup.inline_keyboard.flat().find((b: any) => b.text.startsWith('✓'));
    expect(marked.text).toBe('✓ Оля');
  });

  it('нажатие переключает ассистента и подтверждает', async () => {
    await svc.handleAgentCallback(
      { id: 'cb-1', data: 'agent:Миша', message: { chat: { id: 777 }, message_id: 5 }, from: { id: 42 } } as any,
      'u-1',
    );

    expect(agents.changeAgent).toHaveBeenCalledWith('u-1', 'Миша');
    expect(grammy.sendMessage).toHaveBeenCalledWith(777, expect.stringContaining('Миша'));
  });

  it('неизвестное имя в callback не переключает', async () => {
    agents.getAgents.mockResolvedValue([{ id: 1, name: 'Миша' }]);

    await svc.handleAgentCallback(
      { id: 'cb-2', data: 'agent:Мишa-подделка', message: { chat: { id: 777 }, message_id: 5 }, from: { id: 42 } } as any,
      'u-1',
    );

    expect(agents.changeAgent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npx jest src/tg-bot/tg-commands.assistants.spec.ts`
Expected: FAIL — `svc.handleAssistants is not a function`

- [ ] **Step 3: Реализация**

В `tg-commands.service.ts` добавить `AgentsService` в конструктор и два метода:

```typescript
  /**
   * /assistants — список ассистентов с пометкой текущего.
   * Локаль не передаём: имена ассистентов одинаковы во всех локалях, а
   * описания в клавиатуру не влезают.
   */
  async handleAssistants(msg: any, ownerId: string, page = 0): Promise<void> {
    const agents = await this.agents.getAgents();
    const prof = await this.pg.query(
      `SELECT preferred_agent FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
      [ownerId],
    );
    const current = prof.rows[0]?.preferred_agent ?? null;
    await this.grammy.sendMessage(
      msg.chat.id,
      current ? `Сейчас отвечает *${current}*. Кого позвать?` : 'Кого позвать?',
      { parse_mode: 'Markdown', reply_markup: buildAssistantsKeyboard(agents, page, current) },
    );
  }

  /**
   * Нажатие на карточку ассистента. Имя из callback_data сверяем со списком:
   * callback_data приходит от клиента и доверять ему нельзя.
   */
  async handleAgentCallback(cb: any, ownerId: string): Promise<void> {
    const name = String(cb.data || '').slice('agent:'.length);
    const agents = await this.agents.getAgents();
    if (!agents.some((a: any) => a.name === name)) {
      this.logger.warn(`callback с неизвестным ассистентом "${name}" от ${ownerId}`);
      await this.grammy.answerCallbackQuery(cb.id, { text: 'Такого ассистента нет' });
      return;
    }
    await this.agents.changeAgent(ownerId, name);
    await this.grammy.answerCallbackQuery(cb.id, {});
    await this.grammy.sendMessage(cb.message.chat.id, `Теперь отвечает *${name}*.`, { parse_mode: 'Markdown' });
  }
```

В `tg-bot.service.ts`: в ветку команд добавить `/assistants`, а в `handleUpdate` — обработку `callback_query`:

```typescript
    if (update.callback_query) {
      const cb = update.callback_query;
      const ownerId = await this.identity.getLinkeonIdByTgUserId(cb.from.id);
      if (!ownerId) return;
      if (String(cb.data || '').startsWith('agent:')) {
        await this.commands.handleAgentCallback(cb, ownerId);
        return;
      }
      if (String(cb.data || '').startsWith('agents_page:')) {
        const page = Number(String(cb.data).split(':')[1]) || 0;
        await this.commands.handleAssistants(cb.message, ownerId, page);
        return;
      }
      return;
    }
```

- [ ] **Step 4: Прогнать тест, убедиться что проходит**

Run: `npx jest src/tg-bot/tg-commands.assistants.spec.ts`
Expected: PASS, 3 теста

- [ ] **Step 5: Зарегистрировать команду в меню бота**

В тексте `/help` (строка ~168 `tg-bot.service.ts`) добавить строку `/assistants — выбрать ассистента`.

- [ ] **Step 6: Коммит**

```bash
git add src/tg-bot/tg-commands.service.ts src/tg-bot/tg-bot.service.ts src/tg-bot/tg-commands.assistants.spec.ts
git commit -m "feat(tg-bot): команда /assistants переключает ассистента в переписке"
```

---

## Task 7: Отметка о смене ассистента в истории

**Files:**
- Modify: `src/tg-bot/tg-commands.service.ts` (`handleAgentCallback`)
- Test: `src/tg-bot/tg-commands.assistants.spec.ts` (дописать)

Лента в личке одна на всех ассистентов. Без отметки новый ассистент получает историю, где он же якобы говорил чужим голосом.

- [ ] **Step 1: Дописать падающий тест**

```typescript
  it('в историю пишется системная отметка о смене', async () => {
    await svc.handleAgentCallback(
      { id: 'cb-3', data: 'agent:Миша', message: { chat: { id: 777 }, message_id: 5 }, from: { id: 42 } } as any,
      'u-1',
    );

    const insert = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO tg_bot_messages'));
    expect(insert).toBeDefined();
    expect(insert[1]).toContain('Дальше отвечает Миша');
  });
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx jest src/tg-bot/tg-commands.assistants.spec.ts -t 'системная отметка'`
Expected: FAIL — `expect(received).toBeDefined()` получает undefined

- [ ] **Step 3: Реализация**

В `handleAgentCallback` после `changeAgent`:

```typescript
    const cfg = await this.configs.getActiveByTgChatId(cb.message.chat.id);
    if (cfg) {
      await this.pg.query(
        `INSERT INTO tg_bot_messages (config_id, tg_chat_id, tg_user_id, role, content, content_type, tokens_charged)
         VALUES ($1, $2, $3, 'assistant', $4, 'text', 0)`,
        [cfg.id, cb.message.chat.id, cb.from.id, `— Дальше отвечает ${name}. —`],
      );
    }
```

- [ ] **Step 4: Прогнать тест**

Run: `npx jest src/tg-bot/tg-commands.assistants.spec.ts`
Expected: PASS, 4 теста

- [ ] **Step 5: Коммит**

```bash
git add src/tg-bot/tg-commands.service.ts src/tg-bot/tg-commands.assistants.spec.ts
git commit -m "feat(tg-bot): смена ассистента оставляет отметку в истории"
```

---

## Task 8: Полный прогон и выкат

- [ ] **Step 1: Прогнать все тесты на тестовой ноде**

```bash
git push -u origin feat/tg-assistants-in-bot
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q <sha>'
ssh dv@85.192.61.231 'source ~/.nvm/nvm.sh && cd ~/ci/spirits_back && npm ci --silent && npx jest src/ 2>&1 | tail -20'
```

Expected: 0 failed. Сьюты `tests/*.js` падают с «must contain at least one test» — это предсуществующий шум, мерить дельтой (см. память проекта).

- [ ] **Step 2: Собрать**

Run: `ssh dv@85.192.61.231 'source ~/.nvm/nvm.sh && cd ~/ci/spirits_back && npm run build'`
Expected: `nest build` без ошибок

- [ ] **Step 3: Влить в main и выкатить**

```bash
git checkout main && git merge --no-ff feat/tg-assistants-in-bot && git push origin main
bash ~/Downloads/spirits_back/scripts/deploy.sh
```

Выкат только с явного согласия владельца — deploy.sh трогает прод.

- [ ] **Step 4: Живая проверка на проде**

Написать боту в личку «привет» → должен ответить ассистент из `preferred_agent`. Отправить `/assistants` → список с пометкой текущего → тап → «Теперь отвечает …» → следующее сообщение отвечает уже он.
