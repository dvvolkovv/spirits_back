# Алерт «стоимость растёт с каждым ответом» — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** если у человека (или в чате TG-бота) каждый следующий ответ дороже предыдущего — 5 подряд, последний ×1,2 к первому и не дешевле 8 000 токенов (пороги изменены владельцем 14.10 после прогона по истории; в коде задач ниже — первоначальные 3 и 1 000) — владелец получает алерт в Telegram.

**Architecture:** чистая функция правила `detectCostGrowth`; `CostGrowthService` хранит последние ходы пары в Redis (Lua: RPUSH + LTRIM + EXPIRE + LRANGE одним вызовом) и шлёт алерт через `sendTelegramAlert` с паузой `SET NX`; вызывается без ожидания рядом с алертом «Дорогой ход» в обоих путях списания веб-чата и после списания в TG-боте.

**Tech Stack:** NestJS 10, TypeScript, ioredis (`RedisService`), jest. Сборки и тесты — только на тестовой ноде.

**Спека:** `docs/superpowers/specs/2026-10-14-cost-growth-alert-design.md`.

---

## Где что запускать

- Мак — чтение, правка, git. Нода — `npm ci`, `jest`, `tsc`, `npm run build`: `bash ~/Downloads/land_linkeon/.superpowers/cost-growth/node-run-back.sh '<команда>'` (пушит ТЕКУЩИЙ коммит воркдерева `~/Downloads/spirits_back/.worktrees/cost-growth` в CI-клон ноды и запускает команду там после `npm ci`). Сначала коммит.
- `git add` — только явные пути; без `git add -A`, `reset --hard`, `stash`, `clean`. Репозиторий публичный: без номеров телефонов, секретов, цитат промптов.
- Бэк-гейт типов: `npx tsc -p tsconfig.build.json --noEmit` (jest типы не проверяет).

## Файлы

- Create: `src/cost-growth/cost-growth.rule.ts`, `src/cost-growth/cost-growth.rule.spec.ts` — правило и пороги.
- Create: `src/cost-growth/cost-growth.service.ts`, `src/cost-growth/cost-growth.service.spec.ts` — память в Redis, пауза, текст алерта.
- Modify: `src/chat/chat.service.ts` (конструктор + два вызова), `src/chat/chat.module.ts` (провайдер).
- Modify: `src/tg-bot/tg-bot.service.ts` (конструктор + вызов), `src/tg-bot/tg-bot.module.ts` (провайдер).
- Create: `src/chat/chat.cost-growth.spec.ts`; Modify: `src/tg-bot/tg-bot.quiet-unless-answering.spec.ts` (один тест), `src/chat/chat.module.chat-files.spec.ts` (сторож провайдера).
- Create (вне git): `~/Downloads/land_linkeon/.superpowers/cost-growth/replay.mjs` — прогон по истории.

---

### Task 1: Рабочая копия и прогон на ноде

Воркдерево уже есть: `~/Downloads/spirits_back/.worktrees/cost-growth`, ветка `feat/cost-growth-alert`.

- [ ] **Step 1: Скрипт ноды**

```bash
mkdir -p ~/Downloads/land_linkeon/.superpowers/cost-growth
sed -e 's#WT=~/Downloads/spirits_back/.worktrees/hd-langs#WT=~/Downloads/spirits_back/.worktrees/cost-growth#' \
    -e 's#NODE_WT=ci/wt/hd-langs-back#NODE_WT=ci/wt/cost-growth#' \
    -e 's#BRANCH=tmp/hd-langs-back#BRANCH=tmp/cost-growth#' \
    -e 's#/tmp/hd-langs-back-install.log#/tmp/cost-growth-install.log#' \
    -e 's#hd-langs/node-run-back.sh#cost-growth/node-run-back.sh#' \
    ~/Downloads/land_linkeon/.superpowers/hd-langs/node-run-back.sh > ~/Downloads/land_linkeon/.superpowers/cost-growth/node-run-back.sh
chmod +x ~/Downloads/land_linkeon/.superpowers/cost-growth/node-run-back.sh
grep -n "cost-growth" ~/Downloads/land_linkeon/.superpowers/cost-growth/node-run-back.sh
```

- [ ] **Step 2: Исходный прогон**

```bash
bash ~/Downloads/land_linkeon/.superpowers/cost-growth/node-run-back.sh 'npx jest src/chat src/tg-bot > /tmp/cg.log 2>&1; echo "jest $?"; grep -E "^Tests:|^Test Suites:" /tmp/cg.log; npx tsc -p tsconfig.build.json --noEmit; echo "tsc $?"'
```
Expected: `jest 0`, `tsc 0`; числа — в `~/Downloads/land_linkeon/.superpowers/cost-growth/progress.md` как база.

---

### Task 2: Правило

**Files:** Create `src/cost-growth/cost-growth.rule.ts`, `src/cost-growth/cost-growth.rule.spec.ts`.

- [ ] **Step 1: Красные тесты** — `src/cost-growth/cost-growth.rule.spec.ts`:

