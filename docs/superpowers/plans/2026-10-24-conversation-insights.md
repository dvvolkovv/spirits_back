# Затыки недели — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** раз в неделю бот читает разговоры живых пользователей на проде (обезличенно), находит повторяющиеся затыки и присылает владельцу сводку с кнопками «В бэклог» / «Отклонить».

**Architecture:** модуль `src/insights/` в NestJS. Сбор — SQL по источникам; разметка разговоров — Haiku 4.5 через `ClaudeCliService` пачками; сводка — Sonnet одним вызовом; находки и недели — свои таблицы; сводка и кнопки — через @LinkeonAgentBot (`TgGrammyClient`), callback `ins:` врезается в `TgBotService.handleCallbackQuery` рядом с блогом. Расписание — `@Cron` в UTC, выключатель — в базе.

**Tech Stack:** NestJS 10, `pg`, `@nestjs/schedule`, jest + ts-jest; фронт — React (правка текста политики).

**Спека:** `docs/superpowers/specs/2026-10-24-conversation-insights-design.md`.

**Отличия от спеки, решённые при планировании (с причиной):**
- Выключатель — строка `insights_settings.enabled` и действия `enable`/`disable` админской ручки, а не `INSIGHTS_ENABLED` в `.env`: правка файлов на сервере вручную запрещена правилами выката.
- Крон — `@Cron('0 7 4 * * 1')` (04:07 UTC = 07:07 МСК): опция `timeZone` в проекте не используется нигде.
- Модель сводки — `process.env.INSIGHTS_SYNTH_MODEL || 'sonnet'`: Sonnet в CLI пока не передаёт ни один вызов, псевдоним проверяется первым ручным прогоном.
- Имя своего ассистента (`custom:<uuid>`, `custom_agent_id`) в модель и сводку не идёт — вместо него «свой ассистент»: имя задаёт пользователь, оно может назвать его самого или его дело.
- В находке не может быть фраз «N человек / разговоров»: в `analysis_md` задачи бэклога (а через неё в блог) цифры о людях попасть не должны.

**Где работать:** воркдерево `spirits_back/.worktrees/conversation-insights` (ветка `feat/conversation-insights`), правка политики — воркдерево фронта `spirits_front/.worktrees/conversation-insights` (та же ветка). Прогоны — на ноде `dv@85.192.61.231` в `~/ci/wt/ci-insights-{back,front}` на sha; для спек с базой — scratch-база `insights_test` (`INSIGHTS_PG_URL`).

**Как переносить код из плана в файлы:** каждый новый файл ниже — заголовок `#### \`путь\`` и сразу один блок кода; блоки извлекаются в файлы скриптом (шаг Task 0). Правки существующих файлов — отдельными шагами «было / стало».

---

### Task 0: подготовка

- [ ] Воркдерево бэка уже есть (спека закоммичена в `feat/conversation-insights`).
- [ ] Скрипт извлечения блоков — в scratchpad сессии: читает план, для каждого `#### \`src/...\`` пишет следующий за ним блок кода в файл.
- [ ] На ноде: `createdb insights_test` (роль `dv`, сокет `/var/run/postgresql`), `INSIGHTS_PG_URL=postgres:///insights_test?host=/var/run/postgresql`.

### Task 1: типы, неделя, текстовые проверки

#### `src/insights/insights.types.ts`
```ts
/**
 * Типы бота «Затыки недели». Спека: docs/superpowers/specs/2026-10-24-conversation-insights-design.md.
 *
 * userId живёт только в памяти прогона: в таблицы insights_* он не попадает,
 * в модель — тоже (вместо него «человек N»).
 */

export const FRICTION_TYPES = ['missing', 'confused', 'assistant', 'failure', 'money', 'silent'] as const;
export type FrictionType = (typeof FRICTION_TYPES)[number];

export const FRICTION_LABELS: Record<FrictionType, string> = {
  missing: 'Нет нужного',
  confused: 'Не нашёл или запутался',
  assistant: 'Ассистент не справился',
  failure: 'Сбой',
  money: 'Деньги',
  silent: 'Ушёл молча',
};

export type Source = 'web' | 'tg' | 'support' | 'call';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/** Разговор недели — пара «человек + ассистент». */
export interface Conversation {
  key: string;
  source: Source;
  userId: string;
  /** Имя ассистента для модели и сводки. Свой ассистент — «свой ассистент», не его имя. */
  assistant: string;
  turns: Turn[];
}

/** Сигналы без модели — считаются из данных, текст никуда не уходит. */
export interface Signals {
  unansweredRuns: number;
  silentQuestionMarks: number;
  emptyOrFailedTurns: number;
  meetingsTotal: number;
  meetingsFailed: number;
  crisisConversations: number;
  thirdPartyGroupsSkipped: number;
}

export function emptySignals(): Signals {
  return {
    unansweredRuns: 0,
    silentQuestionMarks: 0,
    emptyOrFailedTurns: 0,
    meetingsTotal: 0,
    meetingsFailed: 0,
    crisisConversations: 0,
    thirdPartyGroupsSkipped: 0,
  };
}

export interface Collected {
  conversations: Conversation[];
  signals: Signals;
  /** Имена человека для обезличивания: userId → строки из профиля и Telegram. */
  names: Map<string, string[]>;
}

/** Один затык в одном разговоре — выход разметки. */
export interface Label {
  person: number;
  assistant: string;
  type: FrictionType;
  about: string;
  severity: 1 | 2 | 3;
}

export type FindingStatus = 'open' | 'backlog' | 'rejected';

/** Находка прошлых недель — вход сводки. */
export interface PriorFinding {
  id: string;
  type: FrictionType;
  title: string;
  status: FindingStatus;
  weeks: number;
  lastPeople: number;
  rejectedPeople: number | null;
}

/** Находка недели — выход сводки после проверки. */
export interface SynthFinding {
  priorId: string | null;
  type: FrictionType;
  title: string;
  description: string;
  proposal: string;
  people: number;
  conversations: number;
  assistants: string[];
  severity: 1 | 2 | 3;
}
```

#### `src/insights/insights-week.ts`
```ts
/**
 * Неделя бота — с понедельника 00:00 по воскресенье 23:59:59 по Москве.
 * Москва — UTC+3 круглый год (перевода часов нет с 2014), поэтому сдвиг
 * постоянный и Intl здесь не нужен.
 */

const MSK_OFFSET_MS = 3 * 3600_000;
const DAY_MS = 86_400_000;

export interface Week {
  start: Date;
  end: Date;
  /** Понедельник по Москве, 'YYYY-MM-DD'. */
  weekStart: string;
}

export function weekOf(weekStart: string): Week {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new Error(`неделя не в формате YYYY-MM-DD: ${weekStart}`);
  }
  const mondayMsk = Date.parse(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(mondayMsk) || new Date(mondayMsk).getUTCDay() !== 1) {
    throw new Error(`${weekStart} — не понедельник`);
  }
  return {
    start: new Date(mondayMsk - MSK_OFFSET_MS),
    end: new Date(mondayMsk + 7 * DAY_MS - MSK_OFFSET_MS),
    weekStart,
  };
}

/** Прошедшая неделя к моменту now. */
export function previousWeekMsk(now: Date): Week {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const sinceMonday = (msk.getUTCDay() + 6) % 7;
  const thisMonday = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - sinceMonday);
  return weekOf(new Date(thisMonday - 7 * DAY_MS).toISOString().slice(0, 10));
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** «19–25 окт», «28 сен – 4 окт». */
export function weekLabel(weekStart: string): string {
  const a = new Date(`${weekStart}T00:00:00Z`);
  const b = new Date(a.getTime() + 6 * DAY_MS);
  const ma = MONTHS[a.getUTCMonth()];
  const mb = MONTHS[b.getUTCMonth()];
  return ma === mb
    ? `${a.getUTCDate()}–${b.getUTCDate()} ${mb}`
    : `${a.getUTCDate()} ${ma} – ${b.getUTCDate()} ${mb}`;
}
```

#### `src/insights/insights-text.ts`
```ts
/**
 * Проверки текста, который пишет модель. Всё, что похоже на цитату или на
 * утечку, отбрасывается целиком, а не правится: правка оставила бы
 * полуцитату.
 */

/** Ряды цифр, почта, кавычки (признак цитаты), метки обезличивания. */
export const FORBIDDEN_RE = /\d{3,}|@|[«»"“”„]|\[(?:имя|телефон|почта|число|ссылка)/u;

/**
 * Цифры о людях: «4 человека», «у 3 пользователей», «2 разговора», «5 раз».
 * Им не место в тексте находки: он уходит в analysis_md задачи бэклога, а
 * оттуда — темой в публичный блог.
 */
export const PEOPLE_COUNT_RE = /\d+\s*(?:чел|пользовател|разговор|раза?(?!\p{L}))/iu;

export function cleanLine(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s || FORBIDDEN_RE.test(s)) return null;
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

/** JSON из ответа модели: без ```-ограды; если вокруг проза — первый массив или объект. */
export function parseModelJson(text: string): unknown {
  const s = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(s);
  } catch {
    // ниже — поиск внутри прозы
  }
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const close = s[start] === '[' ? ']' : '}';
  const end = s.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}
```

#### `src/insights/insights-week.spec.ts`
```ts
import { previousWeekMsk, weekLabel, weekOf } from './insights-week';

describe('неделя по Москве', () => {
  it('в понедельник 07:07 МСК прогон берёт прошлую неделю', () => {
    const w = previousWeekMsk(new Date('2026-10-26T04:07:00Z'));
    expect(w.weekStart).toBe('2026-10-19');
    expect(w.start.toISOString()).toBe('2026-10-18T21:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-25T21:00:00.000Z');
  });

  it('в воскресенье 23:59 МСК неделя ещё не закончилась — берётся позапрошлая', () => {
    expect(previousWeekMsk(new Date('2026-10-25T20:59:00Z')).weekStart).toBe('2026-10-12');
  });

  it('в понедельник 00:30 МСК (ещё воскресенье по UTC) берётся только что закончившаяся', () => {
    expect(previousWeekMsk(new Date('2026-10-25T21:30:00Z')).weekStart).toBe('2026-10-19');
  });

  it('неделя задаётся только понедельником', () => {
    expect(() => weekOf('2026-10-20')).toThrow(/не понедельник/);
    expect(() => weekOf('20.10.2026')).toThrow(/формате/);
  });

  it('подпись недели — внутри месяца и через границу', () => {
    expect(weekLabel('2026-10-19')).toBe('19–25 окт');
    expect(weekLabel('2026-09-28')).toBe('28 сен – 4 окт');
  });
});
```

#### `src/insights/insights-text.spec.ts`
```ts
import { cleanLine, parseModelJson, PEOPLE_COUNT_RE } from './insights-text';

describe('cleanLine', () => {
  it('пропускает суть своими словами', () => {
    expect(cleanLine('  Не нашёл, где   завести бота ', 140)).toBe('Не нашёл, где завести бота');
  });

  it.each([
    'просит выгрузку за 2026 год',
    'пишет на почту a@b',
    'сказал «не работает»',
    'сказал "не работает"',
    'зовут [имя]',
    'оставил [телефон]',
  ])('отбрасывает похожее на цитату или утечку: %s', (s) => {
    expect(cleanLine(s, 140)).toBeNull();
  });

  it('режет длинное с многоточием и не ломает символы', () => {
    const out = cleanLine('я'.repeat(200), 140)!;
    expect(Array.from(out)).toHaveLength(140);
    expect(out.endsWith('…')).toBe(true);
  });

  it('не-строку отбрасывает', () => {
    expect(cleanLine(42, 140)).toBeNull();
    expect(cleanLine(undefined, 140)).toBeNull();
  });
});

describe('PEOPLE_COUNT_RE', () => {
  it.each(['у 4 человек', '3 пользователя', '2 разговора', 'повторил 5 раз', '2 раза'])('ловит «%s»', (s) => {
    expect(PEOPLE_COUNT_RE.test(s)).toBe(true);
  });
  it.each(['разговор обрывается', 'интеграция с 1С', 'Sonnet 4.5'])('не трогает «%s»', (s) => {
    expect(PEOPLE_COUNT_RE.test(s)).toBe(false);
  });
});

