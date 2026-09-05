# Детализация звонков в админке — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Из раздела «Звонки» можно провалиться в пользователя и прочитать, как шёл разговор, — чтобы видеть, почему половина звонков заканчивается ничем.

**Architecture:** Две новые админ-ручки: список звонков человека с посчитанными пометками (без расшифровок) и расшифровка одного звонка. В интерфейсе — ещё одна карточка-секция в существующем `UserActivityDrawer`, отдельным компонентом, как уже сделан `UserDevicesList`.

**Tech Stack:** NestJS 10, PostgreSQL (jsonb), React 18, Tailwind, Jest, Vitest.

**Спек:** `docs/superpowers/specs/2026-09-05-call-details-in-admin-design.md`

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `spirits_back/src/admin/callFlags.ts` (создать) | Чистые функции: пометки и счёт реплик из расшифровки |
| `spirits_back/src/admin/admin.service.ts` (правка, после `getCallsByUser` — строка ~1620) | `getUserCalls`, `getCallTranscript` |
| `spirits_back/src/admin/admin.controller.ts` (правка, после `admin/calls` — строка 243) | Два маршрута |
| `spirits_front/src/components/admin/UserCallsList.tsx` (создать) | Секция «Звонки» в карточке пользователя |
| `spirits_front/src/components/admin/callFlagLabels.ts` (создать) | Подписи и цвета пометок |
| `spirits_front/src/components/admin/UserActivityDrawer.tsx` (правка, рядом с `<UserDevicesList>` — строка 463) | Подключение секции |
| `spirits_front/src/App.tsx` (правка, строка 270) | Убрать глобальную кнопку звонка |
| `spirits_front/src/components/chat/AssistantSelection.tsx` (правка) | Кнопка звонка живёт здесь |

Пометки считаются на бэкенде отдельным модулем, а не внутри сервиса: `admin.service.ts` уже 1600+ строк, и класть туда ещё и логику разбора jsonb значит хоронить её от тестов.

---

## Task 1: Пометки звонка из расшифровки

**Files:**
- Create: `src/admin/callFlags.ts`
- Test: `src/admin/callFlags.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/admin/callFlags.spec.ts
import { countUserTurns, callFlags } from './callFlags';

describe('countUserTurns', () => {
  it('считает только реплики человека', () => {
    const t = [
      { ts: 1, role: 'assistant', text: 'Привет' },
      { ts: 2, role: 'user', text: 'Здравствуй' },
      { ts: 3, role: 'assistant', text: 'Слушаю' },
      { ts: 4, role: 'user', text: 'Вопрос' },
    ];
    expect(countUserTurns(t)).toBe(2);
  });

  it('мусор вместо массива не роняет: расшифровки может не быть вовсе', () => {
    expect(countUserTurns(null)).toBe(0);
    expect(countUserTurns(undefined)).toBe(0);
    expect(countUserTurns('строка' as any)).toBe(0);
    expect(countUserTurns([] as any)).toBe(0);
    expect(countUserTurns([{ role: 'user' }] as any)).toBe(1);
  });
});

describe('callFlags', () => {
  const реплики = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ts: i, role: 'user', text: 'а' }));

  it('прерванный звонок помечен и других пометок не получает', () => {
    expect(callFlags({ status: 'interrupted', duration_sec: null, transcript: null }))
      .toEqual(['interrupted']);
  });

  it('человек не сказал ни слова', () => {
    expect(callFlags({ status: 'completed', duration_sec: 120, transcript: [
      { ts: 1, role: 'assistant', text: 'Алло' },
    ] })).toContain('silent');
  });

  it('одна-две реплики — почти молчал', () => {
    expect(callFlags({ status: 'completed', duration_sec: 120, transcript: реплики(1) }))
      .toContain('nearly_silent');
    expect(callFlags({ status: 'completed', duration_sec: 120, transcript: реплики(2) }))
      .toContain('nearly_silent');
  });

  it('три реплики — уже нормальный разговор', () => {
    expect(callFlags({ status: 'completed', duration_sec: 120, transcript: реплики(3) }))
      .toEqual([]);
  });

  it('короткий завершённый звонок', () => {
    expect(callFlags({ status: 'completed', duration_sec: 12, transcript: реплики(5) }))
      .toEqual(['short']);
  });

  it('короткий И молчаливый получает обе пометки', () => {
    expect(callFlags({ status: 'completed', duration_sec: 5, transcript: [] }).sort())
      .toEqual(['short', 'silent']);
  });
});
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx jest src/admin/callFlags.spec.ts`
Expected: FAIL — `Cannot find module './callFlags'`