```ts
import { costGrowthConfig, detectCostGrowth, type TurnCost } from './cost-growth.rule';

const CFG = { turns: 5, factor: 3, minTokens: 1000 };
const turns = (...tokens: number[]): TurnCost[] => tokens.map((t) => ({ tokens: t, usd: t / 3600 }));

describe('правило «стоимость растёт с каждым ответом»', () => {
  it('пять ходов подряд дороже, последний ×3 и от 1 000 — срабатывает', () => {
    const run = detectCostGrowth(turns(420, 610, 980, 1650, 2900), CFG);
    expect(run?.map((t) => t.tokens)).toEqual([420, 610, 980, 1650, 2900]);
  });

  it('смотрит на последние пять: более ранние ходы не мешают', () => {
    expect(detectCostGrowth(turns(5000, 100, 420, 610, 980, 1650, 2900), CFG)).not.toBeNull();
  });

  it('провал посередине — тишина', () => {
    expect(detectCostGrowth(turns(420, 610, 500, 1650, 2900), CFG)).toBeNull();
  });

  it('равный соседу ход — не «дороже»', () => {
    expect(detectCostGrowth(turns(420, 610, 610, 1650, 2900), CFG)).toBeNull();
  });

  it('рост меньше ×3 — тишина (длинные ответы, но не разгон)', () => {
    expect(detectCostGrowth(turns(1000, 1200, 1500, 2000, 2900), CFG)).toBeNull();
  });

  it('последний дешевле 1 000 — тишина (дешёвая болтовня)', () => {
    expect(detectCostGrowth(turns(100, 150, 300, 600, 900), CFG)).toBeNull();
  });

  it('ходов меньше пяти — тишина', () => {
    expect(detectCostGrowth(turns(420, 980, 1650, 2900), CFG)).toBeNull();
  });

  it('жалоба 14.10: разгон стоимости сессии ловится на пятом ходе', () => {
    // Списывали total_cost_usd всей сессии: каждый ход — сумма предыдущих.
    const usd = [0.16, 0.33, 0.52, 0.74, 0.97];
    const history = usd.map((u) => ({ tokens: Math.ceil(u * 3600), usd: u }));
    expect(detectCostGrowth(history, CFG)).not.toBeNull();
  });
});

describe('пороги из окружения', () => {
  it('по умолчанию — 5 ходов, ×3, 1 000 токенов, пауза 24 часа', () => {
    expect(costGrowthConfig({})).toEqual({ turns: 5, factor: 3, minTokens: 1000, cooldownH: 24 });
  });

  it('берёт числа из .env', () => {
    expect(
      costGrowthConfig({ COST_GROWTH_TURNS: '7', COST_GROWTH_FACTOR: '5', COST_GROWTH_MIN_TOKENS: '2000', COST_GROWTH_COOLDOWN_H: '12' }),
    ).toEqual({ turns: 7, factor: 5, minTokens: 2000, cooldownH: 12 });
  });

  it('мусор и бессмысленные значения — по умолчанию', () => {
    expect(costGrowthConfig({ COST_GROWTH_TURNS: '1', COST_GROWTH_FACTOR: 'abc', COST_GROWTH_MIN_TOKENS: '-5', COST_GROWTH_COOLDOWN_H: '0' })).toEqual({
      turns: 5,
      factor: 3,
      minTokens: 1000,
      cooldownH: 24,
    });
  });
});
```

Commit `test(cost-growth): правило «стоимость растёт с каждым ответом» (красный)` (+ строка Co-Authored-By), прогон на ноде `npx jest src/cost-growth 2>&1 | tail -15` → FAIL (нет модуля).

- [ ] **Step 2: Реализация** — `src/cost-growth/cost-growth.rule.ts`:

```ts
/**
 * Правило «стоимость растёт с каждым ответом» (спека
 * docs/superpowers/specs/2026-10-14-cost-growth-alert-design.md).
 *
 * 14.10.2026: каждый следующий ответ длинной сессии стоил дороже предыдущего —
 * тарификация брала total_cost_usd всей сессии. Ни «Дорогой ход» (от 30 тыс.
 * за ход), ни «всплеск возвратов» этого не видели. Правило ловит и такую
 * поломку, и честно дорожающую длинную сессию: различить их помогают цифры
 * в алерте.
 */

/** Один ход пары: списано токенов, стоимость в $, расклад расчёта. */
export interface TurnCost {
  tokens: number;
  usd: number;
  note?: string;
  /** Время хода, мс от эпохи. */
  at?: number;
}

export interface CostGrowthConfig {
  /** Сколько последних ходов подряд должны дорожать. */
  turns: number;
  /** Во сколько раз последний из них дороже первого — минимум. */
  factor: number;
  /** Последний ход не дешевле — иначе это дешёвая болтовня. */
  minTokens: number;
}

/**
 * Серия, на которую сработало правило (последние `turns` ходов), или null.
 * История — от старого хода к новому; нулевые ходы в неё не попадают
 * (их не записывает CostGrowthService), поэтому первый ход серии > 0.
 */
export function detectCostGrowth(history: TurnCost[], cfg: CostGrowthConfig): TurnCost[] | null {
  if (history.length < cfg.turns) return null;
  const run = history.slice(-cfg.turns);
  for (let i = 1; i < run.length; i++) {
    if (!(run[i].tokens > run[i - 1].tokens)) return null;
  }
  const first = run[0].tokens;
  const last = run[run.length - 1].tokens;
  if (last < cfg.minTokens) return null;
  if (last < cfg.factor * first) return null;
  return run;
}

const num = (raw: string | undefined, fallback: number, ok: (n: number) => boolean): number => {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && ok(n) ? n : fallback;
};

/** Пороги из .env (COST_GROWTH_*); бессмысленные значения — по умолчанию. */
export function costGrowthConfig(env: Record<string, string | undefined> = process.env): CostGrowthConfig & { cooldownH: number } {
  return {
    turns: num(env.COST_GROWTH_TURNS, 5, (n) => Number.isInteger(n) && n >= 2),
    factor: num(env.COST_GROWTH_FACTOR, 3, (n) => n > 1),
    minTokens: num(env.COST_GROWTH_MIN_TOKENS, 1000, (n) => n > 0),
    cooldownH: num(env.COST_GROWTH_COOLDOWN_H, 24, (n) => n > 0),
  };
}
```

- [ ] **Step 3: Зелёный** — commit `feat(cost-growth): правило «стоимость растёт с каждым ответом»`; на ноде `npx jest src/cost-growth 2>&1 | tail -8` и `npx tsc -p tsconfig.build.json --noEmit; echo tsc $?` → PASS, `tsc 0`.

---

### Task 3: Сторож — память в Redis, пауза, алерт

**Files:** Create `src/cost-growth/cost-growth.service.ts`, `src/cost-growth/cost-growth.service.spec.ts`.

- [ ] **Step 1: Красные тесты** — `src/cost-growth/cost-growth.service.spec.ts`:

```ts
import { CostGrowthService, formatCostGrowthAlert, pairKey, type CostPair } from './cost-growth.service';
import { sendTelegramAlert } from '../common/telegram-alert';

jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));
const mockedAlert = sendTelegramAlert as jest.Mock;

/**
 * Поддельный Redis: eval повторяет смысл Lua-скрипта сервиса (RPUSH, LTRIM
 * до последних N, EXPIRE, LRANGE), setNx — SET NX. Сам Lua проверяется на
 * настоящем Redis тестового стенда (Task 6).
 */
function fakeRedis() {
  const lists = new Map<string, string[]>();
  const ttl = new Map<string, number>();
  const flags = new Map<string, string>();
  return {
    lists,
    ttl,
    flags,
    eval: jest.fn(async (_script: string, keys: string[], args: Array<string | number>) => {
      const [key] = keys;
      const [value, keep, ttlSec] = args;
      const list = [...(lists.get(key) ?? []), String(value)].slice(-Number(keep));
      lists.set(key, list);
      ttl.set(key, Number(ttlSec));
      return list;
    }),
    setNx: jest.fn(async (key: string, value: string, _ms: number) => {
      if (flags.has(key)) return false;
      flags.set(key, value);
      return true;
    }),
  };
}

const CHAT: CostPair = { kind: 'chat', userId: 'u1', assistantId: '14' };
const TG: CostPair = { kind: 'tg', configId: 'cfg-1', chatId: '-100123', payerUserId: 'u-owner', botName: 'Финансист' };
const GROWING = [420, 610, 980, 1650, 2900];

async function feed(svc: CostGrowthService, pair: CostPair, tokens: number[], balance?: number) {
  for (const t of tokens) {
    await svc.recordTurn(pair, { tokens: t, usd: t / 3600, note: `implied=$${(t / 3600).toFixed(4)}` }, balance === undefined ? undefined : { balance: async () => balance });
  }
}

describe('CostGrowthService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('пятый растущий ход будит, один алерт', async () => {
    const redis = fakeRedis();
    const svc = new CostGrowthService(redis as any);
    await feed(svc, CHAT, GROWING, 41_300);
    expect(mockedAlert).toHaveBeenCalledTimes(1);
    const text = String(mockedAlert.mock.calls[0][0]);
    expect(text).toContain('Стоимость растёт с каждым ответом');
    expect(text).toContain('<code>u1</code>');
    expect(text).toContain('ассистент 14');
    expect(text).toContain('×6,9');
    expect(text).toContain('Остаток:');
  });

  it('пауза: продолжение роста в те же сутки не будит второй раз', async () => {
    const redis = fakeRedis();
    const svc = new CostGrowthService(redis as any);
    await feed(svc, CHAT, [...GROWING, 4000, 6000]);
    expect(mockedAlert).toHaveBeenCalledTimes(1);
  });

  it('пары не мешают друг другу: свой счёт у каждого ассистента', async () => {
    const redis = fakeRedis();
    const svc = new CostGrowthService(redis as any);
    const other: CostPair = { kind: 'chat', userId: 'u1', assistantId: '7' };
    for (let i = 0; i < GROWING.length; i++) {
      await feed(svc, CHAT, [GROWING[i]]);
      await feed(svc, other, [3000 - i * 100]);
    }
    expect(mockedAlert).toHaveBeenCalledTimes(1);
    expect(String(mockedAlert.mock.calls[0][0])).toContain('ассистент 14');
  });

  it('история — последние 10 ходов, хранится сутки', async () => {
    const redis = fakeRedis();
    const svc = new CostGrowthService(redis as any);
    await feed(svc, CHAT, [5, 4, 3, 2, 1, 5, 4, 3, 2, 1, 5, 4]);
    const key = `cost-growth:turns:${pairKey(CHAT)}`;
    expect(redis.lists.get(key)).toHaveLength(10);
    expect(redis.ttl.get(key)).toBe(24 * 3600);
  });

  it('нулевой ход не записывается и серию не рвёт', async () => {
    const redis = fakeRedis();
    const svc = new CostGrowthService(redis as any);
    await feed(svc, CHAT, [420, 610, 0, 980, 1650, 0, 2900]);
    expect(redis.lists.get(`cost-growth:turns:${pairKey(CHAT)}`)).toHaveLength(5);
    expect(mockedAlert).toHaveBeenCalledTimes(1);
  });

  it('TG-пара: ключ по боту и чату, в алерте — кто платит', async () => {
    const redis = fakeRedis();
    const svc = new CostGrowthService(redis as any);
    await feed(svc, TG, GROWING);
    expect(pairKey(TG)).toBe('tg:cfg-1:-100123');
    const text = String(mockedAlert.mock.calls[0][0]);
    expect(text).toContain('TG-бот');
    expect(text).toContain('«Финансист»');
    expect(text).toContain('платит <code>u-owner</code>');
  });

  it('сбой Redis не бросает и не будит', async () => {
    const redis = { eval: jest.fn(async () => { throw new Error('Connection is closed'); }), setNx: jest.fn() };
    const svc = new CostGrowthService(redis as any);
    (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    await expect(svc.recordTurn(CHAT, { tokens: 500, usd: 0.14 })).resolves.toBeUndefined();
    expect(mockedAlert).not.toHaveBeenCalled();
    expect((svc as any).logger.warn).toHaveBeenCalled();
  });

  it('сбой отправки алерта не бросает', async () => {
    mockedAlert.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const svc = new CostGrowthService(fakeRedis() as any);
    (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    await expect(feed(svc, CHAT, GROWING)).resolves.toBeUndefined();
  });
});

describe('текст алерта', () => {
  it('цепочка токенов и долларов, множитель, расклад последнего хода; HTML экранирован', () => {
    const run = GROWING.map((t) => ({ tokens: t, usd: t / 3600, note: 'reported=$6.21 <x>' }));
    const text = formatCostGrowthAlert({ kind: 'tg', configId: 'c', chatId: '1', payerUserId: 'o', botName: 'A<b>' }, run, 41300);
    expect(text).toContain('📈 <b>Стоимость растёт с каждым ответом</b>');
    expect(text).toContain('420 → 610 → 980 → 1');
    expect(text).toContain('$0.12 → $0.17 → $0.27 → $0.46 → $0.81');
    expect(text).toContain('×6,9');
    expect(text).toContain('A&lt;b&gt;');
    expect(text).toContain('reported=$6.21 &lt;x&gt;');
  });

  it('без остатка — строки «Остаток» нет', () => {
    const run = GROWING.map((t) => ({ tokens: t, usd: t / 3600 }));
    expect(formatCostGrowthAlert(CHAT, run)).not.toContain('Остаток');
  });
});
```

Commit `test(cost-growth): сторож — память в Redis, пауза, алерт (красный)`, прогон на ноде → FAIL (нет модуля).

- [ ] **Step 2: Реализация** — `src/cost-growth/cost-growth.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/services/redis.service';
import { sendTelegramAlert } from '../common/telegram-alert';
import { costGrowthConfig, detectCostGrowth, type TurnCost } from './cost-growth.rule';

/** Чей это разговор: веб-чат — человек и ассистент; TG-бот — бот и чат, платит владелец бота. */
export type CostPair =
  | { kind: 'chat'; userId: string; assistantId: string }
  | { kind: 'tg'; configId: string; chatId: string; payerUserId: string; botName?: string };

export const pairKey = (p: CostPair): string =>
  p.kind === 'chat' ? `chat:${p.userId}:${p.assistantId}` : `tg:${p.configId}:${p.chatId}`;

/** Сколько последних ходов пары хранить и сколько (сек) — с последнего хода. */
const KEEP_TURNS = 10;
const HISTORY_TTL_S = 24 * 3600;

/**
 * Дописать ход и вернуть историю — одним атомарным вызовом: между RPUSH и
 * LRANGE не вклинится ход того же разговора из соседней вкладки.
 */
const PUSH_SCRIPT = `
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return redis.call('LRANGE', KEYS[1], 0, -1)
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n: number) => Math.round(n).toLocaleString('ru');

