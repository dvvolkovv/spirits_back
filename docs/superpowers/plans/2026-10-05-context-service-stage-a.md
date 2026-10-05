# ContextService (этап A) — план внедрения

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Голосовой Роман получает время, календарь, задачи и баланс — всё, что уже лежит на сервере и чего он сегодня не видит.

**Architecture:** Один `ContextService` собирает контекст для всех облачных поверхностей по именованным секциям с бюджетами и рангом вытеснения. Поверхность заявляет профиль потребления. Первым подключается голос — у него преамбула собирается в одном методе; чат и Telegram переезжают позже.

**Tech Stack:** NestJS 10, TypeScript, PostgreSQL, Jest. Воркер голоса — `voice-host/` (LiveKit Agents + OpenAI Realtime).

**Спека:** `~/projects/texts/cases/my.linkeon/spec-context-sovereignty.md`, разделы 4, 7.1, 8.3.

## Global Constraints

- **Деплой только через `scripts/deploy.sh`.** Ручной `ssh + git pull + pm2 restart` запрещён (CLAUDE.md, DEPLOY POLICY).
- **Тяжёлые прогоны — на ноде** `dv@85.192.61.231`, в CI-клоне `~/ci/spirits_back`, по конкретному sha. Живой чекаут `~/spirits_back` на ноде не трогать.
- `source ~/.nvm/nvm.sh` обязателен в каждой ssh-команде с node.
- **Звонок не ронять.** Все источники контекста необязательные и под `catch`: нет профиля/календаря — разговор состоится, Роман просто знает меньше. Звонок стоит денег и начат пользователем.
- **В логи не писать содержимое контекста** — только имена секций, размеры и что вытеснено.
- Секция `device` в этом этапе **не реализуется** (этап B), но место под неё в типах закладывается.
- `voice-web` профиль потребления секцию `device` не получает **никогда** — у веба нет устройства.
- Отсутствие `origin` у звонка трактуется как `launcher`.

---

### Task 1: `ContextService` — секции, бюджеты, вытеснение

**Files:**
- Create: `src/context/context.types.ts`
- Create: `src/context/context.service.ts`
- Create: `src/context/context.module.ts`
- Create: `src/context/context.service.spec.ts`

**Interfaces:**
- Produces: `ContextService.build(userId: string, profile: ConsumerProfile, opts?: { clientTz?: string }): Promise<BuiltContext>`; `BuiltContext = { text: string; sections: SectionStat[] }`; `SectionStat = { name: SectionName; chars: number; dropped: boolean }`.
- Consumes: `TripService.getState(userId): Promise<CoPilotState>` (`src/trip/trip.service.ts:248`), `Neo4jService.getProfileDescription`, `BusinessProfileService.renderForPrompt`, `pg` для истории и баланса.

- [ ] **Step 1: Написать падающий тест на порядок секций и вытеснение**

```ts
// src/context/context.service.spec.ts
import { ContextService } from './context.service';

const noop = { query: jest.fn().mockResolvedValue({ rows: [] }) } as any;

describe('ContextService', () => {
  it('рендерит секции в порядке ранга и режет низкоранговые по бюджету', async () => {
    const svc = new ContextService(noop, null as any, null as any, null as any);
    jest.spyOn(svc as any, 'sectionNow').mockResolvedValue('СЕЙЧАС');
    jest.spyOn(svc as any, 'sectionToday').mockResolvedValue('Т'.repeat(5000));
    jest.spyOn(svc as any, 'sectionHistory').mockResolvedValue('И'.repeat(5000));

    const out = await svc.build('u1', 'voice-launcher');

    expect(out.text.indexOf('СЕЙЧАС')).toBeGreaterThanOrEqual(0);
    // now никогда не вытесняется — он дешёвый и самый нужный
    expect(out.sections.find((s) => s.name === 'now')!.dropped).toBe(false);
    // что-то обязано быть вытеснено, иначе бюджет не работает
    expect(out.sections.some((s) => s.dropped)).toBe(true);
  });

  it('device не собирается для профиля voice-web', async () => {
    const svc = new ContextService(noop, null as any, null as any, null as any);
    const out = await svc.build('u1', 'voice-web', { device: 'ЛИЧНОЕ' } as any);
    expect(out.text).not.toContain('ЛИЧНОЕ');
  });
});
```

- [ ] **Step 2: Прогнать — убедиться, что падает**