- [ ] **Step 3: Реализация**

```typescript
// src/admin/callFlags.ts

/** Реплика расшифровки: так её кладёт voice-host (проверено на проде). */
export interface TranscriptTurn {
  ts?: number;
  role?: string;
  text?: string;
}

export type CallFlag = 'interrupted' | 'silent' | 'nearly_silent' | 'short';

/** Меньше этого — «короткий»: на проде средний состоявшийся звонок 237 секунд. */
export const SHORT_CALL_SEC = 30;

/**
 * Сколько раз человек открыл рот.
 *
 * Терпит всё, что угодно вместо массива: расшифровки нет у трети звонков, а
 * jsonb-колонка не гарантирует форму. Падать здесь нельзя — это уронило бы
 * весь список звонков из-за одной битой строки.
 */
export function countUserTurns(transcript: unknown): number {
  if (!Array.isArray(transcript)) return 0;
  return transcript.filter((t) => (t as TranscriptTurn)?.role === 'user').length;
}

/**
 * Пометки, по которым видно, какой разговор стоит открыть.
 *
 * Смысл именно в проблемных: на 05.09.2026 из 68 звонков 22 не состоялись, а
 * ещё в 15 человек не произнёс ни реплики. Удачные диалоги пометок не имеют.
 */
export function callFlags(call: {
  status?: string;
  duration_sec?: number | null;
  transcript?: unknown;
}): CallFlag[] {
  // Прерванный — отдельный случай: у него нет ни длительности, ни расшифровки,
  // и остальные пометки посчитались бы как «молчал и короткий», что неверно.
  if (call.status === 'interrupted') return ['interrupted'];

  const flags: CallFlag[] = [];
  const turns = countUserTurns(call.transcript);
  if (turns === 0) flags.push('silent');
  else if (turns <= 2) flags.push('nearly_silent');

  const dur = call.duration_sec ?? 0;
  if (dur > 0 && dur < SHORT_CALL_SEC) flags.push('short');

  return flags;
}
```

- [ ] **Step 4: Прогнать тест**

Run: `npx jest src/admin/callFlags.spec.ts`
Expected: PASS, 8 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/admin/callFlags.ts src/admin/callFlags.spec.ts
git commit -m "feat(admin): пометки проблемных звонков из расшифровки"
```

---

## Task 2: Список звонков одного пользователя

**Files:**
- Modify: `src/admin/admin.service.ts` (добавить метод после `getCallsByUser`)
- Test: `src/admin/admin.user-calls.spec.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
// src/admin/admin.user-calls.spec.ts
import { AdminService } from './admin.service';

