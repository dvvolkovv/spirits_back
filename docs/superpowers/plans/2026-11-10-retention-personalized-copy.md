# Персонализация Retention Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить имя пользователя и локализованную паузу в General/Curious email и SMS без чтения содержимого переписки или использования LLM.

**Architecture:** Небольшой pure-helper нормализует имя и форматирует дни/часы через `Intl.PluralRules`. Resolver обогащает контакт именем из `profile_data.name`; общий конструктор писем персонализирует приветствие и вставляет паузу. Внутренняя карта сегмента передаёт имя при отправке, поэтому публичная форма preview не меняется.

**Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL, Intl.PluralRules, Jest 29.

**Спецификация:** [2026-11-10-retention-personalized-copy-design.md](../specs/2026-11-10-retention-personalized-copy-design.md).

---

## Правила исполнения

1. Backend-работа — в новом worktree от актуального `origin/main` (`83f2377b`). Изменения frontend-кода не требуются.
2. Тесты и build — только на `dv@85.192.61.231` через CI-клон `~/ci/spirits_back`, на конкретном SHA. Не запускать Jest/tsc/build на Mac.
3. Реальные письма/SMS не отправлять. Выкат не входит в этот план и требует отдельного разрешения после зелёных проверок.
4. Каждый `git add` перечисляет файлы явно. Не трогать `ProfileService`, историю сообщений, каналы, cooldown, suppression и публичную форму preview.

### CI-команда для каждого прогона

Из backend-worktree:

```bash
back-ci() {
  local sha
  sha=$(git rev-parse HEAD) || return 1
  git push -q origin HEAD:refs/heads/wip/retention-personalized-copy && \
  ssh dv@85.192.61.231 "git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back checkout -q $sha && source ~/.nvm/nvm.sh && cd ~/ci/spirits_back && $*"
}
```

---

### Task 1: Имя и локализованная пауза в resolver

**Files:**
- Create: `src/retention/retention-personalization.ts`
- Create: `src/retention/retention-personalization.spec.ts`
- Modify: `src/retention/retention.types.ts:4-10`
- Modify: `src/retention/retention-recipient-resolver.ts:17,74-80`
- Modify: `src/retention/retention-recipient-resolver.spec.ts`

- [ ] **Step 1: Написать красный тест helpers**

`src/retention/retention-personalization.spec.ts`:

```ts
import { formatRetentionInactivity, normalizeRetentionName } from './retention-personalization';

describe('retention personalization', () => {
  it('берёт имя после trim, отсекает пустое и длиннее 80 символов', () => {
    expect(normalizeRetentionName('  Дмитрий  ')).toBe('Дмитрий');
    expect(normalizeRetentionName('')).toBeNull();
    expect(normalizeRetentionName(null)).toBeNull();
    expect(normalizeRetentionName('x'.repeat(80))).toHaveLength(80);
    expect(normalizeRetentionName('x'.repeat(81))).toBeNull();
  });

  it.each([
    ['ru', 'general', 1, undefined, '1 день'],
    ['ru', 'general', 3, undefined, '3 дня'],
    ['ru', 'general', 5, undefined, '5 дней'],
    ['ru', 'curious', undefined, 25, '25 часов'],
    ['en', 'general', 1, undefined, '1 day'],
    ['en', 'general', 3, undefined, '3 days'],
    ['en', 'curious', undefined, 25, '25 hours'],
    ['de', 'general', 1, undefined, 'einem Tag'],
    ['de', 'general', 3, undefined, '3 Tagen'],
    ['zh', 'general', 3, undefined, '3天'],
    ['zh', 'curious', undefined, 25, '25小时'],
  ])('%s/%s: %s → %s', (language, mode, days, hours, expected) => {
    expect(formatRetentionInactivity(language, mode as any, days, hours)).toBe(expected);
  });

  it('пропускает отрицательную, дробную, строковую и отсутствующую паузу', () => {
    for (const value of [-1, 1.5, Number.NaN, '3', undefined, null]) {
      expect(formatRetentionInactivity('ru', 'general', value, undefined)).toBeNull();
    }
    expect(formatRetentionInactivity('ru', 'curious', 3, undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Добавить красный resolver-тест имени**

Добавить в `retention-recipient-resolver.spec.ts` внутрь `describe('RetentionRecipientResolver')`:

```ts
  it('читает name из profile_data и нормализует его', async () => {
    const pg = fakePg({
      profiles: [{ user_id: UUID, email: null, name: '  Дмитрий  ' }],
    });
    const result = await new RetentionRecipientResolver(pg as any, language as any).resolve([UUID]);
    expect(result.get(UUID)?.name).toBe('Дмитрий');
    expect(pg.query.mock.calls[0][0]).toContain("profile_data->>'name' AS name");
  });