describe('parseModelJson', () => {
  it('снимает ограду ```json', () => {
    expect(parseModelJson('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });
  it('находит JSON внутри прозы', () => {
    expect(parseModelJson('Вот ответ: {"findings": []} — готово')).toEqual({ findings: [] });
  });
  it('мусор — null', () => {
    expect(parseModelJson('не json')).toBeNull();
  });
});
```

- [ ] Извлечь файлы, прогнать `npx jest src/insights/insights-week src/insights/insights-text` на ноде — зелёные.
- [ ] Коммит `insights: типы, неделя по Москве, проверки текста модели`.

### Task 2: обезличивание и кризисные разговоры

Правка `src/chat/crisis-rule.ts` — после `CRISIS_RULE` добавить константу номеров:

```ts
/**
 * Номера телефонов доверия из правила — одной константой. По ним бот «Затыки
 * недели» (src/insights/crisis.ts) узнаёт разговор, где сработал кризисный
 * протокол, и не читает его. Совпадение с текстом правила сторожит
 * crisis-rule.spec.ts.
 */
export const CRISIS_HOTLINES = ['+7 (495) 989-50-50', '8-800-2000-122'] as const;
```

и в `src/chat/crisis-rule.spec.ts` — тест:

```ts
  it('номера для бота «Затыки недели» стоят в тексте правила дословно', () => {
    for (const phone of CRISIS_HOTLINES) expect(CRISIS_RULE).toContain(phone);
  });
```
(импорт `CRISIS_HOTLINES` рядом с `CRISIS_RULE`).

#### `src/insights/deidentify.ts`
```ts
/**
 * Обезличивание текста перед моделью. Это эвристика, а не гарантия (спека,
 * раздел «Обезличивание»): поэтому вдобавок выход модели проверяется
 * (insights-text.ts), разметка не хранится, а сводка уходит только владельцу.
 *
 * Порядок замен важен: ссылки и почта — первыми (в них бывают цифры и имена),
 * затем ряды цифр, затем имена.
 */

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()«»"]+/giu;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// Ряд цифр с разделителями внутри строки. \s сюда нельзя: склеил бы цифры
// через перевод строки («шаг 1\n2 3» превратился бы в число).
const DIGIT_RUN_RE = /\+?\d[\d \t().-]*\d/g;

export function maskUrls(s: string): string {
  return s.replace(URL_RE, (m) => {
    const host = m.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').split(/[/?#:]/)[0].toLowerCase();
    return host ? `[ссылка: ${host}]` : '[ссылка]';
  });
}

export function maskEmails(s: string): string {
  return s.replace(EMAIL_RE, '[почта]');
}

export function maskDigits(s: string): string {
  return s.replace(DIGIT_RUN_RE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return '[телефон]';
    if (digits.length >= 6) return '[число]';
    return m;
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Имя и его падежные формы: «Владимир», «Владимира», «Владимиру». Основа без
 * последней гласной (Анна → Анн), за ней до трёх букв, по краям — не буква.
 */
function namePattern(raw: string): string | null {
  const n = raw.trim();
  const chars = Array.from(n);
  if (chars.length < 3) return null;
  const stem = chars.length >= 4 && /[аеёиоуыэюяьйaeiouy]$/iu.test(n) ? chars.slice(0, -1).join('') : n;
  return `(?<![\\p{L}\\p{N}])${escapeRe(stem)}\\p{L}{0,3}(?![\\p{L}\\p{N}])`;
}

export function maskNames(s: string, names: readonly string[]): string {
  const patterns = new Set<string>();
  for (const raw of names) {
    for (const piece of String(raw || '').split(/[\s,]+/)) {
      const p = namePattern(piece);
      if (p) patterns.add(p);
    }
  }
  if (!patterns.size) return s;
  // Длинные основы первыми: «Владимир» не должна съесть короткая «Влад».
  const re = new RegExp([...patterns].sort((a, b) => b.length - a.length).join('|'), 'giu');
  return s.replace(re, '[имя]');
}

export function deidentify(text: string, names: readonly string[] = []): string {
  return maskNames(maskDigits(maskEmails(maskUrls(String(text || '')))), names);
}
```

#### `src/insights/crisis.ts`
```ts
import { CRISIS_HOTLINES } from '../chat/crisis-rule';
import type { Turn } from './insights.types';

/**
 * Кризисный разговор — тот, где ассистент дал номер телефона доверия из
 * кризисного правила. Такой разговор модель не читает, в сводке — только число.
 *
 * Сравниваются десять последних цифр номера: ассистент мог записать «8 (495)…»
 * вместо «+7 (495)…» или без разделителей.
 */
const HOTLINE_TAILS = CRISIS_HOTLINES.map((p) => p.replace(/\D/g, '').slice(-10));

// В звонке номера звучат словами — формы из CALL_CRISIS_RULE (voice-host/src/prompts.ts).
const SPOKEN = [/девятьсот\s+восемьдесят\s+девять,?\s+пятьдесят/iu, /две\s+тысячи,?\s+сто\s+двадцать\s+два/iu];

const DIGIT_RUN_RE = /\+?\d[\d \t().-]*\d/g;

export function isCrisisText(text: string): boolean {
  const s = String(text || '');
  for (const m of s.match(DIGIT_RUN_RE) ?? []) {
    const digits = m.replace(/\D/g, '');
    if (HOTLINE_TAILS.some((t) => digits.includes(t))) return true;
  }
  return SPOKEN.some((re) => re.test(s));
}

export function isCrisisConversation(turns: readonly Turn[]): boolean {
  return turns.some((t) => t.role === 'assistant' && isCrisisText(t.text));
}
```

#### `src/insights/deidentify.spec.ts`
```ts
import { deidentify, maskDigits, maskEmails, maskNames, maskUrls } from './deidentify';

describe('обезличивание', () => {
  it.each(['+7 (903) 016-91-87', '8-903-016-91-87', '79030169187', '+44 20 7946 0958'])('телефон %s', (phone) => {
    expect(maskDigits(`звоните ${phone} вечером`)).toBe('звоните [телефон] вечером');
  });

  it('номер карты и длинный номер — [число]', () => {
    expect(maskDigits('карта 4276 1234 5678 9012')).toBe('карта [число]');
    expect(maskDigits('заказ 1234567')).toBe('заказ [число]');
  });

  it('короткие числа остаются', () => {
    expect(maskDigits('149 ₽ в 10:30, 2 раза')).toBe('149 ₽ в 10:30, 2 раза');
  });

  it('цифры через перевод строки не склеиваются', () => {
    expect(maskDigits('шаг 1\n2 3')).toBe('шаг 1\n2 3');
  });

  it('почта', () => {
    expect(maskEmails('пишите на v.ivanov@yandex.ru, спасибо')).toBe('пишите на [почта], спасибо');
  });

  it('ссылка — только домен', () => {
    expect(maskUrls('канал https://t.me/sportrodkom?start=abc')).toBe('канал [ссылка: t.me]');
    expect(maskUrls('см. www.ozon.ru/seller/123')).toBe('см. [ссылка: ozon.ru]');
  });

  it('имя в падежах, а похожие слова не трогаются', () => {
    const s = 'Владимир, это для Владимира. Передайте Владимиру. Владение — другое.';
    expect(maskNames(s, ['Владимир'])).toBe('[имя], это для [имя]. Передайте [имя]. Владение — другое.');
  });

  it('женское имя с основой без гласной', () => {
    expect(maskNames('Анна и Анну', ['Анна'])).toBe('[имя] и [имя]');
  });

  it('короткие имена не маскируются — слишком много ложных', () => {
    expect(maskNames('Ян пришёл', ['Ян'])).toBe('Ян пришёл');
  });

  it('всё вместе и в правильном порядке', () => {
    const out = deidentify('Я Иванова, почта ivanova@mail.ru, тел 8 903 016 91 87, сайт https://ivanova.ru/a', ['Иванова']);
    expect(out).toBe('Я [имя], почта [почта], тел [телефон], сайт [ссылка: ivanova.ru]');
  });
});
```

#### `src/insights/crisis.spec.ts`
```ts
import { isCrisisConversation, isCrisisText } from './crisis';

describe('кризисные разговоры', () => {
  it.each([
    'Позвоните на линию МЧС: +7 (495) 989-50-50',
    'Линия МЧС 8 (495) 989 50 50',
    'Детский телефон доверия 8-800-2000-122',
    'детский телефон 88002000122',
  ])('номер в ответе: %s', (s) => {
    expect(isCrisisText(s)).toBe(true);
  });

  it('словесная форма из звонка', () => {
    expect(isCrisisText('плюс семь, четыреста девяносто пять, девятьсот восемьдесят девять, пятьдесят, пятьдесят')).toBe(true);
    expect(isCrisisText('восемь, восемьсот, две тысячи, сто двадцать два')).toBe(true);
  });

  it('одно «112» кризисом не считается — слишком частое число', () => {
    expect(isCrisisText('позвоните 112, если что')).toBe(false);
  });

  it('считается только ответ ассистента: номер от человека — не протокол', () => {
    expect(isCrisisConversation([{ role: 'user', text: 'мой номер 8-800-2000-122?' }])).toBe(false);
    expect(isCrisisConversation([{ role: 'assistant', text: 'телефон доверия 8-800-2000-122' }])).toBe(true);
  });
});
```

- [ ] Извлечь, правка `crisis-rule.ts` и его спеки, прогон `npx jest src/insights/deidentify src/insights/crisis src/chat/crisis-rule` — зелёные.
- [ ] Мутация-проверка: убрать `[телефон]`-ветку в `maskDigits` → спека краснеет; вернуть.
- [ ] Коммит `insights: обезличивание и распознавание кризисных разговоров`.

### Task 3: разметка разговоров (Haiku)

#### `src/insights/insights-label.ts`
```ts
import { deidentify } from './deidentify';
import { cleanLine, parseModelJson } from './insights-text';
import { FRICTION_TYPES, type Conversation, type FrictionType, type Label } from './insights.types';

export const LABEL_MODEL = 'claude-haiku-4-5';
export const LABEL_BATCH = 8;
export const MAX_CONVERSATION_CHARS = 12_000;
const ASSISTANT_HEAD = 400;
const ASSISTANT_TAIL = 200;

export const LABEL_SYSTEM = `Ты помогаешь команде Linkeon находить затыки продукта в разговорах пользователей с AI-ассистентами.
Затык — место, где человек не получил того, за чем пришёл. Типы:
- missing — просит то, чего в Linkeon нет (функцию, интеграцию, формат);
- confused — не находит функцию, путает похожие разделы, не понимает, как сделать;
- assistant — ассистент ответил неверно, отказал без причины, обещал и не сделал, ответил не по своей роли;
- failure — технический сбой: пустой ответ, обрыв, ошибка инструмента;
- money — непонятное списание, не получилось пополнить, «дорого»;
- silent — человек переспрашивает, повторяет вопрос, пишет «?» без ответа, бросает разговор сразу после ответа.

Правила:
- Отмечай только явные затыки. Обычный удачный разговор — пустой список items.
- about — суть своими словами, до 140 знаков, в продуктовых терминах. Без цитат и кавычек, без имён, без чисел, без деталей, по которым можно узнать человека, его дело или его здоровье. Про здоровье и психологию — не глубже темы («вопрос о здоровье»).
- Тексты уже обезличены: метки [имя], [телефон], [почта], [ссылка: …], [число] не раскрывай и не повторяй.
- severity: 1 — мелочь, 2 — мешает, 3 — человек ушёл ни с чем.

Ответь ТОЛЬКО JSON-массивом, без пояснений:
[{"conv": <номер разговора>, "items": [{"type": "<тип>", "about": "<суть>", "severity": 1}]}]`;

export interface LabelInput {
  person: number;
  conversation: Conversation;
}

function clipAssistant(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= ASSISTANT_HEAD + ASSISTANT_TAIL + 50) return text;
  return `${chars.slice(0, ASSISTANT_HEAD).join('')} […] ${chars.slice(-ASSISTANT_TAIL).join('')}`;
}

/** Разговор текстом для модели: обезличен, ответы ассистента сокращены, не длиннее MAX_CONVERSATION_CHARS. */
export function renderConversation(c: Conversation, names: readonly string[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const t of c.turns) {
    const body = deidentify(t.role === 'assistant' ? clipAssistant(t.text) : t.text, names);
    const line = `${t.role === 'user' ? 'Человек' : 'Ассистент'}: ${body}`;
    if (used + line.length > MAX_CONVERSATION_CHARS) {
      lines.push('[…дальше разговор обрезан…]');
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

export function buildLabelPrompt(batch: readonly LabelInput[], namesOf: (userId: string) => readonly string[]): string {
  return batch
    .map(
      (b, i) =>
        `Разговор ${i + 1} (ассистент «${b.conversation.assistant}»):\n${renderConversation(b.conversation, namesOf(b.conversation.userId))}`,
    )
    .join('\n\n');
}

/**
 * Разбор ответа разметки. null — ответ не по форме (повод повторить вызов);
 * [] — затыков нет. Человек и ассистент берутся из пачки, а не из ответа:
 * модель знает только номер разговора.
 */
export function parseLabels(text: string, batch: readonly LabelInput[]): Label[] | null {
  const data = parseModelJson(text);
  if (!Array.isArray(data)) return null;
  const out: Label[] = [];
  for (const row of data as any[]) {
    const input = batch[Number(row?.conv) - 1];
    if (!input || !Array.isArray(row?.items)) continue;
    for (const item of row.items) {
      const type = item?.type as FrictionType;
      if (!FRICTION_TYPES.includes(type)) continue;
      const about = cleanLine(item?.about, 140);
      if (!about) continue;
      const sev = Number(item?.severity);
      out.push({
        person: input.person,
        assistant: input.conversation.assistant,
        type,
        about,
        severity: sev === 1 || sev === 3 ? sev : 2,
      });
    }
  }
  return out;
}
```

#### `src/insights/insights-label.spec.ts`
```ts
import { buildLabelPrompt, MAX_CONVERSATION_CHARS, parseLabels, renderConversation, type LabelInput } from './insights-label';
import type { Conversation } from './insights.types';

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  key: 'web:1',
  source: 'web',
  userId: 'u1',
  assistant: 'Роман',
  turns: [
    { role: 'user', text: 'Я Владимир, мой телефон +7 903 016-91-87' },
    { role: 'assistant', text: 'Здравствуйте!' },
  ],
  ...over,
});

describe('renderConversation', () => {
  it('обезличивает реплики человека', () => {
    const out = renderConversation(conv(), ['Владимир']);
    expect(out).toContain('Человек: Я [имя], мой телефон [телефон]');
    expect(out).not.toContain('Владимир');
    expect(out).not.toMatch(/903/);
  });

  it('длинный ответ ассистента — начало и конец', () => {
    const long = 'а'.repeat(400) + 'СЕРЕДИНА' + 'б'.repeat(400);
    const out = renderConversation(conv({ turns: [{ role: 'user', text: 'вопрос' }, { role: 'assistant', text: long }] }), []);
    expect(out).toContain('[…]');
    expect(out).not.toContain('СЕРЕДИНА');
  });

  it('разговор не длиннее потолка', () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({ role: 'user' as const, text: `реплика ${'х'.repeat(200)} ${i}` }));
    const out = renderConversation(conv({ turns }), []);
    expect(out.length).toBeLessThanOrEqual(MAX_CONVERSATION_CHARS + 100);
    expect(out).toContain('[…дальше разговор обрезан…]');
  });
});

describe('buildLabelPrompt', () => {
  it('нумерует разговоры и называет ассистента', () => {
    const batch: LabelInput[] = [{ person: 1, conversation: conv() }, { person: 2, conversation: conv({ assistant: 'Кира' }) }];
    const out = buildLabelPrompt(batch, () => ['Владимир']);
    expect(out).toContain('Разговор 1 (ассистент «Роман»)');
    expect(out).toContain('Разговор 2 (ассистент «Кира»)');
    expect(out).not.toContain('u1');
  });
});

describe('parseLabels', () => {
  const batch: LabelInput[] = [{ person: 7, conversation: conv() }];

  it('человек и ассистент — из пачки, а не из ответа', () => {
    const out = parseLabels('[{"conv":1,"items":[{"type":"confused","about":"путает два вида ботов","severity":3}]}]', batch);
    expect(out).toEqual([{ person: 7, assistant: 'Роман', type: 'confused', about: 'путает два вида ботов', severity: 3 }]);
  });

  it('чужой тип, цитата и разговор вне пачки отбрасываются', () => {
    const out = parseLabels(
      JSON.stringify([
        { conv: 1, items: [{ type: 'other', about: 'x', severity: 2 }, { type: 'money', about: 'сказал «дорого»', severity: 2 }] },
        { conv: 5, items: [{ type: 'money', about: 'дорого', severity: 2 }] },
      ]),
      batch,
    );
    expect(out).toEqual([]);
  });

  it('тяжесть вне 1–3 — 2', () => {
    const out = parseLabels('[{"conv":1,"items":[{"type":"money","about":"не понял списание","severity":9}]}]', batch);
    expect(out?.[0].severity).toBe(2);
  });

  it('не массив — null, повод повторить', () => {
    expect(parseLabels('{"oops":1}', batch)).toBeNull();
    expect(parseLabels('нет', batch)).toBeNull();
  });
});
```

- [ ] Извлечь, прогон `npx jest src/insights/insights-label` — зелёный.
- [ ] Коммит `insights: разметка разговоров — промпт и проверка ответа`.

### Task 4: сводка недели (Sonnet)

#### `src/insights/insights-synth.ts`
```ts
import { cleanLine, parseModelJson, PEOPLE_COUNT_RE } from './insights-text';
import {
  FRICTION_TYPES,
  type FrictionType,
  type Label,
  type PriorFinding,
  type Signals,
  type SynthFinding,
} from './insights.types';

export const MAX_FINDINGS = 10;

export function synthModel(): string {
  return process.env.INSIGHTS_SYNTH_MODEL || 'sonnet';
}

export const SYNTH_SYSTEM = `Ты — продуктовый аналитик Linkeon. На входе JSON: разметка затыков за неделю (по пункту на затык в разговоре: номер человека внутри недели, ассистент, тип, суть, тяжесть), сигналы недели и находки прошлых недель со статусами.

Склей похожие пункты в находки — от 5 до 10, не больше 10 (если пунктов мало — сколько есть). Для каждой:
- prior_id — id прошлой находки, если это она же; иначе null;
- type — один из: missing, confused, assistant, failure, money, silent;
- title — до 80 знаков; description — до 300 знаков, что происходит у людей; proposal — до 300 знаков, что изменить в продукте;
- people — номера людей из разметки, у которых это было;
- severity — 1, 2 или 3.

Правила: без цитат и кавычек, без имён, без чисел о людях («N человек», «N раз»), без деталей, по которым можно узнать человека, его дело или здоровье; здоровье и психология — не глубже темы. Не выдумывай: каждая находка опирается на пункты разметки. Находку со статусом rejected повторяй, только если людей с ней стало заметно больше.

Ответь ТОЛЬКО JSON: {"findings": [{"prior_id": null, "type": "...", "title": "...", "description": "...", "proposal": "...", "people": [1, 2], "severity": 2}]}`;

export function buildSynthPrompt(input: {
  weekLabel: string;
  labels: readonly Label[];
  signals: Signals;
  prior: readonly PriorFinding[];
}): string {
  return JSON.stringify({
    week: input.weekLabel,
    labels: input.labels.map((l) => ({ person: l.person, assistant: l.assistant, type: l.type, about: l.about, severity: l.severity })),
    signals: input.signals,
    prior: input.prior.map((p) => ({
      id: p.id,
      type: p.type,
      title: p.title,
      status: p.status,
      weeks: p.weeks,
      last_people: p.lastPeople,
      rejected_people: p.rejectedPeople,
    })),
  });
}

function textField(raw: unknown, max: number): string | null {
  const s = cleanLine(raw, max);
  return s && !PEOPLE_COUNT_RE.test(s) ? s : null;
}

/**
 * Разбор и проверка сводки. Счётчики считаются здесь по разметке, а не
 * берутся у модели: людей в находке — только те, кто есть в разметке.
 * null — ответ не по форме.
 */
export function parseFindings(text: string, labels: readonly Label[], prior: readonly PriorFinding[]): SynthFinding[] | null {
  const data = parseModelJson(text) as any;
  const rows: any[] | null = Array.isArray(data?.findings) ? data.findings : Array.isArray(data) ? data : null;
  if (!rows) return null;
  const persons = new Set(labels.map((l) => l.person));
  const priorById = new Map(prior.map((p) => [p.id, p]));
  const list: SynthFinding[] = [];
  for (const r of rows) {
    const type = r?.type as FrictionType;
    if (!FRICTION_TYPES.includes(type)) continue;
    const title = textField(r?.title, 80);
    const description = textField(r?.description, 300);
    const proposal = textField(r?.proposal, 300);
    if (!title || !description || !proposal) continue;
    const rawPeople: unknown[] = Array.isArray(r?.people) ? r.people : [];
    const people = [...new Set(rawPeople.map((x) => Number(x)))].filter((n) => persons.has(n));
    if (!people.length) continue;
    const own = labels.filter((l) => people.includes(l.person) && l.type === type);
    const basis = own.length ? own : labels.filter((l) => people.includes(l.person));
    const conversations = new Set(basis.map((l) => `${l.person}|${l.assistant}`)).size || people.length;
    const assistants = [...new Set(basis.map((l) => l.assistant))];
    const priorRow = typeof r?.prior_id === 'string' ? priorById.get(r.prior_id) : undefined;
    // Отклонённая находка всплывает, только если людей стало хотя бы вдвое больше.
    if (priorRow?.status === 'rejected' && people.length < 2 * Math.max(1, priorRow.rejectedPeople ?? 1)) continue;
    const sev = Number(r?.severity);
    list.push({
      priorId: priorRow?.id ?? null,
      type,
      title,
      description,
      proposal,
      people: people.length,
      conversations,
      assistants,
      severity: sev === 1 || sev === 3 ? sev : 2,
    });
  }
  list.sort((a, b) => b.people * b.severity - a.people * a.severity);
  const usedPrior = new Set<string>();
  const out: SynthFinding[] = [];
  for (const f of list) {
    if (f.priorId) {
      if (usedPrior.has(f.priorId)) continue;
      usedPrior.add(f.priorId);
    }
    out.push(f);
    if (out.length === MAX_FINDINGS) break;
  }
  return out;
}
```

#### `src/insights/insights-synth.spec.ts`
```ts
import { buildSynthPrompt, MAX_FINDINGS, parseFindings } from './insights-synth';
import { emptySignals, type Label, type PriorFinding } from './insights.types';

const L = (person: number, assistant: string, type: Label['type'] = 'confused'): Label => ({
  person,
  assistant,
  type,
  about: 'путает два вида ботов',
  severity: 2,
});

const finding = (over: Record<string, unknown> = {}) => ({
  prior_id: null,
  type: 'confused',
  title: 'Путают два вида ботов',
  description: 'Идут за своим ботом во вкладку групповых ботов',
  proposal: 'Дать во вкладке ссылку на Продукты',
  people: [1, 2],
  severity: 2,
  ...over,
});

const labels = [L(1, 'Роман'), L(2, 'Роман'), L(2, 'Кира'), L(3, 'Кира', 'money')];

describe('buildSynthPrompt', () => {
  it('отдаёт модели разметку без userId и прошлые находки', () => {
    const prior: PriorFinding[] = [{ id: 'p1', type: 'confused', title: 'Т', status: 'open', weeks: 2, lastPeople: 3, rejectedPeople: null }];
    const s = buildSynthPrompt({ weekLabel: '19–25 окт', labels, signals: emptySignals(), prior });
    const j = JSON.parse(s);
    expect(j.labels[0]).toEqual({ person: 1, assistant: 'Роман', type: 'confused', about: 'путает два вида ботов', severity: 2 });
    expect(j.prior[0]).toMatchObject({ id: 'p1', last_people: 3 });
  });
});

describe('parseFindings', () => {
  it('людей и разговоры считает по разметке, а не верит модели', () => {
    const out = parseFindings(JSON.stringify({ findings: [finding({ people: [1, 2, 99] })] }), labels, [])!;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ people: 2, conversations: 3, assistants: ['Роман', 'Кира'], priorId: null });
  });

  it('находка без людей из разметки отбрасывается', () => {
    expect(parseFindings(JSON.stringify({ findings: [finding({ people: [42] })] }), labels, [])).toEqual([]);
  });

  it.each([
    ['цифры о людях', { description: 'Так было у 4 человек' }],
    ['цитата', { title: 'Говорят «не работает»' }],
    ['чужой тип', { type: 'other' }],
  ])('отбрасывает: %s', (_name, over) => {
    expect(parseFindings(JSON.stringify({ findings: [finding(over)] }), labels, [])).toEqual([]);
  });

  it('незнакомый prior_id — новая находка', () => {
    const out = parseFindings(JSON.stringify({ findings: [finding({ prior_id: 'nope' })] }), labels, [])!;
    expect(out[0].priorId).toBeNull();
  });

  it('отклонённая всплывает только при вдвое большем числе людей', () => {
    const prior: PriorFinding[] = [{ id: 'r1', type: 'confused', title: 'Т', status: 'rejected', weeks: 1, lastPeople: 1, rejectedPeople: 2 }];
    expect(parseFindings(JSON.stringify({ findings: [finding({ prior_id: 'r1', people: [1, 2] })] }), labels, prior)).toEqual([]);
    const many = [...labels, L(4, 'Роман'), L(5, 'Роман')];
    const out = parseFindings(JSON.stringify({ findings: [finding({ prior_id: 'r1', people: [1, 2, 4, 5] })] }), many, prior)!;
    expect(out[0].priorId).toBe('r1');
  });

  it('одна прошлая находка — не дважды', () => {
    const prior: PriorFinding[] = [{ id: 'p1', type: 'confused', title: 'Т', status: 'open', weeks: 1, lastPeople: 1, rejectedPeople: null }];
    const out = parseFindings(
      JSON.stringify({ findings: [finding({ prior_id: 'p1' }), finding({ prior_id: 'p1', people: [1] })] }),
      labels,
      prior,
    )!;
    expect(out.filter((f) => f.priorId === 'p1')).toHaveLength(1);
  });

  it('сортировка по важности и потолок', () => {
    const many = Array.from({ length: 15 }, (_, i) => finding({ title: `Находка ${i}`, people: i % 2 ? [1, 2] : [1] }));
    const out = parseFindings(JSON.stringify({ findings: many }), labels, [])!;
    expect(out).toHaveLength(MAX_FINDINGS);
    expect(out[0].people).toBe(2);
  });

  it('не JSON — null', () => {
    expect(parseFindings('мусор', labels, [])).toBeNull();
  });
});
```

- [ ] Извлечь, прогон `npx jest src/insights/insights-synth` — зелёный.
- [ ] Коммит `insights: сводка недели — промпт, проверка, отклонённые`.

### Task 5: текст сводки и кнопки

#### `src/insights/insights-digest.ts`
```ts
import { weekLabel } from './insights-week';
import { FRICTION_LABELS, type FindingStatus, type Signals, type SynthFinding } from './insights.types';

export const DIGEST_MAX_CHARS = 3500;

export interface DigestFinding extends SynthFinding {
  id: string;
  status: FindingStatus;
  /** Сколько недель находка встречается, включая эту. */
  weeksSeen: number;
  /** Людей на прошлой неделе — для «стало меньше». */
  prevPeople: number | null;
}

export interface DigestInput {
  weekStart: string;
  conversations: number;
  people: number;
  crisis: number;
  signals: Signals;
  findings: readonly DigestFinding[];
}

export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export function insightsChatId(): number | null {
  const raw = process.env.INSIGHTS_TG_CHAT_ID || process.env.BLOG_APPROVER_TG_ID;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function trend(f: DigestFinding): string {
  if (f.weeksSeen <= 1) return 'новое';
  if (f.prevPeople !== null && f.people < f.prevPeople) return 'стало меньше';
  return `держится ${f.weeksSeen} нед.`;
}

function block(n: number, f: DigestFinding): string {
  const who = f.people === 1 ? '1 человек' : `${f.people} чел., ${f.conversations} разг.`;
  const head = `${n}. ${FRICTION_LABELS[f.type]} · ${who} · ${f.assistants.join(', ') || '—'} · ${trend(f)}`;
  return `${head}\n${f.title}. ${f.description}\n→ ${f.proposal}`;
}

/** Сначала находки нескольких людей по важности, потом «1 человек». */
export function orderFindings(list: readonly DigestFinding[]): DigestFinding[] {
  const score = (f: DigestFinding) => f.people * f.severity;
  const many = list.filter((f) => f.people > 1).sort((a, b) => score(b) - score(a));
  const one = list.filter((f) => f.people <= 1).sort((a, b) => b.severity - a.severity);
  return [...many, ...one];
}

export function buildDigest(input: DigestInput): { text: string; shown: DigestFinding[] } {
  const s = input.signals;
  const header = [
    `Затыки недели · ${weekLabel(input.weekStart)}`,
    `Разговоров: ${input.conversations} · людей: ${input.people} · кризисных: ${input.crisis}`,
    `Без ответа: ${s.unansweredRuns} · «?» в тишину: ${s.silentQuestionMarks} · пустых и упавших ответов: ${s.emptyOrFailedTurns}` +
      (s.meetingsTotal ? ` · встреч: ${s.meetingsTotal}, оборвалось: ${s.meetingsFailed}` : ''),
  ].join('\n');
  const ordered = orderFindings(input.findings);
  if (!ordered.length) return { text: `${header}\n\nЗатыков на этой неделе не нашлось.`, shown: [] };
  const parts = [header];
  const shown: DigestFinding[] = [];
  for (const f of ordered) {
    const candidate = [...parts, block(shown.length + 1, f)].join('\n\n');
    const rest = ordered.length - shown.length - 1;
    const note = rest > 0 ? `\n\nНе вошло: ${rest}.` : '';
    if (candidate.length + note.length > DIGEST_MAX_CHARS) break;
    parts.push(block(shown.length + 1, f));
    shown.push(f);
  }
  const cut = ordered.length - shown.length;
  return { text: parts.join('\n\n') + (cut > 0 ? `\n\nНе вошло: ${cut}.` : ''), shown };
}

/** Кнопки по строке на находку, номер — как в тексте сводки. */
export function buildKeyboard(items: ReadonlyArray<{ id: string; status: FindingStatus }>): InlineKeyboard {
  return {
    inline_keyboard: items.map((it, i) => {
      const n = i + 1;
      if (it.status === 'backlog') return [{ text: `${n} ✓ В бэклоге`, callback_data: `ins:noop:${it.id}` }];
      if (it.status === 'rejected') return [{ text: `${n} ✗ Отклонено`, callback_data: `ins:noop:${it.id}` }];
      return [
        { text: `${n} → В бэклог`, callback_data: `ins:b:${it.id}` },
        { text: `${n} ✗ Отклонить`, callback_data: `ins:r:${it.id}` },
      ];
    }),
  };
}
```

#### `src/insights/insights-digest.spec.ts`
```ts
import { buildDigest, buildKeyboard, DIGEST_MAX_CHARS, insightsChatId, orderFindings, type DigestFinding } from './insights-digest';
import { emptySignals } from './insights.types';

const F = (over: Partial<DigestFinding> = {}): DigestFinding => ({
  id: '00000000-0000-0000-0000-000000000001',
  status: 'open',
  weeksSeen: 1,
  prevPeople: null,
  priorId: null,
  type: 'confused',
  title: 'Путают два вида ботов',
  description: 'Идут за своим ботом во вкладку групповых ботов',
  proposal: 'Дать во вкладке ссылку на Продукты',
  people: 3,
  conversations: 4,
  assistants: ['Роман'],
  severity: 2,
  ...over,
});

const base = { weekStart: '2026-10-19', conversations: 74, people: 20, crisis: 1, signals: emptySignals() };

describe('buildDigest', () => {
  it('шапка: неделя, счётчики, кризисные — только число', () => {
    const { text } = buildDigest({ ...base, findings: [F()] });
    expect(text.split('\n')[0]).toBe('Затыки недели · 19–25 окт');
    expect(text).toContain('Разговоров: 74 · людей: 20 · кризисных: 1');
  });

  it('находка одного человека — ниже и с пометкой', () => {
    const one = F({ id: 'one', people: 1, conversations: 1, severity: 3, title: 'Хочет бота-аналитика' });
    const ordered = orderFindings([one, F()]);
    expect(ordered.map((f) => f.id)).toEqual(['00000000-0000-0000-0000-000000000001', 'one']);
    expect(buildDigest({ ...base, findings: [one] }).text).toContain('· 1 человек ·');
  });

  it('динамика: новое, держится, стало меньше', () => {
    expect(buildDigest({ ...base, findings: [F()] }).text).toContain('· новое');
    expect(buildDigest({ ...base, findings: [F({ weeksSeen: 3, prevPeople: 2 })] }).text).toContain('держится 3 нед.');
    expect(buildDigest({ ...base, findings: [F({ weeksSeen: 2, prevPeople: 5 })] }).text).toContain('стало меньше');
  });

  it('не длиннее экрана: хвост отрезается с пометкой', () => {
    const long = Array.from({ length: 10 }, (_, i) => F({ id: `id-${i}`, description: 'д'.repeat(290), proposal: 'п'.repeat(290) }));
    const { text, shown } = buildDigest({ ...base, findings: long });
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(shown.length).toBeLessThan(10);
    expect(text).toContain(`Не вошло: ${10 - shown.length}.`);
  });

  it('пустая неделя', () => {
    const out = buildDigest({ ...base, findings: [] });
    expect(out.text).toContain('Затыков на этой неделе не нашлось.');
    expect(out.shown).toEqual([]);
  });
});

describe('buildKeyboard', () => {
  it('открытая — две кнопки, решённая — пометка без действия', () => {
    const kb = buildKeyboard([
      { id: 'a', status: 'open' },
      { id: 'b', status: 'backlog' },
      { id: 'c', status: 'rejected' },
    ]);
    expect(kb.inline_keyboard[0].map((b) => b.callback_data)).toEqual(['ins:b:a', 'ins:r:a']);
    expect(kb.inline_keyboard[1]).toEqual([{ text: '2 ✓ В бэклоге', callback_data: 'ins:noop:b' }]);
    expect(kb.inline_keyboard[2]).toEqual([{ text: '3 ✗ Отклонено', callback_data: 'ins:noop:c' }]);
  });
});

describe('insightsChatId', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('своя переменная важнее чата блога', () => {
    process.env.INSIGHTS_TG_CHAT_ID = '111';
    process.env.BLOG_APPROVER_TG_ID = '222';
    expect(insightsChatId()).toBe(111);
  });

  it('без своей — чат одобрения блога; без обеих — null', () => {
    delete process.env.INSIGHTS_TG_CHAT_ID;
    process.env.BLOG_APPROVER_TG_ID = '222';
    expect(insightsChatId()).toBe(222);
    delete process.env.BLOG_APPROVER_TG_ID;
    expect(insightsChatId()).toBeNull();
  });
});
```

- [ ] Извлечь, прогон `npx jest src/insights/insights-digest` — зелёный.
- [ ] Коммит `insights: текст сводки и кнопки`.

### Task 6: таблицы и хранилище

#### `src/insights/migrations/001_insights.sql`
```sql
-- Затыки недели. Спека: docs/superpowers/specs/2026-10-24-conversation-insights-design.md.
-- Файл катится на каждом старте (как у остальных модулей), идемпотентно.
-- Лок — против двух одновременных первых стартов: проигравший ждёт, а не
-- ловит 23505 на pg_type (так было у products).
SELECT pg_advisory_xact_lock(hashtext('insights/001_insights'));

-- В таблицах insights_* нет ни цитат, ни id пользователей, ни id сессий:
-- поэтому при удалении аккаунта стирать здесь нечего.
CREATE TABLE IF NOT EXISTS insights_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start        date NOT NULL,
  manual            boolean NOT NULL DEFAULT false,
  status            text NOT NULL CHECK (status IN ('running', 'done', 'failed', 'postponed')),
  attempts          int NOT NULL DEFAULT 0,
  retry_at          timestamptz,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  conversations     int,
  people            int,
  crisis_count      int,
  signals           jsonb,
  cost_usd          numeric(10, 4),
  error             text,
  digest_chat_id    bigint,
  digest_message_id bigint,
  finding_ids       uuid[]
);
CREATE INDEX IF NOT EXISTS idx_insights_runs_week ON insights_runs (week_start, status);

CREATE TABLE IF NOT EXISTS insights_findings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL CHECK (type IN ('missing', 'confused', 'assistant', 'failure', 'money', 'silent')),
  title            text NOT NULL,
  description      text NOT NULL,
  proposal         text NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'backlog', 'rejected')),
  first_week       date NOT NULL,
  last_week        date NOT NULL,
  rejected_people  int,
  backlog_item_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_insights_findings_last_week ON insights_findings (last_week DESC);