/** Текст алерта: кто, цепочка ходов в токенах и $, во сколько раз вырос, остаток, расклад последнего хода. */
export function formatCostGrowthAlert(pair: CostPair, run: TurnCost[], balance?: number): string {
  const first = run[0];
  const last = run[run.length - 1];
  const who =
    pair.kind === 'chat'
      ? `Юзер: <code>${esc(pair.userId)}</code>, ассистент ${esc(pair.assistantId)}`
      : `TG-бот <code>${esc(pair.configId)}</code>${pair.botName ? ` («${esc(pair.botName)}»)` : ''}, ` +
        `чат <code>${esc(pair.chatId)}</code>, платит <code>${esc(pair.payerUserId)}</code>`;
  const factor = (last.tokens / first.tokens).toFixed(1).replace('.', ',');
  return (
    `📈 <b>Стоимость растёт с каждым ответом</b>\n` +
    `${who}\n` +
    `Ходы: ${run.map((t) => fmt(t.tokens)).join(' → ')} токенов ` +
    `(${run.map((t) => `$${t.usd.toFixed(2)}`).join(' → ')}), ×${factor}\n` +
    (balance !== undefined && balance >= 0 ? `Остаток: ${fmt(balance)}\n` : '') +
    (last.note ? `Последний ход: <code>${esc(last.note)}</code>` : '')
  ).trimEnd();
}

/**
 * Сторож «стоимость растёт с каждым ответом» (спека
 * docs/superpowers/specs/2026-10-14-cost-growth-alert-design.md).
 *
 * Зовётся без ожидания сразу после списания хода; никогда не бросает:
 * недоступный Redis или Telegram — предупреждение в лог, ход идёт как шёл.
 */
@Injectable()
export class CostGrowthService {
  private readonly logger = new Logger(CostGrowthService.name);

  constructor(private readonly redis: RedisService) {}

  async recordTurn(pair: CostPair, turn: TurnCost, ctx?: { balance?: () => Promise<number> }): Promise<void> {
    if (!(turn.tokens > 0)) return;
    try {
      const cfg = costGrowthConfig();
      const key = pairKey(pair);
      const raw = (await this.redis.eval(PUSH_SCRIPT, [`cost-growth:turns:${key}`], [
        JSON.stringify({ tokens: turn.tokens, usd: turn.usd, note: turn.note, at: turn.at ?? Date.now() }),
        KEEP_TURNS,
        HISTORY_TTL_S,
      ])) as string[];
      const history: TurnCost[] = raw.map((s) => JSON.parse(s));
      const run = detectCostGrowth(history, cfg);
      if (!run) return;
      const first = await this.redis.setNx(`cost-growth:alerted:${key}`, String(Date.now()), cfg.cooldownH * 3600_000);
      if (!first) return;
      const balance = ctx?.balance ? await ctx.balance().catch(() => -1) : undefined;
      await sendTelegramAlert(formatCostGrowthAlert(pair, run, balance));
    } catch (e: any) {
      this.logger.warn(`cost-growth: ход не учтён (${pairKey(pair)}): ${e?.message ?? e}`);
    }
  }
}
```

- [ ] **Step 3: Зелёный** — commit `feat(cost-growth): сторож роста стоимости — память в Redis, пауза, алерт в Telegram`; на ноде `npx jest src/cost-growth 2>&1 | tail -8`, `npx tsc -p tsconfig.build.json --noEmit; echo tsc $?` → PASS, `tsc 0`.

---

### Task 4: Подключение — веб-чат и TG-бот

**Files:** Modify `src/chat/chat.service.ts`, `src/chat/chat.module.ts`, `src/tg-bot/tg-bot.service.ts`, `src/tg-bot/tg-bot.module.ts`, `src/tg-bot/tg-bot.quiet-unless-answering.spec.ts`, `src/chat/chat.module.chat-files.spec.ts`; Create `src/chat/chat.cost-growth.spec.ts`.

- [ ] **Step 1: Красные тесты**

`src/chat/chat.cost-growth.spec.ts` (обвязка — как в `chat.expensive-turn-alert.spec.ts` и `chat.upload-billing.spec.ts`):

```ts
import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { SEAT_TOKENS_PER_USD } from '../common/billing-rates';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 41300 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any,
    null as any, language as any, undefined, undefined, undefined, undefined,
  );
  const costGrowth = { recordTurn: jest.fn(async () => {}) };
  (svc as any).costGrowth = costGrowth;
  return { svc, costGrowth };
}