```

- [ ] **Step 3: Закоммитить красные тесты и подтвердить RED**

```bash
git add src/retention/retention-personalization.spec.ts src/retention/retention-recipient-resolver.spec.ts
git commit -m "test(retention): имя и локализованная пауза (красный)" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
```

Run: `back-ci "npx jest --runTestsByPath src/retention/retention-personalization.spec.ts src/retention/retention-recipient-resolver.spec.ts --runInBand"`
Expected: FAIL — `retention-personalization` отсутствует.

- [ ] **Step 4: Реализовать helpers**

`src/retention/retention-personalization.ts`:

```ts
import { LanguageService } from '../common/services/language.service';
import type { RetentionMode } from './retention.types';

export function normalizeRetentionName(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  return value.length > 0 && value.length <= 80 ? value : null;
}

const FORMS: Record<string, { day: Record<string, string>; hour: Record<string, string> }> = {
  ru: {
    day: { one: 'день', few: 'дня', many: 'дней', other: 'дней' },
    hour: { one: 'час', few: 'часа', many: 'часов', other: 'часов' },
  },
  en: {
    day: { one: 'day', other: 'days' },
    hour: { one: 'hour', other: 'hours' },
  },
  es: {
    day: { one: 'día', other: 'días' },
    hour: { one: 'hora', other: 'horas' },
  },
  de: {
    day: { one: 'einem Tag', other: 'Tagen' },
    hour: { one: 'einer Stunde', other: 'Stunden' },
  },
  fr: {
    day: { one: 'jour', other: 'jours' },
    hour: { one: 'heure', other: 'heures' },
  },
  zh: {
    day: { other: '天' },
    hour: { other: '小时' },
  },
  pt: {
    day: { one: 'dia', other: 'dias' },
    hour: { one: 'hora', other: 'horas' },
  },
};

export function formatRetentionInactivity(
  language: string,
  mode: RetentionMode,
  daysInactive?: unknown,
  hoursInactive?: unknown,
): string | null {
  const raw = mode === 'general' ? daysInactive : hoursInactive;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) return null;
  const lang = LanguageService.normalize(language);
  const unit = mode === 'general' ? 'day' : 'hour';
  const category = new Intl.PluralRules(lang).select(raw);
  const form = FORMS[lang][unit][category] || FORMS[lang][unit].other;
  if (lang === 'de' && raw === 1) return form;
  return `${raw}${lang === 'zh' ? '' : ' '}${form}`;
}
```

- [ ] **Step 5: Добавить name в тип и resolver**

В `RetentionContact` после `language` добавить:

```ts
  name: string | null;
```

В resolver заменить profile-запрос на:

```ts
      this.pg.query(
        "SELECT user_id, email, profile_data->>'name' AS name FROM ai_profiles_consolidated WHERE user_id=ANY($1::text[])",
        [ids],
      ),
```

Добавить import:

```ts
import { normalizeRetentionName } from './retention-personalization';
```

В объект контакта после `language` добавить:

```ts
        name: normalizeRetentionName(profileById.get(id)?.name),
```

В `retention.service.ts` в fallback-контакт для отсутствующего пользователя обязательно добавить `name: null`, поскольку `RetentionContact.name` обязателен:

```ts
        userId: row.user_id, email: null, phone: null, language: 'ru', name: null, unsubscribed: false,