CREATE TABLE IF NOT EXISTS insights_finding_weeks (
  finding_id     uuid NOT NULL REFERENCES insights_findings(id) ON DELETE CASCADE,
  week_start     date NOT NULL,
  people         int NOT NULL,
  conversations  int NOT NULL,
  assistants     text[] NOT NULL DEFAULT '{}',
  severity       int NOT NULL CHECK (severity BETWEEN 1 AND 3),
  PRIMARY KEY (finding_id, week_start)
);

-- Выключатель расписания: в базе, а не в .env — править файлы на сервере
-- руками нельзя (правила выката). Ключ 'enabled', значение jsonb true/false.
CREATE TABLE IF NOT EXISTS insights_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

#### `src/insights/insights-store.service.ts`
```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import type { DigestFinding } from './insights-digest';
import type { FindingStatus, FrictionType, PriorFinding, Signals, SynthFinding } from './insights.types';

export const INSIGHTS_MIGRATIONS = ['001_insights.sql'];

export interface RunRow {
  id: string;
  week_start: string;
  status: string;
  attempts: number;
  manual: boolean;
}

export interface CallbackFinding {
  id: string;
  type: FrictionType;
  title: string;
  description: string;
  proposal: string;
  status: FindingStatus;
  firstWeek: string;
  people: number;
  conversations: number;
  assistants: string[];
  weeks: number;
  runFindingIds: string[] | null;
}

@Injectable()
export class InsightsStore implements OnModuleInit {
  private readonly log = new Logger('InsightsStore');

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    for (const file of INSIGHTS_MIGRATIONS) {
      // .sql в dist не копируется (nest-cli.json без assets): на проде
      // работает второй путь, через src. Не удалять его как «dev-фолбэк».
      const candidates = [
        path.join(__dirname, 'migrations', file),
        path.join(__dirname, '..', '..', 'src', 'insights', 'migrations', file),
      ];
      const p = candidates.find((c) => fs.existsSync(c));
      if (!p) {
        this.log.error(`insights migration ${file} not found`);
        continue;
      }
      try {
        await this.pg.query(fs.readFileSync(p, 'utf8'));
      } catch (e: any) {
        this.log.error(`insights migration ${file} failed: ${e.message}`);
      }
    }
  }

  async isEnabled(): Promise<boolean> {
    const r = await this.pg.query(`SELECT value FROM insights_settings WHERE key = 'enabled'`);
    return r.rows[0]?.value === true;
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.pg.query(
      `INSERT INTO insights_settings (key, value) VALUES ('enabled', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(on)],
    );
  }

  async doneRunExists(weekStart: string): Promise<boolean> {
    const r = await this.pg.query(
      `SELECT 1 FROM insights_runs WHERE week_start = $1::date AND NOT manual AND status IN ('done', 'running', 'postponed') LIMIT 1`,
      [weekStart],
    );
    return r.rows.length > 0;
  }

  async createRun(weekStart: string, manual: boolean): Promise<string> {
    const r = await this.pg.query(
      `INSERT INTO insights_runs (week_start, manual, status) VALUES ($1::date, $2, 'running') RETURNING id::text AS id`,
      [weekStart, manual],
    );
    return r.rows[0].id;
  }

  async markRunning(id: string): Promise<void> {
    await this.pg.query(`UPDATE insights_runs SET status = 'running', started_at = now() WHERE id = $1::uuid`, [id]);
  }

  async finishRun(
    id: string,
    p: { conversations: number; people: number; crisis: number; signals: Signals; costUsd: number },
  ): Promise<void> {
    await this.pg.query(
      `UPDATE insights_runs
          SET status = 'done', finished_at = now(), conversations = $2, people = $3, crisis_count = $4,
              signals = $5::jsonb, cost_usd = $6, error = NULL
        WHERE id = $1::uuid`,
      [id, p.conversations, p.people, p.crisis, JSON.stringify(p.signals), p.costUsd],
    );
  }

  async failRun(id: string, error: string): Promise<void> {
    await this.pg.query(
      `UPDATE insights_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1::uuid`,
      [id, error.slice(0, 1000)],
    );
  }

  /** Отложить на 6 часов. Возвращает число уже сделанных попыток. */
  async postponeRun(id: string, error: string): Promise<number> {
    const r = await this.pg.query(
      `UPDATE insights_runs
          SET status = 'postponed', attempts = attempts + 1, retry_at = now() + interval '6 hours', error = $2
        WHERE id = $1::uuid
        RETURNING attempts`,
      [id, error.slice(0, 1000)],
    );
    return Number(r.rows[0]?.attempts ?? 0);
  }

  async duePostponed(maxAttempts: number): Promise<RunRow[]> {
    const r = await this.pg.query(
      `SELECT id::text AS id, to_char(week_start, 'YYYY-MM-DD') AS week_start, status, attempts, manual
         FROM insights_runs
        WHERE status = 'postponed' AND retry_at <= now() AND attempts < $1
        ORDER BY retry_at`,
      [maxAttempts],
    );
    return r.rows;
  }

  async setDigest(id: string, chatId: number, messageId: number | null, findingIds: string[]): Promise<void> {
    await this.pg.query(
      `UPDATE insights_runs SET digest_chat_id = $2, digest_message_id = $3, finding_ids = $4::uuid[] WHERE id = $1::uuid`,
      [id, chatId, messageId, findingIds],
    );
  }

  /** Находки последних восьми недель до weekStart — со статусами и числом людей на последней неделе. */
  async priorFindings(weekStart: string): Promise<PriorFinding[]> {
    const r = await this.pg.query(
      `SELECT f.id::text AS id, f.type, f.title, f.status, f.rejected_people,
              (SELECT count(*)::int FROM insights_finding_weeks w WHERE w.finding_id = f.id) AS weeks,
              (SELECT w.people FROM insights_finding_weeks w WHERE w.finding_id = f.id ORDER BY w.week_start DESC LIMIT 1) AS last_people
         FROM insights_findings f
        WHERE f.last_week >= $1::date - 56 AND f.last_week < $1::date
        ORDER BY f.last_week DESC`,
      [weekStart],
    );
    return r.rows.map((x: any) => ({
      id: x.id,
      type: x.type,
      title: x.title,
      status: x.status,
      weeks: Number(x.weeks ?? 0),
      lastPeople: Number(x.last_people ?? 0),
      rejectedPeople: x.rejected_people === null ? null : Number(x.rejected_people),
    }));
  }

  async saveFindings(weekStart: string, list: readonly SynthFinding[], prior: readonly PriorFinding[]): Promise<DigestFinding[]> {
    const priorById = new Map(prior.map((p) => [p.id, p]));
    const out: DigestFinding[] = [];
    for (const f of list) {
      let id: string;
      let status: FindingStatus = 'open';
      let weeksSeen = 1;
      let prevPeople: number | null = null;
      const before = f.priorId ? priorById.get(f.priorId) : undefined;
      if (before) {
        // Отклонённая сюда доходит, только если людей стало вдвое больше
        // (parseFindings) — тогда она снова открыта.
        const r = await this.pg.query(
          `UPDATE insights_findings
              SET title = $2, description = $3, proposal = $4, last_week = $5::date,
                  status = CASE WHEN status = 'rejected' THEN 'open' ELSE status END, updated_at = now()
            WHERE id = $1::uuid
            RETURNING id::text AS id, status`,
          [before.id, f.title, f.description, f.proposal, weekStart],
        );
        id = r.rows[0].id;
        status = r.rows[0].status;
        weeksSeen = before.weeks + 1;
        prevPeople = before.lastPeople;
      } else {
        const r = await this.pg.query(
          `INSERT INTO insights_findings (type, title, description, proposal, first_week, last_week)
           VALUES ($1, $2, $3, $4, $5::date, $5::date) RETURNING id::text AS id`,
          [f.type, f.title, f.description, f.proposal, weekStart],
        );
        id = r.rows[0].id;
      }
      await this.pg.query(
        `INSERT INTO insights_finding_weeks (finding_id, week_start, people, conversations, assistants, severity)
         VALUES ($1::uuid, $2::date, $3, $4, $5::text[], $6)
         ON CONFLICT (finding_id, week_start) DO UPDATE
           SET people = EXCLUDED.people, conversations = EXCLUDED.conversations,
               assistants = EXCLUDED.assistants, severity = EXCLUDED.severity`,
        [id, weekStart, f.people, f.conversations, f.assistants, f.severity],
      );
      out.push({ ...f, id, status, weeksSeen, prevPeople });
    }
    return out;
  }

  async findingForCallback(id: string): Promise<CallbackFinding | null> {
    const r = await this.pg.query(
      `SELECT f.id::text AS id, f.type, f.title, f.description, f.proposal, f.status,
              to_char(f.first_week, 'YYYY-MM-DD') AS first_week,
              w.people, w.conversations, w.assistants,
              (SELECT count(*)::int FROM insights_finding_weeks x WHERE x.finding_id = f.id) AS weeks,
              (SELECT r.finding_ids::text[] FROM insights_runs r
                WHERE f.id = ANY (r.finding_ids) ORDER BY r.started_at DESC LIMIT 1) AS run_finding_ids
         FROM insights_findings f
         LEFT JOIN LATERAL (
           SELECT y.people, y.conversations, y.assistants FROM insights_finding_weeks y
            WHERE y.finding_id = f.id ORDER BY y.week_start DESC LIMIT 1
         ) w ON true
        WHERE f.id = $1::uuid`,
      [id],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      id: x.id,
      type: x.type,
      title: x.title,
      description: x.description,
      proposal: x.proposal,
      status: x.status,
      firstWeek: x.first_week,
      people: Number(x.people ?? 0),
      conversations: Number(x.conversations ?? 0),
      assistants: x.assistants ?? [],
      weeks: Number(x.weeks ?? 0),
      runFindingIds: x.run_finding_ids ?? null,
    };
  }

  /** open → backlog одним UPDATE: второе нажатие (или гонка) получит false. */
  async claimBacklog(id: string): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE insights_findings SET status = 'backlog', updated_at = now() WHERE id = $1::uuid AND status = 'open' RETURNING id`,
      [id],
    );
    return r.rows.length > 0;
  }

  async setBacklogItem(id: string, itemId: string): Promise<void> {
    await this.pg.query(`UPDATE insights_findings SET backlog_item_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`, [id, itemId]);
  }

  async revertToOpen(id: string): Promise<void> {
    await this.pg.query(
      `UPDATE insights_findings SET status = 'open', updated_at = now()
        WHERE id = $1::uuid AND status = 'backlog' AND backlog_item_id IS NULL`,
      [id],
    );
  }

  async reject(id: string, people: number): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE insights_findings SET status = 'rejected', rejected_people = $2, updated_at = now()
        WHERE id = $1::uuid AND status = 'open' RETURNING id`,
      [id, people],
    );
    return r.rows.length > 0;
  }

  async statuses(ids: string[]): Promise<Map<string, FindingStatus>> {
    if (!ids.length) return new Map();
    const r = await this.pg.query(`SELECT id::text AS id, status FROM insights_findings WHERE id = ANY ($1::uuid[])`, [ids]);
    return new Map(r.rows.map((x: any) => [x.id, x.status]));
  }

  async status(): Promise<{ enabled: boolean; runs: unknown[] }> {
    const runs = await this.pg.query(
      `SELECT id::text AS id, to_char(week_start, 'YYYY-MM-DD') AS week_start, manual, status, attempts,
              conversations, people, crisis_count, cost_usd, error, started_at, finished_at
         FROM insights_runs ORDER BY started_at DESC LIMIT 5`,
    );
    return { enabled: await this.isEnabled(), runs: runs.rows };
  }
}
```

#### `src/insights/insights.migration.spec.ts`
```ts
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { INSIGHTS_MIGRATIONS } from './insights-store.service';