describe('сторож роста стоимости в веб-чате', () => {
  afterEach(() => jest.clearAllMocks());

  it('обычный ход: пара «пользователь + ассистент», списанные токены и $', async () => {
    const { svc, costGrowth } = makeService();
    (axios.post as jest.Mock).mockResolvedValue({ data: sseStream([{ type: 'delta', text: 'ответ' }, { type: 'done', costUsd: 0.5 }]) });
    const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
    await (svc as any).streamUniversalAgent('u1', 'привет', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined);
    await new Promise((r) => setImmediate(r));
    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
    const [pair, turn, ctx] = costGrowth.recordTurn.mock.calls[0] as any[];
    expect(pair).toEqual({ kind: 'chat', userId: 'u1', assistantId: '7' });
    expect(turn.tokens).toBe(Math.ceil(0.5 * SEAT_TOKENS_PER_USD));
    expect(turn.usd).toBeCloseTo(0.5, 4);
    expect(typeof turn.note).toBe('string');
    expect(await ctx.balance()).toBe(41300);
  });

  it('ход с файлами: та же пара и списанное', async () => {
    const { svc, costGrowth } = makeService();
    await svc.persistUploadTurn({
      userId: 'u1', assistantId: '12', userMsg: '📎 scan.jpg\nпереведи', assistantMsg: 'перевод готов',
      usage: null as any, costUsd: 0.5, durationMs: 1000,
    } as any);
    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
    const [pair, turn] = costGrowth.recordTurn.mock.calls[0] as any[];
    expect(pair).toEqual({ kind: 'chat', userId: 'u1', assistantId: '12' });
    expect(turn.tokens).toBeGreaterThan(0);
  });
});
```

Проверить по `chat.upload-billing.spec.ts`, какие поля `persistUploadTurn` обязательны (и какой `usage` там передают для «$0.50»), и привести вызов к ним — без `as any` там, где тип известен. Если обычный ход в обвязке не доходит до списания (другая сигнатура `streamUniversalAgent`) — взять её точно из `chat.expensive-turn-alert.spec.ts`.

В `src/chat/chat.module.chat-files.spec.ts` — сторож провайдера:

```ts
import { CostGrowthService } from '../cost-growth/cost-growth.service';
import { TgBotModule } from '../tg-bot/tg-bot.module';

it('сторож роста стоимости зарегистрирован в ChatModule и TgBotModule', () => {
  expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChatModule)).toContain(CostGrowthService);
  expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TgBotModule)).toContain(CostGrowthService);
});
```

В `src/tg-bot/tg-bot.quiet-unless-answering.spec.ts` — внутри того же `describe`, где объявлены `makeTurnBot`, `CFG`, `groupMsg`, после последнего `it`:

```ts
  it('сторож роста стоимости: ход TG-бота — пара «бот + чат», списанное и кто платит', async () => {
    const { svc } = makeTurnBot({ transcript: 'Финансист, сколько у нас осталось?' });
    const costGrowth = { recordTurn: jest.fn(async () => {}) };
    (svc as any).costGrowth = costGrowth;
    await (svc as any).handleChatMessage(groupMsg({ voice: true }), CFG);
    await flush();
    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
    const [pair, turn, ctx] = costGrowth.recordTurn.mock.calls[0] as any[];
    expect(pair).toEqual({ kind: 'tg', configId: 'cfg-quiet', chatId: '-100123', payerUserId: 'u-owner', botName: 'Финансист' });
    expect(turn.tokens).toBe(36);
    expect(turn.usd).toBeCloseTo(0.01, 4);
    expect(turn.note).toContain('cost=$');
    expect(await ctx.balance()).toBe(99964);
  });
```

Commit `test(cost-growth): сторож подключён в веб-чат (оба пути) и TG-бот (красный)`, прогон на ноде `npx jest src/chat/chat.cost-growth.spec.ts src/chat/chat.module.chat-files.spec.ts src/tg-bot/tg-bot.quiet-unless-answering.spec.ts 2>&1 | tail -30` → FAIL: `recordTurn` не вызывается, провайдера нет.

- [ ] **Step 2: Реализация**

`src/chat/chat.service.ts`:
- импорт: `import { CostGrowthService } from '../cost-growth/cost-growth.service';`
- в конструктор ПОСЛЕДНИМ параметром (после `chatFiles`; спеки собирают сервис позиционно):

```ts
    // Сторож «стоимость растёт с каждым ответом». Последним и @Optional по
    // той же причине, что chatFiles; что он подключён, сторожит
    // chat.module.chat-files.spec.ts.
    @Optional() private readonly costGrowth?: CostGrowthService,
```

- в обычном ходе — сразу после `await this.alertExpensiveTurn(userId, assistantId, charge, textCost);`:

```ts
      // Сторож роста стоимости: ход за ходом дороже — алерт. Не ждём:
      // ответ и списание от него не зависят. Невыставленный ход (0) не пишется.
      void this.costGrowth?.recordTurn(
        { kind: 'chat', userId, assistantId },
        { tokens: textCost, usd: turnFailed ? 0 : charge.usd, note: charge.note },
        { balance: () => this.getTokenBalance(userId) },
      );
