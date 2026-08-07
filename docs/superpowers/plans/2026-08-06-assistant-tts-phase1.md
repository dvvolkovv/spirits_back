# Озвучка ответов ассистентов — Фаза 1 (бэкенд + веб)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать всем ассистентам инструмент `generate_speech`, который озвучивает произвольный текст любым голосом из каталога и показывает пользователю аудио-плеер в веб-чате.

**Architecture:** Новый NestJS-модуль `src/speech/` синтезирует речь синхронно: язык пользователя выбирает провайдера (Yandex для `ru`, OpenAI для остальных), четырёхуровневая цепочка выбирает голос, результат кладётся в MinIO и в таблицу `speech_clips`, токены списываются после успеха. Инструмент возвращает `clipId`, фронт превращает его в маркер `{{audio:id=…}}` и рендерит плеером — тем же механизмом, что уже работает для SMM-видео.

**Tech Stack:** NestJS 10, TypeScript, PostgreSQL, Redis, MinIO (S3 SDK), Jest + ts-jest, React 18 + Vite + Tailwind, i18next.

**Спека:** `docs/superpowers/specs/2026-08-06-assistant-tts-design.md`

**Репозитории:** бэкенд — `~/Downloads/spirits_back`, фронт — `~/Downloads/spirits_front`. Ветка в обоих — `main`.

**Фазы 2 (Telegram) и 3 (Flutter) в этот план не входят** — у них будут свои планы.

---

## Структура файлов

**Бэкенд** (`~/Downloads/spirits_back`):

| Файл | Ответственность |
|---|---|
| `src/speech/voices.ts` | каталог голосов, карта дефолтов, чистая `resolveVoice()` |
| `src/speech/voices.spec.ts` | тесты каталога и цепочки приоритетов |
| `src/speech/providers/yandex.ts` | HTTP к SpeechKit, отдаёт MP3 |
| `src/speech/providers/openai.ts` | HTTP к OpenAI TTS, отдаёт MP3 |
| `src/speech/speech.service.ts` | оркестрация: язык → голос → кэш → синтез → MinIO → биллинг |
| `src/speech/speech.service.spec.ts` | тесты оркестрации на моках |
| `src/speech/speech.controller.ts` | `GET /webhook/speech/voices`, `GET /webhook/speech/:id` |
| `src/speech/speech.module.ts` | DI-обвязка |
| `src/speech/migrations/001_speech_clips.sql` | таблица клипов |
| `scripts/generate-voice-samples.ts` | разовая генерация превью в MinIO |
| `src/chat/chat-tools.ts` | +описание `generate_speech`, +ветка в `executeTool` |
| `src/profile/profile.service.ts` | валидация `assistant_voices` при обновлении профиля |
| `src/app.module.ts` | регистрация `SpeechModule` |

**Фронт** (`~/Downloads/spirits_front`):

| Файл | Ответственность |
|---|---|
| `src/components/chat/AudioClip.tsx` | плеер одного клипа |
| `src/utils/customMarkdown.tsx` | разбор маркера `{{audio:id=…}}` |
| `src/components/chat/ChatInterface.tsx` | вставка маркера по `tool_result` |
| `src/components/settings/VoiceSettings.tsx` | выбор голоса каждому ассистенту |
| `src/components/settings/SettingsView.tsx` | подключение секции |
| `src/i18n/locales/*.json` | строки в шести локалях |

---

## Task 1: Каталог голосов и цепочка выбора

**Files:**
- Create: `src/speech/voices.ts`
- Test: `src/speech/voices.spec.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `src/speech/voices.spec.ts`:

```typescript
import { VOICE_CATALOG, resolveVoice, providerForLang } from './voices';

describe('providerForLang', () => {
  it('ru → yandex, всё остальное → openai', () => {
    expect(providerForLang('ru')).toBe('yandex');
    expect(providerForLang('en')).toBe('openai');
    expect(providerForLang('zh')).toBe('openai');
  });
});