const PG = process.env.INSIGHTS_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('миграция insights', () => {
  jest.setTimeout(60_000);
  let pool: Pool;
  const sqlOf = (f: string) => fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8');

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 2 });
    // Гард на чужую базу: ниже DROP TABLE.
    const app = await pool.query(`SELECT to_regclass('public.token_transactions') AS t`);
    if (app.rows[0].t) throw new Error('INSIGHTS_PG_URL указывает на базу приложения');
    await pool.query('DROP TABLE IF EXISTS insights_finding_weeks, insights_findings, insights_runs, insights_settings CASCADE');
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('катится дважды без ошибок — старт каждый раз', async () => {
    for (const f of INSIGHTS_MIGRATIONS) await pool.query(sqlOf(f));
    for (const f of INSIGHTS_MIGRATIONS) await pool.query(sqlOf(f));
    const t = await pool.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('insights_runs','insights_findings','insights_finding_weeks','insights_settings')`,
    );
    expect(t.rows[0].n).toBe(4);
  });

  it('в таблицах нет колонок под пользователя и сессию', async () => {
    const c = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name LIKE 'insights_%' AND column_name ~ '(user|session|phone|email)'`,
    );
    expect(c.rows).toEqual([]);
  });
});
```

- [ ] Извлечь, прогон на ноде с `INSIGHTS_PG_URL` — `npx jest src/insights/insights.migration` зелёный.
- [ ] Коммит `insights: таблицы и хранилище`.

### Task 7: сбор разговоров и сигналов

#### `src/insights/insights-collect.service.ts`
```ts
import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TEST_USERS, TEST_USER_PATTERN } from '../common/test-users';
import { isCrisisConversation } from './crisis';
import type { Week } from './insights-week';
import { emptySignals, type Collected, type Conversation, type Signals, type Turn } from './insights.types';