```

- в `persistUploadTurn` — сразу после `await this.alertExpensiveTurn(p.userId, p.assistantId, charge, textCost);`:

```ts
    void this.costGrowth?.recordTurn(
      { kind: 'chat', userId: p.userId, assistantId: p.assistantId },
      { tokens: textCost, usd: turnFailed ? 0 : charge.usd, note: charge.note },
      { balance: () => this.getTokenBalance(p.userId) },
    );
```

(Имена `charge`, `textCost`, `turnFailed` — те, что стоят рядом с вызовом `alertExpensiveTurn` в каждом пути; проверить, что `charge.usd` есть у результата `computeSdkCharge`.)

`src/chat/chat.module.ts`: `import { CostGrowthService } from '../cost-growth/cost-growth.service';`, в `providers` добавить `CostGrowthService`.

`src/tg-bot/tg-bot.service.ts`:
- импорт `CostGrowthService`, `Optional` из `@nestjs/common` (если ещё не импортирован);
- в конструктор ПОСЛЕДНИМ параметром (после `blogApproval`):

```ts
    // Сторож «стоимость растёт с каждым ответом» — последним и @Optional:
    // спеки собирают сервис позиционно.
    @Optional() private readonly costGrowth?: CostGrowthService,
```

- сразу после `await this.billing.alertIfExpensiveTurn(cfg, totalCostUsd, tokensCharged, newBalance);`:

```ts
      // Сторож роста стоимости: ход TG-бота дороже предыдущего пять раз подряд —
      // алерт. Ход списывается по costUsd от релея — ровно там жила поломка
      // 14.10 (стоимость всей сессии за каждый ход).
      void this.costGrowth?.recordTurn(
        { kind: 'tg', configId: String(cfg.id), chatId: String(msg.chat.id), payerUserId: cfg.owner_user_id, botName: cfg.display_name || undefined },
        { tokens: tokensCharged, usd: totalCostUsd, note: `cost=$${reply.costUsd.toFixed(4)} tts=$${voiceTtsCostUsd.toFixed(4)}` },
        { balance: async () => newBalance },
      );
```

`src/tg-bot/tg-bot.module.ts`: импорт и `CostGrowthService` в `providers`.

- [ ] **Step 3: Зелёный** — commit `feat(cost-growth): сторож роста стоимости — веб-чат (обычный ход и с файлами) и TG-бот`; на ноде:

```bash
bash ~/Downloads/land_linkeon/.superpowers/cost-growth/node-run-back.sh 'npx jest src/cost-growth src/chat src/tg-bot > /tmp/cg.log 2>&1; echo "jest $?"; grep -E "^Tests:|^Test Suites:" /tmp/cg.log; grep -E "✕|FAIL " /tmp/cg.log | head; npx tsc -p tsconfig.build.json --noEmit; echo "tsc $?"; npm run build > /tmp/cg-build.log 2>&1; echo "build $?"; ls dist/cost-growth/'
```
Expected: `jest 0` (база Task 1 + новые), `tsc 0`, `build 0`, в `dist/cost-growth/` — `cost-growth.rule.js`, `cost-growth.service.js`.

Затем весь jest (дельтой к main): `npx jest > /tmp/cg-all.log 2>&1; grep -E "^Tests:|^Test Suites:" /tmp/cg-all.log; grep -E "^FAIL " /tmp/cg-all.log | sort -u` — красными могут быть только `tests/api.test.js`, `tests/e2e.test.js`, `tests/db.test.js`, `tests/calendar-smoke.test.js` («must contain at least one test» — так и на main).

---

### Task 5: Прогон правила по истории (только чтение, с OK владельца)

**Files:** Create (вне git) `~/Downloads/land_linkeon/.superpowers/cost-growth/replay.mjs`.

Нужен доступ к базе прода; пока маршрут нода → прод оборван — обход через релей (с OK владельца, ключ снять сразу после; рецепт — заметка памяти «Прод недоступен — обход через релей»). Ничего не пишет; вывод — только в консоль, в git не попадает.

- [ ] **Step 1: Скрипт**

```js
// Прогон правила «стоимость растёт с каждым ответом» по ходам веб-чата за 30 дней.
// Запуск на ПРОДЕ из ~/spirits_back (после выката Task 6 — или с dist из CI-клона):
//   DATABASE_URL=… node replay.mjs <путь к dist/cost-growth/cost-growth.rule.js>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = require(process.cwd() + '/node_modules/pg');
const { detectCostGrowth, costGrowthConfig } = require(process.argv[2]);

const cfg = costGrowthConfig({});
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const { rows } = await db.query(`
  SELECT user_id, agent_id, completed_at, tokens_to_consume::bigint AS tokens,
         COALESCE((metadata->>'costUsd')::numeric, 0) AS usd
    FROM token_consumption_tasks
   WHERE status = 'completed' AND completed_at > now() - interval '30 days'
     AND tokens_to_consume > 0 AND agent_id IS NOT NULL
   ORDER BY user_id, agent_id, completed_at`);
await db.end();