describe('VOICE_CATALOG', () => {
  it('у каждого голоса заполнены обязательные поля', () => {
    for (const v of VOICE_CATALOG) {
      expect(v.id).toBeTruthy();
      expect(['yandex', 'openai']).toContain(v.provider);
      expect(['m', 'f']).toContain(v.gender);
      expect(v.title).toBeTruthy();
      expect(v.description).toBeTruthy();
    }
  });

  it('id уникальны в пределах провайдера', () => {
    const keys = VOICE_CATALOG.map((v) => `${v.provider}:${v.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('resolveVoice — приоритеты', () => {
  it('1: явный voice перебивает всё', () => {
    const r = resolveVoice({ lang: 'ru', assistantName: 'Оля', userChoice: 'jane', requested: 'zahar' });
    expect(r.voice).toBe('zahar');
    expect(r.source).toBe('requested');
  });

  it('2: выбор пользователя перебивает дефолт ассистента', () => {
    const r = resolveVoice({ lang: 'ru', assistantName: 'Оля', userChoice: 'jane' });
    expect(r.voice).toBe('jane');
    expect(r.source).toBe('user');
  });

  it('3: дефолт ассистента, когда выбора нет', () => {
    const r = resolveVoice({ lang: 'ru', assistantName: 'Роман' });
    expect(r.voice).toBe('zahar');
    expect(r.source).toBe('assistant');
  });

  it('4: неизвестный ассистент → женский дефолт', () => {
    const r = resolveVoice({ lang: 'ru', assistantName: 'Незнакомец' });
    expect(r.voice).toBe('alena');
    expect(r.source).toBe('gender-default');
  });
});

describe('resolveVoice — откаты при невалидном голосе', () => {
  it('выдуманный моделью id откатывается на следующий уровень', () => {
    const r = resolveVoice({ lang: 'ru', assistantName: 'Роман', requested: 'megatron-9000' });
    expect(r.voice).toBe('zahar');
    expect(r.source).toBe('assistant');
  });

  it('yandex-голос при английском языке откатывается, а не роняет вызов', () => {
    const r = resolveVoice({ lang: 'en', assistantName: 'Роман', requested: 'zahar' });
    expect(r.voice).toBe('onyx');
    expect(r.source).toBe('assistant');
  });

  it('невалидный пользовательский выбор откатывается на дефолт ассистента', () => {
    const r = resolveVoice({ lang: 'ru', assistantName: 'Роман', userChoice: 'nova' });
    expect(r.voice).toBe('zahar');
    expect(r.source).toBe('assistant');
  });

  it('всегда возвращает голос выбранного провайдера', () => {
    for (const lang of ['ru', 'en', 'de', 'fr', 'es', 'zh']) {
      const r = resolveVoice({ lang, assistantName: 'Оля' });
      const entry = VOICE_CATALOG.find((v) => v.id === r.voice && v.provider === providerForLang(lang));
      expect(entry).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `cd ~/Downloads/spirits_back && npx jest src/speech/voices.spec.ts`
Expected: FAIL — `Cannot find module './voices'`

- [ ] **Step 3: Написать реализацию**

Создать `src/speech/voices.ts`:

```typescript
// src/speech/voices.ts
export type TtsProvider = 'yandex' | 'openai';
export type Gender = 'm' | 'f';

export interface VoiceEntry {
  id: string;
  provider: TtsProvider;
  gender: Gender;
  /** Человекочитаемое имя для UI. Не переводим — имя собственное. */
  title: string;
  /** Тембр в двух словах. Уходит в описание инструмента для модели. */
  description: string;
}

export const VOICE_CATALOG: VoiceEntry[] = [
  // ── Yandex SpeechKit (ru) ────────────────────────────────────────────
  { id: 'alena',     provider: 'yandex', gender: 'f', title: 'Алёна',     description: 'тёплый женский, universal' },
  { id: 'jane',      provider: 'yandex', gender: 'f', title: 'Джейн',     description: 'мягкий женский, подходит для эмпатичных ролей' },
  { id: 'omazh',     provider: 'yandex', gender: 'f', title: 'Омаж',      description: 'деловой женский, спокойный' },
  { id: 'dasha',     provider: 'yandex', gender: 'f', title: 'Даша',      description: 'молодой женский, живой' },
  { id: 'julia',     provider: 'yandex', gender: 'f', title: 'Юлия',      description: 'низкий женский' },
  { id: 'lera',      provider: 'yandex', gender: 'f', title: 'Лера',      description: 'нейтральный женский' },
  { id: 'masha',     provider: 'yandex', gender: 'f', title: 'Маша',      description: 'звонкий женский' },
  { id: 'marina',    provider: 'yandex', gender: 'f', title: 'Марина',    description: 'зрелый женский' },
  { id: 'zahar',     provider: 'yandex', gender: 'm', title: 'Захар',     description: 'уверенный мужской, universal' },
  { id: 'filipp',    provider: 'yandex', gender: 'm', title: 'Филипп',    description: 'дружелюбный мужской' },
  { id: 'ermil',     provider: 'yandex', gender: 'm', title: 'Ермил',     description: 'мягкий мужской' },
  { id: 'madirus',   provider: 'yandex', gender: 'm', title: 'Мадирус',   description: 'глубокий мужской, деловой' },
  { id: 'alexander', provider: 'yandex', gender: 'm', title: 'Александр', description: 'нейтральный мужской' },
  { id: 'kirill',    provider: 'yandex', gender: 'm', title: 'Кирилл',    description: 'молодой мужской' },
  { id: 'anton',     provider: 'yandex', gender: 'm', title: 'Антон',     description: 'спокойный мужской' },

  // ── OpenAI tts-1 (не-ru) ─────────────────────────────────────────────
  { id: 'alloy',   provider: 'openai', gender: 'f', title: 'Alloy',   description: 'нейтральный, ровный' },
  { id: 'nova',    provider: 'openai', gender: 'f', title: 'Nova',    description: 'тёплый женский' },
  { id: 'shimmer', provider: 'openai', gender: 'f', title: 'Shimmer', description: 'светлый женский' },
  { id: 'echo',    provider: 'openai', gender: 'm', title: 'Echo',    description: 'ровный мужской' },
  { id: 'onyx',    provider: 'openai', gender: 'm', title: 'Onyx',    description: 'глубокий мужской' },
  { id: 'fable',   provider: 'openai', gender: 'm', title: 'Fable',   description: 'повествовательный, мягкий' },
];

/** Дефолты по ассистентам. Ключ — имя из agents.name (оно же preferred_agent). */
interface AssistantDefault { gender: Gender; yandex: string; openai: string }

export const ASSISTANT_DEFAULTS: Record<string, AssistantDefault> = {
  'Роман':      { gender: 'm', yandex: 'zahar',   openai: 'onyx' },
  'Миша':       { gender: 'm', yandex: 'filipp',  openai: 'echo' },
  'Андрей':     { gender: 'm', yandex: 'madirus', openai: 'onyx' },
  'Алексей':    { gender: 'm', yandex: 'madirus', openai: 'echo' },
  'Герман':     { gender: 'm', yandex: 'filipp',  openai: 'fable' },
  'Виталий':    { gender: 'm', yandex: 'zahar',   openai: 'fable' },
  'Шанкара':    { gender: 'm', yandex: 'filipp',  openai: 'fable' },
  'Оля':        { gender: 'f', yandex: 'alena',   openai: 'nova' },
  'Маша':       { gender: 'f', yandex: 'jane',    openai: 'shimmer' },
  'Ирина':      { gender: 'f', yandex: 'omazh',   openai: 'nova' },
  'Александра': { gender: 'f', yandex: 'omazh',   openai: 'nova' },
  'Екатерина':  { gender: 'f', yandex: 'alena',   openai: 'alloy' },
  'Анна':       { gender: 'f', yandex: 'alena',   openai: 'alloy' },
  'Лиана':      { gender: 'f', yandex: 'jane',    openai: 'shimmer' },
  'Райя':       { gender: 'f', yandex: 'jane',    openai: 'shimmer' },
};

const GENDER_DEFAULT: Record<Gender, { yandex: string; openai: string }> = {
  m: { yandex: 'zahar', openai: 'onyx' },
  f: { yandex: 'alena', openai: 'nova' },
};

export function providerForLang(lang: string): TtsProvider {
  return lang === 'ru' ? 'yandex' : 'openai';
}

export function isValidVoice(voiceId: string | undefined, provider: TtsProvider): boolean {
  if (!voiceId) return false;
  return VOICE_CATALOG.some((v) => v.id === voiceId && v.provider === provider);
}

export type VoiceSource = 'requested' | 'user' | 'assistant' | 'gender-default';

export interface ResolveVoiceInput {
  lang: string;
  assistantName?: string;
  /** profile_data.assistant_voices[assistantName] */
  userChoice?: string;
  /** параметр voice из вызова инструмента */
  requested?: string;
}

export interface ResolvedVoice {
  voice: string;
  provider: TtsProvider;
  source: VoiceSource;
  /** Уровни, отброшенные из-за невалидного голоса — для warn-лога. */
  rejected: Array<{ source: VoiceSource; voice: string }>;
}

/**
 * Четыре уровня приоритета, первый валидный выигрывает. Невалидный голос
 * (выдуманный моделью id или голос чужого провайдера) не роняет вызов —
 * уровень отбрасывается и попадает в `rejected` для лога.
 */
export function resolveVoice(input: ResolveVoiceInput): ResolvedVoice {
  const provider = providerForLang(input.lang);
  const rejected: Array<{ source: VoiceSource; voice: string }> = [];

  const def = input.assistantName ? ASSISTANT_DEFAULTS[input.assistantName] : undefined;
  const gender: Gender = def?.gender ?? 'f';

  const candidates: Array<{ source: VoiceSource; voice: string | undefined }> = [
    { source: 'requested', voice: input.requested },
    { source: 'user', voice: input.userChoice },
    { source: 'assistant', voice: def ? def[provider] : undefined },
    { source: 'gender-default', voice: GENDER_DEFAULT[gender][provider] },
  ];

  for (const c of candidates) {
    if (!c.voice) continue;
    if (isValidVoice(c.voice, provider)) {
      return { voice: c.voice, provider, source: c.source, rejected };
    }
    rejected.push({ source: c.source, voice: c.voice });
  }

  // Недостижимо: gender-default всегда валиден. Оставлено ради тотальности типа.
  return { voice: GENDER_DEFAULT.f[provider], provider, source: 'gender-default', rejected };
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `cd ~/Downloads/spirits_back && npx jest src/speech/voices.spec.ts`
Expected: PASS, 11 тестов

- [ ] **Step 5: Проверить тесты в обратную сторону**

Временно сломать `resolveVoice` — поменять порядок `candidates`, поставив `user` перед `requested`. Запустить тест снова.
Expected: FAIL на «1: явный voice перебивает всё». Вернуть порядок обратно, убедиться что снова PASS.

Затем временно убрать проверку `isValidVoice` (возвращать первый непустой кандидат). Запустить снова.
Expected: FAIL на трёх тестах группы «откаты». Вернуть проверку.

Это обязательный шаг: зелёный прогон сам по себе не доказывает, что тест что-то проверяет.

- [ ] **Step 6: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/speech/voices.ts src/speech/voices.spec.ts
git commit -m "feat(speech): каталог голосов и цепочка выбора resolveVoice"
```

---

## Task 2: Провайдеры синтеза

**Files:**
- Create: `src/speech/providers/yandex.ts`
- Create: `src/speech/providers/openai.ts`

Тестов на эти файлы нет: они целиком состоят из сетевого вызова, юнит-тест проверял бы мок HTTP-клиента, а не поведение. Интеграционная проверка — в Task 10.

- [ ] **Step 1: Yandex-провайдер**

Создать `src/speech/providers/yandex.ts`:

```typescript
// src/speech/providers/yandex.ts
import axios from 'axios';

/**
 * Синтез через Yandex SpeechKit v1. Просим сразу mp3 (в отличие от
 * worker/src/tts/yandex.ts, которому нужен LPCM под ffmpeg-пайплайн Remotion).
 */
export async function synthesizeYandex(text: string, voice: string): Promise<Buffer> {
  const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY;
  const folderId = process.env.YANDEX_TTS_FOLDER_ID;
  if (!apiKey || !folderId) {
    throw new Error('YANDEX_SPEECHKIT_API_KEY or YANDEX_TTS_FOLDER_ID not configured');
  }

  const params = new URLSearchParams();
  params.set('text', text);
  params.set('lang', 'ru-RU');
  params.set('voice', voice);
  params.set('format', 'mp3');
  params.set('folderId', folderId);

  const r = await axios.post(
    'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize',
    params.toString(),
    {
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      responseType: 'arraybuffer',
      timeout: 60000,
      validateStatus: () => true,
    },
  );
  if (r.status !== 200) {
    const errBody = Buffer.from(r.data).toString('utf8').slice(0, 200);
    throw new Error(`Yandex TTS ${r.status}: ${errBody}`);
  }
  const buf = Buffer.from(r.data);
  if (buf.length === 0) throw new Error('Yandex TTS returned empty body');
  return buf;
}
```

- [ ] **Step 2: OpenAI-провайдер**

Создать `src/speech/providers/openai.ts`:

```typescript
// src/speech/providers/openai.ts
import OpenAI from 'openai';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  // Ленивая инициализация: без неё отсутствие ключа роняет весь Nest-bootstrap
  // на test-сервере — ровно та же грабля, что уже описана в tg-voice.service.ts.
  if (!client) client = new OpenAI({ apiKey });
  return client;
}

/**
 * Синтез через OpenAI tts-1. Просим mp3, а не opus: в MinIO клип лежит одним
 * каноническим форматом для веба и мобилки, Telegram конвертирует его сам.
 */
export async function synthesizeOpenai(text: string, voice: string): Promise<Buffer> {
  const resp = await getClient().audio.speech.create({
    model: 'tts-1',
    voice: voice as any,
    input: text,
    response_format: 'mp3',
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length === 0) throw new Error('OpenAI TTS returned empty body');
  return buf;
}
```

- [ ] **Step 3: Проверить, что проект компилируется**

Run: `cd ~/Downloads/spirits_back && npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок в `src/speech/**`

- [ ] **Step 4: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/speech/providers/
git commit -m "feat(speech): адаптеры Yandex SpeechKit и OpenAI tts-1"
```

---

## Task 3: Миграция таблицы клипов

**Files:**
- Create: `src/speech/migrations/001_speech_clips.sql`

- [ ] **Step 1: Написать миграцию**

Создать `src/speech/migrations/001_speech_clips.sql`:

```sql
-- Клипы озвучки ассистентов.
-- cache_key = sha256(text + voice + lang): тот же текст другим голосом обязан
-- дать другой клип, поэтому это НЕ хэш одного текста.
CREATE TABLE IF NOT EXISTS speech_clips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL,
  assistant_id TEXT,
  cache_key    TEXT NOT NULL,
  url          TEXT NOT NULL,
  duration_sec NUMERIC(6,2),
  chars        INTEGER NOT NULL,
  provider     TEXT NOT NULL,
  voice        TEXT NOT NULL,
  lang         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS speech_clips_user_key
  ON speech_clips (user_id, cache_key);

CREATE INDEX IF NOT EXISTS speech_clips_user_created
  ON speech_clips (user_id, created_at DESC);
```

`user_id` — `TEXT`, не `varchar(20)`: у email/OAuth-пользователей идентификатор это UUID на 36 символов.

- [ ] **Step 2: Прогнать миграцию локально**

Если есть локальная БД — применить и проверить схему. Если нет, пропустить: применение на серверах в Task 13.

- [ ] **Step 3: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/speech/migrations/001_speech_clips.sql
git commit -m "feat(speech): миграция таблицы speech_clips"
```

---

## Task 4: SpeechService — расчёт цены и ключ кэша

Сервис строится в три захода: сначала чистые функции (эта задача), потом оркестрация (Task 5), потом rate limit (Task 6). Так каждый кусок тестируется отдельно.

**Files:**
- Create: `src/speech/speech.service.ts`
- Test: `src/speech/speech.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `src/speech/speech.service.spec.ts`:

```typescript
import { tokenCostFor, cacheKeyFor, estimateDurationSec, maxCharsFor } from './speech.service';

describe('tokenCostFor', () => {
  it('округляет вверх до целых тысяч', () => {
    expect(tokenCostFor(1)).toBe(1000);
    expect(tokenCostFor(999)).toBe(1000);
    expect(tokenCostFor(1000)).toBe(1000);
    expect(tokenCostFor(1001)).toBe(2000);
    expect(tokenCostFor(5000)).toBe(5000);
  });
});

describe('cacheKeyFor', () => {
  it('одинаковые входы дают одинаковый ключ', () => {
    expect(cacheKeyFor('привет', 'zahar', 'ru')).toBe(cacheKeyFor('привет', 'zahar', 'ru'));
  });

  it('смена голоса даёт другой ключ', () => {
    expect(cacheKeyFor('привет', 'zahar', 'ru')).not.toBe(cacheKeyFor('привет', 'filipp', 'ru'));
  });

  it('смена языка даёт другой ключ', () => {
    expect(cacheKeyFor('hello', 'onyx', 'en')).not.toBe(cacheKeyFor('hello', 'onyx', 'de'));
  });

  it('смена текста даёт другой ключ', () => {
    expect(cacheKeyFor('привет', 'zahar', 'ru')).not.toBe(cacheKeyFor('пока', 'zahar', 'ru'));
  });
});

describe('estimateDurationSec', () => {
  it('оценивает по 15 символов в секунду', () => {
    expect(estimateDurationSec(150)).toBeCloseTo(10, 1);
  });
});

describe('maxCharsFor — потолок свой у каждого провайдера', () => {
  it('yandex — 2000 символов: 15 КБ лимит тела, кириллица раздувается в 6 раз', () => {
    expect(maxCharsFor('yandex')).toBe(2000);
  });

  it('openai — 4000 символов: у tts-1 лимит 4096 на input', () => {
    expect(maxCharsFor('openai')).toBe(4000);
  });

  it('потолок yandex реально влезает в 15 КБ тела на кириллице', () => {
    const params = new URLSearchParams();
    params.set('text', 'я'.repeat(maxCharsFor('yandex')));
    expect(Buffer.byteLength(params.toString())).toBeLessThan(15000);
  });

  it('вдвое больший текст в лимит уже НЕ влезает — проверка, что потолок не декоративный', () => {
    const params = new URLSearchParams();
    params.set('text', 'я'.repeat(maxCharsFor('yandex') * 2));
    expect(Buffer.byteLength(params.toString())).toBeGreaterThan(15000);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `cd ~/Downloads/spirits_back && npx jest src/speech/speech.service.spec.ts`
Expected: FAIL — `Cannot find module './speech.service'`

- [ ] **Step 3: Написать чистые функции**

Создать `src/speech/speech.service.ts`:

```typescript
// src/speech/speech.service.ts
import { createHash } from 'crypto';
import { TtsProvider } from './voices';

export const RATE_LIMIT_PER_MIN = 20;

/**
 * Потолок длины у каждого провайдера свой — единой константы быть не может.
 *
 * Yandex: лимит не на символы, а 15 КБ на тело POST-запроса. В
 * application/x-www-form-urlencoded каждый байт кодируется как %XX, кириллица
 * занимает 2 байта → 6 символов тела на символ текста. Замер: 5000 кириллических
 * символов = 30 005 байт (вдвое сверх лимита), 2000 = 12 005 байт (влезает
 * с запасом). На латинице тот же текст прошёл бы — поэтому баг не ловится
 * короткой тестовой фразой и вылезает на первом длинном русском ответе.
 *
 * OpenAI: у tts-1 жёсткий лимит 4096 символов на input, берём 4000.
 */
const MAX_CHARS_BY_PROVIDER: Record<TtsProvider, number> = {
  yandex: 2000,
  openai: 4000,
};

export function maxCharsFor(provider: TtsProvider): number {
  return MAX_CHARS_BY_PROVIDER[provider];
}

/** 1000 токенов за каждую начатую 1000 символов. */
export function tokenCostFor(chars: number): number {
  return Math.ceil(chars / 1000) * 1000;
}

/** Ключ кэша: текст + голос + язык. Голос обязан входить в ключ. */
export function cacheKeyFor(text: string, voice: string, lang: string): string {
  return createHash('sha256').update(`${text} ${voice} ${lang}`).digest('hex');
}

/**
 * Оценка длительности: ни Yandex, ни OpenAI её не возвращают, а ffprobe в
 * API-процессе ради подписи под плеером не нужен — точное время покажет
 * сам аудио-тег на клиенте.
 */
export function estimateDurationSec(chars: number): number {
  return Math.round((chars / 15) * 100) / 100;
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `cd ~/Downloads/spirits_back && npx jest src/speech/speech.service.spec.ts`
Expected: PASS, 7 тестов

- [ ] **Step 5: Проверить тест в обратную сторону**

Временно заменить `Math.ceil` на `Math.floor` в `tokenCostFor`.
Expected: FAIL на «округляет вверх». Вернуть `Math.ceil`.

Временно убрать `voice` из строки в `cacheKeyFor`.
Expected: FAIL на «смена голоса даёт другой ключ». Вернуть.

- [ ] **Step 6: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/speech/speech.service.ts src/speech/speech.service.spec.ts
git commit -m "feat(speech): расчёт цены, ключ кэша, оценка длительности"
```

---

## Task 5: SpeechService — оркестрация синтеза

**Files:**
- Modify: `src/speech/speech.service.ts`
- Modify: `src/speech/speech.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

Дописать в конец `src/speech/speech.service.spec.ts`:

```typescript
import { SpeechService } from './speech.service';

/** Минимальные заглушки зависимостей — без сети и БД. */
function makeService(overrides: any = {}) {
  const rows: Record<string, any[]> = { clips: [] };

  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM speech_clips/.test(sql)) {
        const hit = rows.clips.find((c) => c.user_id === params[0] && c.cache_key === params[1]);
        return { rows: hit ? [hit] : [] };
      }
      if (/INSERT INTO speech_clips/.test(sql)) {
        const row = {
          id: 'clip-1', user_id: params[0], assistant_id: params[1], cache_key: params[2],
          url: params[3], duration_sec: params[4], chars: params[5],
          provider: params[6], voice: params[7], lang: params[8],
        };
        rows.clips.push(row);
        return { rows: [row] };
      }
      if (/preferred_agent/.test(sql)) return { rows: [{ preferred_agent: 'Роман', profile_data: {} }] };
      if (/SELECT tokens/.test(sql)) return { rows: [{ tokens: overrides.balance ?? 100000 }] };
      return { rows: [] };
    }),
  };

  const storage = { upload: jest.fn(async () => 'https://minio.test/linkeon-assets/audio/x.mp3') };
  const misc = { deductTokens: jest.fn(async () => undefined) };
  const language = { resolveUserLanguage: jest.fn(async () => overrides.lang ?? 'ru') };
  const redis = { incr: jest.fn(async () => 1), expire: jest.fn(async () => undefined) };

  const svc = new SpeechService(pg as any, storage as any, misc as any, language as any, redis as any);
  // Подменяем сетевые вызовы — тестируем оркестрацию, не HTTP.
  (svc as any).synthesizeWith = jest.fn(async () => Buffer.from('fake-mp3-bytes'));
  return { svc, pg, storage, misc, language, redis };
}

describe('SpeechService.synthesize', () => {
  it('успешный синтез списывает токены и возвращает клип', async () => {
    const { svc, misc, storage } = makeService();
    const r = await svc.synthesize('u1', { text: 'Привет, это тест' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.voice).toBe('zahar');
    expect(r.tokensSpent).toBe(1000);
    expect(r.cached).toBe(false);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(misc.deductTokens).toHaveBeenCalledWith('u1', 1000);
  });

  it('повтор того же текста берётся из кэша и не стоит токенов', async () => {
    const { svc, misc, storage } = makeService();
    await svc.synthesize('u1', { text: 'Привет' });
    const second = await svc.synthesize('u1', { text: 'Привет' });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cached).toBe(true);
    expect(second.tokensSpent).toBe(0);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(misc.deductTokens).toHaveBeenCalledTimes(1);
  });

  it('смена голоса обходит кэш', async () => {
    const { svc, storage } = makeService();
    await svc.synthesize('u1', { text: 'Привет' });
    await svc.synthesize('u1', { text: 'Привет', voice: 'filipp' });
    expect(storage.upload).toHaveBeenCalledTimes(2);
  });

  it('при нехватке баланса не синтезирует и не списывает', async () => {
    const { svc, misc, storage } = makeService({ balance: 500 });
    const r = await svc.synthesize('u1', { text: 'Привет' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('insufficient_tokens');
    expect(r.required).toBe(1000);
    expect(r.balance).toBe(500);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(misc.deductTokens).not.toHaveBeenCalled();
  });

  it('на русском потолок 2000 символов — 2001 отклоняется без синтеза', async () => {
    const { svc, storage } = makeService();
    const r = await svc.synthesize('u1', { text: 'я'.repeat(2001) });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('text_too_long');
    expect(r.maxChars).toBe(2000);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('на английском тот же текст проходит — потолок там 4000', async () => {
    const { svc } = makeService({ lang: 'en' });
    const r = await svc.synthesize('u1', { text: 'a'.repeat(2001) });
    expect(r.ok).toBe(true);
  });

  it('на английском 4001 символ отклоняется', async () => {
    const { svc } = makeService({ lang: 'en' });
    const r = await svc.synthesize('u1', { text: 'a'.repeat(4001) });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('text_too_long');
    expect(r.maxChars).toBe(4000);
  });

  it('пустой текст отклоняется', async () => {
    const { svc } = makeService();
    const r = await svc.synthesize('u1', { text: '   ' });
    expect(r.ok).toBe(false);
  });

  it('за упавший синтез токены не списываются', async () => {
    const { svc, misc } = makeService();
    (svc as any).synthesizeWith = jest.fn(async () => { throw new Error('Yandex TTS 503'); });

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(false);
    expect(misc.deductTokens).not.toHaveBeenCalled();
  });

  it('английский язык уводит на openai-голос', async () => {
    const { svc } = makeService({ lang: 'en' });
    const r = await svc.synthesize('u1', { text: 'Hello there' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider).toBe('openai');
    expect(r.voice).toBe('onyx');
  });

  it('гонку выиграл параллельный вызов — отдаём его клип и не списываем повторно', async () => {
    const { svc, pg, misc } = makeService();
    // INSERT ... ON CONFLICT DO NOTHING вернул ноль строк: параллельный вызов
    // успел вставить ту же пару (user_id, cache_key) и уже оплатил синтез.
    let insertSeen = false;
    (pg.query as jest.Mock).mockImplementation(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO speech_clips/.test(sql)) { insertSeen = true; return { rows: [] }; }
      if (/FROM speech_clips/.test(sql)) {
        return insertSeen
          ? { rows: [{ id: 'clip-parallel', url: 'https://minio.test/a.mp3', duration_sec: 2, chars: 6 }] }
          : { rows: [] };
      }
      if (/preferred_agent/.test(sql)) return { rows: [{ preferred_agent: 'Роман', profile_data: {} }] };
      if (/SELECT tokens/.test(sql)) return { rows: [{ tokens: 100000 }] };
      return { rows: [] };
    });

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clipId).toBe('clip-parallel');
    expect(r.cached).toBe(true);
    expect(r.tokensSpent).toBe(0);
    expect(misc.deductTokens).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `cd ~/Downloads/spirits_back && npx jest src/speech/speech.service.spec.ts`
Expected: FAIL — `SpeechService is not a constructor`

- [ ] **Step 3: Написать сервис**

Дописать в `src/speech/speech.service.ts` (импорты — в начало файла, класс — в конец):

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { MiscService } from '../misc/misc.service';
import { LanguageService } from '../common/services/language.service';
import { RedisService } from '../common/services/redis.service';
import { resolveVoice, providerForLang, TtsProvider } from './voices';
import { synthesizeYandex } from './providers/yandex';
import { synthesizeOpenai } from './providers/openai';

const SPEECH_BUCKET = process.env.SPEECH_BUCKET || 'linkeon-assets';
const DEFAULT_ASSISTANT = 'Роман';

export interface SynthesizeInput {
  text: string;
  /** Любой id из каталога. Невалидный молча откатывается на следующий уровень. */
  voice?: string;
}

export type SynthesizeResult =
  | {
      ok: true; clipId: string; audioUrl: string; durationSec: number;
      chars: number; voice: string; provider: TtsProvider;
      tokensSpent: number; cached: boolean;
    }
  | { ok: false; error: 'insufficient_tokens'; balance: number; required: number }
  | { ok: false; error: 'text_too_long'; maxChars: number; provider: TtsProvider }
  | { ok: false; error: 'rate_limited'; retryAfterSec: number }
  | { ok: false; error: string };

@Injectable()
export class SpeechService {
  private readonly logger = new Logger(SpeechService.name);

  constructor(
    private readonly pg: PgService,
    private readonly storage: StorageService,
    private readonly misc: MiscService,
    private readonly language: LanguageService,
    private readonly redis: RedisService,
  ) {}

  async synthesize(userId: string, input: SynthesizeInput): Promise<SynthesizeResult> {
    const text = String(input.text ?? '').trim();
    if (!text) return { ok: false, error: 'empty text' };

    const lang = await this.language.resolveUserLanguage(userId);

    // Ассистент берётся из БД, а не из аргументов инструмента: по MCP модель
    // сама подставляет аргументы и может назвать чужого ассистента.
    const profRes = await this.pg.query(
      'SELECT preferred_agent, profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const assistantName: string = profRes.rows[0]?.preferred_agent || DEFAULT_ASSISTANT;
    const userChoice: string | undefined =
      profRes.rows[0]?.profile_data?.assistant_voices?.[assistantName];

    const resolved = resolveVoice({ lang, assistantName, userChoice, requested: input.voice });
    for (const r of resolved.rejected) {
      this.logger.warn(`voice rejected: source=${r.source} voice=${r.voice} lang=${lang}`);
    }

    // Потолок длины проверяем только здесь: он зависит от провайдера, а провайдер
    // известен лишь после разрешения языка и голоса.
    const maxChars = maxCharsFor(resolved.provider);
    if (text.length > maxChars) {
      return { ok: false, error: 'text_too_long', maxChars, provider: resolved.provider };
    }

    const cacheKey = cacheKeyFor(text, resolved.voice, lang);
    const hit = await this.pg.query(
      'SELECT id, url, duration_sec, chars FROM speech_clips WHERE user_id = $1 AND cache_key = $2',
      [userId, cacheKey],
    );
    if (hit.rows.length) {
      const row = hit.rows[0];
      return {
        ok: true, clipId: String(row.id), audioUrl: row.url,
        durationSec: Number(row.duration_sec ?? 0), chars: Number(row.chars),
        voice: resolved.voice, provider: resolved.provider, tokensSpent: 0, cached: true,
      };
    }

    const required = tokenCostFor(text.length);
    const balRes = await this.pg.query(
      'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const balance = Number(balRes.rows[0]?.tokens ?? 0);
    if (balance < required) return { ok: false, error: 'insufficient_tokens', balance, required };

    let bytes: Buffer;
    try {
      bytes = await this.synthesizeWith(resolved.provider, text, resolved.voice);
    } catch (e: any) {
      this.logger.warn(`synthesize failed (${resolved.provider}/${resolved.voice}): ${e.message}`);
      return { ok: false, error: e?.message || 'tts failed' };
    }

    const key = `audio/${cacheKey}.mp3`;
    const url = await this.storage.upload({
      bucket: SPEECH_BUCKET, key, body: bytes,
      contentType: 'audio/mpeg', cacheControl: 'public, max-age=31536000, immutable',
    });

    const durationSec = estimateDurationSec(text.length);

    // ON CONFLICT обязателен: уникальный индекс (user_id, cache_key) — это и есть
    // механизм кэша, а сценка по ролям шлёт несколько синтезов подряд. Два
    // параллельных вызова с одним текстом иначе дали бы 23505 unique_violation
    // и 500-ку вместо кэш-хита.
    const ins = await this.pg.query(
      `INSERT INTO speech_clips (user_id, assistant_id, cache_key, url, duration_sec, chars, provider, voice, lang)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, cache_key) DO NOTHING
       RETURNING id`,
      [userId, assistantName, cacheKey, url, durationSec, text.length, resolved.provider, resolved.voice, lang],
    );

    if (ins.rows.length === 0) {
      // Гонку выиграл параллельный вызов — он уже оплатил синтез. Отдаём его клип
      // и второй раз денег не берём.
      const existing = await this.pg.query(
        'SELECT id, url, duration_sec, chars FROM speech_clips WHERE user_id = $1 AND cache_key = $2',
        [userId, cacheKey],
      );
      const row = existing.rows[0];
      return {
        ok: true, clipId: String(row.id), audioUrl: row.url,
        durationSec: Number(row.duration_sec ?? 0), chars: Number(row.chars),
        voice: resolved.voice, provider: resolved.provider, tokensSpent: 0, cached: true,
      };
    }

    // Списываем только после успешного синтеза и заливки.
    await this.misc.deductTokens(userId, required);

    return {
      ok: true, clipId: String(ins.rows[0].id), audioUrl: url, durationSec,
      chars: text.length, voice: resolved.voice, provider: resolved.provider,
      tokensSpent: required, cached: false,
    };
  }

  /** Выделено отдельным методом, чтобы тесты подменяли сеть одной строкой. */
  private async synthesizeWith(provider: TtsProvider, text: string, voice: string): Promise<Buffer> {
    return provider === 'yandex' ? synthesizeYandex(text, voice) : synthesizeOpenai(text, voice);
  }

  async getClip(userId: string, clipId: string): Promise<any | null> {
    const res = await this.pg.query(
      'SELECT id, url, duration_sec, chars, voice, provider, lang, created_at FROM speech_clips WHERE id = $1 AND user_id = $2',
      [clipId, userId],
    );
    return res.rows[0] ?? null;
  }
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `cd ~/Downloads/spirits_back && npx jest src/speech/speech.service.spec.ts`
Expected: PASS, 15 тестов (7 из Task 4 + 8 новых)

- [ ] **Step 5: Проверить тесты в обратную сторону**

Переставить `deductTokens` до вызова `synthesizeWith`.
Expected: FAIL на «за упавший синтез токены не списываются». Вернуть порядок.

Убрать проверку баланса (`if (balance < required)`).
Expected: FAIL на «при нехватке баланса не синтезирует». Вернуть.

Убрать чтение кэша (всегда синтезировать заново).
Expected: FAIL на «повтор того же текста берётся из кэша». Вернуть.

- [ ] **Step 6: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/speech/speech.service.ts src/speech/speech.service.spec.ts
git commit -m "feat(speech): оркестрация синтеза — кэш, баланс, MinIO, списание"
```

---

## Task 6: Rate limit и ретрай провайдера

**Files:**
- Modify: `src/speech/speech.service.ts`
- Modify: `src/speech/speech.service.spec.ts`

- [ ] **Step 1: Написать падающий тест**

Дописать в `src/speech/speech.service.spec.ts`:

```typescript
describe('SpeechService — rate limit', () => {
  it('21-й вызов за минуту отклоняется', async () => {
    const { svc, redis, storage } = makeService();
    (redis.incr as jest.Mock).mockResolvedValue(21);

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('rate_limited');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('20-й вызов ещё проходит — сценка по ролям не должна упираться в потолок', async () => {
    const { svc, redis } = makeService();
    (redis.incr as jest.Mock).mockResolvedValue(20);

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(true);
  });

  it('TTL ставится только на первом вызове окна', async () => {
    const { svc, redis } = makeService();
    (redis.incr as jest.Mock).mockResolvedValue(1);
    await svc.synthesize('u1', { text: 'Привет' });
    expect(redis.expire).toHaveBeenCalledWith(expect.stringContaining('u1'), 60);

    (redis.expire as jest.Mock).mockClear();
    (redis.incr as jest.Mock).mockResolvedValue(2);
    await svc.synthesize('u1', { text: 'Другой текст' });
    expect(redis.expire).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `cd ~/Downloads/spirits_back && npx jest src/speech/speech.service.spec.ts -t "rate limit"`
Expected: FAIL — вызовы проходят, `rate_limited` не возвращается

- [ ] **Step 3: Добавить проверку в сервис**

В `src/speech/speech.service.ts`, в `synthesize()`, сразу после проверки длины текста и до `resolveUserLanguage`:

```typescript
    const rlKey = `speech:rl:${userId}`;
    const hits = await this.redis.incr(rlKey);
    if (hits === 1) await this.redis.expire(rlKey, 60);
    if (hits > RATE_LIMIT_PER_MIN) {
      this.logger.warn(`rate limited: user=${userId} hits=${hits}`);
      return { ok: false, error: 'rate_limited', retryAfterSec: 60 };
    }
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `cd ~/Downloads/spirits_back && npx jest src/speech/`
Expected: PASS, 29 тестов

- [ ] **Step 5: Проверить тест в обратную сторону**

Поменять `hits > RATE_LIMIT_PER_MIN` на `hits > 1000`.
Expected: FAIL на «21-й вызов за минуту отклоняется». Вернуть.

- [ ] **Step 6: Написать падающий тест на ретрай**

Спека требует один ретрай при сетевой ошибке провайдера. Дописать в `src/speech/speech.service.spec.ts`:

```typescript
describe('SpeechService — ретрай провайдера', () => {
  it('одна неудача ретраится и вызов завершается успешно', async () => {
    const { svc, misc } = makeService();
    const inner = jest.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(Buffer.from('fake-mp3-bytes'));
    (svc as any).callProvider = inner;

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(true);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(misc.deductTokens).toHaveBeenCalledTimes(1);
  });

  it('две неудачи подряд — отказ, ретраев ровно два вызова', async () => {
    const { svc, misc } = makeService();
    const inner = jest.fn().mockRejectedValue(new Error('Yandex TTS 503'));
    (svc as any).callProvider = inner;

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(false);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(misc.deductTokens).not.toHaveBeenCalled();
  });
});
```

Тест подменяет `callProvider`, а не `synthesizeWith`: ретрай живёт в `synthesizeWith`, поэтому подменять надо уровнем ниже, иначе тест проверит заглушку вместо логики.

- [ ] **Step 7: Запустить тест, убедиться что падает**

Run: `cd ~/Downloads/spirits_back && npx jest src/speech/speech.service.spec.ts -t "ретрай"`
Expected: FAIL — `callProvider` не вызывается, ретрая нет

- [ ] **Step 8: Реализовать ретрай**

В `src/speech/speech.service.ts` заменить `synthesizeWith` на пару методов:

```typescript
  /** Один ретрай при ошибке провайдера. Фолбэка на другого провайдера нет:
   *  разный тембр на повторе звучит как баг, а не как спасение. */
  private async synthesizeWith(provider: TtsProvider, text: string, voice: string): Promise<Buffer> {
    try {
      return await this.callProvider(provider, text, voice);
    } catch (e: any) {
      this.logger.warn(`tts attempt 1 failed (${provider}/${voice}): ${e.message}, retrying`);
      return await this.callProvider(provider, text, voice);
    }
  }

  private async callProvider(provider: TtsProvider, text: string, voice: string): Promise<Buffer> {
    return provider === 'yandex' ? synthesizeYandex(text, voice) : synthesizeOpenai(text, voice);
  }
```

Тесты Task 5 подменяют `synthesizeWith` целиком, поэтому продолжают работать без изменений.

- [ ] **Step 9: Запустить весь набор**

Run: `cd ~/Downloads/spirits_back && npx jest src/speech/`
Expected: PASS, 31 тест

- [ ] **Step 10: Проверить в обратную сторону**

Убрать `catch` из `synthesizeWith` (пробрасывать ошибку сразу).
Expected: FAIL на «одна неудача ретраится». Вернуть.

Добавить второй ретрай (три попытки).
Expected: FAIL на «ретраев ровно два вызова». Вернуть.

- [ ] **Step 11: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/speech/speech.service.ts src/speech/speech.service.spec.ts
git commit -m "feat(speech): rate limit 20/мин и один ретрай провайдера"
```

---

## Task 7: Контроллер и модуль

**Files:**
- Create: `src/speech/speech.controller.ts`
- Create: `src/speech/speech.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Контроллер**

Создать `src/speech/speech.controller.ts`:

```typescript
// src/speech/speech.controller.ts
import { Controller, Get, Param, UseGuards, NotFoundException } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SpeechService } from './speech.service';
import { VOICE_CATALOG, providerForLang } from './voices';
import { LanguageService } from '../common/services/language.service';

// Префикс без 'webhook': он уже навешен глобально в main.ts через
// app.setGlobalPrefix('webhook'). С 'webhook/speech' маршрут стал бы
// /webhook/webhook/speech.
@Controller('speech')
export class SpeechController {
  constructor(
    private readonly speech: SpeechService,
    private readonly language: LanguageService,
  ) {}

  /**
   * Каталог голосов под язык пользователя: в английском интерфейсе
   * Yandex-голоса показывать бессмысленно — их не выберет провайдер.
   * Объявлен ДО ':id', иначе '/voices' уедет в параметр маршрута.
   */
  @Get('voices')
  @UseGuards(JwtGuard)
  async voices(@CurrentUser() user: any) {
    const lang = await this.language.resolveUserLanguage(user.userId);
    const provider = providerForLang(lang);
    // sampleUrl собирает бэкенд, а не фронт: базовый публичный URL MinIO живёт
    // в MINIO_PUBLIC_URL и фронту неизвестен.
    const base = (process.env.MINIO_PUBLIC_URL || '').replace(/\/$/, '');
    const bucket = process.env.SPEECH_BUCKET || 'linkeon-assets';
    return {
      lang,
      provider,
      voices: VOICE_CATALOG.filter((v) => v.provider === provider).map((v) => ({
        ...v,
        sampleUrl: `${base}/${bucket}/speech-samples/${v.id}.mp3`,
      })),
    };
  }

  @Get(':id')
  @UseGuards(JwtGuard)
  async clip(@CurrentUser() user: any, @Param('id') id: string) {
    const clip = await this.speech.getClip(user.userId, id);
    if (!clip) throw new NotFoundException('clip not found');
    return {
      id: clip.id,
      url: clip.url,
      durationSec: Number(clip.duration_sec ?? 0),
      chars: Number(clip.chars),
      voice: clip.voice,
      provider: clip.provider,
      lang: clip.lang,
      createdAt: clip.created_at,
    };
  }
}
```

Перед реализацией сверить пути импортов `JwtGuard` и `CurrentUser` с любым существующим контроллером, например `src/agents/agents.controller.ts` — если там другие пути, использовать их.

- [ ] **Step 2: Модуль**

Создать `src/speech/speech.module.ts`:

```typescript
// src/speech/speech.module.ts
import { Module } from '@nestjs/common';
import { SpeechService } from './speech.service';
import { SpeechController } from './speech.controller';
import { CommonModule } from '../common/common.module';
import { MiscModule } from '../misc/misc.module';

@Module({
  imports: [CommonModule, MiscModule],
  controllers: [SpeechController],
  providers: [SpeechService],
  exports: [SpeechService],
})
export class SpeechModule {}
```

Сверить имена модулей с `src/app.module.ts`: если `PgService` / `StorageService` / `LanguageService` / `RedisService` предоставляются не через `CommonModule`, импортировать те модули, которые их экспортируют.

- [ ] **Step 3: Зарегистрировать модуль**

В `src/app.module.ts` добавить `SpeechModule` в массив `imports` рядом с остальными модулями.

- [ ] **Step 4: Проверить, что приложение стартует**

Run: `cd ~/Downloads/spirits_back && npx tsc --noEmit && npm run build`
Expected: сборка без ошибок

- [ ] **Step 5: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/speech/speech.controller.ts src/speech/speech.module.ts src/app.module.ts
git commit -m "feat(speech): контроллер каталога и клипов, регистрация модуля"
```

---

## Task 8: Инструмент generate_speech

**Files:**
- Modify: `src/chat/chat-tools.ts` (объявление в `CHAT_TOOLS`, ветка в `executeTool:333`, конструктор `:324`)
- Test: `src/chat/generate-speech.spec.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `src/chat/generate-speech.spec.ts` по образцу существующего `src/chat/propose-calendar.spec.ts` (посмотреть, как там собирается сервис с моками):

```typescript
import { ChatToolsService } from './chat-tools';

function makeTools(speechResult: any) {
  const speech = { synthesize: jest.fn(async () => speechResult) };
  const svc = new ChatToolsService(
    {} as any, {} as any, { query: jest.fn(async () => ({ rows: [] })) } as any,
    {} as any, {} as any, {} as any, speech as any,
  );
  return { svc, speech };
}

describe('generate_speech', () => {
  it('успех прокидывает clipId и kind=audio', async () => {
    const { svc } = makeTools({
      ok: true, clipId: 'c1', audioUrl: 'https://minio/audio/x.mp3',
      durationSec: 3.2, chars: 48, voice: 'zahar', provider: 'yandex',
      tokensSpent: 1000, cached: false,
    });

    const r: any = await svc.executeTool('u1', 'generate_speech', { text: 'Привет' });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('audio');
    expect(r.clipId).toBe('c1');
    expect(r.tokensSpent).toBe(1000);
  });

  it('нехватка токенов прокидывается как есть', async () => {
    const { svc } = makeTools({ ok: false, error: 'insufficient_tokens', balance: 10, required: 1000 });
    const r: any = await svc.executeTool('u1', 'generate_speech', { text: 'Привет' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('insufficient_tokens');
    expect(r.required).toBe(1000);
  });

  it('voice прокидывается в сервис', async () => {
    const { svc, speech } = makeTools({
      ok: true, clipId: 'c1', audioUrl: 'u', durationSec: 1, chars: 6,
      voice: 'jane', provider: 'yandex', tokensSpent: 1000, cached: false,
    });
    await svc.executeTool('u1', 'generate_speech', { text: 'Привет', voice: 'jane' });
    expect(speech.synthesize).toHaveBeenCalledWith('u1', { text: 'Привет', voice: 'jane' });
  });

  it('assistantId из аргументов игнорируется — ассистент берётся из БД', async () => {
    const { svc, speech } = makeTools({
      ok: true, clipId: 'c1', audioUrl: 'u', durationSec: 1, chars: 6,
      voice: 'zahar', provider: 'yandex', tokensSpent: 1000, cached: false,
    });
    await svc.executeTool('u1', 'generate_speech', { text: 'Привет', assistantId: '999' });
    expect(speech.synthesize).toHaveBeenCalledWith('u1', { text: 'Привет', voice: undefined });
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `cd ~/Downloads/spirits_back && npx jest src/chat/generate-speech.spec.ts`
Expected: FAIL — `unknown tool: generate_speech`

- [ ] **Step 3: Объявить инструмент**

В `src/chat/chat-tools.ts` добавить в массив `CHAT_TOOLS` (рядом с `generate_image`):

```typescript
  {
    name: 'generate_speech',
    description:
      'Озвучить текст голосом и показать пользователю аудио-плеер. Вызывай, когда просят «озвучь», ' +
      '«прочитай вслух», «наговори голосом», «сделай аудио». ' +
      'Голос можно выбрать любой — он НЕ обязан совпадать с твоей персоной: можно озвучить реплику ' +
      'женским голосом, а в одном ответе сделать несколько клипов разными голосами (диалог, сценка по ролям) — ' +
      'для этого вызови инструмент по разу на каждую реплику со своим voice. ' +
      'Язык берётся из настроек пользователя автоматически, параметра языка нет. ' +
      'НИКОГДА не придумывай ссылку на аудио сам — плеер появляется у пользователя отдельной карточкой. ' +
      'Если инструмент вернул ошибку — передай её текст пользователю и НЕ утверждай, что аудио «готовится». ' +
      'Стоимость: 1000 токенов за каждую начатую 1000 символов. Максимум за вызов — 2000 символов ' +
      'для русского и 4000 для остальных языков (ограничения провайдеров). Текст длиннее вернёт ' +
      'ошибку text_too_long с точным максимумом — тогда сократи или озвучь несколькими вызовами. ' +
      'Голоса для русского: alena (тёплый женский), jane (мягкий женский), omazh (деловой женский), ' +
      'dasha, julia, lera, masha, marina (женские), zahar (уверенный мужской), filipp (дружелюбный мужской), ' +
      'ermil (мягкий мужской), madirus (глубокий деловой мужской), alexander, kirill, anton (мужские). ' +
      'Голоса для остальных языков: alloy, nova, shimmer (женские), echo, onyx, fable (мужские). ' +
      'Если voice не передан — берётся голос, назначенный пользователем, иначе голос ассистента по умолчанию.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Текст для озвучки. До 2000 символов на русском, до 4000 на других языках.' },
        voice: { type: 'string', description: 'Необязательный id голоса из списка выше. Несуществующий id молча заменяется на голос по умолчанию.' },
      },
      required: ['text'],
    },
  },
```

- [ ] **Step 4: Добавить зависимость и ветку обработки**

В конструктор `ChatToolsService` (`src/chat/chat-tools.ts:324`) добавить последним параметром:

```typescript
    private readonly speech: SpeechService,
```

и импорт в начало файла:

```typescript
import { SpeechService } from '../speech/speech.service';
```

В `executeTool` добавить ветку рядом с `generate_image`:

```typescript
      if (name === 'generate_speech') {
        // assistantId из аргументов сознательно игнорируется: по MCP модель сама
        // подставляет аргументы, ассистент берётся из preferred_agent в БД.
        const r = await this.speech.synthesize(userId, {
          text: String(input?.text ?? ''),
          voice: typeof input?.voice === 'string' ? input.voice : undefined,
        });
        if (!r.ok) return r as any;
        return {
          ok: true, kind: 'audio', clipId: r.clipId, audioUrl: r.audioUrl,
          durationSec: r.durationSec, chars: r.chars, voice: r.voice,
          tokensSpent: r.tokensSpent, cached: r.cached,
        };
      }
```

Добавить `'audio'` в union-тип `ToolResult` (`src/chat/chat-tools.ts:238`), по образцу существующих `kind`-веток.

В `ChatModule` добавить `SpeechModule` в `imports`, иначе DI не найдёт `SpeechService`.

- [ ] **Step 5: Запустить тесты**

Run: `cd ~/Downloads/spirits_back && npx jest src/chat/generate-speech.spec.ts`
Expected: PASS, 4 теста

Затем весь набор: `npx jest`
Expected: PASS. Если упал `propose-calendar.spec.ts` — там конструктор `ChatToolsService` вызывается позиционно, добавить седьмым аргументом заглушку `{} as any`.

- [ ] **Step 6: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/chat/chat-tools.ts src/chat/generate-speech.spec.ts src/chat/chat.module.ts
git commit -m "feat(chat): инструмент generate_speech для всех ассистентов"
```

---

## Task 9: Валидация выбора голоса в профиле

**Files:**
- Modify: `src/profile/profile.service.ts:115` (метод обновления профиля)
- Test: `src/profile/assistant-voices.spec.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `src/profile/assistant-voices.spec.ts`:

```typescript
import { sanitizeAssistantVoices } from './profile.service';

describe('sanitizeAssistantVoices', () => {
  it('пропускает валидные пары', () => {
    expect(sanitizeAssistantVoices({ 'Роман': 'filipp', 'Оля': 'nova' }))
      .toEqual({ 'Роман': 'filipp', 'Оля': 'nova' });
  });

  it('выбрасывает несуществующие голоса', () => {
    expect(sanitizeAssistantVoices({ 'Роман': 'megatron-9000' })).toEqual({});
  });

  it('null очищает переопределение', () => {
    expect(sanitizeAssistantVoices({ 'Роман': null })).toEqual({});
  });

  it('не-объект превращается в пустой объект', () => {
    expect(sanitizeAssistantVoices('строка' as any)).toEqual({});
    expect(sanitizeAssistantVoices(null as any)).toEqual({});
  });

  it('ограничивает число ключей', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 200; i++) many[`Агент${i}`] = 'zahar';
    expect(Object.keys(sanitizeAssistantVoices(many)).length).toBeLessThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `cd ~/Downloads/spirits_back && npx jest src/profile/assistant-voices.spec.ts`
Expected: FAIL — `sanitizeAssistantVoices is not a function`

- [ ] **Step 3: Написать реализацию**

В `src/profile/profile.service.ts` добавить экспортируемую функцию:

```typescript
import { VOICE_CATALOG } from '../speech/voices';

const MAX_VOICE_OVERRIDES = 50;

/**
 * Пользовательский выбор голосов приходит из браузера, поэтому проверяем всё:
 * несуществующие id выбрасываем, null трактуем как «сбросить на дефолт».
 */
export function sanitizeAssistantVoices(raw: any): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const valid = new Set(VOICE_CATALOG.map((v) => v.id));
  const out: Record<string, string> = {};
  for (const [assistant, voice] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_VOICE_OVERRIDES) break;
    if (typeof voice !== 'string') continue;
    if (!valid.has(voice)) continue;
    out[assistant] = voice;
  }
  return out;
}
```

В методе обновления профиля (`profile.service.ts:115`, там где `profile_data = COALESCE(profile_data, '{}'::jsonb) || $1::jsonb`) прогнать входящее поле через санитайзер перед мержем: если в теле запроса есть `assistant_voices`, заменить его на `sanitizeAssistantVoices(body.assistant_voices)`.

- [ ] **Step 4: Запустить тест**

Run: `cd ~/Downloads/spirits_back && npx jest src/profile/assistant-voices.spec.ts`
Expected: PASS, 5 тестов

- [ ] **Step 5: Проверить в обратную сторону**

Убрать проверку `valid.has(voice)`.
Expected: FAIL на «выбрасывает несуществующие голоса». Вернуть.

- [ ] **Step 6: Коммит**

```bash
cd ~/Downloads/spirits_back
git add src/profile/profile.service.ts src/profile/assistant-voices.spec.ts
git commit -m "feat(profile): валидация assistant_voices при обновлении профиля"
```

---

## Task 10: Скрипт превью-сэмплов

**Files:**
- Create: `scripts/generate-voice-samples.ts`

Этот же скрипт служит интеграционной проверкой обоих провайдеров: если он отработал и залил непустые MP3, значит и Yandex, и OpenAI отвечают.

- [ ] **Step 1: Написать скрипт**

Создать `scripts/generate-voice-samples.ts`:

```typescript
/**
 * Разовая генерация превью голосов в MinIO: speech-samples/<voice>.mp3.
 * Идемпотентен — уже загруженные сэмплы пропускает.
 *
 * Запуск: npx ts-node scripts/generate-voice-samples.ts [--force]
 */
import 'dotenv/config';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { VOICE_CATALOG } from '../src/speech/voices';
import { synthesizeYandex } from '../src/speech/providers/yandex';
import { synthesizeOpenai } from '../src/speech/providers/openai';

const SAMPLE_RU = 'Здравствуйте! Так звучит мой голос. Я помогу вам разобраться с вашим вопросом.';
const SAMPLE_EN = 'Hello! This is how my voice sounds. I am here to help you with your question.';
const BUCKET = process.env.SPEECH_BUCKET || 'linkeon-assets';
const FORCE = process.argv.includes('--force');

async function main() {
  const s3 = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY!,
      secretAccessKey: process.env.MINIO_SECRET_KEY!,
    },
    forcePathStyle: true,
  });

  let created = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const v of VOICE_CATALOG) {
    const key = `speech-samples/${v.id}.mp3`;
    if (!FORCE) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        skipped++;
        continue;
      } catch {
        // нет объекта — генерируем
      }
    }

    try {
      const bytes = v.provider === 'yandex'
        ? await synthesizeYandex(SAMPLE_RU, v.id)
        : await synthesizeOpenai(SAMPLE_EN, v.id);

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: bytes,
        ContentType: 'audio/mpeg',
        CacheControl: 'public, max-age=31536000, immutable',
      }));
      created++;
      console.log(`ok   ${v.provider}/${v.id} — ${bytes.length} bytes`);
    } catch (e: any) {
      failed.push(`${v.provider}/${v.id}: ${e.message}`);
      console.error(`FAIL ${v.provider}/${v.id} — ${e.message}`);
    }
  }

  console.log(`\ncreated=${created} skipped=${skipped} failed=${failed.length}`);
  if (failed.length) {
    console.error('Провалившиеся голоса:\n' + failed.join('\n'));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Прогнать скрипт**

Run: `cd ~/Downloads/spirits_back && npx ts-node scripts/generate-voice-samples.ts`
Expected: `created=21 skipped=0 failed=0`, каждая строка с ненулевым размером

Если какой-то Yandex-голос отвечает 400 — его нет в актуальном SpeechKit. Убрать этот голос из `VOICE_CATALOG` (спека прямо предупреждает, что состав меняется) и прогнать снова.

- [ ] **Step 3: Проверить идемпотентность**

Run: `npx ts-node scripts/generate-voice-samples.ts`
Expected: `created=0 skipped=21 failed=0`

- [ ] **Step 4: Проверить, что сэмплы играются**

Открыть в браузере `<MINIO_PUBLIC_URL>/linkeon-assets/speech-samples/zahar.mp3` — должен проиграться русский текст мужским голосом. Затем `nova.mp3` — английский женским.

- [ ] **Step 5: Коммит**

```bash
cd ~/Downloads/spirits_back
git add scripts/generate-voice-samples.ts src/speech/voices.ts
git commit -m "feat(speech): скрипт генерации превью-сэмплов голосов"
```

---

## Task 11: Фронт — аудио-плеер в чате

**Files:** (репозиторий `~/Downloads/spirits_front`)
- Create: `src/components/chat/AudioClip.tsx`
- Modify: `src/utils/customMarkdown.tsx:28` (регулярки), `:97` (замена), возврат объекта
- Modify: `src/components/chat/ChatInterface.tsx:1192` (обработка `tool_result`)
- Modify: `src/i18n/locales/{ru,en,es,de,fr,zh}.json`

- [ ] **Step 1: Компонент плеера**

Создать `src/components/chat/AudioClip.tsx`:

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, Download, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../../services/apiClient';

interface ClipMeta {
  id: string;
  url: string;
  durationSec: number;
  voice: string;
}

const AudioClip: React.FC<{ clipId: string }> = ({ clipId }) => {
  const { t } = useTranslation();
  const [meta, setMeta] = useState<ClipMeta | null>(null);
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get(`/webhook/speech/${clipId}`);
        if (!cancelled) setMeta(res.data ?? res);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [clipId]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); } else { void el.play(); }
  };

  if (error) {
    return (
      <div className="flex items-center gap-2 my-2 p-3 rounded-lg bg-red-50 text-red-700 text-sm">
        <AlertCircle className="w-4 h-4 shrink-0" />
        <span>{t('chat.audio_load_error')}</span>
      </div>
    );
  }

  if (!meta) {
    return <div className="my-2 h-14 rounded-lg bg-gray-100 animate-pulse" aria-hidden="true" />;
  }

  const duration = audioRef.current?.duration || meta.durationSec || 0;
  const pct = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  return (
    <div className="flex items-center gap-3 my-2 p-3 rounded-lg bg-blue-50 border border-blue-100">
      <button
        onClick={toggle}
        aria-label={playing ? t('chat.audio_pause') : t('chat.audio_play')}
        className="w-10 h-10 shrink-0 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700 transition-colors"
      >
        {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
      </button>

      <div className="flex-1 min-w-0">
        <div className="h-1.5 rounded-full bg-blue-200 overflow-hidden">
          <div className="h-full bg-blue-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1 text-xs text-blue-900/70 tabular-nums">
          {fmt(progress)} / {fmt(duration)}
        </div>
      </div>

      <a
        href={meta.url}
        download
        aria-label={t('chat.audio_download')}
        className="w-8 h-8 shrink-0 rounded-full text-blue-700 hover:bg-blue-100 flex items-center justify-center"
      >
        <Download className="w-4 h-4" />
      </a>

      <audio
        ref={audioRef}
        src={meta.url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0); }}
        onTimeUpdate={(e) => setProgress((e.target as HTMLAudioElement).currentTime)}
      />
    </div>
  );
};

export default AudioClip;
```

Сверить способ вызова `apiClient.get` с любым существующим компонентом — в проекте он может возвращать распарсенный объект, а не `{ data }`.

- [ ] **Step 2: Разбор маркера в customMarkdown**

В `src/utils/customMarkdown.tsx` рядом с `SMM_VIDEO_REGEX` (строка 28) добавить:

```typescript
const AUDIO_CLIP_REGEX = /\{\{audio:id=([a-f0-9-]{36})\}\}/g;
```

Рядом с обработкой `SMM_VIDEO_REGEX` (строка ~97) добавить:

```typescript
  parsedContent = parsedContent.replace(AUDIO_CLIP_REGEX, (_match, clipId) => {
    const key = `audio_${clipId}`;
    audioClips.set(key, clipId);
    return `__AUDIO_CLIP_${key}__`;
  });
```

Завести `const audioClips = new Map<string, string>();` рядом с `smmVideos`, добавить `audioClips` в возвращаемый объект, и отрендерить `__AUDIO_CLIP_*__` через `<AudioClip clipId={…} />` там же, где рендерится `__SMM_VIDEO_*__`.

- [ ] **Step 3: Вставка маркера по tool_result**

В `src/components/chat/ChatInterface.tsx` рядом с обработкой `generate_video` (строка ~1192) добавить:

```typescript
            if (data.type === 'tool_result' && data.tool === 'generate_speech') {
              if (data.result?.ok && data.result?.kind === 'audio' && data.result?.clipId) {
                accumulatedContent += `\n\n{{audio:id=${data.result.clipId}}}`;
              } else if (data.result?.error) {
                accumulatedContent += `\n\n*${t('chat.speech_gen_error', { error: data.result.error })}*`;
              }
            }
```

- [ ] **Step 4: Строки локализации**

Добавить в секцию `chat` каждого из шести файлов `src/i18n/locales/{ru,en,es,de,fr,zh}.json`:

```json
"audio_play": "Воспроизвести",
"audio_pause": "Пауза",
"audio_download": "Скачать аудио",
"audio_load_error": "Не удалось загрузить аудио",
"speech_gen_error": "Не удалось озвучить: {{error}}"
```

(в `ru.json` — как есть; в остальные — переводы на соответствующий язык)

- [ ] **Step 5: Проверить сборку и линт**

Run: `cd ~/Downloads/spirits_front && pnpm lint && pnpm build`
Expected: без ошибок

- [ ] **Step 6: Проверить вручную в dev**

Run: `cd ~/Downloads/spirits_front && pnpm dev`

В чате попросить ассистента: «озвучь, пожалуйста: проверка связи». Ожидается карточка плеера, звук играет, время идёт, кнопка скачивания работает. Перезагрузить страницу — плеер должен остаться на месте и играть.

Проверить и обратную сторону: временно сломать регулярку (например, ждать 10 символов вместо 36) — маркер должен остаться видимым текстом `{{audio:id=…}}` вместо плеера. Вернуть регулярку.

- [ ] **Step 7: Коммит**

```bash
cd ~/Downloads/spirits_front
git add src/components/chat/AudioClip.tsx src/utils/customMarkdown.tsx src/components/chat/ChatInterface.tsx src/i18n/locales/
git commit -m "feat(chat): аудио-плеер для озвучки ответов ассистентов"
```

---

## Task 12: Фронт — выбор голоса в настройках

**Files:** (репозиторий `~/Downloads/spirits_front`)
- Create: `src/components/settings/VoiceSettings.tsx`
- Modify: `src/components/settings/SettingsView.tsx`
- Modify: `src/i18n/locales/{ru,en,es,de,fr,zh}.json`

- [ ] **Step 1: Компонент секции**

Создать `src/components/settings/VoiceSettings.tsx`:

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../../services/apiClient';

interface Voice { id: string; title: string; description: string; gender: 'm' | 'f'; sampleUrl: string }
interface Assistant { id: number; name: string; displayName?: string }

const VoiceSettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [voices, setVoices] = useState<Voice[]>([]);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const previewRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    (async () => {
      const [v, a, p] = await Promise.all([
        apiClient.get('/webhook/speech/voices'),
        apiClient.get(`/webhook/agents?lang=${i18n.language}`),
        apiClient.get('/webhook/profile'),
      ]);
      setVoices((v.data ?? v).voices ?? []);
      setAssistants(a.data ?? a);
      setSelection(((p.data ?? p).profile_data?.assistant_voices) ?? {});
    })();
  }, [i18n.language]);

  const play = (voiceId: string) => {
    const entry = voices.find((v) => v.id === voiceId);
    if (!entry) return;
    if (previewRef.current) previewRef.current.pause();
    const audio = new Audio(entry.sampleUrl);
    previewRef.current = audio;
    void audio.play();
  };

  const change = async (assistantName: string, voiceId: string) => {
    // Пустая строка = «по умолчанию»: убираем ключ, бэкенд откатится на дефолт ассистента.
    const next = { ...selection };
    if (voiceId) next[assistantName] = voiceId; else delete next[assistantName];
    setSelection(next);
    setSaving(true);
    try {
      await apiClient.put('/webhook/profile-update', { assistant_voices: next });
      if (voiceId) play(voiceId);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-white rounded-xl p-4 md:p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <Volume2 className="w-5 h-5 text-blue-600" />
        <h2 className="text-lg font-semibold text-gray-900">{t('settings.voices_title')}</h2>
      </div>
      <p className="text-sm text-gray-600 mb-4">{t('settings.voices_hint')}</p>

      <div className="space-y-3">
        {assistants.map((a) => (
          <div key={a.id} className="flex items-center gap-3">
            <span className="w-32 shrink-0 text-sm text-gray-800">{a.displayName ?? a.name}</span>
            <select
              value={selection[a.name] ?? ''}
              onChange={(e) => change(a.name, e.target.value)}
              disabled={saving}
              className="flex-1 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">{t('settings.voice_default')}</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>{v.title} — {v.description}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => play(selection[a.name] ?? voices[0]?.id)}
              aria-label={t('settings.voice_preview')}
              className="w-9 h-9 shrink-0 rounded-full text-blue-700 hover:bg-blue-50 flex items-center justify-center"
            >
              <Volume2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
};

export default VoiceSettings;
```

URL сэмпла приходит готовым полем `sampleUrl` из `GET /webhook/speech/voices` (Task 7) — фронт его не собирает, потому что `MINIO_PUBLIC_URL` ему неизвестен.

- [ ] **Step 2: Подключить секцию**

В `src/components/settings/SettingsView.tsx` отрендерить `<VoiceSettings />` рядом с существующими секциями настроек.

- [ ] **Step 3: Строки локализации**

Добавить в секцию `settings` каждого из шести файлов локалей:

```json
"voices_title": "Голоса ассистентов",
"voices_hint": "Выберите, каким голосом будет озвучивать ответы каждый ассистент. Кнопка справа проигрывает образец.",
"voice_default": "По умолчанию",
"voice_preview": "Прослушать образец"
```

- [ ] **Step 4: Проверить сборку**

Run: `cd ~/Downloads/spirits_front && pnpm lint && pnpm build`
Expected: без ошибок

- [ ] **Step 5: Проверить вручную**

В dev-режиме открыть настройки: список ассистентов, у каждого селект. Выбрать Роману голос `filipp` — должен проиграться образец. Перейти в чат, попросить озвучку — голос должен быть `filipp`, а не дефолтный `zahar`.

Проверить обратную сторону: вернуть «По умолчанию», снова попросить озвучку — должен вернуться `zahar`. Если голос не поменялся, значит либо кэш отдаёт старый клип (проверить, что текст отличается), либо ключ в `assistant_voices` не совпал с `preferred_agent`.

- [ ] **Step 6: Коммит**

```bash
cd ~/Downloads/spirits_front
git add src/components/settings/VoiceSettings.tsx src/components/settings/SettingsView.tsx src/i18n/locales/
git commit -m "feat(settings): выбор голоса для каждого ассистента"
```

---

## Task 13: Прогон, миграция, деплой

- [ ] **Step 1: Полный прогон тестов бэка**

Run: `cd ~/Downloads/spirits_back && npx jest`
Expected: PASS, включая 29 новых тестов в `src/speech/` и 9 в `src/chat/`, `src/profile/`

- [ ] **Step 2: Сборка обоих проектов**

```bash
cd ~/Downloads/spirits_back && npm run build
cd ~/Downloads/spirits_front && pnpm build
```
Expected: обе сборки зелёные

- [ ] **Step 3: Проверить переменные окружения на обоих серверах**

`YANDEX_TTS_FOLDER_ID` сейчас лежит только в `worker/.env` — основному API он тоже нужен:

```bash
ssh dvolkov@212.113.106.202 "grep -c '^YANDEX_TTS_FOLDER_ID=' /home/dvolkov/spirits_back/.env"
ssh dv@85.192.61.231 "grep -c '^YANDEX_TTS_FOLDER_ID=' ~/spirits_back/.env"
```
Expected: `1` на обоих. Если `0` — дописать значение из `worker/.env` (взять через `grep`, не выводя в общий лог).

- [ ] **Step 4: Накатить миграцию на test**

`npm run migrate` на проде застревает на `base/001`, поэтому только вручную:

```bash
ssh dv@85.192.61.231 "cd ~/spirits_back && DB=\$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-) && psql \"\$DB\" -f src/speech/migrations/001_speech_clips.sql && psql \"\$DB\" -c \"INSERT INTO schema_migrations (name) VALUES ('speech/001_speech_clips') ON CONFLICT DO NOTHING\""
```

Сверить имя колонки в `schema_migrations` перед вставкой — если там не `name`, подставить фактическую.

- [ ] **Step 5: Деплой**

```bash
bash ~/Downloads/spirits_back/scripts/deploy.sh
```

Без флагов: test → smoke → prod → smoke. Прод не трогается, пока test красный. Ручной `rsync` / `git pull` / правка файлов на сервере запрещены.

**Деплой запускать только после явного «ок» от владельца.**

- [ ] **Step 6: Накатить миграцию на прод**

После зелёного test — та же команда для `dvolkov@212.113.106.202` и `/home/dvolkov/spirits_back`.

- [ ] **Step 7: Сгенерировать сэмплы на проде**

```bash
ssh dvolkov@212.113.106.202 "cd /home/dvolkov/spirits_back && npx ts-node scripts/generate-voice-samples.ts"
```
Expected: `created=21 skipped=0 failed=0`

- [ ] **Step 8: Проверить на живом проде**

Зайти на my.linkeon.io тестовым аккаунтом, попросить Романа «озвучь: проверка связи». Ожидается плеер, звук играет. Проверить баланс токенов до и после — должен уменьшиться ровно на 1000.

Затем повторить ту же просьбу тем же текстом: второй раз должно быть бесплатно (кэш), баланс не меняется.

---

## Definition of Done

- [ ] `generate_speech` доступен всем ассистентам, Роман озвучивает по просьбе
- [ ] Голос можно задать параметром API, в одном ответе работают разные голоса
- [ ] Пользователь назначает голос каждому ассистенту в настройках, с превью
- [ ] Списывается 1000 токенов за начатую 1000 символов, повтор бесплатен
- [ ] Плеер переживает перезагрузку страницы
- [ ] Все тесты зелёные и проверены на ломкость в обе стороны
- [ ] Прод и test задеплоены через `deploy.sh`, миграция накачена, сэмплы сгенерированы