```
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/context --maxWorkers=2'
```
Expected: FAIL, «Cannot find module './context.service'».

- [ ] **Step 3: Типы секций**

```ts
// src/context/context.types.ts
export type SectionName =
  | 'identity' | 'now' | 'today' | 'history'
  | 'cloud_profile' | 'business' | 'device' | 'balance';

export type ConsumerProfile = 'voice-launcher' | 'voice-web' | 'chat' | 'tg';

export interface SectionSpec {
  /** Чем меньше, тем раньше вытесняется при нехватке бюджета. */
  rank: number;
  /** Потолок секции в знаках. */
  budget: number;
}

export interface SectionStat {
  name: SectionName;
  chars: number;
  dropped: boolean;
}

export interface BuiltContext {
  text: string;
  sections: SectionStat[];
}

/**
 * Состав и бюджеты по профилям потребления.
 *
 * Ранги читать так: `now` не вытесняется никогда (ранг максимальный) — без времени
 * ассистент врёт про «сегодня» и «завтра», и это дешевле всего починить. `history`
 * вытесняется первой: разговор её восстановит, а календарь — нет.
 *
 * ⚠️ `device` отсутствует у `voice-web` намеренно: у веба нет устройства, и
 * выжимка с чужого телефона туда попасть не может (спека §4.1).
 */
export const PROFILES: Record<ConsumerProfile, Partial<Record<SectionName, SectionSpec>>> = {
  'voice-launcher': {
    now:           { rank: 100, budget: 200 },
    identity:      { rank: 90,  budget: 200 },
    today:         { rank: 80,  budget: 1200 },
    device:        { rank: 70,  budget: 1200 },
    cloud_profile: { rank: 60,  budget: 1200 },
    business:      { rank: 50,  budget: 800 },
    balance:       { rank: 40,  budget: 120 },
    history:       { rank: 30,  budget: 1800 },
  },
  'voice-web': {
    now:           { rank: 100, budget: 200 },
    identity:      { rank: 90,  budget: 200 },
    today:         { rank: 80,  budget: 1200 },
    cloud_profile: { rank: 60,  budget: 1200 },
    business:      { rank: 50,  budget: 800 },
    balance:       { rank: 40,  budget: 120 },
    history:       { rank: 30,  budget: 1800 },
  },
  chat: {},
  tg: {},
};

/** Общий потолок на весь контекст. Realtime платит за преамбулу в каждом звонке. */
export const TOTAL_BUDGET = 6000;
```

- [ ] **Step 4: Сервис**