export const MAX_CONVERSATIONS = 400;
export const CUSTOM_ASSISTANT = 'свой ассистент';

/**
 * «Живой пользователь»: не тестовый, не админ, не удалённый. Параметры $3
 * (тестовые номера) и $4 (маска) — общие для всех запросов сбора.
 */
export function liveUserSql(col: string): string {
  return `${col} <> ALL ($3::text[]) AND ${col} !~ $4
    AND NOT EXISTS (SELECT 1 FROM ai_profiles_consolidated ap WHERE ap.user_id = ${col} AND ap.isadmin)
    AND NOT EXISTS (SELECT 1 FROM user_id du WHERE du.internal_id = ${col} AND du.state = 'deleted')`;
}

/** Серии из двух и больше реплик человека подряд и реплики из одного «?». */
export function silenceSignals(turns: readonly Turn[]): { unansweredRuns: number; silentQuestionMarks: number } {
  let runs = 0;
  let marks = 0;
  let streak = 0;
  for (const t of turns) {
    if (t.role !== 'user') {
      streak = 0;
      continue;
    }
    streak += 1;
    if (streak === 2) runs += 1;
    if (/^[\s?？!.…]*[?？][\s?？!.…]*$/u.test(t.text)) marks += 1;
  }
  return { unansweredRuns: runs, silentQuestionMarks: marks };
}

type Head = Omit<Conversation, 'turns'>;

function group<R>(rows: readonly R[], keyOf: (r: R) => string, head: (r: R) => Head, turn: (r: R) => Turn): Conversation[] {
  const map = new Map<string, Conversation>();
  for (const row of rows) {
    const k = keyOf(row);
    let c = map.get(k);
    if (!c) {
      c = { ...head(row), turns: [] };
      map.set(k, c);
    }
    const t = turn(row);
    if (t.text.trim()) c.turns.push(t);
  }
  return [...map.values()];
}

@Injectable()
export class InsightsCollectService {
  constructor(private readonly pg: PgService) {}

  async collect(week: Week, maxConversations = MAX_CONVERSATIONS): Promise<Collected> {
    const p: unknown[] = [week.start, week.end, TEST_USERS, TEST_USER_PATTERN];
    const agents = await this.agentNames();
    const signals = emptySignals();
    const all = [
      ...(await this.web(p, agents)),
      ...(await this.telegram(p, agents, signals)),
      ...(await this.support(p)),
      ...(await this.calls(p, agents, signals)),
    ];
    signals.emptyOrFailedTurns = await this.badTurns(p);
    const kept: Conversation[] = [];
    for (const c of all) {
      if (!c.turns.some((t) => t.role === 'user')) continue;
      if (isCrisisConversation(c.turns)) {
        signals.crisisConversations += 1;
        continue;
      }
      const s = silenceSignals(c.turns);
      signals.unansweredRuns += s.unansweredRuns;
      signals.silentQuestionMarks += s.silentQuestionMarks;
      kept.push(c);
    }
    const userTurns = (c: Conversation) => c.turns.filter((t) => t.role === 'user').length;
    const conversations =
      kept.length > maxConversations ? [...kept].sort((a, b) => userTurns(b) - userTurns(a)).slice(0, maxConversations) : kept;
    const names = await this.names([...new Set(conversations.map((c) => c.userId))]);
    return { conversations, signals, names };
  }

  private async web(p: unknown[], agents: Map<string, string>): Promise<Conversation[]> {
    const r = await this.pg.query(
      `SELECT h.session_id, split_part(h.session_id, '_', 1) AS user_id, split_part(h.session_id, '_', 2) AS assistant_ref,
              h.sender_type, h.content
         FROM custom_chat_history h
        WHERE h.created_at >= $1 AND h.created_at < $2 AND h.message_type = 'text'
          AND ${liveUserSql(`split_part(h.session_id, '_', 1)`)}
        ORDER BY h.session_id, h.created_at, h.id`,
      p,
    );
    return group(
      r.rows,
      (row: any) => row.session_id,
      (row: any) => ({
        key: `web:${row.session_id}`,
        source: 'web',
        userId: row.user_id,
        assistant: String(row.assistant_ref).startsWith('custom:')
          ? CUSTOM_ASSISTANT
          : agents.get(String(row.assistant_ref)) ?? 'ассистент',
      }),
      (row: any) => ({ role: row.sender_type === 'human' ? 'user' : 'assistant', text: String(row.content ?? '') }),
    );
  }

  /**
   * Telegram: личка и группы, где за всё время писал только владелец. В
   * остальных группах пишут посторонние без согласия — их текст не уходит
   * никуда, считаются только сигналы.
   */
  private async telegram(p: unknown[], agents: Map<string, string>, signals: Signals): Promise<Conversation[]> {
    const r = await this.pg.query(
      `SELECT c.id::text AS config_id, c.owner_user_id AS user_id, c.tg_chat_id::text AS chat_id,
              c.preset_agent_id, c.custom_agent_id::text AS custom_agent_id, m.role, m.content
         FROM tg_bot_messages m JOIN tg_bot_configs c ON c.id = m.config_id
        WHERE m.created_at >= $1 AND m.created_at < $2 AND m.role IN ('user', 'assistant')
          AND ${liveUserSql('c.owner_user_id')}
        ORDER BY c.id, m.created_at, m.id`,
      p,
    );
    if (!r.rows.length) return [];
    const chatOf = new Map<string, number>(r.rows.map((x: any) => [x.config_id, Number(x.chat_id)]));
    const groupIds = [...chatOf].filter(([, chat]) => chat < 0).map(([id]) => id);
    const ownerOnly = new Set<string>();
    if (groupIds.length) {
      const w = await this.pg.query(
        `SELECT m.config_id::text AS config_id,
                bool_and(m.tg_user_id IS NOT NULL AND i.tg_user_id IS NOT NULL AND m.tg_user_id = i.tg_user_id) AS only_owner
           FROM tg_bot_messages m
           JOIN tg_bot_configs c ON c.id = m.config_id
           LEFT JOIN tg_user_identities i ON i.linkeon_user_id = c.owner_user_id
          WHERE m.role = 'user' AND m.config_id = ANY ($1::uuid[])
          GROUP BY m.config_id`,
        [groupIds],
      );
      for (const row of w.rows) if (row.only_owner) ownerOnly.add(row.config_id);
    }
    const convs = group(
      r.rows,
      (row: any) => row.config_id,
      (row: any) => ({
        key: `tg:${row.config_id}`,
        source: 'tg',
        userId: row.user_id,
        assistant: row.custom_agent_id ? CUSTOM_ASSISTANT : agents.get(String(row.preset_agent_id)) ?? 'ассистент',
      }),
      (row: any) => ({ role: row.role === 'user' ? 'user' : 'assistant', text: String(row.content ?? '') }),
    );
    const out: Conversation[] = [];
    for (const c of convs) {
      const id = c.key.slice('tg:'.length);
      if ((chatOf.get(id) ?? 0) > 0 || ownerOnly.has(id)) {
        out.push(c);
        continue;
      }
      signals.thirdPartyGroupsSkipped += 1;
      const s = silenceSignals(c.turns);
      signals.unansweredRuns += s.unansweredRuns;
      signals.silentQuestionMarks += s.silentQuestionMarks;
    }
    return out;
  }

  private async support(p: unknown[]): Promise<Conversation[]> {
    const r = await this.pg.query(
      `SELECT t.id::text AS ticket_id, t.user_id, s.sender_type, s.content
         FROM support_messages s JOIN support_tickets t ON t.id = s.ticket_id
        WHERE s.created_at >= $1 AND s.created_at < $2 AND s.visible_to_user
          AND s.sender_type IN ('user', 'ai', 'owner') AND ${liveUserSql('t.user_id')}
        ORDER BY t.id, s.created_at, s.id`,
      p,
    );
    return group(
      r.rows,
      (row: any) => row.ticket_id,
      (row: any) => ({ key: `support:${row.ticket_id}`, source: 'support', userId: row.user_id, assistant: 'Поддержка' }),
      (row: any) => ({ role: row.sender_type === 'user' ? 'user' : 'assistant', text: String(row.content ?? '') }),
    );
  }

