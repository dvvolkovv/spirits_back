# Ассистент знает баланс и предупреждает об исходе — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ассистент всегда знает баланс токенов пользователя, однократно предупреждает при падении ниже 10 000 со ссылкой на пополнение, а во фронте цифра баланса меняет цвет независимо от модели.

**Architecture:** Новый `BalanceContextService` в `spirits_back/src/tokens/` собирает текстовый блок для системного промпта (по образцу `TasksService.buildContextForPrompt`). Блок собирается один раз за ход в `ChatService.streamChat` сразу после существующего шлагбаума баланса и передаётся готовой строкой в три пути чата. Решение «пора предупредить» принимает сервер и пишет отметку в `profile_data.low_balance_warned`. Фронт получает независимый визуальный сигнал из общей константы порогов.

**Tech Stack:** NestJS 10 + TypeScript + PostgreSQL (бэк, тесты — jest); React 18 + TypeScript + Tailwind + i18next (фронт, тесты — vitest).

**Спека:** `docs/superpowers/specs/2026-08-15-assistant-balance-awareness-design.md`

**Репозитории:** задачи 1–7 — `~/Downloads/spirits_back`, задачи 8–10 — `~/Downloads/spirits_front`. Все команды запускать из корня соответствующего репозитория.

---

## Структура файлов

**Бэкенд (`~/Downloads/spirits_back`):**

| Файл | Ответственность |
|------|-----------------|
| `src/tokens/balance-context.service.ts` | *создать* — сборка блока промпта, правило выдачи разрешения, отметка в profile_data |
| `src/tokens/balance-context.spec.ts` | *создать* — юниты на правило разрешения и на прогноз |
| `src/tokens/consumption-rate.ts` | *создать* — чистая функция медианы расхода, без БД |
| `src/tokens/consumption-rate.spec.ts` | *создать* — юниты на медиану и порог статистики |
| `src/tokens/tokens.module.ts` | *изменить* — провайдер + экспорт нового сервиса |
| `src/chat/chat.module.ts` | *изменить* — импорт `TokensModule` |
| `src/chat/chat.service.ts` | *изменить* — сборка блока после шлагбаума, передача в оба пути |
| `src/chat/claude-agent.service.ts` | *изменить* — блок в `ctxBlock` Юли |
| `src/chat/chat-tools.ts` | *изменить* — единый хелпер отказа `insufficient_tokens` |
| `src/chat/balance-context-delivery.spec.ts` | *создать* — сторож: блок доезжает до промпта в обоих путях |

**Фронт (`~/Downloads/spirits_front`):**

| Файл | Ответственность |
|------|-----------------|
| `src/config/balanceThresholds.ts` | *создать* — пороги и `balanceLevel()`, единственный источник правды |
| `src/config/balanceThresholds.test.ts` | *создать* — юниты на границы |
| `src/components/chat/ChatInterface.tsx` | *изменить* — цвет кнопки баланса в шапке (строка ~2213) |
| `src/components/layout/Navigation.tsx` | *изменить* — цвет блока баланса (строка ~148) |
| `src/i18n/locales/*.json` | *изменить* — ключи подписи низкого баланса в 7 локалях |

---

## Task 1: Чистая функция расчёта расхода

Медиана, а не среднее: одно видео за 10 000 токенов перекосило бы прогноз человеку, который просто переписывается. Функция чистая — БД в неё не ходит, чтобы её можно было тестировать без моков.

**Files:**
- Create: `src/tokens/consumption-rate.ts`
- Test: `src/tokens/consumption-rate.spec.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `src/tokens/consumption-rate.spec.ts`:

```typescript
import { medianSpend, MIN_SAMPLES } from './consumption-rate';

describe('medianSpend', () => {
  it('меньше MIN_SAMPLES замеров — null, а не выдуманная цифра', () => {
    expect(medianSpend([100, 200, 300, 400])).toBeNull();
  });

  it('ровно MIN_SAMPLES замеров — уже считаем', () => {
    expect(medianSpend([100, 200, 300, 400, 500])).toBe(300);
  });

  it('нечётное число замеров — средний элемент', () => {
    expect(medianSpend([500, 100, 300, 200, 400])).toBe(300);
  });

  it('чётное число замеров — среднее двух средних', () => {
    expect(medianSpend([100, 200, 300, 400, 500, 600])).toBe(350);
  });

  it('одно дорогое видео не перекашивает прогноз переписки', () => {
    // Пять коротких сообщений и одно видео. Среднее было бы 1758,
    // медиана остаётся в масштабе реальной переписки.
    expect(medianSpend([300, 350, 400, 300, 500, 10000])).toBe(375);
  });

  it('нули и отрицательные отбрасываются, а не занижают медиану', () => {
    // В token_transactions расход лежит отрицательным числом в части строк:
    // знак нормализует вызывающий, сюда должны приходить величины.
    expect(medianSpend([0, -100, 300, 400, 500, 600, 700])).toBe(500);
  });

  it('пустой список — null', () => {
    expect(medianSpend([])).toBeNull();
  });
});