```ts
// src/context/context.service.ts
import { Injectable, Logger, Optional } from '@nestjs/common';
import { TripService } from '../trip/trip.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { BusinessProfileService } from '../business-profile/business-profile.service';
import {
  BuiltContext, ConsumerProfile, PROFILES, SectionName, SectionStat, TOTAL_BUDGET,
} from './context.types';

/**
 * Единственное место, где собирается контекст для облачных поверхностей.
 *
 * До этого каждая поверхность лепила промпт сама, и составы разошлись: у голоса
 * не было ни времени, ни календаря, ни задач — при том что всё это лежит на
 * сервере рядом. Отсюда «на локскрине встреча в 14:00, а Роман про неё не знает».
 *
 * Все источники необязательные и под catch: звонок начат пользователем и стоит
 * денег, ронять его из-за недоступного Neo4j нельзя.
 */
@Injectable()
export class ContextService {
  private readonly logger = new Logger(ContextService.name);

  constructor(
    private readonly pg: any,
    @Optional() private readonly trip?: TripService,
    @Optional() private readonly neo4j?: Neo4jService,
    @Optional() private readonly businessProfile?: BusinessProfileService,
  ) {}

  async build(
    userId: string,
    profile: ConsumerProfile,
    opts: { clientTz?: string; device?: string; agentId?: number } = {},
  ): Promise<BuiltContext> {
    const specs = PROFILES[profile] || {};
    const names = (Object.keys(specs) as SectionName[])
      .sort((a, b) => specs[b]!.rank - specs[a]!.rank);

    const rendered: { name: SectionName; text: string }[] = [];
    for (const name of names) {
      let text = '';
      try {
        text = (await this.renderSection(name, userId, opts)) || '';
      } catch (e: any) {
        this.logger.warn(`секция ${name} для ${userId} не собралась: ${e?.message}`);
        text = '';
      }
      const cap = specs[name]!.budget;
      if (text.length > cap) text = text.slice(0, cap) + '…';
      if (text.trim()) rendered.push({ name, text: text.trim() });
    }

    const stats: SectionStat[] = [];
    const kept: string[] = [];
    let left = TOTAL_BUDGET;
    for (const r of rendered) {
      if (r.text.length <= left) {
        left -= r.text.length;
        kept.push(r.text);
        stats.push({ name: r.name, chars: r.text.length, dropped: false });
      } else {
        stats.push({ name: r.name, chars: r.text.length, dropped: true });
      }
    }

    // Только имена и размеры. Содержимое контекста в логи не попадает никогда.
    this.logger.log(
      `[context] user=${userId} profile=${profile} ` +
        stats.map((s) => `${s.name}=${s.chars}${s.dropped ? '✂' : ''}`).join(' '),
    );

    return { text: kept.join('\n\n'), sections: stats };
  }

  private renderSection(
    name: SectionName, userId: string, opts: { clientTz?: string; device?: string; agentId?: number },
  ): Promise<string> {
    switch (name) {
      case 'now':           return this.sectionNow(opts.clientTz);
      case 'today':         return this.sectionToday(userId);
      case 'identity':      return this.sectionIdentity(userId);
      case 'cloud_profile': return this.sectionCloudProfile(userId);
      case 'business':      return this.sectionBusiness(userId);
      case 'balance':       return this.sectionBalance(userId);
      case 'history':       return this.sectionHistory(userId, opts.agentId);
      case 'device':        return Promise.resolve(opts.device || '');
      default:              return Promise.resolve('');
    }
  }

  /**
   * Время ГЛАЗАМИ ПОЛЬЗОВАТЕЛЯ. У голоса этого блока не было вовсе, и модель
   * считала «сегодня» от UTC сервера.
   */
  private async sectionNow(clientTz?: string): Promise<string> {
    const tz = clientTz && /^[A-Za-z]+\/[A-Za-z0-9_+\-\/]+$/.test(clientTz)
      ? clientTz : 'Asia/Yekaterinburg';
    const local = new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz, dateStyle: 'full', timeStyle: 'short',
    }).format(new Date());
    return `--- Сейчас ---\nУ пользователя ${local} (пояс ${tz}).\n` +
      `Считай «сегодня», «завтра» и сроки от ЭТОГО времени, а не от своего системного.`;
  }

  /**
   * Сегодняшний день из того же источника, что рисует лаунчер. Отметка времени
   * снимка нужна, чтобы при расхождении с экраном Роман мог честно сказать,
   * на какой момент у него данные (спека §4.4).
   */
  private async sectionToday(userId: string): Promise<string> {
    if (!this.trip) return '';
    const st = await this.trip.getState(userId);
    const lines: string[] = [];
    for (const e of (st.events || []).slice(0, 8)) {
      const time = String(e.at).slice(11, 16) || String(e.at);
      lines.push(`${time} — ${e.title}${e.location ? ` (${e.location})` : ''}`);
    }
    const open = (st.tasks || []).filter((t) => t.status === 'pending');
    for (const t of open.slice(0, 8)) lines.push(`дело: ${t.title}${t.overdue ? ' (просрочено)' : ''}`);
    if (!lines.length) return '';
    const stamp = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Asia/Yekaterinburg', timeStyle: 'short',
    }).format(new Date());
    return `--- День пользователя (данные на ${stamp}) ---\n${lines.join('\n')}`;
  }

  private async sectionIdentity(userId: string): Promise<string> {
    const r = await this.pg.query(
      `SELECT profile_data->>'name' AS name FROM ai_profiles_consolidated WHERE user_id = $1`,
      [userId],
    );
    const name = r.rows?.[0]?.name;
    return name ? `--- Собеседник ---\nИмя: ${name}.` : '';
  }

  /**
   * Neo4j помечается явно: это НЕ полный профиль человека, а то, что он сам
   * рассказывал в облачных чатах. Полный живёт на устройстве (спека §2.3).
   */
  private async sectionCloudProfile(userId: string): Promise<string> {
    if (!this.neo4j) return '';
    const text = (await this.neo4j.getProfileDescription(userId))?.trim();
    return text ? `--- Что ты знаешь по облачным чатам ---\n${text}` : '';
  }

  private async sectionBusiness(userId: string): Promise<string> {
    if (!this.businessProfile) return '';
    return (await this.businessProfile.renderForPrompt(userId, 'assistant'))?.trim() || '';
  }

  private async sectionBalance(userId: string): Promise<string> {
    const r = await this.pg.query(
      `SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1`, [userId],
    );
    const t = r.rows?.[0]?.tokens;
    return t == null ? '' : `--- Энергия ---\nОстаток: ${t}.`;
  }

  private async sectionHistory(userId: string, agentId = 12): Promise<string> {
    const res = await this.pg.query(
      `SELECT sender_type, content FROM custom_chat_history
       WHERE session_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [`${userId}_${agentId}`],
    );
    if (!res.rows?.length) return '';
    const lines: string[] = [];
    for (const r of res.rows) {
      const who = r.sender_type === 'human' ? 'Пользователь' : 'Ассистент';
      const text = String(r.content || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      lines.push(`${who}: ${text.length > 400 ? text.slice(0, 400) + '…' : text}`);
    }
    return lines.length ? `--- Из переписки ---\n${lines.reverse().join('\n')}` : '';
  }
}
```

- [ ] **Step 5: Модуль**

```ts
// src/context/context.module.ts
import { Module } from '@nestjs/common';
import { ContextService } from './context.service';
import { TripModule } from '../trip/trip.module';
import { Neo4jModule } from '../neo4j/neo4j.module';
import { BusinessProfileModule } from '../business-profile/business-profile.module';