  /** Звонок ассистенту один на один — расшифровка; встреча с людьми — только сигналы. */
  private async calls(p: unknown[], agents: Map<string, string>, signals: Signals): Promise<Conversation[]> {
    const r = await this.pg.query(
      `SELECT v.id::text AS call_id, v.user_id, v.agent_id::text AS agent_id, v.provider, v.status, v.transcript
         FROM voice_calls v
        WHERE v.started_at >= $1 AND v.started_at < $2 AND ${liveUserSql('v.user_id')}`,
      p,
    );
    const out: Conversation[] = [];
    for (const row of r.rows) {
      if (row.provider !== 'linkeon') {
        signals.meetingsTotal += 1;
        if (row.status !== 'completed') signals.meetingsFailed += 1;
        continue;
      }
      const items: any[] = Array.isArray(row.transcript) ? row.transcript : [];
      const turns: Turn[] = items
        .filter((t) => typeof t?.text === 'string' && t.text.trim())
        .map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', text: t.text }));
      if (turns.length) {
        out.push({
          key: `call:${row.call_id}`,
          source: 'call',
          userId: row.user_id,
          assistant: `${agents.get(String(row.agent_id)) ?? 'ассистент'} (звонок)`,
          turns,
        });
      }
    }
    return out;
  }

  private async badTurns(p: unknown[]): Promise<number> {
    const r = await this.pg.query(
      `SELECT count(*)::int AS bad FROM events e
        WHERE e.name = 'chat_quality' AND e.ts >= $1 AND e.ts < $2 AND e.user_id IS NOT NULL
          AND (COALESCE((e.props->>'empty')::boolean, false) OR COALESCE((e.props->>'failed')::boolean, false))
          AND ${liveUserSql('e.user_id')}`,
      p,
    );
    return Number(r.rows[0]?.bad ?? 0);
  }

  private async agentNames(): Promise<Map<string, string>> {
    const r = await this.pg.query(`SELECT id::text AS id, COALESCE(NULLIF(display_name, ''), name) AS name FROM agents`);
    return new Map(r.rows.map((x: any) => [String(x.id), String(x.name)]));
  }

  /** Имена для обезличивания: профиль, Telegram, часть почты до @. */
  private async names(userIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!userIds.length) return out;
    const r = await this.pg.query(
      `SELECT a.user_id, a.email, a.profile_data->>'name' AS name, a.profile_data->>'family_name' AS family_name,
              a.profile_data->>'user_nickname' AS nick, i.tg_first_name, i.tg_username
         FROM ai_profiles_consolidated a LEFT JOIN tg_user_identities i ON i.linkeon_user_id = a.user_id
        WHERE a.user_id = ANY ($1::text[])`,
      [userIds],
    );
    for (const row of r.rows) {
      const list = [row.name, row.family_name, row.nick, row.tg_first_name, row.tg_username, String(row.email || '').split('@')[0]]
        .map((s) => String(s || '').trim())
        .filter((s) => Array.from(s).length >= 3);
      out.set(row.user_id, [...new Set(list)]);
    }
    return out;
  }
}
```

#### `src/insights/insights-collect.spec.ts`
```ts
import { Pool } from 'pg';
import { InsightsCollectService, CUSTOM_ASSISTANT, silenceSignals } from './insights-collect.service';
import { weekOf } from './insights-week';

describe('silenceSignals', () => {
  it('серии реплик подряд и «?» в тишину', () => {
    const s = silenceSignals([
      { role: 'user', text: 'вопрос' },
      { role: 'user', text: '?' },
      { role: 'user', text: '??' },
      { role: 'assistant', text: 'ответ' },
      { role: 'user', text: 'спасибо' },
    ]);
    expect(s).toEqual({ unansweredRuns: 1, silentQuestionMarks: 2 });
  });
});

const PG = process.env.INSIGHTS_PG_URL;
const maybe = PG ? describe : describe.skip;

/**
 * Минимальные копии таблиц-источников — ровно те колонки, что читает сбор.
 * Живёт в scratch-базе insights_test на ноде; на базу приложения спека не
 * пойдёт (гард ниже).
 */
const SCHEMA = `
DROP TABLE IF EXISTS custom_chat_history, ai_profiles_consolidated, user_id, agents, tg_bot_configs,
  tg_bot_messages, tg_user_identities, support_tickets, support_messages, voice_calls, events CASCADE;
CREATE TABLE custom_chat_history (id serial PRIMARY KEY, session_id text NOT NULL, sender_type text NOT NULL,
  agent int, content text NOT NULL, created_at timestamptz NOT NULL, message_type text NOT NULL DEFAULT 'text');
CREATE TABLE ai_profiles_consolidated (user_id text PRIMARY KEY, email text, isadmin boolean DEFAULT false, profile_data jsonb DEFAULT '{}');
CREATE TABLE user_id (internal_id text PRIMARY KEY, state text);
CREATE TABLE agents (id int PRIMARY KEY, name text, display_name text);
CREATE TABLE tg_bot_configs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id text NOT NULL, tg_chat_id bigint,
  preset_agent_id text, custom_agent_id uuid, display_name text NOT NULL DEFAULT 'бот');
CREATE TABLE tg_bot_messages (id bigserial PRIMARY KEY, config_id uuid NOT NULL, tg_chat_id bigint, tg_user_id bigint,
  role text NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL);
CREATE TABLE tg_user_identities (linkeon_user_id text PRIMARY KEY, tg_user_id bigint UNIQUE, tg_username text, tg_first_name text);
CREATE TABLE support_tickets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL);
CREATE TABLE support_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL, sender_type text NOT NULL,
  content text NOT NULL, visible_to_user boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL);
CREATE TABLE voice_calls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, agent_id int, provider text NOT NULL,
  status text NOT NULL, transcript jsonb, started_at timestamptz NOT NULL);
CREATE TABLE events (id bigserial PRIMARY KEY, ts timestamptz NOT NULL, user_id text, name text NOT NULL, props jsonb NOT NULL DEFAULT '{}');
`;

maybe('сбор разговоров недели', () => {
  jest.setTimeout(60_000);
  let pool: Pool;
  let svc: InsightsCollectService;
  const week = weekOf('2026-10-19');
  const IN = '2026-10-20T10:00:00Z';
  const OUT = '2026-10-10T10:00:00Z';

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 2 });
    const app = await pool.query(`SELECT to_regclass('public.token_transactions') AS t`);
    if (app.rows[0].t) throw new Error('INSIGHTS_PG_URL указывает на базу приложения');
    await pool.query(SCHEMA);
    await pool.query(`INSERT INTO agents VALUES (12, 'Роман', ''), (21, 'Кира', 'Кира')`);
    await pool.query(`INSERT INTO ai_profiles_consolidated (user_id, email, isadmin, profile_data) VALUES
      ('79990000001', 'vova@mail.ru', false, '{"name":"Владимир"}'),
      ('79990000002', null, true, '{}'),
      ('79990000003', null, false, '{}'),
      ('79990000004', null, false, '{}')`);
    await pool.query(`INSERT INTO user_id VALUES ('79990000003', 'deleted')`);
    const chat = async (session: string, rows: Array<[string, string]>, at = IN) => {
      for (const [who, text] of rows) {
        await pool.query(`INSERT INTO custom_chat_history (session_id, sender_type, agent, content, created_at) VALUES ($1, $2, 12, $3, $4)`, [
          session,
          who,
          text,
          at,
        ]);
      }
    };
    await chat('79990000001_12', [['human', 'Я Владимир, где завести бота?'], ['ai', 'В Студии']]);
    await chat('79990000001_custom:9f1c0a55-0000-0000-0000-000000000000', [['human', 'вопрос своему'], ['ai', 'ответ']]);
    await chat('70000000000_12', [['human', 'тестовый'], ['ai', 'ответ']]);
    await chat('79990000002_12', [['human', 'админ'], ['ai', 'ответ']]);
    await chat('79990000003_12', [['human', 'удалённый'], ['ai', 'ответ']]);
    await chat('79990000004_12', [['human', 'мне плохо'], ['ai', 'Позвоните: 8-800-2000-122']]);
    await chat('79990000004_21', [['human', 'старое'], ['ai', 'ответ']], OUT);
    await pool.query(`INSERT INTO tg_user_identities VALUES ('79990000001', 5001, null, 'Вова')`);
    const cfg = async (chatId: number) =>
      (await pool.query(`INSERT INTO tg_bot_configs (owner_user_id, tg_chat_id, preset_agent_id) VALUES ('79990000001', $1, '12') RETURNING id`, [chatId]))
        .rows[0].id;
    const priv = await cfg(5001);
    const ownerGroup = await cfg(-100);
    const mixedGroup = await cfg(-200);
    const tg = async (config: string, user: number | null, role: string, text: string) =>
      pool.query(`INSERT INTO tg_bot_messages (config_id, tg_user_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)`, [config, user, role, text, IN]);
    await tg(priv, 5001, 'user', 'личный вопрос');
    await tg(priv, null, 'assistant', 'ответ');
    await tg(ownerGroup, 5001, 'user', 'вопрос в своей группе');
    await tg(ownerGroup, null, 'assistant', 'ответ');
    await tg(mixedGroup, 5001, 'user', 'вопрос владельца');
    await tg(mixedGroup, 6002, 'user', 'посторонний пишет');
    await tg(mixedGroup, 6002, 'user', 'и ещё');
    const t = (await pool.query(`INSERT INTO support_tickets (user_id) VALUES ('79990000001') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO support_messages (ticket_id, sender_type, content, created_at) VALUES ($1, 'user', 'не могу пополнить', $2), ($1, 'ai', 'помогу', $2)`, [t, IN]);
    await pool.query(`INSERT INTO voice_calls (user_id, agent_id, provider, status, transcript, started_at) VALUES
      ('79990000001', 12, 'linkeon', 'completed', '[{"role":"user","text":"голосом","ts":1},{"role":"assistant","text":"ответ","ts":2}]', $1),
      ('79990000001', 12, 'linkeon_room', 'active', '[{"role":"user","text":"на встрече чужие люди","ts":1}]', $1)`, [IN]);
    await pool.query(`INSERT INTO events (ts, user_id, name, props) VALUES
      ($1, '79990000001', 'chat_quality', '{"ok":false,"empty":true}'),
      ($1, '70000000000', 'chat_quality', '{"ok":false,"failed":true}'),
      ($1, '79990000001', 'chat_quality', '{"ok":true}')`, [IN]);
    svc = new InsightsCollectService({ query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) } as any);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('берёт живых, отсекает тестовых, админов, удалённых и прошлые недели', async () => {
    const out = await svc.collect(week);
    const keys = out.conversations.map((c) => c.key).sort();
    expect(keys.filter((k) => k.startsWith('web:'))).toEqual([
      'web:79990000001_12',
      'web:79990000001_custom:9f1c0a55-0000-0000-0000-000000000000',
    ]);
    expect(out.conversations.every((c) => c.userId === '79990000001')).toBe(true);
  });

  it('кризисный разговор не берётся, только считается', async () => {
    const out = await svc.collect(week);
    expect(out.signals.crisisConversations).toBe(1);
    expect(out.conversations.some((c) => c.userId === '79990000004')).toBe(false);
  });

  it('Telegram: личка и группа с одним владельцем — да; группа с посторонними — только сигналы', async () => {
    const out = await svc.collect(week);
    const tgTexts = out.conversations.filter((c) => c.source === 'tg').flatMap((c) => c.turns.map((t) => t.text));
    expect(tgTexts).toEqual(expect.arrayContaining(['личный вопрос', 'вопрос в своей группе']));
    expect(tgTexts).not.toContain('посторонний пишет');
    expect(out.signals.thirdPartyGroupsSkipped).toBe(1);
    expect(out.signals.unansweredRuns).toBeGreaterThanOrEqual(1);
  });

  it('свой ассистент — без имени, звонок — расшифровкой, встреча — сигналом', async () => {
    const out = await svc.collect(week);
    expect(out.conversations.find((c) => c.key.includes('custom:'))?.assistant).toBe(CUSTOM_ASSISTANT);
    expect(out.conversations.find((c) => c.source === 'call')?.assistant).toBe('Роман (звонок)');
    expect(out.conversations.flatMap((c) => c.turns.map((t) => t.text))).not.toContain('на встрече чужие люди');
    expect(out.signals).toMatchObject({ meetingsTotal: 1, meetingsFailed: 1 });
  });

  it('пустые и упавшие ответы — только живых', async () => {
    expect((await svc.collect(week)).signals.emptyOrFailedTurns).toBe(1);
  });

  it('имена для обезличивания — из профиля, Telegram и почты', async () => {
    const out = await svc.collect(week);
    expect(out.names.get('79990000001')).toEqual(expect.arrayContaining(['Владимир', 'Вова', 'vova']));
  });
});
```

- [ ] Извлечь, прогон на ноде с `INSIGHTS_PG_URL`: `npx jest src/insights/insights-collect` — зелёный (без переменной — только `silenceSignals`).
- [ ] Коммит `insights: сбор разговоров и сигналов недели`.

### Task 8: прогон, кнопки, ручка, расписание

#### `src/insights/insights.service.ts`
```ts
import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import { PgService } from '../common/services/pg.service';
import { classifyLlmError } from '../monitoring/claude-health.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { InsightsCollectService } from './insights-collect.service';
import { buildDigest, buildKeyboard, insightsChatId, type DigestInput } from './insights-digest';
import { buildLabelPrompt, LABEL_BATCH, LABEL_MODEL, LABEL_SYSTEM, parseLabels, type LabelInput } from './insights-label';
import { InsightsStore, type RunRow } from './insights-store.service';
import { buildSynthPrompt, parseFindings, SYNTH_SYSTEM, synthModel } from './insights-synth';
import { weekLabel, weekOf, type Week } from './insights-week';
import type { Label, SynthFinding } from './insights.types';

/** Один прогон за раз на все процессы API. */
export const INSIGHTS_LOCK_KEY = 7_361_001;
export const MAX_POSTPONES = 3;

/** Недельный лимит или rate limit подписки: прогон откладывается, а не падает. */
export class PostponeError extends Error {}

function isLimit(msg: string): boolean {
  const kind = classifyLlmError(msg).kind;
  return kind === 'weekly_limit' || kind === 'rate_limit';
}

@Injectable()
export class InsightsService {
  private readonly log = new Logger('Insights');