describe('getUserCalls', () => {
  const pg = { query: jest.fn() };
  const svc = new AdminService(pg as any);

  beforeEach(() => jest.resetAllMocks());

  it('отдаёт звонки с пометками и без расшифровок', async () => {
    pg.query.mockResolvedValue({
      rows: [
        {
          id: 'c-1', started_at: '2026-09-04T07:15:56Z', duration_sec: 153,
          status: 'completed', tokens_charged: 695, model: 'gpt-realtime',
          provider: 'linkeon', summary: 'Проверка связи',
          transcript: [{ ts: 1, role: 'assistant', text: 'Привет' }],
        },
        {
          id: 'c-2', started_at: '2026-09-03T10:00:00Z', duration_sec: null,
          status: 'interrupted', tokens_charged: 0, model: null,
          provider: 'linkeon', summary: null, transcript: null,
        },
      ],
    });

    const r = await svc.getUserCalls('79236230446');

    expect(r.calls).toHaveLength(2);
    expect(r.calls[0].flags).toContain('silent');
    expect(r.calls[1].flags).toEqual(['interrupted']);
    // Расшифровку в списке не отдаём: она тяжёлая и нужна по клику.
    expect(r.calls[0]).not.toHaveProperty('transcript');
  });

  it('user_id уходит параметром, а не склейкой в SQL', async () => {
    pg.query.mockResolvedValue({ rows: [] });
    await svc.getUserCalls("' OR 1=1 --");
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).not.toContain('OR 1=1');
    expect(params).toContain("' OR 1=1 --");
  });
});
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx jest src/admin/admin.user-calls.spec.ts`
Expected: FAIL — `svc.getUserCalls is not a function`

Если конструктор `AdminService` требует больше зависимостей — подставить
актуальные (проверить по объявлению класса); в тесте нужен только `pg`.

- [ ] **Step 3: Реализация**

Добавить в `admin.service.ts` (импорт `callFlags` — в шапку файла):

```typescript
  /**
   * Звонки одного человека для карточки в админке.
   *
   * Расшифровку СЮДА не кладём: 49 расшифровок на проде весят заметно больше
   * остального ответа, а нужны они по одной за раз. Пометки считаем здесь же,
   * чтобы интерфейс не тянул диалоги ради подсчёта реплик.
   *
   * Тестовые аккаунты не исключаем — в отличие от агрегата: сюда приходят по
   * конкретному user_id, и если это тестовый аккаунт, значит его и смотрят.
   */
  async getUserCalls(userId: string, opts: { limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const res = await this.pg.query(
      `SELECT c.id, c.started_at, c.ended_at, c.duration_sec, c.status,
              c.tokens_charged, c.model, c.provider, c.summary, c.transcript
         FROM voice_calls c
        WHERE c.user_id = $1
        ORDER BY c.started_at DESC
        LIMIT $2`,
      [userId, limit],
    );

    const calls = res.rows.map((r: any) => {
      const { transcript, ...rest } = r;
      return { ...rest, flags: callFlags(r), user_turns: countUserTurns(transcript) };
    });
    return { userId, calls };
  }

  /** Расшифровка одного звонка — по клику из списка. */
  async getCallTranscript(callId: string) {
    const res = await this.pg.query(
      `SELECT id, summary, transcript, duration_sec, status, started_at
         FROM voice_calls WHERE id = $1 LIMIT 1`,
      [callId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      ...row,
      transcript: Array.isArray(row.transcript) ? row.transcript : [],
    };
  }
```

В шапку файла добавить:

```typescript
import { callFlags, countUserTurns } from './callFlags';
```

- [ ] **Step 4: Прогнать тесты**

Run: `npx jest src/admin/admin.user-calls.spec.ts src/admin/callFlags.spec.ts`
Expected: PASS, 10 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/admin/admin.service.ts src/admin/admin.user-calls.spec.ts
git commit -m "feat(admin): список звонков пользователя с пометками"
```

---

## Task 3: Маршруты

**Files:**
- Modify: `src/admin/admin.controller.ts` (после метода `callsByUser`, строка ~243)

- [ ] **Step 1: Реализация**

```typescript
  @Get('admin/calls/user/:userId')
  async userCalls(
    @Param('userId') userId: string,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    const data = await this.adminService.getUserCalls(userId, {
      limit: limit ? parseInt(limit, 10) || undefined : undefined,
    });
    return res.status(200).json(data);
  }

  @Get('admin/calls/:id/transcript')
  async callTranscript(@Param('id') id: string, @Res() res: Response) {
    const data = await this.adminService.getCallTranscript(id);
    // 404, а не пустой объект: иначе интерфейс покажет пустой диалог и это
    // будет неотличимо от звонка, где человек молчал.
    if (!data) return res.status(404).json({ error: 'call not found' });
    return res.status(200).json(data);
  }
```

Порядок маршрутов важен: `admin/calls/user/:userId` объявляется ДО
`admin/calls/:id/transcript` — иначе `user` попадёт в `:id`.

`AdminGuard` стоит на уровне класса, отдельно вешать не нужно.

- [ ] **Step 2: Сборка**

Run: `npm run build`
Expected: `nest build` без ошибок

- [ ] **Step 3: Проверить на живых данных прода**

```bash
ssh dvolkov@212.113.106.202 'B=http://127.0.0.1:3001; P=79030169187; \
  curl -s "$B/webhook/898c938d-f094-455c-86af-969617e62f7a/sms/$P" >/dev/null; \
  C=$(curl -s "$B/webhook/debug/sms-code/$P" | grep -oE "[0-9]{4,6}" | head -1); \
  T=$(curl -s "$B/webhook/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/$P/$C" | python3 -c "import sys,json;print(json.load(sys.stdin)[\"access-token\"])"); \
  curl -s -H "Authorization: Bearer $T" "$B/webhook/admin/calls/user/79236230446" | head -c 400'
```

Expected: JSON со звонком, у которого есть `flags` и нет `transcript`.
Делать это ПОСЛЕ выката — на проде живые данные, локально их нет.

- [ ] **Step 4: Коммит**

```bash
git add src/admin/admin.controller.ts
git commit -m "feat(admin): ручки списка звонков пользователя и расшифровки"
```

---

## Task 4: Подписи пометок в интерфейсе

**Files:**
- Create: `spirits_front/src/components/admin/callFlagLabels.ts`
- Test: `spirits_front/src/components/admin/callFlagLabels.test.ts`

- [ ] **Step 1: Написать падающий тест**

```typescript
import { describe, it, expect } from 'vitest';
import { flagLabel, flagTone, KNOWN_FLAGS } from './callFlagLabels';

describe('подписи пометок', () => {
  const t = ((key: string, def?: string) => def ?? key) as any;

  it('у каждой известной пометки есть подпись и тон', () => {
    for (const f of KNOWN_FLAGS) {
      expect(flagLabel(f, t)).toBeTruthy();
      expect(['danger', 'warn', 'neutral']).toContain(flagTone(f));
    }
  });

  it('незнакомая пометка с бэкенда не роняет строку', () => {
    // Бэкенд может завести новую пометку раньше, чем обновится фронт.
    expect(flagLabel('что-то новое' as any, t)).toBe('что-то новое');
    expect(flagTone('что-то новое' as any)).toBe('neutral');
  });
});
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx vitest run src/components/admin/callFlagLabels.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализация**

```typescript
// src/components/admin/callFlagLabels.ts
import type { TFunction } from 'i18next';

export const KNOWN_FLAGS = ['interrupted', 'silent', 'nearly_silent', 'short'] as const;
export type CallFlag = (typeof KNOWN_FLAGS)[number];

const LABELS: Record<CallFlag, [string, string]> = {
  interrupted: ['admin.calls.flag.interrupted', 'не состоялся'],
  silent: ['admin.calls.flag.silent', 'человек молчал'],
  nearly_silent: ['admin.calls.flag.nearlySilent', 'почти молчал'],
  short: ['admin.calls.flag.short', 'короткий'],
};

const TONES: Record<CallFlag, 'danger' | 'warn' | 'neutral'> = {
  interrupted: 'danger',
  silent: 'danger',
  nearly_silent: 'warn',
  short: 'warn',
};

/**
 * Незнакомую пометку показываем как есть, а не прячем: бэкенд может завести
 * новую раньше, чем обновится фронт, и молча потерянная пометка хуже, чем
 * непереведённая.
 */
export function flagLabel(flag: string, t: TFunction): string {
  const pair = LABELS[flag as CallFlag];
  return pair ? t(pair[0], pair[1]) : flag;
}

export function flagTone(flag: string): 'danger' | 'warn' | 'neutral' {
  return TONES[flag as CallFlag] ?? 'neutral';
}
```

- [ ] **Step 4: Прогнать тест**

Run: `npx vitest run src/components/admin/callFlagLabels.test.ts`
Expected: PASS, 2 теста

- [ ] **Step 5: Коммит**

```bash
git add src/components/admin/callFlagLabels.ts src/components/admin/callFlagLabels.test.ts
git commit -m "feat(admin): подписи и цвета пометок звонков"
```

---

## Task 5: Секция «Звонки» в карточке пользователя

**Files:**
- Create: `spirits_front/src/components/admin/UserCallsList.tsx`
- Modify: `spirits_front/src/components/admin/UserActivityDrawer.tsx` (рядом с `<UserDevicesList phone={phone} />`, строка ~463)

- [ ] **Step 1: Реализация компонента**

```tsx
// src/components/admin/UserCallsList.tsx
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Phone, ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { apiClient } from '../../services/apiClient';
import { flagLabel, flagTone } from './callFlagLabels';

interface CallRow {
  id: string;
  started_at: string;
  duration_sec: number | null;
  status: string;
  tokens_charged: number;
  model: string | null;
  summary: string | null;
  flags: string[];
  user_turns: number;
}

interface Turn { ts?: number; role?: string; text?: string }

/**
 * Смещение реплики от начала разговора: «01:23». Пустая строка, если меток
 * времени нет — у части расшифровок ts может отсутствовать, и «NaN:NaN» в
 * диалоге хуже, чем ничего.
 */
function offsetLabel(firstTs?: number, ts?: number): string {
  if (typeof firstTs !== 'number' || typeof ts !== 'number') return '';
  const sec = Math.max(0, Math.round((ts - firstTs) / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

const TONE_CLASS = {
  danger: 'bg-red-50 text-red-700 border-red-200',
  warn: 'bg-amber-50 text-amber-700 border-amber-200',
  neutral: 'bg-gray-50 text-gray-600 border-gray-200',
} as const;

/**
 * Звонки человека — отдельным компонентом, как UserDevicesList: дровер уже
 * 990 строк, и класть туда ещё один экран значит сделать его нечитаемым.
 */
export const UserCallsList: React.FC<{ userId: string }> = ({ userId }) => {
  const { t } = useTranslation();
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Record<string, Turn[]>>({});

  useEffect(() => {
    let alive = true;
    apiClient
      .get(`/webhook/admin/calls/user/${encodeURIComponent(userId)}`)
      .then((r) => r.json())
      .then((d) => { if (alive) setCalls(d.calls ?? []); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [userId]);

  const toggle = async (id: string) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    if (turns[id]) return;
    try {
      const r = await apiClient.get(`/webhook/admin/calls/${encodeURIComponent(id)}/transcript`);
      const d = await r.json();
      setTurns((prev) => ({ ...prev, [id]: Array.isArray(d.transcript) ? d.transcript : [] }));
    } catch {
      setTurns((prev) => ({ ...prev, [id]: [] }));
    }
  };

  if (failed) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <p className="text-sm text-red-600">{t('admin.calls.loadFailed', 'Не удалось загрузить звонки')}</p>
      </div>
    );
  }
  if (calls === null) {
    return <div className="bg-white border border-gray-200 rounded-xl p-4 text-sm text-gray-400">…</div>;
  }
  if (calls.length === 0) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <h3 className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-gray-900">
        <Phone className="w-4 h-4 text-forest-600" />
        {t('admin.calls.sectionTitle', 'Звонки')}
        <span className="text-xs font-normal text-gray-500">({calls.length})</span>
      </h3>

      <ul className="flex flex-col gap-2">
        {calls.map((c) => {
          const open = openId === c.id;
          const interrupted = c.status === 'interrupted';
          return (
            <li key={c.id} className="rounded-lg border border-gray-200">
              <button
                onClick={() => !interrupted && toggle(c.id)}
                className={clsx(
                  'flex w-full items-start gap-2 p-3 text-left',
                  !interrupted && 'hover:bg-gray-50',
                )}
              >
                {!interrupted && (open
                  ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                  : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />)}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    <span>{new Date(c.started_at).toLocaleString()}</span>
                    {c.duration_sec ? <span>{Math.round(c.duration_sec / 60)} мин {c.duration_sec % 60} с</span> : null}
                    {c.flags.map((f) => (
                      <span key={f} className={clsx('rounded border px-1.5 py-0.5', TONE_CLASS[flagTone(f)])}>
                        {flagLabel(f, t)}
                      </span>
                    ))}
                  </span>
                  <span className="mt-1 block text-sm text-gray-800">
                    {c.summary || t('admin.calls.noSummary', 'Без саммари')}
                  </span>
                </span>
              </button>

              {open && (
                <div className="border-t border-gray-100 bg-gray-50 p-3">
                  {!turns[c.id] && <p className="text-xs text-gray-400">…</p>}
                  {turns[c.id]?.length === 0 && (
                    <p className="text-xs text-gray-500">{t('admin.calls.noTranscript', 'Расшифровки нет')}</p>
                  )}
                  <div className="flex flex-col gap-2">
                    {turns[c.id]?.map((turn, i, all) => (
                      <div key={i} className="text-sm">
                        {/* Время от начала разговора, а не абсолютное: важно
                            «на какой секунде человек замолчал», а не «в котором
                            часу». ts — epoch мс от voice-host. */}
                        <span className="mr-2 font-mono text-xs text-gray-400">
                          {offsetLabel(all[0]?.ts, turn.ts)}
                        </span>
                        <span className={clsx(
                          'mr-2 text-xs font-medium',
                          turn.role === 'user' ? 'text-forest-700' : 'text-gray-500',
                        )}>
                          {turn.role === 'user'
                            ? t('admin.calls.human', 'Человек')
                            : t('admin.calls.assistant', 'Ассистент')}
                        </span>
                        <span className="text-gray-800">{turn.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
```

- [ ] **Step 2: Подключить в дровер**

В `UserActivityDrawer.tsx` рядом со строкой `<UserDevicesList phone={phone} />`:

```tsx
              {/* Звонки — читать, как шёл разговор. phone здесь и есть user_id:
                  дровер получает его из списков админки как есть. */}
              {phone && <UserCallsList userId={phone} />}
```

и импорт в шапку:

```tsx
import { UserCallsList } from './UserCallsList';
```

- [ ] **Step 3: Проверка типов**

Run: `npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -c error`
Expected: столько же, сколько до правки (база — 48; своих ошибок не добавлять)

- [ ] **Step 4: Коммит**

```bash
git add src/components/admin/UserCallsList.tsx src/components/admin/UserActivityDrawer.tsx
git commit -m "feat(admin): звонки человека в его карточке, с раскрытием диалога"
```

---

## Task 6: Строки локализации

**Files:**
- Modify: `spirits_front/src/i18n/locales/{ru,en,es,de,fr,pt,zh}.json`

- [ ] **Step 1: Добавить ключи**

Ключи: `admin.calls.sectionTitle`, `admin.calls.loadFailed`, `admin.calls.noSummary`,
`admin.calls.noTranscript`, `admin.calls.human`, `admin.calls.assistant`,
`admin.calls.flag.interrupted`, `admin.calls.flag.silent`,
`admin.calls.flag.nearlySilent`, `admin.calls.flag.short`.

```
                      ru              en                de                es
sectionTitle          Звонки          Calls             Anrufe            Llamadas
loadFailed            Не удалось      Could not load    Anrufe nicht      No se pudieron
                      загрузить       calls             geladen           cargar
                      звонки
noSummary             Без саммари     No summary        Keine             Sin resumen
                                                        Zusammenfassung
noTranscript          Расшифровки     No transcript     Kein Transkript   Sin transcripción
                      нет
human                 Человек         Person            Person            Persona
assistant             Ассистент       Assistant         Assistent         Asistente
flag.interrupted      не состоялся    not connected     nicht verbunden   no conectó
flag.silent           человек молчал  person silent     Person schwieg    persona callada
flag.nearlySilent     почти молчал    barely spoke      kaum gesprochen   apenas habló
flag.short            короткий        short             kurz              corta
```

Французский: `Appels`, `Échec du chargement des appels`, `Sans résumé`,
`Pas de transcription`, `Personne`, `Assistant`, `non connecté`,
`personne silencieuse`, `a peu parlé`, `court`.

Португальский: `Chamadas`, `Falha ao carregar chamadas`, `Sem resumo`,
`Sem transcrição`, `Pessoa`, `Assistente`, `não conectou`,
`pessoa em silêncio`, `falou pouco`, `curta`.

Китайский: `通话`, `无法加载通话`, `无摘要`, `无转录`, `用户`, `助手`,
`未接通`, `用户未发言`, `几乎未发言`, `简短`.

- [ ] **Step 2: Проверить полноту**

Run: `node scripts/check-locales.mjs`
Expected: все локали зелёные, число ключей совпадает

- [ ] **Step 3: Коммит**

```bash
git add src/i18n/locales
git commit -m "i18n(admin): строки раздела звонков в семи локалях"
```

---

## Task 7: Кнопка звонка только в списке ассистентов

**Files:**
- Modify: `spirits_front/src/App.tsx:270`
- Modify: `spirits_front/src/components/chat/AssistantSelection.tsx`

- [ ] **Step 1: Убрать глобальную кнопку**

В `App.tsx` удалить строку `<FloatingCallButton />` и её импорт.

- [ ] **Step 2: Показать её в списке ассистентов**

В `AssistantSelection.tsx` — импорт и рендер в конце корневого элемента:

```tsx
import { FloatingCallButton } from './FloatingCallButton';
```

```tsx
      {/* Звонок предлагается там, где человек выбирает собеседника. В самой
          переписке кнопка не нужна: там звонок в шапке, а плавающая налезала
          на поле ввода (репорт владельца 05.09.2026). */}
      <FloatingCallButton />
```

- [ ] **Step 3: Убрать из FloatingCallButton отсечку по маршруту**

Внутри компонента больше не нужны `useLocation`, `inChat` и проверка
`viewportWidth >= 768`: он рендерится только там, где нужен. Удалить их,
оставив позиционирование и перетаскивание. `defaultPosition(viewport, inChat)`
вызывать с `false` — в списке ассистентов поля ввода нет, поднимать кнопку
не от чего.

- [ ] **Step 4: Прогнать тесты позиции и типов**

Run: `npx vitest run src/components/chat/floatingCallPosition.test.ts`
Expected: PASS, 12 тестов

Run: `npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -c error`
Expected: 48 (без новых)

- [ ] **Step 5: Коммит**

```bash
git add src/App.tsx src/components/chat/AssistantSelection.tsx src/components/chat/FloatingCallButton.tsx
git commit -m "fix(call): кнопка звонка живёт в списке ассистентов, а не на всех экранах"
```

---

## Task 8: Прогон и выкат

- [ ] **Step 1: Тесты и сборка на тестовой ноде**

```bash
git push -u origin <ветка>   # проверить, что коммит реально в origin/main
ssh dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q <sha> && source ~/.nvm/nvm.sh && cd ~/ci/spirits_back && npm ci --silent && npx jest src/admin 2>&1 | tail -5'
ssh dv@85.192.61.231 'git -C ~/ci/spirits_front fetch -q origin && git -C ~/ci/spirits_front checkout -q <sha> && source ~/.nvm/nvm.sh && cd ~/ci/spirits_front && pnpm install && pnpm test && pnpm build'
```

Ожидание: тесты `src/admin` зелёные; во фронте красным остаётся только
предсуществующий `customMarkdown.test.ts` (метка встречи, чужая работа).

- [ ] **Step 2: Выкат**

```bash
bash ~/Downloads/spirits_back/scripts/deploy.sh
```

Только с явного согласия владельца. Перед запуском убедиться, что рабочие
деревья чистые: параллельная сессия часто держит их занятыми, и защита
остановит выкат.

- [ ] **Step 3: Живая проверка на проде**

Открыть админку → «Звонки» → кликнуть по пользователю `79236230446` → в его
карточке должна быть секция «Звонки» с одним звонком, у которого есть саммари;
раскрыть — увидеть диалог репликами. Отдельно проверить, что на страницах
`/profile` и `/search` плавающей кнопки больше нет, а в списке ассистентов она
есть и перетаскивается.