@Module({
  imports: [TripModule, Neo4jModule, BusinessProfileModule],
  providers: [ContextService],
  exports: [ContextService],
})
export class ContextModule {}
```

- [ ] **Step 6: Прогнать — тесты зелёные**

```
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/context --maxWorkers=2'
```
Expected: PASS, 2 теста.

- [ ] **Step 7: Коммит**

```bash
git add src/context && git commit -m "feat(context): ContextService — секции с бюджетами и вытеснением"
```

---

### Task 2: Подключить голос к `ContextService`

**Files:**
- Modify: `src/voice-call/voice-call.service.ts:95-157` (`buildPreamble`, `profileBlock`), `:159-204` (`start`)
- Modify: `src/voice-call/voice-call.module.ts`
- Create: `src/voice-call/voice-call.context.spec.ts`

**Interfaces:**
- Consumes: `ContextService.build` из Task 1.
- Produces: `VoiceCallService.start(userId, origin?)` — сигнатура расширяется в Task 3.

- [ ] **Step 1: Тест — преамбула содержит время и день**

```ts
// src/voice-call/voice-call.context.spec.ts
describe('преамбула звонка', () => {
  it('содержит секции времени и дня', async () => {
    const ctx = { build: jest.fn().mockResolvedValue({
      text: '--- Сейчас ---\nУ пользователя воскресенье…\n\n--- День пользователя ---\n14:00 — Разбор макетов',
      sections: [{ name: 'now', chars: 40, dropped: false }],
    }) } as any;
    const svc: any = new (require('./voice-call.service').VoiceCallService)(
      { query: jest.fn().mockResolvedValue({ rows: [] }) }, null, null, null, null, ctx,
    );
    const text = await svc.buildPreamble('u1', 12, 'launcher');
    expect(text).toContain('Разбор макетов');
    expect(ctx.build).toHaveBeenCalledWith('u1', 'voice-launcher', expect.anything());
  });
});
```

- [ ] **Step 2: Прогнать — падает**

```
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/voice-call --maxWorkers=2'
```
Expected: FAIL.

- [ ] **Step 3: Переписать `buildPreamble` на сервис**

`buildPreamble` целиком заменяется на делегирование; `profileBlock` и константы `PREAMBLE_MSG_LIMIT`/`PREAMBLE_CHAR_LIMIT` удаляются — их роль теперь у `PROFILES`:

```ts
  /**
   * Контекст звонка. Раньше собирался здесь же из профиля и истории, без времени,
   * календаря и задач. Теперь — через ContextService, общий для облачных поверхностей.
   */
  async buildPreamble(
    userId: string,
    agentId: number = HOST_AGENT_ID,
    origin: 'launcher' | 'web' = 'launcher',
    device?: string,
  ): Promise<string> {
    if (!this.context) return '';
    const built = await this.context.build(
      userId,
      origin === 'web' ? 'voice-web' : 'voice-launcher',
      { agentId, device },
    );
    return built.text;
  }