  constructor(
    private readonly store: InsightsStore,
    private readonly collector: InsightsCollectService,
    private readonly claude: ClaudeCliService,
    private readonly pg: PgService,
    @Inject(forwardRef(() => TgGrammyClient)) private readonly tg: TgGrammyClient,
  ) {}

  /** Плановый прогон — один раз на неделю. */
  async runScheduled(week: Week): Promise<void> {
    if (await this.store.doneRunExists(week.weekStart)) return;
    const id = await this.store.createRun(week.weekStart, false);
    await this.execute(id, week);
  }

  /** Ручной прогон из админки: в фоне, сразу возвращает id. Сводка — только владельцу. */
  async startManual(week: Week): Promise<string> {
    const id = await this.store.createRun(week.weekStart, true);
    void this.execute(id, week).catch((e) => this.log.error(`ручной прогон ${id}: ${e?.message}`));
    return id;
  }

  async retry(run: RunRow): Promise<void> {
    await this.store.markRunning(run.id);
    await this.execute(run.id, weekOf(run.week_start));
  }

  async execute(runId: string, week: Week): Promise<void> {
    const lock = await this.pg.tryAdvisoryLock(INSIGHTS_LOCK_KEY);
    if (!lock) {
      await this.store.failRun(runId, 'другой прогон уже идёт');
      return;
    }
    try {
      const collected = await this.collector.collect(week);
      // «Человек N» — только внутри прогона: номер нигде не сохраняется.
      const personOf = new Map<string, number>();
      const inputs: LabelInput[] = collected.conversations.map((conversation) => {
        if (!personOf.has(conversation.userId)) personOf.set(conversation.userId, personOf.size + 1);
        return { person: personOf.get(conversation.userId)!, conversation };
      });
      let cost = 0;
      const labels: Label[] = [];
      for (let i = 0; i < inputs.length; i += LABEL_BATCH) {
        const batch = inputs.slice(i, i + LABEL_BATCH);
        const prompt = buildLabelPrompt(batch, (u) => collected.names.get(u) ?? []);
        const r = await this.callModel(prompt, LABEL_SYSTEM, LABEL_MODEL, 120_000, (t) => parseLabels(t, batch));
        cost += r.cost;
        if (r.value) labels.push(...r.value);
        else this.log.warn(`пачка разговоров ${i / LABEL_BATCH + 1} пропущена: разметка не разобралась дважды`);
      }
      const prior = await this.store.priorFindings(week.weekStart);
      let findings: SynthFinding[] = [];
      if (labels.length) {
        const prompt = buildSynthPrompt({ weekLabel: weekLabel(week.weekStart), labels, signals: collected.signals, prior });
        const r = await this.callModel(prompt, SYNTH_SYSTEM, synthModel(), 300_000, (t) => parseFindings(t, labels, prior));
        cost += r.cost;
        if (!r.value) throw new Error('сводка не разобралась дважды');
        findings = r.value;
      }
      const saved = await this.store.saveFindings(week.weekStart, findings, prior);
      const totals = {
        conversations: inputs.length,
        people: personOf.size,
        crisis: collected.signals.crisisConversations,
        signals: collected.signals,
      };
      await this.store.finishRun(runId, { ...totals, costUsd: cost });
      await this.sendDigest(runId, { weekStart: week.weekStart, ...totals, findings: saved });
    } catch (e: any) {
      await this.handleFailure(runId, week, e);
    } finally {
      await lock.release();
    }
  }

  /** Вызов модели с одним повтором. null — ответ дважды не по форме или вызов дважды упал. */
  private async callModel<T>(
    prompt: string,
    system: string,
    model: string,
    timeoutMs: number,
    parse: (text: string) => T | null,
  ): Promise<{ value: T | null; cost: number }> {
    let cost = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await this.claude.textWithCost(prompt, { system, model, timeoutMs });
        cost += r.costUsd || 0;
        const value = parse(r.text);
        if (value !== null) return { value, cost };
        // Отказ CLI иногда приходит под видом ответа — короткой строкой.
        if (r.text.length <= 300 && isLimit(r.text)) throw new PostponeError(r.text);
        this.log.warn(`ответ модели не по форме (попытка ${attempt})`);
      } catch (e: any) {
        if (e instanceof PostponeError) throw e;
        if (isLimit(String(e?.message))) throw new PostponeError(String(e?.message));
        this.log.warn(`модель не ответила (попытка ${attempt}): ${e?.message}`);
      }
    }
    return { value: null, cost };
  }

  private async handleFailure(runId: string, week: Week, e: any): Promise<void> {
    const reason = String(e?.message || e).slice(0, 200);
    if (e instanceof PostponeError) {
      const attempts = await this.store.postponeRun(runId, reason);
      if (attempts < MAX_POSTPONES) return;
      await this.store.failRun(runId, `лимит подписки ${MAX_POSTPONES} раза подряд: ${reason}`);
    } else {
      this.log.error(`прогон ${runId} не удался: ${reason}`);
      await this.store.failRun(runId, reason);
    }
    await this.notify(`Затыки недели · ${weekLabel(week.weekStart)}: сводка не собралась — ${reason}`);
  }

  private async sendDigest(runId: string, input: DigestInput): Promise<void> {
    const chatId = insightsChatId();
    if (!chatId) {
      this.log.warn('чат сводки не задан (INSIGHTS_TG_CHAT_ID / BLOG_APPROVER_TG_ID) — сводка не отправлена');
      return;
    }
    const { text, shown } = buildDigest(input);
    const msg: any = await this.tg.sendMessage(chatId, text, shown.length ? { reply_markup: buildKeyboard(shown) } : {});
    await this.store.setDigest(runId, chatId, msg?.message_id ?? null, shown.map((f) => f.id));
  }

  private async notify(text: string): Promise<void> {
    const chatId = insightsChatId();
    if (!chatId) return;
    try {
      await this.tg.sendMessage(chatId, text);
    } catch (e: any) {
      this.log.error(`не смог сообщить о сбое прогона: ${e?.message}`);
    }
  }
}
```

#### `src/insights/insights-callback.service.ts`
```ts
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { BacklogService } from '../backlog/backlog.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { buildKeyboard, insightsChatId } from './insights-digest';
import { InsightsStore, type CallbackFinding } from './insights-store.service';
import { FRICTION_LABELS } from './insights.types';

export function shouldRouteToInsights(data?: string): boolean {
  return String(data || '').startsWith('ins:');
}

export function parseInsightsCallback(data: string): { action: 'b' | 'r' | 'noop'; findingId: string } | null {
  const m = /^ins:(b|r|noop):([0-9a-f-]{36})$/i.exec(String(data || ''));
  return m ? { action: m[1] as 'b' | 'r' | 'noop', findingId: m[2] } : null;
}

/**
 * Описание задачи бэклога — без цифр о людях: задача в статусе done уходит
 * темой в публичный блог (blogTopicFromBacklog — заголовок и первые 500 знаков).
 */
export function backlogAnalysis(f: Pick<CallbackFinding, 'type' | 'description' | 'proposal'>): string {
  return [
    '## Проблема',
    '',
    f.description,
    '',
    '## Предложение',
    '',
    f.proposal,
    '',
    `_Находка бота «Затыки недели», тип: ${FRICTION_LABELS[f.type].toLowerCase()}._`,
  ].join('\n');
}

/** Счётчики — в комментарий: комментарии в блог не уходят. */
export function backlogCounts(f: Pick<CallbackFinding, 'people' | 'conversations' | 'assistants' | 'weeks' | 'firstWeek'>): string {
  return (
    `Счётчики на момент передачи: людей — ${f.people}, разговоров — ${f.conversations}; ` +
    `ассистенты: ${f.assistants.join(', ') || '—'}; недель с находкой — ${f.weeks}, впервые — неделя с ${f.firstWeek}.`
  );
}

@Injectable()
export class InsightsCallbackService {
  private readonly log = new Logger('InsightsCallback');

  constructor(
    private readonly store: InsightsStore,
    private readonly backlog: BacklogService,
    @Inject(forwardRef(() => TgGrammyClient)) private readonly tg: TgGrammyClient,
  ) {}

  async handleCallback(cb: any): Promise<void> {
    const answer = (text: string) => this.tg.answerCallbackQuery(cb?.id, { text }).catch(() => undefined);
    const chatId = insightsChatId();
    // Кнопки сводки — только у владельца и только в его чате.
    if (!chatId || Number(cb?.from?.id) !== chatId || Number(cb?.message?.chat?.id) !== chatId) {
      await answer('Недоступно');
      return;
    }
    const parsed = parseInsightsCallback(cb?.data);
    if (!parsed) {
      await answer('Не понял кнопку');
      return;
    }
    if (parsed.action === 'noop') {
      await answer('Уже обработано');
      return;
    }
    const f = await this.store.findingForCallback(parsed.findingId);
    if (!f) {
      await answer('Находка не найдена');
      return;
    }
    let reply: string;
    if (parsed.action === 'b') {
      if (!(await this.store.claimBacklog(f.id))) {
        await answer('Уже обработано');
        return;
      }
      try {
        const item = await this.backlog.create('insights', { title: f.title, analysis_md: backlogAnalysis(f), status: 'approved' });
        await this.store.setBacklogItem(f.id, item.id);
        try {
          await this.backlog.addComment(item.id, 'insights', backlogCounts(f));
        } catch (e: any) {
          this.log.warn(`комментарий со счётчиками к задаче ${item.id} не записан: ${e?.message}`);
        }
        reply = 'В бэклоге';
      } catch (e: any) {
        this.log.error(`задача из находки ${f.id} не заведена: ${e?.message}`);
        await this.store.revertToOpen(f.id);
        await answer('Не получилось завести задачу');
        return;
      }
    } else {
      if (!(await this.store.reject(f.id, f.people))) {
        await answer('Уже обработано');
        return;
      }
      reply = 'Отклонено';
    }
    await this.refreshKeyboard(f.runFindingIds, cb.message);
    await answer(reply);
  }

  private async refreshKeyboard(ids: string[] | null, message: any): Promise<void> {
    if (!ids?.length || !message?.message_id) return;
    const st = await this.store.statuses(ids);
    const reply_markup = buildKeyboard(ids.map((id) => ({ id, status: st.get(id) ?? 'open' })));
    try {
      await this.tg.getBot().api.editMessageReplyMarkup(message.chat.id, message.message_id, { reply_markup });
    } catch (e: any) {
      // Старое сообщение или та же клавиатура — не повод ронять нажатие.
      this.log.warn(`клавиатура сводки не обновлена: ${e?.message}`);
    }
  }
}
```

#### `src/insights/insights.cron.ts`
```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InsightsService, MAX_POSTPONES } from './insights.service';
import { InsightsStore } from './insights-store.service';
import { previousWeekMsk } from './insights-week';

/**
 * Сервис с кроном — только в InsightsModule: провайдер с @Cron в нескольких
 * модулях срабатывает по разу на каждый (так вышло с PersonasService).
 */
@Injectable()
export class InsightsCron {
  private readonly log = new Logger('InsightsCron');

  constructor(
    private readonly store: InsightsStore,
    private readonly insights: InsightsService,
  ) {}

  /** Понедельник 04:07 UTC = 07:07 по Москве: трафик чатов минимален, подписка общая. */
  @Cron('0 7 4 * * 1')
  async weekly(): Promise<void> {
    try {
      if (!(await this.store.isEnabled())) return;
      await this.insights.runScheduled(previousWeekMsk(new Date()));
    } catch (e: any) {
      this.log.error(`еженедельный прогон: ${e?.message}`);
    }
  }

  /** Отложенные из-за лимита подписки — повтор, когда подошёл срок. */
  @Cron('0 */30 * * * *')
  async retryPostponed(): Promise<void> {
    try {
      for (const run of await this.store.duePostponed(MAX_POSTPONES)) await this.insights.retry(run);
    } catch (e: any) {
      this.log.error(`повтор отложенного прогона: ${e?.message}`);
    }
  }
}
```

#### `src/insights/insights.controller.ts`
```ts
import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtGuard } from '../common/guards/jwt.guard';
import { InsightsService } from './insights.service';
import { InsightsStore } from './insights-store.service';
import { previousWeekMsk, weekOf } from './insights-week';

@Controller('')
export class InsightsController {
  constructor(
    private readonly insights: InsightsService,
    private readonly store: InsightsStore,
  ) {}

  /** Действия как у остальной админки: run (прогон прошлой или заданной недели), status, enable, disable. */
  @Post('admin/insights')
  @UseGuards(JwtGuard, AdminGuard)
  async action(@Body() body: any, @Res() res: Response) {
    switch (body?.action) {
      case 'run': {
        let week;
        try {
          week = body?.week ? weekOf(String(body.week)) : previousWeekMsk(new Date());
        } catch (e: any) {
          return res.status(400).json({ error: e.message });
        }
        const runId = await this.insights.startManual(week);
        return res.status(202).json({ runId, weekStart: week.weekStart });
      }
      case 'status':
        return res.status(200).json(await this.store.status());
      case 'enable':
        await this.store.setEnabled(true);
        return res.status(200).json({ enabled: true });
      case 'disable':
        await this.store.setEnabled(false);
        return res.status(200).json({ enabled: false });
      default:
        return res.status(400).json({ error: `Unknown action: ${body?.action}` });
    }
  }
}
```

#### `src/insights/insights.module.ts`
```ts
import { Module, forwardRef } from '@nestjs/common';
import { BacklogModule } from '../backlog/backlog.module';
import { TgBotModule } from '../tg-bot/tg-bot.module';
import { InsightsCallbackService } from './insights-callback.service';
import { InsightsCollectService } from './insights-collect.service';
import { InsightsController } from './insights.controller';
import { InsightsCron } from './insights.cron';
import { InsightsService } from './insights.service';
import { InsightsStore } from './insights-store.service';

/**
 * Затыки недели. TgBotModule — через forwardRef с обеих сторон: бот зовёт
 * InsightsCallbackService (кнопки сводки), а сводка шлётся через TgGrammyClient.
 */
@Module({
  imports: [BacklogModule, forwardRef(() => TgBotModule)],
  controllers: [InsightsController],
  providers: [InsightsStore, InsightsCollectService, InsightsService, InsightsCron, InsightsCallbackService],
  exports: [InsightsCallbackService],
})
export class InsightsModule {}
```

#### `src/insights/insights.service.spec.ts`
```ts
import { InsightsService, MAX_POSTPONES } from './insights.service';
import { weekOf } from './insights-week';
import { emptySignals } from './insights.types';