```

- [ ] **Step 6: Закоммитить реализацию и проверить GREEN**

```bash
git add src/retention/retention-personalization.ts src/retention/retention.types.ts src/retention/retention-recipient-resolver.ts
git commit -m "feat(retention): имя и локализованная пауза в resolver" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
```

Run: `back-ci "npx jest --runTestsByPath src/retention/retention-personalization.spec.ts src/retention/retention-recipient-resolver.spec.ts --runInBand"`
Expected: PASS, helpers 3 suites/assertion groups и resolver 8 tests.

---

### Task 2: Персонализация общего конструктора email/SMS

**Files:**
- Modify: `src/retention/retention-mail.ts:4-111`
- Modify: `src/retention/retention-mail.spec.ts`

- [ ] **Step 1: Добавить красные тесты персонализированных текстов**

Добавить в `retention-mail.spec.ts` внутрь `describe('retention mail')`:

```ts
  it('General email персонализирует приветствие и паузу', () => {
    const mail = buildRetentionEmail({
      mode: 'general', language: 'ru', assistantName: 'Роман', name: 'Дмитрий', daysInactive: 3,
      chatUrl: retentionChatUrl('ru'), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('Здравствуйте, Дмитрий! Последняя активность в Linkeon была 3 дня назад. Роман из LINKEON');
  });

  it('Curious email персонализирует часы', () => {
    const mail = buildRetentionEmail({
      mode: 'curious', language: 'ru', assistantName: null, name: 'Дмитрий', hoursInactive: 25,
      chatUrl: retentionChatUrl('ru'), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('Здравствуйте, Дмитрий! Последняя активность в Linkeon была 25 часов назад.');
  });

  it('SMS General и Curious получают те же персонализацию', () => {
    expect(buildRetentionSmsMessage('general', 'Роман', 'Дмитрий', 3))
      .toContain('Здравствуйте, Дмитрий! Последняя активность в Linkeon была 3 дня назад.');
    expect(buildRetentionSmsMessage('curious', null, 'Дмитрий', undefined, 25))
      .toContain('Здравствуйте, Дмитрий! Последняя активность в Linkeon была 25 часов назад.');
  });

  it('без имени вставляет паузу после нейтрального приветствия, без undefined', () => {
    const mail = buildRetentionEmail({
      mode: 'general', language: 'ru', assistantName: null, name: null, daysInactive: 3,
      chatUrl: retentionChatUrl('ru'), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('Здравствуйте! Последняя активность в Linkeon была 3 дня назад.');
    expect(mail.text).not.toContain('undefined');
  });

  it('имя экранируется в HTML', () => {
    const mail = buildRetentionEmail({
      mode: 'general', language: 'en', assistantName: null, name: '<img src=x>', daysInactive: 3,
      chatUrl: retentionChatUrl('en'), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('<img src=x>');
    expect(mail.html).not.toContain('<img src=x>');
    expect(mail.html).toContain('&lt;img src=x&gt;');
  });

  it.each([
    ['ru', '3 дня'],
    ['en', '3 days'],
    ['es', '3 días'],
    ['de', '3 Tagen'],
    ['fr', '3 jours'],
    ['zh', '3天'],
    ['pt', '3 dias'],
  ])('%s локализует паузу без русских фраз', (language, expected) => {
    const mail = buildRetentionEmail({
      mode: 'general', language, assistantName: null, name: 'Alex', daysInactive: 3,
      chatUrl: retentionChatUrl(language), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('Alex');
    expect(mail.text).toContain(expected);
    if (language !== 'ru') expect(mail.text).not.toContain('дня');
  });

  it('некорректная пауза пропускается', () => {
    const mail = buildRetentionEmail({
      mode: 'general', language: 'en', assistantName: null, name: 'Alex', daysInactive: -1,
      chatUrl: retentionChatUrl('en'), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('Hello, Alex!');
    expect(mail.text).not.toContain('last activity');
  });
```

- [ ] **Step 2: Закоммитить красные тесты и подтвердить RED**

```bash
git add src/retention/retention-mail.spec.ts
git commit -m "test(retention): имя и пауза в email и SMS (красный)" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
```

Run: `back-ci "npx jest --runTestsByPath src/retention/retention-mail.spec.ts --runInBand"`
Expected: FAIL — лишние поля `buildRetentionEmail`/`buildRetentionSmsMessage` пока игнорируются.

- [ ] **Step 3: Добавить строки приветствия и активности**

В `Strings` добавить три обязательных поля:

```ts
  defaultGreeting: string;
  namedGreeting: string;
  lastActivity: string;
```

Добавить в каждую локаль `STRINGS`:

```ts
// ru
defaultGreeting: 'Здравствуйте!', namedGreeting: 'Здравствуйте, {name}!', lastActivity: 'Последняя активность в Linkeon была {inactivity} назад.',
// en
defaultGreeting: 'Hello!', namedGreeting: 'Hello, {name}!', lastActivity: 'Your last activity in Linkeon was {inactivity} ago.',
// es
defaultGreeting: '¡Hola!', namedGreeting: '¡Hola, {name}!', lastActivity: 'Tu última actividad en Linkeon fue hace {inactivity}.',
// de
defaultGreeting: 'Guten Tag!', namedGreeting: 'Guten Tag, {name}!', lastActivity: 'Ihre letzte Aktivität in Linkeon war vor {inactivity}.',
// fr
defaultGreeting: 'Bonjour !', namedGreeting: 'Bonjour, {name} !', lastActivity: 'Dernière activité sur Linkeon : il y a {inactivity}.',
// zh
defaultGreeting: '您好！', namedGreeting: '您好，{name}！', lastActivity: '您在 Linkeon 的最近活动是在{inactivity}前。',
// pt
defaultGreeting: 'Olá!', namedGreeting: 'Olá, {name}!', lastActivity: 'A sua última atividade no Linkeon foi há {inactivity}.',
```

- [ ] **Step 4: Реализовать общий personalize-helper и новые сигнатуры**

Добавить import:

```ts
import { formatRetentionInactivity, normalizeRetentionName } from './retention-personalization';
```

Добавить после `fill`:

```ts
function personalizeBody(
  template: string,
  mode: RetentionMode,
  language: string,
  strings: Strings,
  name: unknown,
  daysInactive?: unknown,
  hoursInactive?: unknown,
): string {
  const lang = LanguageService.normalize(language);
  const normalizedName = normalizeRetentionName(name);
  const greeting = normalizedName
    ? strings.namedGreeting.split('{name}').join(normalizedName)
    : strings.defaultGreeting;
  const inactivity = formatRetentionInactivity(lang, mode, daysInactive, hoursInactive);
  const activity = inactivity
    ? ` ${strings.lastActivity.split('{inactivity}').join(inactivity)}`
    : '';
  return `${greeting}${activity}${template.slice(strings.defaultGreeting.length)}`;
}
```

Заменить `buildRetentionSmsMessage` целиком:

```ts
export function buildRetentionSmsMessage(
  mode: RetentionMode,
  assistantName?: string | null,
  name?: unknown,
  daysInactive?: unknown,
  hoursInactive?: unknown,
): string {
  const s = STRINGS.ru;
  const who = assistantName ? `${assistantName}${s.fromLinkeon}` : `${s.defaultAssistant}${s.fromLinkeon}`;
  const template = fill(mode === 'general' ? s.generalBody : s.curiousBody, who);
  return personalizeBody(template, mode, 'ru', s, name, daysInactive, hoursInactive)
    .split('{url}').join('https://my.linkeon.io/chat');
}
```

В `buildRetentionEmail` добавить поля входа:

```ts
  name?: unknown;
  daysInactive?: unknown;
  hoursInactive?: unknown;
```

Заменить вычисление `body` и `[beforeUrl, afterUrl]`:

```ts
  const personalized = personalizeBody(template, input.mode, language, s, input.name, input.daysInactive, input.hoursInactive);
  const body = personalized.split('{url}').join(input.chatUrl);
  const [beforeUrl, afterUrl] = personalized.split('{url}');
```

Удалить прежнее `fill(template, assistant).split('{url}')` для этих двух значений, оставив вычисление `assistant` и `template` как есть. Plain text и HTML теперь экранируют имя внутри `escapeRetentionHtml(beforeUrl/afterUrl)`.

- [ ] **Step 5: Закоммитить реализацию и проверить GREEN**

```bash
git add src/retention/retention-mail.ts
git commit -m "feat(retention): имя и локализованная пауза в email и SMS" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
```

Run: `back-ci "npx jest --runTestsByPath src/retention/retention-mail.spec.ts --runInBand"`
Expected: PASS, все исходные 11 и новые персонализационные tests.

---

### Task 3: Передача имени в preview и фактическую отправку

**Files:**
- Modify: `src/retention/retention.service.ts:24-28,79-128,187-225`
- Modify: `src/retention/retention.preview.pg.spec.ts:58-60,75-90`
- Modify: `src/retention/retention-send.spec.ts:24-53,75-84`

- [ ] **Step 1: Добавить красный send-test персонализации**

В `retention-send.spec.ts` изменить harness-сигнатуру и добавить map:

```ts
function harness(
  drafts: RetentionDraft[],
  suppressedEntries: Array<[string, { phone: string | null }]> = [],
  personalizationEntries: Array<[string, { name: string | null }]> = [],
) {
  const svc = Object.create(RetentionService.prototype) as any;
  const suppressed = new Map(suppressedEntries);
  const personalization = new Map(personalizationEntries);
```

Заменить две строки segment-mock:

```ts
  svc.buildGeneralSegment = jest.fn().mockResolvedValue({ preview: generalPreview, suppressed, personalization });
  svc.buildCuriousSegment = jest.fn().mockResolvedValue({ preview: curiousPreview, suppressed, personalization });
```

Добавить тест после первого email-success теста:

```ts
  it('фактическая отправка email содержит имя и паузу', async () => {
    const svc = harness(
      [draft({ days_inactive: 3 })],
      [],
      [['u1', { name: 'Alex' }]],
    );
    await svc.sendRetentionOutreach({ confirm: true });
    expect(svc.mail.send.mock.calls[0][3]).toContain('Hello, Alex! Your last activity in Linkeon was 3 days ago.');
  });
```

- [ ] **Step 2: Добавить красные PG-assertions имени**

В `retention.preview.pg.spec.ts` заменить вставку профилей:

```ts
    await pool.query(`INSERT INTO ai_profiles_consolidated (user_id, email, profile_data) VALUES
      ($1, 'uuid@example.com', '{"name":"Alex"}'),
      ($2, 'blocked@example.com', '{}'),
      ('70001112233', NULL, '{}'),
      ('70000000000', 'test@example.com', '{}'),
      ($3, 'curious@example.com', '{"name":"Дмитрий"}')`,
      [EMAIL_UUID, SUPPRESSED_UUID, CURIOUS_UUID]);
```

В general-test добавить:

```ts
    expect(byId.get(EMAIL_UUID)?.message)
      .toContain('Hello, Alex! Your last activity in Linkeon was 3 days ago.');
```

В Curious-test добавить:

```ts
    expect(preview.drafts[0].message)
      .toContain('Здравствуйте, Дмитрий! Последняя активность в Linkeon была 25 часов назад.');
```

- [ ] **Step 3: Закоммитить красные тесты и подтвердить RED**

```bash
git add src/retention/retention-send.spec.ts src/retention/retention.preview.pg.spec.ts
git commit -m "test(retention): имя в preview и фактической отправке (красный)" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
```

Run unit RED: `back-ci "npx jest --runTestsByPath src/retention/retention-send.spec.ts --runInBand"`
Expected: FAIL — сообщение не содержит имени/паузы.

Run PG RED:

```bash
back-ci 'DB=retention_personal_ci_$(date +%s)_$$; createdb -h /var/run/postgresql "$DB"; PROVISIONING_PG_URL="postgres:///$DB?host=/var/run/postgresql" npx jest --runTestsByPath src/retention/retention.preview.pg.spec.ts --runInBand; RC=$?; dropdb -h /var/run/postgresql --if-exists "$DB"; exit $RC'
```

Expected: FAIL — в preview нет персонализации; база удалена.

- [ ] **Step 4: Передать name через внутреннюю карту сегмента**

В `RetentionSegmentResult` добавить:

```ts
  personalization: Map<string, { name: string | null }>;
```

В `buildPreview` после `const suppressed` добавить:

```ts
    const personalization = new Map<string, { name: string | null }>();
```

В начале цикла `for (const row of rows)` после чтения contact добавить:

```ts
    personalization.set(row.user_id, { name: contact.name });
```

Вызов email-builder в preview заменить на:

```ts
      const mail = channel === 'email' ? buildRetentionEmail({
        mode, language: contact.language, assistantName: row.assistant_name,
        name: contact.name, daysInactive: row.days_inactive, hoursInactive: row.hours_inactive,
        chatUrl: retentionChatUrl(contact.language), unsubscribeUrl: null,
      }) : null;
```

В return `buildPreview` добавить `personalization` рядом с `suppressed`.

В send при построении email изменить вызов:

```ts
              const content = buildRetentionEmail({
                mode, language: d.language, assistantName: d.assistant_name,
                name: segment.personalization.get(d.user_id)?.name,
                daysInactive: d.days_inactive, hoursInactive: d.hours_inactive,
                chatUrl: retentionChatUrl(d.language), unsubscribeUrl,
              });
```

Вызов SMS изменить:

```ts
        const sent = await this.sendOutreachSms(
          d.phone!,
          buildRetentionSmsMessage(
            mode,
            d.assistant_name,
            segment.personalization.get(d.user_id)?.name,
            d.days_inactive,
            d.hours_inactive,
          ),
        );
```

Для fallback при отсутствии map использовать `segment.personalization?.get(d.user_id)?.name`, чтобы старые тестовые mocks без map не ломались. Новая production-реализация всегда создаёт map.

- [ ] **Step 5: Закоммитить интеграцию и проверить GREEN**

```bash
git add src/retention/retention.service.ts
git commit -m "feat(retention): персонализация preview и фактической отправки" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
```

Run unit: `back-ci "npx jest --runTestsByPath src/retention/retention-send.spec.ts --runInBand"`
Expected: PASS, включая новый send-test.

Run PG:

```bash
back-ci 'DB=retention_personal_ci_$(date +%s)_$$; createdb -h /var/run/postgresql "$DB"; PROVISIONING_PG_URL="postgres:///$DB?host=/var/run/postgresql" npx jest --runTestsByPath src/retention/retention.preview.pg.spec.ts --runInBand; RC=$?; dropdb -h /var/run/postgresql --if-exists "$DB"; exit $RC'
```

Expected: PASS, 2 tests; база удалена.

---

### Task 4: Полная проверка

**Files:**
- Verify all files from Tasks 1–3.

- [ ] **Step 1: Все backend unit и соседние suites**

```bash
back-ci "npx jest --runTestsByPath \$(find src/retention -maxdepth 1 -name '*.spec.ts' ! -name '*.pg.spec.ts' | sort) src/common/services/mail.service.spec.ts src/admin/admin.retention-controller.spec.ts src/admin/admin.tg-activity.spec.ts src/admin/admin.calls-controller.spec.ts src/profile/account-deletion.spec.ts src/profile/session-prefix-like.spec.ts --maxWorkers=2"
```

Expected: все suites PASS, включая исходные 129 tests и новые helpers/mail/send tests.

- [ ] **Step 2: Обе PG-suites на одноразовой БД**

```bash
back-ci 'DB=retention_personal_final_$(date +%s)_$$; createdb -h /var/run/postgresql "$DB"; PROVISIONING_PG_URL="postgres:///$DB?host=/var/run/postgresql" npx jest --runTestsByPath src/retention/retention-unsubscribe.pg.spec.ts src/retention/retention.preview.pg.spec.ts --runInBand; RC=$?; dropdb -h /var/run/postgresql --if-exists "$DB"; exit $RC'
```

Expected: PASS, обе suites не skipped; база удалена.

- [ ] **Step 3: TypeScript и production build**

Run: `back-ci "npx tsc --noEmit -p tsconfig.build.json && npm run build"`
Expected: обе команды exit 0.

- [ ] **Step 4: Финальный diff и статус**

```bash
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: diff --check пустой, worktree чистый. Сообщить фактический HEAD, число tests и отсутствие внешних отправок. Не запускать `deploy.sh` без отдельного разрешения.