```

- [ ] **Step 4: Прокинуть зависимость**

В конструктор `VoiceCallService` добавить `@Optional() private readonly context?: ContextService`, в `voice-call.module.ts` — `imports: [..., ContextModule]`.

- [ ] **Step 5: Прогнать — зелено**

```
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/voice-call --maxWorkers=2'
```
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/voice-call && git commit -m "feat(voice): контекст звонка через ContextService — время, день, задачи"
```

---

### Task 3: `origin` звонка

**Files:**
- Create: `src/voice-call/migrations/003_voice_call_origin.sql`
- Modify: `src/voice-call/voice-call.service.ts` (`start`, `onModuleInit`), `src/voice-call/voice-call.controller.ts:17-20`

- [ ] **Step 1: Миграция**

```sql
-- 003_voice_call_origin.sql
-- Откуда начат звонок. Нужно для двух вещей: профиля потребления контекста
-- (вебу секция device не положена — у него нет устройства) и срока хранения
-- транскрипта (спека §7).
--
-- Дефолт 'launcher' намеренно: старые версии компаньона метку не пришлют,
-- а они как раз лаунчерные, и ошибаться надо в сторону более короткого хранения.
ALTER TABLE voice_calls
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'launcher';
```

- [ ] **Step 2: Применить в `onModuleInit`** тем же способом, что `TasksService` (`src/tasks/tasks.service.ts:52-58`).

- [ ] **Step 3: Контроллер принимает тело**

```ts
  @Post('start')
  @UseGuards(JwtGuard)
  async start(@CurrentUser() u: any, @Body() body: any) {
    const origin = body?.origin === 'web' ? 'web' : 'launcher';
    return this.calls.start(String(u.userId), origin, body?.device);
  }
```

- [ ] **Step 4: `start` пишет origin и прокидывает в преамбулу** — `INSERT ... (id, user_id, agent_id, room_name, status, origin)`, и `this.buildPreamble(userId, HOST_AGENT_ID, origin, device)`.

- [ ] **Step 5: Прогон + коммит**

```
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/voice-call --maxWorkers=2'
git add -A src/voice-call && git commit -m "feat(voice): origin звонка (launcher|web) + профиль потребления контекста"
```

---

### Task 4: Роман знает правду о себе

**Files:**
- Modify: `voice-host/src/prompts.ts` (`callInstructions`)

- [ ] **Step 1: Добавить в инструкцию звонка абзац**

```
Твоё знание о собеседнике неполное: личный слой живёт на его телефоне и тебе
целиком не доступен. Если тебя спрашивают о том, чего ты про человека не знаешь,
прямо скажи, что этого не знаешь, и спроси. Не додумывай и не говори уверенно
о том, чего нет в контексте. Время и дела пользователя даны на момент снимка —
если расходится с тем, что он видит на экране, доверяй ему, а не себе.
```

- [ ] **Step 2: Коммит**

```bash
git add voice-host/src/prompts.ts && git commit -m "feat(voice): Роман говорит о границах своего знания вместо отсебятины"
```

---

### Task 5: Проверка на живом звонке и деплой

- [ ] **Step 1: Полный прогон юнит-тестов затронутых модулей**

```
ssh dv@85.192.61.231 'cd ~/ci/spirits_back && source ~/.nvm/nvm.sh && npx jest src/context src/voice-call src/trip --maxWorkers=2'
```

- [ ] **Step 2: Деплой**

```bash
bash scripts/deploy.sh
```
Expected: `ALL PHASES GREEN` (test → smoke → prod → smoke).

- [ ] **Step 3: Проверка на живом звонке с Vivo**

Завести событие на ближайший час, позвонить Роману с локскрина, спросить «что у меня сегодня». Ожидаем: называет событие и время верно.

- [ ] **Step 4: Проверить лог сборки**

```bash
ssh dvolkov@212.113.106.202 "pm2 logs linkeon-api --lines 200 --nostream | grep '\[context\]'"
```
Expected: строка вида `[context] user=… profile=voice-launcher now=120 identity=30 today=240 …`, **без содержимого секций**.

---

## Чего в этапе A нет

- Секция `device` — только место в типах; сбор выжимки на устройстве это этап B.
- Досылка `now`/`today` по data-каналу при длинном звонке (спека §4.5) — следующей задачей, после проверки базового состава.
- Переезд чата и Telegram на `ContextService` — после голоса.
- Инструменты календаря у звонка (спека §8.1) и починка пути к специалистам (§8.2).