const DAY = 24 * 3600_000;
const hits = [];
let key = null, history = [], cooldownUntil = 0, lastAt = 0;
for (const r of rows) {
  const k = `${r.user_id}:${r.agent_id}`;
  const at = new Date(r.completed_at).getTime();
  if (k !== key || at - lastAt > DAY) { key = k; history = []; cooldownUntil = 0; }
  lastAt = at;
  history = [...history, { tokens: Number(r.tokens), usd: Number(r.usd) }].slice(-10);
  const run = detectCostGrowth(history, cfg);
  if (run && at >= cooldownUntil) {
    hits.push({ key: k, at: new Date(at).toISOString(), tokens: run.map((t) => t.tokens), usd: run.map((t) => t.usd.toFixed(2)) });
    cooldownUntil = at + cfg.cooldownH * 3600_000;
  }
}
const byDay = {};
for (const h of hits) byDay[h.at.slice(0, 10)] = (byDay[h.at.slice(0, 10)] ?? 0) + 1;
console.log(`ходов: ${rows.length}, алертов за 30 дней: ${hits.length}, пар: ${new Set(hits.map((h) => h.key)).size}`);
console.log('по дням:', JSON.stringify(byDay));
for (const h of hits.slice(-15)) console.log(h.at, h.key.replace(/^(\d{4})\d+(\d{2})/, '$1…$2'), h.tokens.join('→'), '$' + h.usd.join('→$'));
```

- [ ] **Step 2: Запуск** — скопировать `replay.mjs` и `dist/cost-growth/cost-growth.rule.js` из CI-клона ноды на прод во `/tmp`, запустить в `~/spirits_back` с `DATABASE_URL` из `.env` прода (через `dotenv.parse`, в вывод не печатать), удалить оба файла из `/tmp` после.

- [ ] **Step 3: Вывод владельцу** — число алертов за месяц и по дням; поймана ли жалоба 14.10 (серии с `usd`, растущими от ~$0.16 до единиц $ в тот день). Если алертов больше ~2 в день — предложить пороги строже (`COST_GROWTH_FACTOR`, `COST_GROWTH_MIN_TOKENS`) и решить с владельцем до выката. Итог — в `progress.md` (без номеров пользователей).

---

### Task 6: Слияние и выкат (OK владельца)

- [ ] **Step 1: Слияние** — `git fetch`, `git rebase origin/main` в воркдереве, на ноде `npx jest src/cost-growth src/chat src/tg-bot` + `tsc` + `npm run build` → 0; `git push origin HEAD:main` (fast-forward).
- [ ] **Step 2: Выкат** — с OK владельца: `BACK_ONLY=1 deploy.sh` со свежего клона на ноде (в клон — `scripts/test-server.env.local`, ссылка `tests/node_modules`), отвязанно; при оборванном маршруте — `PROD_HOST=linkeon-prod-via-relay` (обход — тоже с OK, снять сразу после).
- [ ] **Step 3: Проверка на тестовом стенде** — на ноде в `~/spirits_back` (живой чекаут test — только ЧТЕНИЕ кода, запуск отдельного процесса node, ничего не менять):

```bash
cd ~/spirits_back && source ~/.nvm/nvm.sh && node -e '
require("dotenv").config();
const { RedisService } = require("./dist/common/services/redis.service");
const { CostGrowthService } = require("./dist/cost-growth/cost-growth.service");
(async () => {
  const redis = new RedisService(); redis.onModuleInit();
  const svc = new CostGrowthService(redis);
  const pair = { kind: "chat", userId: "cost-growth-selftest", assistantId: "0" };
  for (const t of [420, 610, 980, 1650, 2900, 4000]) await svc.recordTurn(pair, { tokens: t, usd: t / 3600, note: "самопроверка выката" });
  console.log("history", (await redis.lrange("cost-growth:turns:chat:cost-growth-selftest:0", 0, -1)).length);
  await redis.del("cost-growth:turns:chat:cost-growth-selftest:0"); await redis.del("cost-growth:alerted:chat:cost-growth-selftest:0");
  await redis.onModuleDestroy();
})();'
```
Expected: `history 6`; в чат алертов test-стенда (его `TELEGRAM_CHAT_ID`) пришло ОДНО сообщение «📈 Стоимость растёт с каждым ответом … самопроверка выката» (шестой растущий ход — в паузе). Если у test-стенда `TELEGRAM_CHAT_ID` не задан — отметить, что проверена только запись в Redis, и спросить владельца, проверять ли тем же способом на проде (служебная пара, ключи удаляются).

---

### Task 7: Память, итоги, уборка

- [ ] **Step 1: Память** — заметка о стороже (пороги в `.env`, ключи Redis `cost-growth:*`, где вызывается, пауза сутки; TG без истории в `token_transactions`), строка в `MEMORY.md`.
- [ ] **Step 2: Итоги** — раздел «Итоги выката» в конце этого плана (дата, коммиты, прогон по истории — числа без номеров, отклонения), коммит в main.
- [ ] **Step 3: Уборка** — воркдерево, `tmp/cost-growth` и `ci/wt/cost-growth` на ноде, клон выката; ветка `feat/cost-growth-alert` — после «ок» владельца.