const week = weekOf('2026-10-19');

function harness(over: { labelText?: string[]; synthText?: string[]; claudeError?: string; lock?: boolean; attempts?: number } = {}) {
  const calls: Array<{ prompt: string; opts: any }> = [];
  const labelQueue = [...(over.labelText ?? ['[{"conv":1,"items":[{"type":"confused","about":"путает два вида ботов","severity":2}]}]'])];
  const synthQueue = [
    ...(over.synthText ?? [
      JSON.stringify({
        findings: [{ prior_id: null, type: 'confused', title: 'Путают боты', description: 'Идут не во ту вкладку', proposal: 'Дать ссылку', people: [1], severity: 2 }],
      }),
    ]),
  ];
  const claude = {
    textWithCost: jest.fn(async (prompt: string, opts: any) => {
      calls.push({ prompt, opts });
      if (over.claudeError) throw new Error(over.claudeError);
      const queue = opts.model === 'claude-haiku-4-5' ? labelQueue : synthQueue;
      return { text: queue.length > 1 ? queue.shift()! : queue[0], costUsd: 0.01 };
    }),
  };
  const lock = { release: jest.fn() };
  const pg = { tryAdvisoryLock: jest.fn(async () => (over.lock === false ? null : lock)) };
  const store = {
    priorFindings: jest.fn(async () => []),
    saveFindings: jest.fn(async (_w: string, list: any[]) => list.map((f, i) => ({ ...f, id: `id-${i}`, status: 'open', weeksSeen: 1, prevPeople: null }))),
    finishRun: jest.fn(),
    failRun: jest.fn(),
    postponeRun: jest.fn(async () => over.attempts ?? 1),
    setDigest: jest.fn(),
  };
  const collector = {
    collect: jest.fn(async () => ({
      conversations: [
        {
          key: 'web:79990000001_12',
          source: 'web',
          userId: '79990000001',
          assistant: 'Роман',
          turns: [
            { role: 'user', text: 'Я Владимир, почта vova@mail.ru, телефон 8 903 016 91 87' },
            { role: 'assistant', text: 'ответ' },
          ],
        },
      ],
      signals: emptySignals(),
      names: new Map([['79990000001', ['Владимир']]]),
    })),
  };
  const tg = { sendMessage: jest.fn(async () => ({ message_id: 555 })) };
  const svc = new InsightsService(store as any, collector as any, claude as any, pg as any, tg as any);
  return { svc, calls, store, tg, lock, claude };
}

describe('InsightsService.execute', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.INSIGHTS_TG_CHAT_ID = '42';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('счастливый путь: разметка, сводка, запись, сводка владельцу с кнопками', async () => {
    const h = harness();
    await h.svc.execute('run-1', week);
    expect(h.store.finishRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ conversations: 1, people: 1, costUsd: 0.02 }));
    expect(h.tg.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('Затыки недели · 19–25 окт'), {
      reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    });
    expect(h.store.setDigest).toHaveBeenCalledWith('run-1', 42, 555, ['id-0']);
    expect(h.lock.release).toHaveBeenCalled();
  });

  it('модели не уходят телефон, почта, имя и userId', async () => {
    const h = harness();
    await h.svc.execute('run-1', week);
    const all = h.calls.map((c) => c.prompt).join('\n');
    expect(all).not.toMatch(/Владимир|vova@mail\.ru|903|79990000001/);
  });

  it('второй прогон при занятом замке не идёт', async () => {
    const h = harness({ lock: false });
    await h.svc.execute('run-1', week);
    expect(h.store.failRun).toHaveBeenCalledWith('run-1', 'другой прогон уже идёт');
    expect(h.claude.textWithCost).not.toHaveBeenCalled();
  });

  it('сводка дважды не по форме — прогон failed и сообщение владельцу', async () => {
    const h = harness({ synthText: ['мусор'] });
    await h.svc.execute('run-1', week);
    expect(h.store.failRun).toHaveBeenCalledWith('run-1', 'сводка не разобралась дважды');
    expect(h.tg.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('сводка не собралась'));
  });

  it('разметка дважды не по форме — пачка пропущена, прогон доходит до конца', async () => {
    const h = harness({ labelText: ['мусор'] });
    await h.svc.execute('run-1', week);
    expect(h.store.finishRun).toHaveBeenCalled();
    expect(h.tg.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('Затыков на этой неделе не нашлось.'), {});
  });

  it('недельный лимит — отложить без сообщения, а на третий раз — failed и сообщение', async () => {
    const first = harness({ claudeError: "You've hit your usage limit", attempts: 1 });
    await first.svc.execute('run-1', week);
    expect(first.store.postponeRun).toHaveBeenCalled();
    expect(first.tg.sendMessage).not.toHaveBeenCalled();

    const last = harness({ claudeError: "You've hit your usage limit", attempts: MAX_POSTPONES });
    await last.svc.execute('run-1', week);
    expect(last.store.failRun).toHaveBeenCalledWith('run-1', expect.stringContaining('лимит подписки'));
    expect(last.tg.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('сводка не собралась'));
  });
});
```

#### `src/insights/insights-callback.spec.ts`
```ts
import { backlogAnalysis, backlogCounts, InsightsCallbackService, parseInsightsCallback, shouldRouteToInsights } from './insights-callback.service';

const ID = '11111111-2222-3333-4444-555555555555';

const finding = {
  id: ID,
  type: 'confused' as const,
  title: 'Путают два вида ботов',
  description: 'Идут за своим ботом во вкладку групповых ботов',
  proposal: 'Дать во вкладке ссылку на Продукты',
  status: 'open' as const,
  firstWeek: '2026-10-12',
  people: 4,
  conversations: 6,
  assistants: ['Роман'],
  weeks: 2,
  runFindingIds: [ID],
};

function harness(over: { claim?: boolean; reject?: boolean; createFails?: boolean } = {}) {
  const store = {
    findingForCallback: jest.fn(async () => finding),
    claimBacklog: jest.fn(async () => over.claim ?? true),
    setBacklogItem: jest.fn(),
    revertToOpen: jest.fn(),
    reject: jest.fn(async () => over.reject ?? true),
    statuses: jest.fn(async () => new Map([[ID, 'backlog']])),
  };
  const backlog = {
    create: jest.fn(async () => {
      if (over.createFails) throw new Error('db down');
      return { id: 'item-1' };
    }),
    addComment: jest.fn(),
  };
  const editMessageReplyMarkup = jest.fn();
  const tg = { answerCallbackQuery: jest.fn(async () => undefined), getBot: () => ({ api: { editMessageReplyMarkup } }) };
  const svc = new InsightsCallbackService(store as any, backlog as any, tg as any);
  return { svc, store, backlog, tg, editMessageReplyMarkup };
}

const cb = (data: string, from = 42, chat = 42) => ({ id: 'cb1', data, from: { id: from }, message: { message_id: 9, chat: { id: chat } } });

describe('разбор кнопок', () => {
  it('префикс и форма', () => {
    expect(shouldRouteToInsights('ins:b:x')).toBe(true);
    expect(shouldRouteToInsights('blog:ok:x')).toBe(false);
    expect(parseInsightsCallback(`ins:b:${ID}`)).toEqual({ action: 'b', findingId: ID });
    expect(parseInsightsCallback('ins:b:not-a-uuid')).toBeNull();
  });
});

describe('текст задачи бэклога', () => {
  it('в описании нет цифр о людях, они — в комментарии', () => {
    expect(backlogAnalysis(finding)).not.toMatch(/\d/);
    expect(backlogCounts(finding)).toContain('людей — 4, разговоров — 6');
  });
});

describe('InsightsCallbackService', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.INSIGHTS_TG_CHAT_ID = '42';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('чужой аккаунт — отказ, ничего не меняется', async () => {
    const h = harness();
    await h.svc.handleCallback(cb(`ins:b:${ID}`, 7));
    expect(h.tg.answerCallbackQuery).toHaveBeenCalledWith('cb1', { text: 'Недоступно' });
    expect(h.store.claimBacklog).not.toHaveBeenCalled();
  });

  it('кнопка из чужого чата — отказ', async () => {
    const h = harness();
    await h.svc.handleCallback(cb(`ins:b:${ID}`, 42, -100));
    expect(h.store.claimBacklog).not.toHaveBeenCalled();
  });

  it('«В бэклог»: задача одобрена, без цифр, счётчики комментарием, клавиатура обновлена', async () => {
    const h = harness();
    await h.svc.handleCallback(cb(`ins:b:${ID}`));
    expect(h.backlog.create).toHaveBeenCalledWith('insights', { title: finding.title, analysis_md: backlogAnalysis(finding), status: 'approved' });
    expect(h.store.setBacklogItem).toHaveBeenCalledWith(ID, 'item-1');
    expect(h.backlog.addComment).toHaveBeenCalledWith('item-1', 'insights', backlogCounts(finding));
    expect(h.editMessageReplyMarkup).toHaveBeenCalledWith(42, 9, {
      reply_markup: { inline_keyboard: [[{ text: '1 ✓ В бэклоге', callback_data: `ins:noop:${ID}` }]] },
    });
    expect(h.tg.answerCallbackQuery).toHaveBeenLastCalledWith('cb1', { text: 'В бэклоге' });
  });

  it('повторное нажатие — «Уже обработано», задача не заводится второй раз', async () => {
    const h = harness({ claim: false });
    await h.svc.handleCallback(cb(`ins:b:${ID}`));
    expect(h.backlog.create).not.toHaveBeenCalled();
    expect(h.tg.answerCallbackQuery).toHaveBeenCalledWith('cb1', { text: 'Уже обработано' });
  });

  it('задача не завелась — находка снова открыта', async () => {
    const h = harness({ createFails: true });
    await h.svc.handleCallback(cb(`ins:b:${ID}`));
    expect(h.store.revertToOpen).toHaveBeenCalledWith(ID);
  });

  it('«Отклонить» запоминает число людей', async () => {
    const h = harness();
    await h.svc.handleCallback(cb(`ins:r:${ID}`));
    expect(h.store.reject).toHaveBeenCalledWith(ID, 4);
    expect(h.tg.answerCallbackQuery).toHaveBeenLastCalledWith('cb1', { text: 'Отклонено' });
  });
});
```

Правки существующих файлов:

- **`src/tg-bot/tg-bot.service.ts`**:
  - импорт `import { InsightsCallbackService, shouldRouteToInsights } from '../insights/insights-callback.service';`;
  - в конструктор последним параметром, после `costGrowth`:
    ```ts
    // Кнопки сводки «Затыки недели» — @Optional и последним: спеки собирают
    // сервис позиционно; кольцо модулей рвётся forwardRef, как у блога.
    @Optional() @Inject(forwardRef(() => InsightsCallbackService))
    private readonly insights?: InsightsCallbackService,
    ```
  - в `handleCallbackQuery` сразу после ветки блога:
    ```ts
    // Кнопки сводки — тоже до проверки привязки: владелец сводки
    // определяется чатом сводки, а не связкой ассистентов.
    if (shouldRouteToInsights(data)) {
      await this.insights?.handleCallback(cb);
      return;
    }
    ```
- **`src/tg-bot/tg-bot.module.ts`**: в `imports` добавить `forwardRef(() => InsightsModule)` (импорт из `../insights/insights.module`).
- **`src/app.module.ts`**: `InsightsModule` в `imports` рядом с `VpmModule`.
- **`src/common/guards/admin-routes.spec.ts`**: `describe('InsightsController')` — все методы под `JwtGuard` + `AdminGuard`.
- **`src/tg-bot/tg-bot.blog-routing.spec.ts`**: тест — `ins:` уходит в `insights.handleCallback` даже у непривязанного пользователя (сервис собирается с 15-м аргументом).

- [ ] Извлечь, правки, прогон `npx jest src/insights src/tg-bot/tg-bot.blog-routing src/common/guards/admin-routes src/chat/crisis-rule`, затем `npx tsc -p tsconfig.build.json --noEmit` — зелёные.
- [ ] Коммит `insights: прогон недели, кнопки сводки, админская ручка, расписание`.

### Task 9: пункт политики (фронт)

- **`src/components/onboarding/LegalModal.tsx`** (воркдерево фронта):
  - русская редакция, абзац «Цели AI-обработки» — дописать после «персонализация опыта»: «, а также анализ обезличенных текстов диалогов и обращений для выявления затруднений пользователей и улучшения сервиса. Для такого анализа из текстов заранее удаляются номера телефонов, адреса электронной почты, имена и иные идентификаторы; результаты хранятся только в обобщённом виде, без цитат и без связи с учетной записью.»;
  - английская, «Purposes of AI processing» — «…, personalizing the experience, and analyzing de-identified texts of conversations and support requests to identify where users run into difficulties and to improve the service. Before such analysis, phone numbers, email addresses, names and other identifiers are removed from the texts; the results are stored only in aggregated form, without quotes and without any link to the user account.»;
  - даты редакции политики (`Редакция от …` и `Last updated: …` у privacy) — дата выката.
- [ ] Тест (vitest) рядом с компонентом, если тестов политики нет: русская и английская редакции содержат новый пункт.
- [ ] Прогон на ноде, коммит `legal: политика — анализ обезличенных текстов для улучшения сервиса`.

### Task 10: ревью, слияние, выкат, первый прогон

- [ ] Спека: строку про `INSIGHTS_ENABLED` заменить выключателем в базе (`insights_settings`, действия `enable`/`disable`).
- [ ] Ревью обоих диффов субагентом против спеки; поправить найденное.
- [ ] Слить ветки в `main` обоих репозиториев, `deploy.sh` с ноды со свежих клонов (`SKIP_BOTS=1`, если к машине ботов встреч по-прежнему нет ключа).
- [ ] Проверка выката: таблицы `insights_*` на проде, маршрут `POST /webhook/admin/insights` без админа — 403.
- [ ] Ручной прогон (`{"action":"run"}`) админским токеном на самом сервере; дождаться `status` = done; сводка пришла владельцу. Если `sonnet` не принят CLI — `INSIGHTS_SYNTH_MODEL` не трогаем без владельца, сообщаем.
- [ ] Владелец смотрит первую сводку → `{"action":"enable"}` по его решению.