describe('MIN_SAMPLES', () => {
  it('равен пяти — ниже прогноз недостоверен', () => {
    expect(MIN_SAMPLES).toBe(5);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

```bash
cd ~/Downloads/spirits_back && npx jest src/tokens/consumption-rate.spec.ts
```

Ожидаемо: FAIL — `Cannot find module './consumption-rate'`.

- [ ] **Step 3: Написать минимальную реализацию**

Создать `src/tokens/consumption-rate.ts`:

```typescript
/**
 * Минимум замеров, ниже которого прогноз «хватит на N сообщений» недостоверен.
 *
 * Выдуманная цифра хуже её отсутствия: пользователь строит на ней решение,
 * а ассистент, назвавший «хватит на 20 сообщений» по двум замерам, ошибётся
 * в разы.
 */
export const MIN_SAMPLES = 5;

/**
 * Медиана расхода за ход. Медиана, а не среднее: у человека, который в
 * основном переписывается, одно сгенерированное видео за 10 000 токенов
 * перекосило бы среднее на порядок и превратило бы прогноз в бессмыслицу.
 *
 * Возвращает null, если замеров меньше MIN_SAMPLES.
 */
export function medianSpend(amounts: number[]): number | null {
  const values = (amounts || [])
    .map((a) => Math.abs(Number(a)))
    .filter((a) => Number.isFinite(a) && a > 0)
    .sort((a, b) => a - b);

  if (values.length < MIN_SAMPLES) return null;

  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[mid]
    : (values[mid - 1] + values[mid]) / 2;
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

```bash
cd ~/Downloads/spirits_back && npx jest src/tokens/consumption-rate.spec.ts
```

Ожидаемо: PASS, 8 тестов.

- [ ] **Step 5: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/tokens/consumption-rate.ts src/tokens/consumption-rate.spec.ts
git commit -m "feat(tokens): медиана расхода токенов для прогноза остатка"
```

---

## Task 2: Правило выдачи разрешения на предупреждение

Сердце задачи: решение «пора предупредить» принимает сервер, а не модель. Модель не держит счётчики между ходами — оставив решение ей, получим просьбу пополнить баланс в каждом ответе.

Функция чистая, состояние приходит аргументом. Так правило тестируется без БД и без подмены времени.

**Files:**
- Modify: `src/tokens/consumption-rate.ts` (дописать в конец)
- Test: `src/tokens/consumption-rate.spec.ts` (дописать в конец)

- [ ] **Step 1: Написать падающий тест**

Дописать в конец `src/tokens/consumption-rate.spec.ts`:

```typescript
import { shouldWarn, LOW_BALANCE_THRESHOLD, WARN_COOLDOWN_MS } from './consumption-rate';

describe('shouldWarn — сервер решает, пора ли предупреждать', () => {
  const now = new Date('2026-08-15T12:00:00Z').getTime();
  const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();

  it('баланс выше порога — не предупреждаем', () => {
    expect(shouldWarn({ balance: 12000, warned: null, now })).toBe(false);
  });

  it('баланс ниже порога, предупреждения не было — предупреждаем', () => {
    expect(shouldWarn({ balance: 8000, warned: null, now })).toBe(true);
  });

  it('ровно на пороге — ещё не предупреждаем', () => {
    expect(shouldWarn({ balance: LOW_BALANCE_THRESHOLD, warned: null, now })).toBe(false);
  });

  it('уже предупреждали час назад — молчим', () => {
    expect(shouldWarn({
      balance: 8000,
      warned: { at: hoursAgo(1), atBalance: 9000 },
      now,
    })).toBe(false);
  });

  it('прошли сутки — предупреждаем снова', () => {
    expect(shouldWarn({
      balance: 8000,
      warned: { at: hoursAgo(25), atBalance: 9000 },
      now,
    })).toBe(true);
  });

  it('баланс вырос относительно прошлого предупреждения — было пополнение, счётчик сброшен', () => {
    // Пользователь пополнил на 5 000, снова потратил до 8 000. Это новый цикл,
    // а не то же самое предупреждение: молчать сутки было бы неправильно.
    expect(shouldWarn({
      balance: 8000,
      warned: { at: hoursAgo(1), atBalance: 3000 },
      now,
    })).toBe(true);
  });

  it('приветственное сообщение — молчим даже при нулевом остатке', () => {
    // Первое, что слышит новый пользователь, не должно быть просьбой заплатить.
    expect(shouldWarn({ balance: 500, warned: null, now, isGreeting: true })).toBe(false);
  });

  it('битая отметка в profile_data не роняет правило и не блокирует предупреждение', () => {
    expect(shouldWarn({
      balance: 8000,
      warned: { at: 'не-дата', atBalance: 9000 } as any,
      now,
    })).toBe(true);
  });
});

describe('константы правила', () => {
  it('порог — 10 000 токенов', () => {
    expect(LOW_BALANCE_THRESHOLD).toBe(10000);
  });

  it('окно молчания — сутки', () => {
    expect(WARN_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

```bash
cd ~/Downloads/spirits_back && npx jest src/tokens/consumption-rate.spec.ts
```

Ожидаемо: FAIL — `shouldWarn is not a function`.

- [ ] **Step 3: Написать минимальную реализацию**

Дописать в конец `src/tokens/consumption-rate.ts`:

```typescript
/** Ниже этого остатка пользователя пора предупредить. */
export const LOW_BALANCE_THRESHOLD = 10000;

/** Сколько молчим после выданного предупреждения. */
export const WARN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Что лежит в profile_data.low_balance_warned. */
export interface WarnMark {
  at: string;
  atBalance: number;
}

/**
 * Пора ли разрешить ассистенту предупредить о низком балансе.
 *
 * Чистая функция: всё состояние приходит аргументами, поэтому правило
 * проверяется без БД и без подмены системного времени.
 */
export function shouldWarn(args: {
  balance: number;
  warned: WarnMark | null;
  now: number;
  isGreeting?: boolean;
}): boolean {
  const { balance, warned, now, isGreeting } = args;

  // На приветствии шлагбаум баланса тоже пропускается (chat.service.ts:394):
  // первое сообщение новому пользователю не должно быть просьбой заплатить.
  if (isGreeting) return false;
  if (balance >= LOW_BALANCE_THRESHOLD) return false;
  if (!warned) return true;

  // Битую отметку трактуем как отсутствующую: она не должна навсегда
  // заглушить предупреждения из-за одной кривой записи.
  const at = Date.parse(warned.at);
  if (!Number.isFinite(at)) return true;

  if (now - at >= WARN_COOLDOWN_MS) return true;

  // Баланс выше, чем на момент предупреждения — значит было пополнение,
  // и это новый цикл трат, а не продолжение старого.
  const atBalance = Number(warned.atBalance);
  if (Number.isFinite(atBalance) && balance > atBalance) return true;

  return false;
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

```bash
cd ~/Downloads/spirits_back && npx jest src/tokens/consumption-rate.spec.ts
```

Ожидаемо: PASS, 18 тестов.

- [ ] **Step 5: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/tokens/consumption-rate.ts src/tokens/consumption-rate.spec.ts
git commit -m "feat(tokens): правило однократного предупреждения о низком балансе"
```

---

## Task 3: BalanceContextService — сборка блока промпта

Сервис по образцу `TasksService.buildContextForPrompt` (`src/tasks/tasks.service.ts:162`): один публичный метод, возвращающий готовый текст для системного промпта или пустую строку.

**Files:**
- Create: `src/tokens/balance-context.service.ts`
- Test: `src/tokens/balance-context.spec.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `src/tokens/balance-context.spec.ts`. Фейковый pg — по образцу `src/chat/chat.language.spec.ts:28`: объект с одним методом `query`.

```typescript
import { BalanceContextService } from './balance-context.service';

/** Фейковый PgService: отдаёт заготовленные ответы и записывает все запросы. */
function fakePg(opts: {
  warned?: { at: string; atBalance: number } | null;
  spends?: number[];
} = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  return {
    calls,
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/low_balance_warned|profile_data/.test(sql) && /SELECT/i.test(sql)) {
        return { rows: [{ warned: opts.warned ?? null }] };
      }
      if (/token_transactions/.test(sql)) {
        return { rows: (opts.spends ?? []).map((a) => ({ amount: a })) };
      }
      return { rows: [] };
    },
  } as any;
}

const svc = (pg: any) => new BalanceContextService(pg);

describe('BalanceContextService — постоянная часть блока', () => {
  it('называет точную цифру баланса', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 43210);
    expect(block).toContain('43210');
  });

  it('запрещает заговаривать о балансе первым', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 43210);
    expect(block).toContain('Сам про баланс не заговаривай');
  });

  it('объясняет, что делать с отказом инструмента', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 43210);
    expect(block).toContain('insufficient_tokens');
    expect(block).toContain('https://my.linkeon.io/chat?view=tokens');
  });
});

describe('BalanceContextService — прогноз остатка', () => {
  it('баланс выше 30 000 — за медианой в базу не ходим', async () => {
    const pg = fakePg({ spends: [300, 300, 300, 300, 300] });
    await svc(pg).buildContextForPrompt('u1', 43210);
    expect(pg.calls.some((c: any) => /token_transactions/.test(c.sql))).toBe(false);
  });

  it('баланс ниже 30 000 и статистики хватает — пишем прогноз', async () => {
    const pg = fakePg({ spends: [300, 400, 400, 400, 500] });
    const block = await svc(pg).buildContextForPrompt('u1', 8000);
    // 8000 / 400 = 20 сообщений
    expect(block).toContain('20');
    expect(block).toContain('примерно');
  });

  it('статистики не хватает — прогноза нет, цифра остаётся', async () => {
    const block = await svc(fakePg({ spends: [300, 400] })).buildContextForPrompt('u1', 8000);
    expect(block).toContain('8000');
    expect(block).not.toContain('примерно');
  });
});

describe('BalanceContextService — разрешение предупредить', () => {
  it('баланс ниже порога, не предупреждали — разрешение выдано', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 8000);
    expect(block).toContain('Баланс на исходе');
    expect(block).toContain('Пополнить баланс');
  });

  it('баланс выше порога — разрешения нет', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 43210);
    expect(block).not.toContain('Баланс на исходе');
  });

  it('уже предупреждали час назад — разрешения нет', async () => {
    const at = new Date(Date.now() - 3600_000).toISOString();
    const pg = fakePg({ warned: { at, atBalance: 9000 } });
    const block = await svc(pg).buildContextForPrompt('u1', 8000);
    expect(block).not.toContain('Баланс на исходе');
  });

  it('приветствие — разрешения нет', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 500, { isGreeting: true });
    expect(block).not.toContain('Баланс на исходе');
  });

  it('выдав разрешение, ставит отметку в profile_data', async () => {
    const pg = fakePg();
    await svc(pg).buildContextForPrompt('u1', 8000);
    const write = pg.calls.find((c: any) => /UPDATE/i.test(c.sql) && /low_balance_warned/.test(c.sql));
    expect(write).toBeDefined();
  });

  it('не выдав разрешения, отметку не трогает', async () => {
    const pg = fakePg();
    await svc(pg).buildContextForPrompt('u1', 43210);
    const write = pg.calls.find((c: any) => /UPDATE/i.test(c.sql));
    expect(write).toBeUndefined();
  });
});

describe('BalanceContextService — устойчивость', () => {
  it('падение базы не роняет ход: блок пустой, исключения нет', async () => {
    const pg = { query: async () => { throw new Error('db down'); } } as any;
    await expect(svc(pg).buildContextForPrompt('u1', 8000)).resolves.toBe('');
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

```bash
cd ~/Downloads/spirits_back && npx jest src/tokens/balance-context.spec.ts
```

Ожидаемо: FAIL — `Cannot find module './balance-context.service'`.

- [ ] **Step 3: Написать минимальную реализацию**

Создать `src/tokens/balance-context.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import {
  medianSpend,
  shouldWarn,
  LOW_BALANCE_THRESHOLD,
  WarnMark,
} from './consumption-rate';

/** Выше этого остатка прогноз не нужен — и запрос за медианой не делаем. */
const FORECAST_BALANCE_CEILING = 30000;

/** За сколько дней смотрим расход для медианы. */
const FORECAST_WINDOW_DAYS = 14;

/**
 * Ссылка абсолютная, а не /chat?view=tokens: модель воспроизводит её текстом,
 * и относительный путь в ответе, уехавшем в мобильное приложение или в
 * пересланное сообщение, никуда не ведёт.
 */
export const TOP_UP_URL = 'https://my.linkeon.io/chat?view=tokens';

/**
 * Блок про баланс для системного промпта ассистента.
 *
 * Устроен как TasksService.buildContextForPrompt: единственный публичный
 * метод, готовая строка или пустая. Баланс приходит аргументом — шлагбаум в
 * ChatService.streamChat уже прочитал его парой строк выше, и второй SELECT
 * на каждый ход не нужен.
 *
 * Решение «пора предупредить» принимает этот сервис, а не модель: модель не
 * держит счётчики между ходами и напоминала бы про баланс в каждом ответе.
 */
@Injectable()
export class BalanceContextService {
  private readonly logger = new Logger(BalanceContextService.name);

  constructor(private readonly pg: PgService) {}

  async buildContextForPrompt(
    userId: string,
    balance: number,
    opts: { isGreeting?: boolean } = {},
  ): Promise<string> {
    try {
      const forecast = await this.forecastMessages(userId, balance);

      let block = `--- Баланс пользователя ---\n`;
      block += forecast == null
        ? `На счету ${balance} токенов.\n`
        : `На счету ${balance} токенов — примерно на ${forecast} сообщений при его обычном расходе.\n`;
      block +=
        `Сам про баланс не заговаривай. Если спросят, сколько осталось — назови эту цифру, ` +
        `не выдумывай и не округляй.\n` +
        `Если инструмент вернул ошибку insufficient_tokens — объясни спокойно, что на эту ` +
        `операцию не хватает токенов, назови, сколько нужно и сколько есть, и дай ссылку ` +
        `${TOP_UP_URL}. Не пробуй тот же инструмент повторно.\n`;

      if (await this.grantWarning(userId, balance, opts.isGreeting)) {
        block +=
          `Баланс на исходе, и пользователя об этом ещё не предупреждали. Один раз, в конце ` +
          `этого ответа, коротко и без давления скажи, что токены заканчиваются, и дай ссылку: ` +
          `[Пополнить баланс](${TOP_UP_URL}). Не выноси это в отдельное сообщение и не повторяй ` +
          `в следующих ответах.\n`;
      }

      return block;
    } catch (e: any) {
      // Блок про баланс — украшение хода, а не его условие: сломанный запрос
      // не должен стоить пользователю ответа ассистента.
      this.logger.warn(`не удалось собрать блок баланса для ${userId}: ${e?.message}`);
      return '';
    }
  }

  /** Сколько примерно сообщений осталось, или null если считать не на чем. */
  private async forecastMessages(userId: string, balance: number): Promise<number | null> {
    if (balance >= FORECAST_BALANCE_CEILING) return null;

    const res = await this.pg.query(
      `SELECT amount FROM token_transactions
        WHERE user_id = $1
          AND transaction_type = 'consumed'
          AND created_at > now() - ($2 || ' days')::interval
        ORDER BY created_at DESC
        LIMIT 200`,
      [userId, String(FORECAST_WINDOW_DAYS)],
    );

    const median = medianSpend(res.rows.map((r: any) => Number(r.amount)));
    if (median == null || median <= 0) return null;

    return Math.max(1, Math.floor(balance / median));
  }

  /**
   * Выдать разрешение предупредить и сразу поставить отметку.
   *
   * Отметка ставится по факту ВЫДАЧИ разрешения, а не по факту произнесённой
   * ассистентом фразы. Проверить второе можно было бы только регуляркой по
   * тексту ответа — ровно тот класс проверок, который уже ломался у нас после
   * перевода на семь языков. Если модель проигнорирует инструкцию, следующее
   * окно откроется через сутки; предупредить с опозданием лучше, чем дважды
   * подряд.
   */
  private async grantWarning(
    userId: string,
    balance: number,
    isGreeting?: boolean,
  ): Promise<boolean> {
    const res = await this.pg.query(
      `SELECT profile_data->'low_balance_warned' AS warned
         FROM ai_profiles_consolidated WHERE user_id = $1`,
      [userId],
    );
    const warned = (res.rows[0]?.warned ?? null) as WarnMark | null;

    if (!shouldWarn({ balance, warned, now: Date.now(), isGreeting })) return false;

    await this.pg.query(
      `UPDATE ai_profiles_consolidated
          SET profile_data = jsonb_set(
                coalesce(profile_data, '{}'::jsonb),
                '{low_balance_warned}',
                $2::jsonb,
                true
              )
        WHERE user_id = $1`,
      [userId, JSON.stringify({ at: new Date().toISOString(), atBalance: balance })],
    );
    return true;
  }
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

```bash
cd ~/Downloads/spirits_back && npx jest src/tokens/balance-context.spec.ts
```

Ожидаемо: PASS, 13 тестов.

- [ ] **Step 5: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/tokens/balance-context.service.ts src/tokens/balance-context.spec.ts
git commit -m "feat(tokens): сервис блока баланса для системного промпта"
```

---

## Task 4: Проводка модуля

Без этого шага сервис существует, но в `ChatService` его не внедрить: Nest не найдёт провайдера.

**Files:**
- Modify: `src/tokens/tokens.module.ts`
- Modify: `src/chat/chat.module.ts`

- [ ] **Step 1: Добавить провайдер в TokensModule**

Заменить содержимое `src/tokens/tokens.module.ts` целиком:

```typescript
import { Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { ProfileModule } from '../profile/profile.module';
import { CommonModule } from '../common/common.module';
import { BalanceContextService } from './balance-context.service';

@Module({
  imports: [ProfileModule, CommonModule],
  controllers: [TokensController],
  providers: [BalanceContextService],
  exports: [BalanceContextService],
})
export class TokensModule {}
```

- [ ] **Step 2: Импортировать TokensModule в ChatModule**

В `src/chat/chat.module.ts` добавить импорт строкой после `import { SpeechModule } from '../speech/speech.module';`:

```typescript
import { TokensModule } from '../tokens/tokens.module';
```

и добавить `TokensModule` в массив `imports`:

```typescript
  imports: [MiscModule, CommonModule, VideoModule, SmmModule, CalendarModule, TalerIdModule, SpeechModule, TokensModule],
```

- [ ] **Step 3: Проверить, что приложение собирается**

```bash
cd ~/Downloads/spirits_back && npx tsc --noEmit -p tsconfig.json
```

Ожидаемо: без ошибок.

Если `tsc` ругается на циклический импорт `ChatModule ↔ TokensModule` — проверить, что `TokensModule` не импортирует `ChatModule` ни напрямую, ни через `ProfileModule`. На момент написания плана не импортирует.

- [ ] **Step 4: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/tokens/tokens.module.ts src/chat/chat.module.ts
git commit -m "chore(tokens): провести BalanceContextService в ChatModule"
```

---

## Task 5: Сборка блока в streamChat и передача в оба пути

Блок собирается **один раз за ход** — так побочный эффект (отметка о предупреждении) случается ровно один раз, а тексты в путях не могут разойтись.

**Files:**
- Modify: `src/chat/chat.service.ts:252-264` (конструктор)
- Modify: `src/chat/chat.service.ts:393-412` (шлагбаум — вынести `balance` наружу, собрать блок)
- Modify: `src/chat/chat.service.ts:458-464` (передача в `streamUniversalAgent`)
- Modify: `src/chat/chat.service.ts:519-527` (путь Маши)
- Modify: `src/chat/chat.service.ts:723-741` (сигнатура `streamUniversalAgent`)
- Modify: `src/chat/chat.service.ts:895-907` (инжект в `contextPrefix`)

- [ ] **Step 1: Внедрить сервис в конструктор**

В `src/chat/chat.service.ts` добавить импорт рядом с остальными:

```typescript
import { BalanceContextService } from '../tokens/balance-context.service';
```

В конструкторе (строка 252) добавить параметр последним из обязательных — перед первым `@Optional()`:

```typescript
  constructor(
    private readonly pg: PgService,
    @Optional() private readonly neo4j: Neo4jService,
    @Optional() private readonly kling: KlingService,
    private readonly tools: ChatToolsService,
    private readonly smmProducerTools: SmmProducerToolsService,
    private readonly claudeAgent: ClaudeAgentService,
    private readonly claudeCli: ClaudeCliService,
    private readonly language: LanguageService,
    private readonly balanceCtx: BalanceContextService,
    @Optional() private readonly tasksService?: TasksService,
    @Optional() private readonly events?: EventsService,
    @Optional() private readonly talerIdOauth?: TalerIdOauthService,
  ) {}
```

- [ ] **Step 2: Вынести balance из шлагбаума и собрать блок**

Заменить блок в `src/chat/chat.service.ts:393-412` (начинается с `// Check token balance (skip for first greeting)`) на:

```typescript
    // Check token balance (skip for first greeting)
    const isGreetingMsg = recentHistory.length === 0 && /привет|расскажи про себя|hello|hi$/i.test(message.trim());
    // Баланс нужен и шлагбауму, и блоку промпта — читаем один раз.
    let balance = 0;
    {
      const balRes = await this.pg.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1', [userId]);
      balance = Number(balRes.rows[0]?.tokens || 0);
    }
    if (!isGreetingMsg) {
      if (balance <= 0) {
        res.status(200);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const noTokensMsg = '⚠️ **Недостаточно токенов**\n\nВаш баланс исчерпан. Пополните баланс, чтобы продолжить общение с ассистентами.\n\n👉 [Пополнить баланс](/chat?view=tokens)';
        res.write(JSON.stringify({ type: 'begin' }) + '\n');
        res.write(JSON.stringify({ type: 'item', content: noTokensMsg }) + '\n');
        res.write(JSON.stringify({ type: 'end', content: noTokensMsg, usage: { input: 0, output: 0, total: 0 } }) + '\n');
        res.end();
        return;
      }
    }

    // Блок про баланс собирается ОДИН раз за ход и передаётся готовой строкой
    // во все пути: побочный эффект (отметка о выданном предупреждении) должен
    // случиться однократно, а тексты в путях — не разойтись.
    const balanceBlock = await this.balanceCtx.buildContextForPrompt(userId, balance, {
      isGreeting: isGreetingMsg,
    });
```

- [ ] **Step 3: Прокинуть блок в путь Юли (SMM)**

В `src/chat/chat.service.ts` найти строку `const ctx = { userId, isAdmin };` (около 424) и заменить на:

```typescript
      const ctx = { userId, isAdmin, balanceBlock };
```

- [ ] **Step 4: Прокинуть блок в streamUniversalAgent**

В вызове (около строки 458) добавить `balanceBlock` последним аргументом:

```typescript
      return this.streamUniversalAgent(
        userId, message, String(assistantId), String(agent.id),
        recentHistory, profileText, res,
        agent.name, agent.description || '', agent.system_prompt || '',
        req, fresh, chatSessionId, requestLang, clientTz, balanceBlock,
      );
```

В сигнатуре `streamUniversalAgent` (строка 723) добавить параметр последним:

```typescript
    // Часовой пояс клиента (IANA) — см. streamChat.
    clientTz?: string,
    // Готовый блок про баланс (см. BalanceContextService). Собран в streamChat,
    // сюда приезжает строкой: пересобирать его здесь нельзя — отметка о
    // предупреждении встала бы дважды за ход.
    balanceBlock?: string,
  ): Promise<void> {
```

- [ ] **Step 5: Инжектить блок в contextPrefix**

В `src/chat/chat.service.ts` сразу после блока активных задач (около строки 907, перед `if (recentHistory.length > 0) {`) добавить:

```typescript
    if (balanceBlock) {
      contextPrefix += balanceBlock + '\n';
    }
```

- [ ] **Step 6: Инжектить блок в путь Маши**

В `src/chat/chat.service.ts` сразу после блока задач в пути Маши (около строки 527, перед комментарием `// Плоская строка для путей...`) добавить:

```typescript
    if (balanceBlock) {
      volatileSystemPrompt += `\n\n${balanceBlock}`;
    }
```

- [ ] **Step 7: Проверить сборку**

```bash
cd ~/Downloads/spirits_back && npx tsc --noEmit -p tsconfig.json
```

Ожидаемо: без ошибок. Если `tsc` ругается на `balanceBlock` в `ctx` внутри `claude-agent.service.ts` — это Task 6, временно можно оставить: `ctx` там типизирован структурно, лишнее поле не ломает вызов.

- [ ] **Step 8: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/chat/chat.service.ts
git commit -m "feat(chat): ассистент видит баланс пользователя в системном промпте"
```

---

## Task 6: Блок в промпте Юли (SMM)

**Files:**
- Modify: `src/smm/producer/smm-producer-tools.service.ts:18-23` (интерфейс `ToolContext`)
- Modify: `src/chat/claude-agent.service.ts:82`

- [ ] **Step 1: Расширить ToolContext**

`ctx` в `streamSmmProducer` типизирован интерфейсом `ToolContext`. Добавить в него поле в `src/smm/producer/smm-producer-tools.service.ts`:

```typescript
export interface ToolContext {
  userId: string;
  isAdmin: boolean;
  /** Most recent campaign id this user opened in the current chat session (optional). */
  recentCampaignId?: string;
  /**
   * Готовый блок про баланс из BalanceContextService. Собирается один раз за
   * ход в ChatService.streamChat вместе с отметкой о предупреждении — сюда
   * приезжает строкой, пересобирать нельзя.
   */
  balanceBlock?: string;
}
```

- [ ] **Step 2: Дописать блок в ctxBlock**

В `src/chat/claude-agent.service.ts` найти строку:

```typescript
    const ctxBlock = `Контекст юзера: isAdmin=${ctx.isAdmin}.`;
```

и заменить на:

```typescript
    const ctxBlock = [
      `Контекст юзера: isAdmin=${ctx.isAdmin}.`,
      ctx.balanceBlock || '',
    ].filter(Boolean).join('\n\n');
```

- [ ] **Step 3: Проверить сборку**

```bash
cd ~/Downloads/spirits_back && npx tsc --noEmit -p tsconfig.json
```

Ожидаемо: без ошибок. Здесь же исчезает предупреждение из Task 5 Step 7 про лишнее поле в `ctx`.

- [ ] **Step 4: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/smm/producer/smm-producer-tools.service.ts src/chat/claude-agent.service.ts
git commit -m "feat(chat): Юля тоже видит баланс пользователя"
```

---

## Task 7: Сторож доставки блока + внятный отказ инструмента

Две вещи, которые ломаются молча: блок перестал доезжать до промпта при рефакторинге `contextPrefix`, и седьмая точка отказа `insufficient_tokens` приехала без ссылки.

**Files:**
- Create: `src/chat/balance-context-delivery.spec.ts`
- Modify: `src/chat/chat-tools.ts` (шесть возвратов `insufficient_tokens`)

- [ ] **Step 1: Написать падающий тест на хелпер отказа**

Создать `src/chat/balance-context-delivery.spec.ts`:

```typescript
import { insufficientTokens } from './chat-tools';

describe('insufficientTokens — единый ответ на нехватку токенов', () => {
  it('несёт баланс, требуемое и нехватку', () => {
    const r = insufficientTokens(3000, 10000);
    expect(r).toMatchObject({
      ok: false,
      error: 'insufficient_tokens',
      balance: 3000,
      required: 10000,
      shortfall: 7000,
    });
  });

  it('несёт ссылку на пополнение — без неё ассистент импровизирует', () => {
    expect(insufficientTokens(3000, 10000).topUpUrl).toBe('https://my.linkeon.io/chat?view=tokens');
  });

  it('нехватка не уходит в минус при балансе больше требуемого', () => {
    expect(insufficientTokens(12000, 10000).shortfall).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

```bash
cd ~/Downloads/spirits_back && npx jest src/chat/balance-context-delivery.spec.ts
```

Ожидаемо: FAIL — `insufficientTokens is not a function`.

- [ ] **Step 3: Добавить хелпер и развести по шести точкам**

В `src/chat/chat-tools.ts` добавить в начало файла, после импортов:

```typescript
import { TOP_UP_URL } from '../tokens/balance-context.service';

/**
 * Единый ответ инструмента на нехватку токенов.
 *
 * Собран в одном месте намеренно: раньше шесть точек отказа собирали объект
 * руками, и седьмая приехала бы без ссылки на пополнение — ассистент в этот
 * момент импровизирует, потому что кроме кода ошибки у него ничего нет.
 */
export function insufficientTokens(balance: number, required: number) {
  return {
    ok: false as const,
    error: 'insufficient_tokens' as const,
    balance,
    required,
    shortfall: Math.max(0, required - balance),
    topUpUrl: TOP_UP_URL,
  };
}
```

Заменить все шесть возвратов. Найти их так:

```bash
cd ~/Downloads/spirits_back && grep -n "insufficient_tokens" src/chat/chat-tools.ts
```

Каждый вида

```typescript
return { ok: false, error: 'insufficient_tokens', balance: Number(bal.rows[0]?.tokens || 0), required: 10000 };
```

заменить на

```typescript
return insufficientTokens(Number(bal.rows[0]?.tokens || 0), 10000);
```

сохраняя `required` каждой точки как есть (5000 для std-картинки, 10000 для hd и апскейла). Возврат в `catch` по `InsufficientTokensError` (около строки 706):

```typescript
        return insufficientTokens(e.balance, e.required);
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

```bash
cd ~/Downloads/spirits_back && npx jest src/chat/balance-context-delivery.spec.ts
```

Ожидаемо: PASS, 3 теста.

- [ ] **Step 5: Дописать сторож доставки блока**

Дописать в конец `src/chat/balance-context-delivery.spec.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

/**
 * Сторож против самого вероятного способа сломать фичу: отрефакторить
 * contextPrefix и потерять вызов. Сервис при этом останется зелёным, а
 * ассистент молча перестанет видеть баланс.
 *
 * Проверяем исходник, а не поведение: поднять полный streamChat в юните
 * невозможно — он требует агента, БД и живой стрим.
 */
describe('доставка блока баланса в промпт', () => {
  const src = fs.readFileSync(
    path.join(__dirname, 'chat.service.ts'),
    'utf8',
  );

  it('блок собирается ровно один раз за ход', () => {
    const calls = src.match(/balanceCtx\.buildContextForPrompt/g) || [];
    expect(calls.length).toBe(1);
  });

  it('доезжает до contextPrefix (путь relay — все ассистенты)', () => {
    expect(src).toMatch(/contextPrefix \+= balanceBlock/);
  });

  it('доезжает до volatileSystemPrompt (локальный путь Маши)', () => {
    expect(src).toMatch(/volatileSystemPrompt \+= .*balanceBlock/);
  });

  it('передаётся в путь Юли через ctx', () => {
    expect(src).toMatch(/const ctx = \{ userId, isAdmin, balanceBlock \}/);
  });
});
```

- [ ] **Step 6: Запустить весь набор**

```bash
cd ~/Downloads/spirits_back && npx jest src/tokens src/chat/balance-context-delivery.spec.ts
```

Ожидаемо: PASS, 24 теста.

- [ ] **Step 7: Проверить, что ничего не сломалось**

```bash
cd ~/Downloads/spirits_back && npm test
```

Ожидаемо: весь набор зелёный. Если красное — чинить до перехода к фронту.

- [ ] **Step 8: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/chat/chat-tools.ts src/chat/balance-context-delivery.spec.ts
git commit -m "feat(chat): отказ по токенам несёт ссылку на пополнение + сторож доставки блока"
```

---

## Task 8: Пороги баланса во фронте

Одна константа на обе точки показа. Расхождение двух копий здесь уже случалось с прайсом — см. комментарий в шапке `src/config/tokenPackages.ts`.

**Files:**
- Create: `src/config/balanceThresholds.ts`
- Test: `src/config/balanceThresholds.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `src/config/balanceThresholds.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { balanceLevel, LOW_BALANCE, CRITICAL_BALANCE } from './balanceThresholds';

describe('balanceLevel', () => {
  it('большой баланс — ok', () => {
    expect(balanceLevel(50000)).toBe('ok');
  });

  it('ровно на пороге низкого — ещё ok', () => {
    expect(balanceLevel(LOW_BALANCE)).toBe('ok');
  });

  it('ниже порога низкого — low', () => {
    expect(balanceLevel(LOW_BALANCE - 1)).toBe('low');
  });

  it('ровно на критическом — ещё low', () => {
    expect(balanceLevel(CRITICAL_BALANCE)).toBe('low');
  });

  it('ниже критического — critical', () => {
    expect(balanceLevel(CRITICAL_BALANCE - 1)).toBe('critical');
  });

  it('ноль — critical', () => {
    expect(balanceLevel(0)).toBe('critical');
  });
});

describe('пороги', () => {
  it('низкий порог совпадает с бэкендовым LOW_BALANCE_THRESHOLD', () => {
    // Бэк предупреждает устами ассистента ниже 10 000 — цвет должен меняться
    // там же, иначе пользователь видит зелёную цифру и слышит «токены на исходе».
    expect(LOW_BALANCE).toBe(10000);
  });

  it('критический порог — 2 000', () => {
    expect(CRITICAL_BALANCE).toBe(2000);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

```bash
cd ~/Downloads/spirits_front && npx vitest run src/config/balanceThresholds.test.ts
```

Ожидаемо: FAIL — не найден модуль `./balanceThresholds`.

- [ ] **Step 3: Написать реализацию**

Создать `src/config/balanceThresholds.ts`:

```typescript
/**
 * Пороги остатка токенов — единственный источник правды для всех витрин.
 *
 * LOW_BALANCE обязан совпадать с LOW_BALANCE_THRESHOLD на бэкенде
 * (spirits_back/src/tokens/consumption-rate.ts): ассистент предупреждает
 * пользователя ровно ниже этой отметки, и зелёная цифра рядом с фразой
 * «токены на исходе» выглядела бы как ошибка одного из двух.
 */
export const LOW_BALANCE = 10000;
export const CRITICAL_BALANCE = 2000;

export type BalanceLevel = 'ok' | 'low' | 'critical';

export function balanceLevel(tokens: number): BalanceLevel {
  if (tokens < CRITICAL_BALANCE) return 'critical';
  if (tokens < LOW_BALANCE) return 'low';
  return 'ok';
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

```bash
cd ~/Downloads/spirits_front && npx vitest run src/config/balanceThresholds.test.ts
```

Ожидаемо: PASS, 8 тестов.

- [ ] **Step 5: Коммит**

```bash
cd ~/Downloads/spirits_front
git add src/config/balanceThresholds.ts src/config/balanceThresholds.test.ts
git commit -m "feat(tokens): пороги низкого баланса одной константой"
```

---

## Task 9: Ключи локалей для подписи низкого баланса

Русский — источник правды; остальные шесть заполняются скриптом перевода. Непереведённый ключ ловится `check-locales`.

**Files:**
- Modify: `src/i18n/locales/ru.json`
- Modify: `src/i18n/locales/{en,es,de,fr,zh,pt}.json`

- [ ] **Step 1: Добавить ключи в русскую локаль**

В `src/i18n/locales/ru.json` в секцию `chat` добавить:

```json
    "tokens_low_title": "Токены заканчиваются",
    "tokens_critical_title": "Токены почти закончились"
```

- [ ] **Step 2: Прогнать перевод на остальные шесть языков**

```bash
cd ~/Downloads/spirits_front && pnpm translate-locales
```

- [ ] **Step 3: Проверить паритет ключей**

```bash
cd ~/Downloads/spirits_front && pnpm check-locales
```

Ожидаемо: без ошибок — оба новых ключа присутствуют во всех семи локалях.

- [ ] **Step 4: Коммит**

```bash
cd ~/Downloads/spirits_front
git add src/i18n/locales
git commit -m "i18n(tokens): подписи низкого и критического баланса"
```

---

## Task 10: Цвет баланса в шапке чата и в навигации

**Files:**
- Modify: `src/components/chat/ChatInterface.tsx:2213-2224`
- Modify: `src/components/layout/Navigation.tsx:148-160`

- [ ] **Step 1: Раскрасить кнопку в шапке чата**

В `src/components/chat/ChatInterface.tsx` добавить импорт рядом с остальными:

```typescript
import { balanceLevel } from '../../config/balanceThresholds';
```

Заменить блок на строке 2213:

```tsx
            {user?.tokens !== undefined && (
              <button
                onClick={() => setShowTokenPackages(true)}
                className={clsx(
                  'flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border transition-all cursor-pointer',
                  balanceLevel(user.tokens) === 'critical'
                    ? 'bg-red-50 hover:bg-red-100 border-red-200 hover:border-red-300'
                    : balanceLevel(user.tokens) === 'low'
                      ? 'bg-amber-50 hover:bg-amber-100 border-amber-200 hover:border-amber-300'
                      : 'bg-forest-50 hover:bg-forest-100 border-forest-200 hover:border-forest-300',
                )}
                title={
                  balanceLevel(user.tokens) === 'critical'
                    ? t('chat.tokens_critical_title')
                    : balanceLevel(user.tokens) === 'low'
                      ? t('chat.tokens_low_title')
                      : t('chat.tokens_top_up_title')
                }
              >
                <Coins className={clsx(
                  'w-4 h-4',
                  balanceLevel(user.tokens) === 'critical'
                    ? 'text-red-600'
                    : balanceLevel(user.tokens) === 'low' ? 'text-amber-600' : 'text-forest-600',
                )} />
                <span className={clsx(
                  'text-sm font-semibold',
                  balanceLevel(user.tokens) === 'critical'
                    ? 'text-red-700'
                    : balanceLevel(user.tokens) === 'low' ? 'text-amber-700' : 'text-forest-700',
                )}>
                  {formatTokens(user.tokens)}
                </span>
              </button>
            )}
```

`clsx` в этом файле уже импортирован (используется на строке 2227) — второй импорт не добавлять.

- [ ] **Step 2: Раскрасить цифру в навигации**

В `src/components/layout/Navigation.tsx` добавить импорт:

```typescript
import { balanceLevel } from '../../config/balanceThresholds';
```

Заменить блок с цифрой (строка 160):

```tsx
              <div className={clsx(
                'text-2xl font-bold',
                balanceLevel(user.tokens) === 'critical'
                  ? 'text-red-700'
                  : balanceLevel(user.tokens) === 'low' ? 'text-amber-700' : 'text-forest-700',
              )}>
                {formatTokens(user.tokens)}
              </div>
```

Если `clsx` в `Navigation.tsx` не импортирован — добавить `import clsx from 'clsx';` рядом с остальными импортами.

- [ ] **Step 3: Проверить типы и линт**

```bash
cd ~/Downloads/spirits_front && pnpm typecheck && pnpm lint
```

Ожидаемо: без ошибок.

- [ ] **Step 4: Проверить, что ключи существуют**

```bash
cd ~/Downloads/spirits_front && pnpm check-keys
```

Ожидаемо: без ошибок — `chat.tokens_low_title` и `chat.tokens_critical_title` найдены в локалях.

- [ ] **Step 5: Прогнать весь набор тестов фронта**

```bash
cd ~/Downloads/spirits_front && pnpm test
```

Ожидаемо: весь набор зелёный.

- [ ] **Step 6: Коммит**

```bash
cd ~/Downloads/spirits_front
git add src/components/chat/ChatInterface.tsx src/components/layout/Navigation.tsx
git commit -m "feat(tokens): баланс желтеет ниже 10 000 и краснеет ниже 2 000"
```

---

## Проверка на живом стенде

Автотесты не докажут главного: что модель действительно послушалась инструкции и что предупреждение не превратилось в назойливое. Это проверяется руками.

- [ ] **Step 1: Выкатить на test**

```bash
TEST_ONLY=1 bash ~/Downloads/spirits_back/scripts/deploy.sh
```

Прод не трогается. **Не запускать полный `deploy.sh` без явного согласования с владельцем.**

- [ ] **Step 2: Подготовить тестовый аккаунт**

Войти под `70000000000` (OTP — через `GET /webhook/debug/sms-code/70000000000`), выставить баланс ниже порога:

```bash
ssh dv@85.192.61.231 "psql -p 5433 -d linkeon -c \"UPDATE ai_profiles_consolidated SET tokens = 8000, profile_data = profile_data - 'low_balance_warned' WHERE user_id = '70000000000'\""
```

- [ ] **Step 3: Проверить, что предупреждение приходит ровно один раз**

Написать ассистенту три сообщения подряд. Ожидаемо: предупреждение со ссылкой в первом ответе, в двух следующих — молчание.

- [ ] **Step 4: Проверить прямой вопрос**

Спросить «сколько у меня осталось токенов?». Ожидаемо: названа цифра 8000 (или близкая, с учётом списаний за предыдущие ходы), а не отказ и не выдумка.

- [ ] **Step 5: Проверить сброс после пополнения**

```bash
ssh dv@85.192.61.231 "psql -p 5433 -d linkeon -c \"UPDATE ai_profiles_consolidated SET tokens = 9500 WHERE user_id = '70000000000'\""
```

Написать ещё сообщение. Ожидаемо: предупреждение выдано снова — баланс вырос относительно `atBalance`, значит новый цикл.

- [ ] **Step 6: Проверить, что молчит на здоровом балансе**

```bash
ssh dv@85.192.61.231 "psql -p 5433 -d linkeon -c \"UPDATE ai_profiles_consolidated SET tokens = 500000 WHERE user_id = '70000000000'\""
```

Написать три сообщения. Ожидаемо: про баланс не сказано ни слова, цифра в шапке зелёная.

- [ ] **Step 7: Проверить второй язык**

Переключить интерфейс на английский, повторить шаги 2–3. Ожидаемо: предупреждение по-английски, ссылка кликабельна.

- [ ] **Step 8: Вернуть баланс тестового аккаунта**

```bash
ssh dv@85.192.61.231 "psql -p 5433 -d linkeon -c \"UPDATE ai_profiles_consolidated SET tokens = 50000, profile_data = profile_data - 'low_balance_warned' WHERE user_id = '70000000000'\""
```
