# Короткие ролики, план 1: ролик-образец и ядро студии — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собрать в `spirits_back/studio/` ядро студии (съёмка настоящего кабинета, озвучка SpeechKit, сборка в Remotion, проверка файла) и выпустить им один ролик-образец, на котором владелец согласует внешний вид, голос и темп.

**Architecture:** Отдельный ESM-пакет на TypeScript, как `voice-host/`. Чистые модули (таймлайн, субтитры, панорама, абзацы, проверки) покрыты тестами `tsx --test`. Съёмка — Playwright на демо-аккаунте, сборка — Remotion 4.0.530, вызываемый из кода (`@remotion/bundler` + `@remotion/renderer`). Две команды: `capture` (сцена → папка съёмки) и `render` (папка съёмки + сценарий → mp4 + проверка). Во втором плане они станут заданиями `capture` и `render` конвейера.

**Tech Stack:** Node 22, TypeScript 5, Playwright 1.59.1, Remotion 4.0.530 + React 19.1.0, `@remotion/google-fonts` (Nunito, как в мультфильме), Yandex SpeechKit v1, ffmpeg/ffprobe.

**Спека:** `docs/superpowers/specs/2026-10-24-promo-shorts-design.md` (раздел «Порядок работ», шаг 1).

**Вне этого плана** (планы 2 и 3, пишутся после отзыва владельца об образце): модуль `src/shorts/` в API, таблицы, одобрение в Telegram, публикация, админка, метки, VK, сводка, выкат студии на прод.

---

## Как работать

- **Воркдерево на маке:** `/Users/dmitry/Downloads/spirits_back/.worktrees/promo-shorts`, ветка `feat/promo-shorts`. Ниже `WT` — этот путь. Git-команды — через `git -C "$WT"`, без `cd` в цепочках (CLAUDE.md: `cd` переносится между звеньями `&&`).
- **Всё тяжёлое — на тестовой ноде** `dv@85.192.61.231` (CLAUDE.md: «мак не тянет»): `npm install`, тесты, рендер, съёмка. Код на ноду попадает только через git. Скрипт `studio/scripts/node-run.sh "<команда>"` (задача 0) пушит ветку и ставит воркдерево ноды `~/ci/wt/promo-shorts` на **точный коммит**, затем выполняет команду в `studio/`.
- **Живой чекаут `~/spirits_back` на ноде не трогать** — из него работает test.linkeon.io. Из его `.env` можно только читать (`grep`).
- **Ничего не выкатывать.** Ни `deploy.sh`, ни прод в этом плане не участвуют. Съёмка образца идёт на стенде `test.linkeon.io`.
- **Импорты без расширений** (`from './timeline'`). Composition Remotion собирает webpack, а он не превращает `./x.js` в `./x.tsx`; tsx и `tsc` (moduleResolution `bundler`) понимают импорты без расширения.
- **Коммиты** — по-русски, с префиксом, как в репозитории: `test(studio): … (красный)` для падающего теста, затем `feat(studio): …`. Каждое сообщение заканчивается строкой `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **SSH к ноде — по одному соединению за раз:** там `MaxStartups 10:30:100`, параллельные сессии рвутся.

## Файлы

| Файл | За что отвечает |
|---|---|
| `studio/package.json`, `tsconfig.json`, `.gitignore`, `.env.example` | Пакет студии |
| `studio/scripts/node-run.sh` | Прогон команды на ноде по точному коммиту |
| `studio/src/types.ts` | Типы: сцена, съёмка, сценарий, таймлайн, пропсы |
| `studio/src/guard.ts` | Демо-номер — только тестового шаблона `790300XXXXX` |
| `studio/src/timeline.ts` | Реплики с длительностями → кадры сцен |
| `studio/src/captions.ts` | Реплика → куски субтитров и их кадры |
| `studio/src/pan.ts` | Сдвиг высокого скриншота к абзацу |
| `studio/src/boxes.ts` | Блоки ответа из DOM → абзацы на картинке |
| `studio/src/plural.ts` | «18 ассистентов» через `Intl.PluralRules` |
| `studio/src/script.ts` | Проверка сценария до озвучки |
| `studio/src/answer.ts` | Годится ли ответ для съёмки, встречный ли это вопрос |
| `studio/src/ffprobe.ts` | Разбор ffprobe и silencedetect, проверка ролика |
| `studio/src/config.ts` | Разбор окружения |
| `studio/src/tts.ts` | SpeechKit с кешем |
| `studio/src/render/props.ts` | Съёмка + сценарий + озвучка → пропсы композиции |
| `studio/src/render/run-render.ts` | Команда `render` |
| `studio/src/render/render.fixture.ts` | Сквозной рендер из фикстуры без сети |
| `studio/src/remotion/*` | Композиция `Short`: тема, сцены, субтитры |
| `studio/src/capture/login.ts` | Вход демо-аккаунта через API |
| `studio/src/capture/chat-scene.ts` | Съёмка сцены чата Playwright |
| `studio/src/capture/run-capture.ts` | Команда `capture` |
| `studio/public/logo.png` | Логотип 512×512 (из `spirits_front/public/android-chrome-512x512.png`) |
| `studio/scenes/sample-lawyer-lease.json` | Сцена образца |
| `studio/README.md` | Как снимать и собирать |

---

### Task 0: Прогон на ноде и воркдерево

**Files:**
- Create: `studio/scripts/node-run.sh`

- [ ] **Step 1: Написать скрипт**

`studio/scripts/node-run.sh`:

```bash
#!/usr/bin/env bash
# Прогон команды студии на тестовой ноде (CLAUDE.md: сборки и тесты — не на маке).
# Пушит текущую ветку и ставит воркдерево ноды ~/ci/wt/promo-shorts на ТОЧНЫЙ коммит:
# по имени ветки нельзя — в общие чекауты коммитят параллельные сессии.
#   studio/scripts/node-run.sh "npm test"
set -euo pipefail
cmd="${1:?usage: studio/scripts/node-run.sh \"<команда в studio/>\"}"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse HEAD)"
branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
git -C "$repo" push -q origin "HEAD:refs/heads/${branch}"
ssh -o ConnectTimeout=15 dv@85.192.61.231 \
  "set -e; cd ~/ci/wt/promo-shorts && git fetch -q origin && git checkout -q --detach ${sha} && cd studio && source ~/.nvm/nvm.sh >/dev/null && ${cmd}"
```

- [ ] **Step 2: Сделать исполняемым и закоммитить**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/promo-shorts
chmod +x "$WT/studio/scripts/node-run.sh"
git -C "$WT" add studio/scripts/node-run.sh
git -C "$WT" commit -q -m "chore(studio): прогон на тестовой ноде по точному коммиту" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C "$WT" push -q -u origin feat/promo-shorts
```

- [ ] **Step 3: Завести воркдерево на ноде**

```bash
SHA=$(git -C "$WT" rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/promo-shorts ${SHA} && git -C ~/ci/wt/promo-shorts log --oneline -1"
```

Expected: строка с коммитом `chore(studio): прогон на тестовой ноде…`.

---

### Task 1: Каркас пакета и проверка демо-номера

**Files:**
- Create: `studio/package.json`, `studio/tsconfig.json`, `studio/.gitignore`, `studio/.env.example`
- Create: `studio/src/guard.ts`
- Test: `studio/src/guard.test.ts`

- [ ] **Step 1: Каркас пакета**

`studio/package.json`:

```json
{
  "name": "linkeon-studio",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Студия коротких роликов Linkeon: съёмка кабинета, озвучка SpeechKit, сборка в Remotion",
  "scripts": {
    "test": "tsx --test src/guard.test.ts",
    "test:render": "tsx --test src/render/render.fixture.ts",
    "typecheck": "tsc --noEmit",
    "capture": "tsx src/capture/run-capture.ts",
    "render": "tsx src/render/run-render.ts"
  },
  "dependencies": {
    "@remotion/bundler": "4.0.530",
    "@remotion/google-fonts": "4.0.530",
    "@remotion/renderer": "4.0.530",
    "dotenv": "^17.4.2",
    "playwright": "1.59.1",
    "react": "19.1.0",
    "react-dom": "19.1.0",
    "remotion": "4.0.530"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.1.0",
    "tsx": "^4.23.12",
    "typescript": "^5.9.3"
  }
}
```

`studio/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

`studio/.gitignore`:

```
node_modules/
out/
.env
```

`studio/.env.example`:

```
# Куда смотрит студия. Образец — на стенде; конвейер (план 2) — на проде.
CABINET_URL=https://test.linkeon.io
API_URL=https://test.linkeon.io
# Basic Auth стенда «user:pass» (TEST_BASIC_AUTH из spirits_back/scripts/test-server.env.local). На проде пусто.
CABINET_BASIC_AUTH=
# Демо-аккаунт: только номер тестового шаблона 790300XXXXX.
DEMO_PHONE=79030000001
# Секрет debug-ручек той среды, куда ходит студия (DEBUG_SECRET из её .env).
DEBUG_SECRET=
# SpeechKit — те же ключи, что у бэкенда.
YANDEX_SPEECHKIT_API_KEY=
YANDEX_TTS_FOLDER_ID=
```

- [ ] **Step 2: Написать падающий тест**

`studio/src/guard.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDemoPhone } from './guard';

test('номер тестового шаблона принимается', () => {
  assert.equal(assertDemoPhone(' 79030000001 '), '79030000001');
});

test('живой номер отклоняется', () => {
  assert.throws(() => assertDemoPhone('79161234567'), /790300XXXXX/);
});

test('пустой и короткий номер отклоняются', () => {
  assert.throws(() => assertDemoPhone(''), /790300XXXXX/);
  assert.throws(() => assertDemoPhone('7903000001'), /790300XXXXX/);
});
```

- [ ] **Step 3: Закоммитить красный тест**

```bash
git -C "$WT" add studio/package.json studio/tsconfig.json studio/.gitignore studio/.env.example studio/src/guard.test.ts
git -C "$WT" commit -q -m "test(studio): демо-номер только из тестового шаблона (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Поставить зависимости на ноде и убедиться, что тест падает**

```bash
"$WT/studio/scripts/node-run.sh" "npm install --no-audit --no-fund && npx playwright install chromium && npm test"
```

Expected: `npm install` проходит. `npm test` падает с ошибкой вида `Cannot find module '…/src/guard'`.

- [ ] **Step 5: Забрать lock-файл с ноды**

`npm install` создал `package-lock.json` на ноде; его коммитим, чтобы дальше ставить через `npm ci`.

```bash
scp dv@85.192.61.231:ci/wt/promo-shorts/studio/package-lock.json "$WT/studio/package-lock.json"
```

- [ ] **Step 6: Реализация**

`studio/src/guard.ts`:

```ts
/**
 * Тестовый шаблон номеров. Под него уже настроены фильтры аналитики
 * (AttributionService) и белый список debug-ручек бэкенда, поэтому
 * демо-аккаунт не попадает в отчёты, а живой номер студия не возьмёт никогда.
 */
export const DEMO_PHONE_PATTERN = /^790300\d{5}$/;

export function assertDemoPhone(phone: string): string {
  const p = String(phone ?? '').trim();
  if (!DEMO_PHONE_PATTERN.test(p)) {
    throw new Error(`studio: демо-номер обязан подходить под 790300XXXXX, получено «${p}»`);
  }
  return p;
}
```

- [ ] **Step 7: Тест проходит**

Неотслеживаемый lock на ноде мешает `git checkout` коммита, в котором lock уже есть, поэтому сначала его убрать:

```bash
ssh dv@85.192.61.231 'rm -f ~/ci/wt/promo-shorts/studio/package-lock.json'
git -C "$WT" add studio/src/guard.ts studio/package-lock.json
git -C "$WT" commit -q -m "feat(studio): каркас пакета студии, демо-номер только тестовый" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: `# pass 3`, `# fail 0`.

---

### Task 2: Типы и таймлайн

**Files:**
- Create: `studio/src/types.ts`, `studio/src/timeline.ts`
- Test: `studio/src/timeline.test.ts`
- Modify: `studio/package.json` (скрипт `test`)

- [ ] **Step 1: Типы**

`studio/src/types.ts`:

```ts
/** Сцена, которую нужно снять: что и у какого ассистента спросить. */
export interface Scene {
  kind: 'chat';
  assistantId: number;
  /** Имя ассистента как в кабинете — по нему проверяется, что открыт нужный. */
  assistantName: string;
  question: string;
  /** Ответы на встречный вопрос ассистента, по порядку. Используется не больше двух. */
  followups: string[];
}

/** Абзац ответа на высоком скриншоте, в пикселях картинки. */
export interface ImageBox {
  /** Номер с 1, сверху вниз. На него ссылаются реплики сценария. */
  n: number;
  top: number;
  height: number;
  /** Начало текста абзаца (до 120 символов) — подсказка сценаристу. */
  text: string;
}

export interface CaptureResult {
  scene: Scene;
  cabinetUrl: string;
  capturedAt: string;
  questionShot: string;
  answerShot: string;
  answerShotWidth: number;
  answerShotHeight: number;
  answerText: string;
  /** Сколько ходов ушло: 1 + ответы на встречные вопросы. */
  turns: number;
  boxes: ImageBox[];
  assistantsCount: number;
}

export type LineScene = 'hook' | 'question' | 'answer' | 'final';

export interface ScriptLine {
  id: string;
  scene: LineScene;
  text: string;
  /** Номер абзаца. Обязателен у сцены answer, у остальных запрещён. */
  box?: number;
  /** Голос SpeechKit этой реплики; по умолчанию — Script.voice. */
  voice?: string;
}

export interface Script {
  hook: string;
  /** Голос ассистента — из src/speech/voices.ts бэкенда. */
  voice: string;
  speed?: number;
  lines: ScriptLine[];
  final: { disclaimer?: string };
}

export interface VoicedLine extends ScriptLine {
  durationMs: number;
  /** Путь к mp3 относительно папки съёмки — для staticFile(). */
  audio: string;
}

export interface Segment {
  lineId: string;
  scene: LineScene;
  text: string;
  box?: number;
  audio: string;
  /** Кадр начала реплики от начала ролика. */
  from: number;
  /** Кадров звучания реплики, без паузы после неё. */
  duration: number;
}

export interface SceneSpan {
  from: number;
  duration: number;
}

export interface Timeline {
  segments: Segment[];
  scenes: Record<LineScene, SceneSpan>;
  totalFrames: number;
}

/** Пропсы композиции Short. Именно type, а не interface: Remotion требует Record<string, unknown>. */
export type ShortProps = {
  fps: number;
  hook: string;
  questionShot: string;
  answerShot: string;
  answerShotHeight: number;
  boxes: ImageBox[];
  timeline: Timeline;
  final: { assistantsCount: number; disclaimer?: string };
};
```

- [ ] **Step 2: Падающий тест**

`studio/src/timeline.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline } from './timeline';
import type { LineScene, VoicedLine } from './types';

const line = (id: string, scene: LineScene, durationMs: number, box?: number): VoicedLine => ({
  id,
  scene,
  text: id,
  durationMs,
  audio: `voice/${id}.mp3`,
  ...(box ? { box } : {}),
});

const sample = (): VoicedLine[] => [
  line('h', 'hook', 1500),
  line('q', 'question', 4000),
  line('a1', 'answer', 8000, 1),
  line('a2', 'answer', 8000, 2),
  line('a3', 'answer', 8000, 3),
  line('f', 'final', 4000),
];

test('сцены идут подряд, зацепка не короче двух секунд', () => {
  const t = buildTimeline(sample(), 30);
  assert.deepEqual(t.scenes.hook, { from: 0, duration: 60 });
  assert.deepEqual(t.scenes.question, { from: 60, duration: 128 });
  assert.deepEqual(t.scenes.answer, { from: 188, duration: 744 });
  assert.deepEqual(t.scenes.final, { from: 932, duration: 128 });
  assert.equal(t.totalFrames, 1060);
});

test('реплика начинается после предыдущей и паузы в 8 кадров', () => {
  const t = buildTimeline(sample(), 30);
  assert.deepEqual(
    t.segments.map((s) => [s.lineId, s.from, s.duration]),
    [['h', 0, 45], ['q', 60, 120], ['a1', 188, 240], ['a2', 436, 240], ['a3', 684, 240], ['f', 932, 120]],
  );
  assert.equal(t.segments[2].box, 1);
  assert.equal(t.segments[2].audio, 'voice/a1.mp3');
});

test('зацепка — первая и единственная', () => {
  assert.throws(() => buildTimeline(sample().slice(1)), /зацепка/);
  assert.throws(() => buildTimeline([line('h0', 'hook', 1000), ...sample()]), /зацепка/);
});

test('сцены не идут в обратном порядке', () => {
  const s = sample();
  assert.throws(() => buildTimeline([s[0], s[2], s[1], ...s.slice(3)]), /порядок/);
});

test('в каждой сцене хотя бы одна реплика', () => {
  assert.throws(() => buildTimeline(sample().filter((l) => l.scene !== 'question')), /question/);
});

test('ролик короче 30 с и длиннее 60 с не собирается', () => {
  const short = [line('h', 'hook', 1000), line('q', 'question', 2000), line('a', 'answer', 3000, 1), line('f', 'final', 2000)];
  assert.throws(() => buildTimeline(short), /короче 30 с/);
  const long = [
    line('h', 'hook', 1000),
    line('q', 'question', 2000),
    line('a1', 'answer', 30000, 1),
    line('a2', 'answer', 30000, 2),
    line('f', 'final', 2000),
  ];
  assert.throws(() => buildTimeline(long), /длиннее 60 с/);
});
```

В `studio/package.json` строка `test` становится:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts",
```

- [ ] **Step 3: Красный коммит и прогон**

```bash
git -C "$WT" add studio/src/types.ts studio/src/timeline.test.ts studio/package.json
git -C "$WT" commit -q -m "test(studio): таймлайн ролика по длительности озвучки (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: FAIL — `Cannot find module '…/src/timeline'`.

- [ ] **Step 4: Реализация**

`studio/src/timeline.ts`:

```ts
import type { LineScene, Segment, Timeline, VoicedLine } from './types';

export const FPS = 30;
/** Пауза после каждой реплики. */
export const GAP_MS = 250;
/** Зацепка держится не меньше двух секунд, даже если фраза короче. */
export const MIN_HOOK_MS = 2000;
export const MIN_TOTAL_MS = 30_000;
export const MAX_TOTAL_MS = 60_000;

const ORDER: LineScene[] = ['hook', 'question', 'answer', 'final'];

export const msToFrames = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);

/**
 * Раскладывает озвученные реплики по кадрам. Длину ролика задаёт озвучка:
 * сцена идёт, пока звучат её реплики, плюс паузы. Порядок сцен —
 * hook → question → answer → final, в каждой хотя бы одна реплика,
 * зацепка — ровно одна. Ролик обязан уложиться в 30–60 с.
 */
export function buildTimeline(lines: VoicedLine[], fps = FPS): Timeline {
  const hooks = lines.filter((l) => l.scene === 'hook');
  if (lines[0]?.scene !== 'hook' || hooks.length !== 1) {
    throw new Error('timeline: зацепка (hook) — первая и единственная реплика своей сцены');
  }
  let at = 0;
  for (const l of lines) {
    const i = ORDER.indexOf(l.scene);
    if (i < at) throw new Error(`timeline: сцена ${l.scene} после ${ORDER[at]}; порядок hook → question → answer → final`);
    at = i;
  }
  for (const s of ORDER) {
    if (!lines.some((l) => l.scene === s)) throw new Error(`timeline: в сцене ${s} нет реплик`);
  }

  const gap = msToFrames(GAP_MS, fps);
  const segments: Segment[] = [];
  const scenes = {} as Timeline['scenes'];
  let cursor = 0;
  for (const scene of ORDER) {
    const from = cursor;
    for (const l of lines.filter((x) => x.scene === scene)) {
      const duration = Math.max(1, msToFrames(l.durationMs, fps));
      segments.push({ lineId: l.id, scene, text: l.text, box: l.box, audio: l.audio, from: cursor, duration });
      cursor += duration + gap;
    }
    if (scene === 'hook') cursor = Math.max(cursor, from + msToFrames(MIN_HOOK_MS, fps));
    scenes[scene] = { from, duration: cursor - from };
  }
  const sec = cursor / fps;
  if (sec * 1000 < MIN_TOTAL_MS) throw new Error(`timeline: ролик ${sec.toFixed(1)} с — короче 30 с`);
  if (sec * 1000 > MAX_TOTAL_MS) throw new Error(`timeline: ролик ${sec.toFixed(1)} с — длиннее 60 с`);
  return { segments, scenes, totalFrames: cursor };
}
```

- [ ] **Step 5: Зелёный коммит и прогон**

```bash
git -C "$WT" add studio/src/timeline.ts
git -C "$WT" commit -q -m "feat(studio): таймлайн ролика по длительности озвучки" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: `# pass 9`, `# fail 0`.

---

### Task 3: Субтитры

**Files:**
- Create: `studio/src/captions.ts`
- Test: `studio/src/captions.test.ts`
- Modify: `studio/package.json` (скрипт `test`)

- [ ] **Step 1: Падающий тест**

`studio/src/captions.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionCues, splitCaption } from './captions';

test('короткая реплика — один кусок', () => {
  assert.deepEqual(splitCaption('Я Алексей, юрист.'), ['Я Алексей, юрист.']);
});

test('длинная реплика режется по словам и не теряет текст', () => {
  const text = 'Первая ловушка — залог без срока возврата: хозяин может тянуть с деньгами месяцами.';
  const chunks = splitCaption(text, 42);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 42, `кусок длиннее 42: «${c}»`);
  assert.equal(chunks.join(' '), text);
});

test('слово длиннее предела — отдельным куском целиком', () => {
  assert.deepEqual(splitCaption('а сверхдлинноесловобезпробелов б', 10), ['а', 'сверхдлинноесловобезпробелов', 'б']);
});

test('кадры делятся пропорционально длине и покрывают реплику без дыр', () => {
  assert.deepEqual(captionCues(['ааааа', 'ааааааааааааааа'], 100, 80), [
    { text: 'ааааа', from: 100, duration: 20 },
    { text: 'ааааааааааааааа', from: 120, duration: 60 },
  ]);
});

test('кадров меньше, чем кусков, — вся реплика одним куском', () => {
  assert.deepEqual(captionCues(['а', 'б', 'в'], 0, 2), [{ text: 'а б в', from: 0, duration: 2 }]);
});
```

Строка `test` в `studio/package.json`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts",
```

- [ ] **Step 2: Красный коммит и прогон**

```bash
git -C "$WT" add studio/src/captions.test.ts studio/package.json
git -C "$WT" commit -q -m "test(studio): субтитры по словам и пропорциональные кадры (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: FAIL — `Cannot find module '…/src/captions'`.

- [ ] **Step 3: Реализация**

`studio/src/captions.ts`:

```ts
export const MAX_CHUNK_CHARS = 42;

/**
 * Режет реплику на куски для субтитров по словам, не длиннее maxChars.
 * Слово длиннее предела идёт отдельным куском целиком: рвать слово хуже,
 * чем чуть вылезти за предел.
 */
export function splitCaption(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || next.length <= maxChars) {
      cur = next;
    } else {
      chunks.push(cur);
      cur = w;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export interface CaptionCue {
  text: string;
  from: number;
  duration: number;
}

/**
 * Делит кадры реплики между кусками пропорционально длине: длинный кусок
 * голос читает дольше. Каждому следующему куску остаётся хотя бы кадр,
 * последний забирает остаток от округления. Если кадров меньше, чем
 * кусков, реплика показывается одним куском.
 */
export function captionCues(chunks: string[], from: number, duration: number): CaptionCue[] {
  if (chunks.length === 0) return [];
  if (duration < chunks.length) return [{ text: chunks.join(' '), from, duration }];
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const cues: CaptionCue[] = [];
  let cursor = from;
  chunks.forEach((text, i) => {
    const left = from + duration - cursor;
    const reserve = chunks.length - i - 1;
    const share = Math.max(1, Math.round((duration * text.length) / total));
    const d = i === chunks.length - 1 ? left : Math.min(left - reserve, share);
    cues.push({ text, from: cursor, duration: d });
    cursor += d;
  });
  return cues;
}
```

- [ ] **Step 4: Зелёный коммит и прогон**

```bash
git -C "$WT" add studio/src/captions.ts
git -C "$WT" commit -q -m "feat(studio): субтитры по словам и пропорциональные кадры" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: `# pass 14`, `# fail 0`.

---

### Task 4: Панорама к абзацу

**Files:**
- Create: `studio/src/pan.ts`
- Test: `studio/src/pan.test.ts`
- Modify: `studio/package.json` (скрипт `test`)

- [ ] **Step 1: Падающий тест**

`studio/src/pan.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panOffset } from './pan';

const base = { imageHeight: 9000, frameHeight: 1920, anchorY: 760 };

test('середина абзаца встаёт на линию', () => {
  assert.equal(panOffset({ ...base, boxTop: 3000, boxHeight: 200 }), -2340);
});

test('у верха картинки сдвига нет — над ней не видно пустоты', () => {
  assert.equal(panOffset({ ...base, boxTop: 100, boxHeight: 200 }), 0);
});

test('у низа картинка не уезжает выше кадра', () => {
  assert.equal(panOffset({ ...base, boxTop: 8800, boxHeight: 150 }), -7080);
});

test('картинка ниже кадра не двигается', () => {
  assert.equal(panOffset({ boxTop: 900, boxHeight: 200, imageHeight: 1500, frameHeight: 1920, anchorY: 760 }), 0);
});
```

Строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts",
```

- [ ] **Step 2: Красный коммит и прогон**

```bash
git -C "$WT" add studio/src/pan.test.ts studio/package.json
git -C "$WT" commit -q -m "test(studio): сдвиг высокого скриншота к абзацу (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: FAIL — `Cannot find module '…/src/pan'`.

- [ ] **Step 3: Реализация**

`studio/src/pan.ts`:

```ts
/**
 * Сдвиг высокого скриншота по вертикали (пиксели кадра, ≤ 0), при котором
 * середина абзаца встаёт на линию anchorY. Края не показываются: сверху
 * нет пустоты, снизу картинка не кончается раньше кадра.
 */
export function panOffset(o: {
  boxTop: number;
  boxHeight: number;
  imageHeight: number;
  frameHeight: number;
  anchorY: number;
}): number {
  const raw = o.anchorY - (o.boxTop + o.boxHeight / 2);
  const lowest = Math.min(0, o.frameHeight - o.imageHeight);
  return Math.max(lowest, Math.min(0, raw));
}
```

- [ ] **Step 4: Зелёный коммит и прогон**

```bash
git -C "$WT" add studio/src/pan.ts
git -C "$WT" commit -q -m "feat(studio): сдвиг высокого скриншота к абзацу" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: `# pass 18`, `# fail 0`.

---

### Task 5: Абзацы ответа на картинке

**Files:**
- Create: `studio/src/boxes.ts`
- Test: `studio/src/boxes.test.ts`
- Modify: `studio/package.json` (скрипт `test`)

- [ ] **Step 1: Падающий тест**

`studio/src/boxes.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toImageBoxes } from './boxes';

test('переводит в пиксели картинки и нумерует сверху вниз', () => {
  const boxes = toImageBoxes(
    [
      { top: 300.4, height: 40, text: 'второй' },
      { top: 120, height: 60.2, text: 'первый' },
    ],
    3,
  );
  assert.deepEqual(boxes, [
    { n: 1, top: 360, height: 181, text: 'первый' },
    { n: 2, top: 901, height: 120, text: 'второй' },
  ]);
});

test('пустые и крошечные блоки отбрасываются', () => {
  const boxes = toImageBoxes(
    [
      { top: 10, height: 4, text: 'мелочь' },
      { top: 20, height: 30, text: '   ' },
      { top: 60, height: 30, text: 'текст' },
    ],
    3,
  );
  assert.deepEqual(boxes.map((b) => [b.n, b.text]), [[1, 'текст']]);
});

test('текст схлопывается и обрезается до 120 символов', () => {
  const [b] = toImageBoxes([{ top: 0, height: 20, text: `a\n\n  b ${'x'.repeat(200)}` }], 1);
  assert.equal(b.text.length, 120);
  assert.ok(b.text.startsWith('a b x'));
});

test('блок за низом картинки не попадает в список', () => {
  const boxes = toImageBoxes(
    [
      { top: 100, height: 50, text: 'есть' },
      { top: 990, height: 50, text: 'за краем' },
    ],
    1,
    1000,
  );
  assert.deepEqual(boxes.map((b) => b.text), ['есть']);
});
```

Строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts",
```

- [ ] **Step 2: Красный коммит и прогон**

```bash
git -C "$WT" add studio/src/boxes.test.ts studio/package.json
git -C "$WT" commit -q -m "test(studio): абзацы ответа в пикселях скриншота (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: FAIL — `Cannot find module '…/src/boxes'`.

- [ ] **Step 3: Реализация**

`studio/src/boxes.ts`:

```ts
import type { ImageBox } from './types';

/** Блок ответа в CSS-пикселях документа (getBoundingClientRect + scrollY). */
export interface CssRect {
  top: number;
  height: number;
  text: string;
}

export const MIN_BLOCK_CSS_PX = 8;

/**
 * Блоки ответа → абзацы на скриншоте (пиксели картинки при deviceScaleFactor = scale).
 * Пустые и крошечные блоки отбрасываются, остальные нумеруются с 1 сверху вниз.
 * Блок, вылезающий за низ картинки, тоже отбрасывается: показать его нечем.
 */
export function toImageBoxes(rects: CssRect[], scale: number, imageHeight = Infinity): ImageBox[] {
  return rects
    .filter((r) => r.height >= MIN_BLOCK_CSS_PX && r.text.trim().length > 0)
    .map((r) => ({
      top: Math.round(r.top * scale),
      height: Math.round(r.height * scale),
      text: r.text.replace(/\s+/g, ' ').trim().slice(0, 120),
    }))
    .filter((b) => b.top + b.height <= imageHeight)
    .sort((a, b) => a.top - b.top)
    .map((b, i) => ({ n: i + 1, ...b }));
}
```

- [ ] **Step 4: Зелёный коммит и прогон**

```bash
git -C "$WT" add studio/src/boxes.ts
git -C "$WT" commit -q -m "feat(studio): абзацы ответа в пикселях скриншота" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: `# pass 22`, `# fail 0`.

---

### Task 6: «18 ассистентов»

**Files:**
- Create: `studio/src/plural.ts`
- Test: `studio/src/plural.test.ts`
- Modify: `studio/package.json` (скрипт `test`)

- [ ] **Step 1: Падающий тест**

`studio/src/plural.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantsLabel } from './plural';

test('форма слова — по категориям Intl.PluralRules', () => {
  assert.equal(assistantsLabel(1), '1 ассистент');
  assert.equal(assistantsLabel(3), '3 ассистента');
  assert.equal(assistantsLabel(5), '5 ассистентов');
  assert.equal(assistantsLabel(11), '11 ассистентов');
  assert.equal(assistantsLabel(18), '18 ассистентов');
  assert.equal(assistantsLabel(21), '21 ассистент');
  assert.equal(assistantsLabel(22), '22 ассистента');
});
```

Строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts",
```

- [ ] **Step 2: Красный коммит и прогон**

```bash
git -C "$WT" add studio/src/plural.test.ts studio/package.json
git -C "$WT" commit -q -m "test(studio): число ассистентов словами (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: FAIL — `Cannot find module '…/src/plural'`.

- [ ] **Step 3: Реализация**

`studio/src/plural.ts`:

```ts
const FORMS: Record<string, string> = {
  one: 'ассистент',
  few: 'ассистента',
  many: 'ассистентов',
  other: 'ассистента',
};

const rules = new Intl.PluralRules('ru-RU');

/** «18 ассистентов», «21 ассистент» — категории из Intl.PluralRules, а не самодельные остатки от деления. */
export function assistantsLabel(n: number): string {
  return `${n} ${FORMS[rules.select(n)]}`;
}
```

- [ ] **Step 4: Зелёный коммит и прогон**

```bash
git -C "$WT" add studio/src/plural.ts
git -C "$WT" commit -q -m "feat(studio): число ассистентов словами" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: `# pass 23`, `# fail 0`.

---

### Task 7: Проверка сценария

**Files:**
- Create: `studio/src/script.ts`
- Test: `studio/src/script.test.ts`
- Modify: `studio/package.json` (скрипт `test`)

- [ ] **Step 1: Падающий тест**

`studio/src/script.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScript } from './script';
import type { Script } from './types';

const capture = {
  boxes: [
    { n: 1, top: 0, height: 10, text: 'a' },
    { n: 2, top: 20, height: 10, text: 'b' },
  ],
};

const good = (): Script => ({
  hook: 'Юрист нашёл три ловушки',
  voice: 'madirus',
  lines: [
    { id: 'h', scene: 'hook', text: 'Юрист нашёл три ловушки' },
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист.' },
    { id: 'a1', scene: 'answer', text: 'Первая ловушка.', box: 1 },
    { id: 'f', scene: 'final', text: 'Ссылка в описании.', voice: 'alena' },
  ],
  final: {},
});

test('корректный сценарий проходит без замечаний', () => {
  assert.deepEqual(validateScript(good(), capture), []);
});

test('реплика ответа без абзаца и с несуществующим абзацем', () => {
  const s = good();
  s.lines[2] = { id: 'a1', scene: 'answer', text: 'x' };
  assert.match(validateScript(s, capture).join(';'), /a1 не привязана к абзацу/);
  s.lines[2] = { id: 'a1', scene: 'answer', text: 'x', box: 7 };
  assert.match(validateScript(s, capture).join(';'), /абзац 7/);
});

test('абзац у реплики не из ответа — ошибка', () => {
  const s = good();
  s.lines[1] = { ...s.lines[1], box: 1 };
  assert.match(validateScript(s, capture).join(';'), /q сцены question не должна ссылаться/);
});

test('зацепка длиннее восьми слов и расхождение с репликой hook', () => {
  const s = good();
  s.hook = 'раз два три четыре пять шесть семь восемь девять';
  const p = validateScript(s, capture).join(';');
  assert.match(p, /длиннее 8 слов/);
  assert.match(p, /совпадать с зацепкой/);
});

test('повтор id и пустая реплика', () => {
  const s = good();
  s.lines.push({ id: 'f', scene: 'final', text: ' ' });
  const p = validateScript(s, capture).join(';');
  assert.match(p, /повтор id реплики f/);
  assert.match(p, /реплика f пустая/);
});
```

Строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts src/script.test.ts",
```

- [ ] **Step 2: Красный коммит и прогон**

```bash
git -C "$WT" add studio/src/script.test.ts studio/package.json
git -C "$WT" commit -q -m "test(studio): проверка сценария до озвучки (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: FAIL — `Cannot find module '…/src/script'`.

- [ ] **Step 3: Реализация**

`studio/src/script.ts`:

```ts
import type { CaptureResult, Script } from './types';

/**
 * То, что студия может проверить сама до озвучки: у каждой реплики ответа
 * есть абзац, и такой абзац снят. Правила текста (цифры, конкуренты,
 * «анонимно»…) проверяет бэкенд во втором плане.
 */
export function validateScript(script: Script, capture: Pick<CaptureResult, 'boxes'>): string[] {
  const problems: string[] = [];
  const hook = script.hook?.trim() ?? '';
  if (!hook) problems.push('нет зацепки');
  if (hook.split(/\s+/).filter(Boolean).length > 8) problems.push('зацепка длиннее 8 слов');
  if (!script.voice?.trim()) problems.push('не задан голос');

  const ids = new Set<string>();
  const known = new Set(capture.boxes.map((b) => b.n));
  for (const l of script.lines) {
    if (ids.has(l.id)) problems.push(`повтор id реплики ${l.id}`);
    ids.add(l.id);
    if (!l.text?.trim()) problems.push(`реплика ${l.id} пустая`);
    if (l.scene === 'answer') {
      if (l.box == null) problems.push(`реплика ${l.id} не привязана к абзацу`);
      else if (!known.has(l.box)) problems.push(`реплика ${l.id} ссылается на абзац ${l.box}, а снято абзацев: ${capture.boxes.length}`);
    } else if (l.box != null) {
      problems.push(`реплика ${l.id} сцены ${l.scene} не должна ссылаться на абзац`);
    }
  }
  const hookLine = script.lines.find((l) => l.scene === 'hook');
  if (hookLine && hookLine.text.trim() !== hook) problems.push('текст реплики hook должен совпадать с зацепкой');
  return problems;
}
```

- [ ] **Step 4: Зелёный коммит и прогон**

```bash
git -C "$WT" add studio/src/script.ts
git -C "$WT" commit -q -m "feat(studio): проверка сценария до озвучки" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: `# pass 28`, `# fail 0`.

---

### Task 8: Годится ли ответ для съёмки

**Files:**
- Create: `studio/src/answer.ts`
- Test: `studio/src/answer.test.ts`
- Modify: `studio/package.json` (скрипт `test`)

- [ ] **Step 1: Падающий тест**

`studio/src/answer.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerProblems, isCounterQuestion } from './answer';

test('короткий ответ с вопросом в конце — встречный вопрос', () => {
  assert.equal(isCounterQuestion('Уточните, в каком городе квартира?', 400), true);
  assert.equal(isCounterQuestion('Короткий ответ без вопроса.', 400), false);
  assert.equal(isCounterQuestion(`${'Подробный разбор. '.repeat(30)}Остались вопросы?`, 400), false);
});

test('«Временный сбой» и короткий ответ не снимаются', () => {
  const p = answerProblems('Временный сбой, попробуйте позже', 400);
  assert.match(p.join(';'), /Временный сбой/);
  assert.match(p.join(';'), /меньше порога 400/);
});

test('подробный ответ годится', () => {
  assert.deepEqual(answerProblems('Пункт. '.repeat(80), 400), []);
});
```

Строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts src/script.test.ts src/answer.test.ts",
```

- [ ] **Step 2: Красный коммит и прогон**

```bash
git -C "$WT" add studio/src/answer.test.ts studio/package.json
git -C "$WT" commit -q -m "test(studio): годность ответа и встречный вопрос (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: FAIL — `Cannot find module '…/src/answer'`.

- [ ] **Step 3: Реализация**

`studio/src/answer.ts`:

```ts
/** Тексты, которыми релей сообщает о сбое вместо ответа. */
export const FAILURE_MARKERS = ['Временный сбой'];

/** Встречный вопрос вместо ответа: коротко и кончается вопросительным знаком. */
export function isCounterQuestion(answer: string, minChars: number): boolean {
  const a = answer.trim();
  return a.length < minChars && a.endsWith('?');
}

/** Почему этот ответ нельзя снимать; пустой список — можно. */
export function answerProblems(answer: string, minChars: number): string[] {
  const a = answer.trim();
  const problems: string[] = [];
  if (FAILURE_MARKERS.some((m) => a.includes(m))) problems.push('ассистент ответил «Временный сбой»');
  if (a.length < minChars) problems.push(`ответ ${a.length} символов — меньше порога ${minChars}`);
  return problems;
}
```

- [ ] **Step 4: Зелёный коммит и прогон**

```bash
git -C "$WT" add studio/src/answer.ts
git -C "$WT" commit -q -m "feat(studio): годность ответа и встречный вопрос" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: `# pass 31`, `# fail 0`.

---

### Task 9: Проверка готового ролика

**Files:**
- Create: `studio/src/ffprobe.ts`
- Test: `studio/src/ffprobe.test.ts`
- Modify: `studio/package.json` (скрипт `test`)

- [ ] **Step 1: Падающий тест**

`studio/src/ffprobe.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbe, parseSilences, verifyVideo } from './ffprobe';

const PROBE = JSON.stringify({
  format: { duration: '41.633333' },
  streams: [{ codec_type: 'video', width: 1080, height: 1920 }, { codec_type: 'audio' }],
});

const SILENCE_LOG = [
  '[silencedetect @ 0x1] silence_start: 3.2',
  '[silencedetect @ 0x1] silence_end: 3.9 | silence_duration: 0.7',
  'frame=   10 fps=0.0 q=-0.0 size=N/A',
  '[silencedetect @ 0x1] silence_start: 38.5',
].join('\n');

test('разбор ffprobe', () => {
  assert.deepEqual(parseProbe(PROBE), { durationSec: 41.633333, width: 1080, height: 1920, hasAudio: true });
});

test('разбор тишины: незакрытая тянется до конца файла', () => {
  assert.deepEqual(parseSilences(SILENCE_LOG, 41.6), [
    { start: 3.2, end: 3.9, duration: 0.7 },
    { start: 38.5, end: 41.6, duration: 41.6 - 38.5 },
  ]);
});

test('годный ролик проходит проверку', () => {
  assert.deepEqual(verifyVideo(parseProbe(PROBE), [{ start: 3.2, end: 3.9, duration: 0.7 }]), []);
});

test('проверка ловит длину, кадр, отсутствие звука и долгую тишину', () => {
  const p = verifyVideo({ durationSec: 25, width: 720, height: 1280, hasAudio: false }, [{ start: 10, end: 13, duration: 3 }]);
  assert.equal(p.length, 4);
  const all = p.join(';');
  assert.match(all, /длина 25.0 с/);
  assert.match(all, /кадр 720×1280/);
  assert.match(all, /нет звуковой дорожки/);
  assert.match(all, /тишина 3.0 с с 10.0 с/);
});
```

Строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts src/script.test.ts src/answer.test.ts src/ffprobe.test.ts",
```

- [ ] **Step 2: Красный коммит и прогон**

```bash
git -C "$WT" add studio/src/ffprobe.test.ts studio/package.json
git -C "$WT" commit -q -m "test(studio): проверка ролика по ffprobe и тишине (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: FAIL — `Cannot find module '…/src/ffprobe'`.

- [ ] **Step 3: Реализация**

`studio/src/ffprobe.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface Silence {
  start: number;
  end: number;
  duration: number;
}

export function parseProbe(json: string): ProbeInfo {
  const data = JSON.parse(json) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = data.streams?.find((s) => s.codec_type === 'video');
  return {
    durationSec: Number(data.format?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: Boolean(data.streams?.some((s) => s.codec_type === 'audio')),
  };
}

/** Разбор stderr `ffmpeg -af silencedetect`. Незакрытая тишина тянется до конца файла. */
export function parseSilences(stderr: string, totalSec: number): Silence[] {
  const out: Silence[] = [];
  let start: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    if (s) {
      start = Math.max(0, Number(s[1]));
      continue;
    }
    const e = line.match(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/);
    if (e && start != null) {
      out.push({ start, end: Number(e[1]), duration: Number(e[2]) });
      start = null;
    }
  }
  if (start != null) out.push({ start, end: totalSec, duration: totalSec - start });
  return out;
}

export interface VerifyLimits {
  minSec: number;
  maxSec: number;
  width: number;
  height: number;
  maxSilenceSec: number;
}

export const SHORT_LIMITS: VerifyLimits = { minSec: 30, maxSec: 60, width: 1080, height: 1920, maxSilenceSec: 2 };

/**
 * Проверка готового ролика. Тишина длиннее предела — значит, реплика не
 * прозвучала: на мультфильме проверка первых секунд пропустила остановку
 * плеера на 0:23, поэтому смотрим звук по всей длине.
 */
export function verifyVideo(probe: ProbeInfo, silences: Silence[], limits: VerifyLimits = SHORT_LIMITS): string[] {
  const problems: string[] = [];
  if (probe.durationSec < limits.minSec || probe.durationSec > limits.maxSec) {
    problems.push(`длина ${probe.durationSec.toFixed(1)} с вне ${limits.minSec}–${limits.maxSec} с`);
  }
  if (probe.width !== limits.width || probe.height !== limits.height) {
    problems.push(`кадр ${probe.width}×${probe.height}, нужен ${limits.width}×${limits.height}`);
  }
  if (!probe.hasAudio) problems.push('нет звуковой дорожки');
  for (const s of silences) {
    if (s.duration > limits.maxSilenceSec) problems.push(`тишина ${s.duration.toFixed(1)} с с ${s.start.toFixed(1)} с`);
  }
  return problems;
}

export async function probeFile(file: string): Promise<ProbeInfo> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  return parseProbe(stdout);
}

export async function detectSilences(file: string, totalSec: number): Promise<Silence[]> {
  // silencedetect пишет в stderr, ffmpeg при этом выходит с кодом 0.
  const { stderr } = await run(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-45dB:d=0.5', '-f', 'null', '-'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return parseSilences(stderr, totalSec);
}

export async function audioDurationMs(file: string): Promise<number> {
  return Math.round((await probeFile(file)).durationSec * 1000);
}
```

- [ ] **Step 4: Зелёный коммит и прогон**

```bash
git -C "$WT" add studio/src/ffprobe.ts
git -C "$WT" commit -q -m "feat(studio): проверка ролика по ffprobe и тишине" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: `# pass 35`, `# fail 0`.

---

### Task 10: Настройки из окружения

**Files:**
- Create: `studio/src/config.ts`
- Test: `studio/src/config.test.ts`
- Modify: `studio/package.json` (скрипт `test`)

- [ ] **Step 1: Падающий тест**

`studio/src/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from './config';

const none = { capture: false, tts: false };

test('по умолчанию — стенд, API там же, без Basic Auth', () => {
  const c = parseConfig({}, none);
  assert.equal(c.cabinetUrl, 'https://test.linkeon.io');
  assert.equal(c.apiUrl, 'https://test.linkeon.io');
  assert.equal(c.basicAuth, null);
});

test('хвостовой слэш снимается, API можно задать отдельно', () => {
  const c = parseConfig({ CABINET_URL: 'https://my.linkeon.io/', API_URL: 'https://api.example/' }, none);
  assert.equal(c.cabinetUrl, 'https://my.linkeon.io');
  assert.equal(c.apiUrl, 'https://api.example');
});

test('Basic Auth разбирается по первому двоеточию', () => {
  assert.deepEqual(parseConfig({ CABINET_BASIC_AUTH: 'linkeon:pa:ss' }, none).basicAuth, { username: 'linkeon', password: 'pa:ss' });
  assert.throws(() => parseConfig({ CABINET_BASIC_AUTH: 'nocolon' }, none), /user:pass/);
});

test('для съёмки нужны демо-номер тестового шаблона и секрет', () => {
  const capture = { capture: true, tts: false };
  assert.throws(() => parseConfig({ DEBUG_SECRET: 's' }, capture), /DEMO_PHONE/);
  assert.throws(() => parseConfig({ DEMO_PHONE: '79161234567', DEBUG_SECRET: 's' }, capture), /790300XXXXX/);
  assert.throws(() => parseConfig({ DEMO_PHONE: '79030000001' }, capture), /DEBUG_SECRET/);
  assert.equal(parseConfig({ DEMO_PHONE: '79030000001', DEBUG_SECRET: 's' }, capture).demoPhone, '79030000001');
});

test('для озвучки нужны ключи SpeechKit', () => {
  const tts = { capture: false, tts: true };
  assert.throws(() => parseConfig({}, tts), /YANDEX_SPEECHKIT_API_KEY/);
  const c = parseConfig({ YANDEX_SPEECHKIT_API_KEY: 'k', YANDEX_TTS_FOLDER_ID: 'f' }, tts);
  assert.equal(c.speechkitKey, 'k');
  assert.equal(c.speechkitFolder, 'f');
});
```

Строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts src/script.test.ts src/answer.test.ts src/ffprobe.test.ts src/config.test.ts",
```

- [ ] **Step 2: Красный коммит и прогон**

```bash
git -C "$WT" add studio/src/config.test.ts studio/package.json
git -C "$WT" commit -q -m "test(studio): разбор окружения студии (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: FAIL — `Cannot find module '…/src/config'`.

- [ ] **Step 3: Реализация**

`studio/src/config.ts`:

```ts
import { assertDemoPhone } from './guard';

export interface StudioConfig {
  cabinetUrl: string;
  apiUrl: string;
  basicAuth: { username: string; password: string } | null;
  demoPhone: string;
  debugSecret: string;
  speechkitKey: string;
  speechkitFolder: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`studio: не задана переменная ${name} (см. studio/.env.example)`);
  return v;
}

/**
 * Разбор окружения без побочных эффектов: файл .env читает вызывающий
 * (`import 'dotenv/config'`). needs говорит, какие ключи обязательны:
 * съёмке — демо-номер и секрет debug-ручек, озвучке — SpeechKit.
 */
export function parseConfig(env: Env, needs: { capture: boolean; tts: boolean }): StudioConfig {
  const cabinetUrl = (env.CABINET_URL?.trim() || 'https://test.linkeon.io').replace(/\/+$/, '');
  const apiUrl = (env.API_URL?.trim() || cabinetUrl).replace(/\/+$/, '');
  let basicAuth: StudioConfig['basicAuth'] = null;
  const ba = env.CABINET_BASIC_AUTH?.trim();
  if (ba) {
    const i = ba.indexOf(':');
    if (i <= 0) throw new Error('studio: CABINET_BASIC_AUTH должен быть в виде user:pass');
    basicAuth = { username: ba.slice(0, i), password: ba.slice(i + 1) };
  }
  return {
    cabinetUrl,
    apiUrl,
    basicAuth,
    demoPhone: needs.capture ? assertDemoPhone(required(env, 'DEMO_PHONE')) : (env.DEMO_PHONE?.trim() ?? ''),
    debugSecret: needs.capture ? required(env, 'DEBUG_SECRET') : '',
    speechkitKey: needs.tts ? required(env, 'YANDEX_SPEECHKIT_API_KEY') : '',
    speechkitFolder: needs.tts ? required(env, 'YANDEX_TTS_FOLDER_ID') : '',
  };
}
```

- [ ] **Step 4: Зелёный коммит и прогон**

```bash
git -C "$WT" add studio/src/config.ts
git -C "$WT" commit -q -m "feat(studio): разбор окружения студии" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: `# pass 40`, `# fail 0`.

---

### Task 11: Озвучка SpeechKit с кешем

**Files:**
- Create: `studio/src/tts.ts`
- Test: `studio/src/tts.test.ts`
- Modify: `studio/package.json` (скрипт `test`)

- [ ] **Step 1: Падающий тест**

`studio/src/tts.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedResult, ttsKey } from './tts';

test('ключ кеша зависит от текста, голоса и темпа', () => {
  const base = { text: 'Привет', voice: 'madirus', speed: 1 };
  assert.equal(ttsKey(base), ttsKey({ ...base }));
  assert.notEqual(ttsKey(base), ttsKey({ ...base, text: 'Привет!' }));
  assert.notEqual(ttsKey(base), ttsKey({ ...base, voice: 'alena' }));
  assert.notEqual(ttsKey(base), ttsKey({ ...base, speed: 1.1 }));
});

test('кеш срабатывает только при совпадении ключа и наличии файла', () => {
  const req = { id: 'l1', text: 'Привет', voice: 'madirus', speed: 1 };
  const manifest = { l1: { key: ttsKey(req), durationMs: 1234 } };
  assert.deepEqual(cachedResult(manifest, req, '/run/voice', () => true), { id: 'l1', file: '/run/voice/l1.mp3', durationMs: 1234 });
  assert.equal(cachedResult(manifest, req, '/run/voice', () => false), null);
  assert.equal(cachedResult(manifest, { ...req, text: 'Пока' }, '/run/voice', () => true), null);
});
```

Строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts src/script.test.ts src/answer.test.ts src/ffprobe.test.ts src/config.test.ts src/tts.test.ts",
```

- [ ] **Step 2: Красный коммит и прогон**

```bash
git -C "$WT" add studio/src/tts.test.ts studio/package.json
git -C "$WT" commit -q -m "test(studio): кеш озвучки SpeechKit (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: FAIL — `Cannot find module '…/src/tts'`.

- [ ] **Step 3: Реализация**

`studio/src/tts.ts`:

```ts
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { audioDurationMs } from './ffprobe';

export interface TtsRequest {
  id: string;
  text: string;
  voice: string;
  speed: number;
}

export interface TtsResult {
  id: string;
  file: string;
  durationMs: number;
}

export type Manifest = Record<string, { key: string; durationMs: number }>;

/** Ключ кеша: тот же текст тем же голосом и темпом заново не синтезируется — каждый вызов платный. */
export function ttsKey(r: Pick<TtsRequest, 'text' | 'voice' | 'speed'>): string {
  return createHash('sha1').update(`${r.voice}|${r.speed}|${r.text}`).digest('hex');
}

export function cachedResult(manifest: Manifest, r: TtsRequest, dir: string, exists: (file: string) => boolean): TtsResult | null {
  const entry = manifest[r.id];
  const file = path.join(dir, `${r.id}.mp3`);
  if (entry && entry.key === ttsKey(r) && exists(file)) return { id: r.id, file, durationMs: entry.durationMs };
  return null;
}

/**
 * Озвучка реплик в SpeechKit v1 (тот же вызов, что src/speech/providers/yandex.ts
 * бэкенда). Файлы — dir/<id>.mp3, длительности — dir/manifest.json.
 * В ошибку не попадают ни ключ, ни текст запроса.
 */
export async function synthesizeAll(reqs: TtsRequest[], dir: string, creds: { apiKey: string; folderId: string }): Promise<TtsResult[]> {
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest: Manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const out: TtsResult[] = [];
  for (const r of reqs) {
    const hit = cachedResult(manifest, r, dir, fs.existsSync);
    if (hit) {
      out.push(hit);
      continue;
    }
    const body = new URLSearchParams({
      text: r.text,
      lang: 'ru-RU',
      voice: r.voice,
      format: 'mp3',
      speed: String(r.speed),
      folderId: creds.folderId,
    });
    const resp = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
      method: 'POST',
      headers: { Authorization: `Api-Key ${creds.apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) throw new Error(`tts ${r.id}: SpeechKit ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const file = path.join(dir, `${r.id}.mp3`);
    fs.writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
    const durationMs = await audioDurationMs(file);
    manifest[r.id] = { key: ttsKey(r), durationMs };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    out.push({ id: r.id, file, durationMs });
  }
  return out;
}
```

- [ ] **Step 4: Зелёный коммит и прогон**

```bash
git -C "$WT" add studio/src/tts.ts
git -C "$WT" commit -q -m "feat(studio): озвучка SpeechKit с кешем" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: `# pass 42`, `# fail 0`.

---

### Task 12: Пропсы композиции

**Files:**
- Create: `studio/src/render/props.ts`
- Test: `studio/src/render/props.test.ts`
- Modify: `studio/package.json` (скрипт `test`)

- [ ] **Step 1: Падающий тест**

`studio/src/render/props.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProps } from './props';
import type { CaptureResult, Script } from '../types';

const capture: CaptureResult = {
  scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Проверьте договор', followups: [] },
  cabinetUrl: 'https://test.linkeon.io',
  capturedAt: '2026-10-24T00:00:00.000Z',
  questionShot: 'question.png',
  answerShot: 'answer.png',
  answerShotWidth: 1080,
  answerShotHeight: 5400,
  answerText: 'ответ',
  turns: 1,
  boxes: [
    { n: 1, top: 900, height: 300, text: 'a' },
    { n: 2, top: 2400, height: 300, text: 'b' },
  ],
  assistantsCount: 18,
};

const script: Script = {
  hook: 'Юрист нашёл две ловушки',
  voice: 'madirus',
  lines: [
    { id: 'h', scene: 'hook', text: 'Юрист нашёл две ловушки' },
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист.' },
    { id: 'a1', scene: 'answer', text: 'Первая.', box: 1 },
    { id: 'a2', scene: 'answer', text: 'Вторая.', box: 2 },
    { id: 'f', scene: 'final', text: 'Ссылка в описании.', voice: 'alena' },
  ],
  final: { disclaimer: 'Ответ ИИ, не заменяет специалиста' },
};

const ms: Record<string, number> = { h: 1500, q: 4000, a1: 12000, a2: 12000, f: 4000 };

test('пропсы: пути озвучки относительно папки съёмки, финал из съёмки и сценария', () => {
  const voiced = script.lines.map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: ms[l.id] }));
  const p = buildProps(capture, script, voiced, '/run');
  assert.equal(p.timeline.segments[0].audio, 'voice/h.mp3');
  assert.equal(p.answerShotHeight, 5400);
  assert.deepEqual(p.final, { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет специалиста' });
  assert.ok(p.timeline.totalFrames >= 900, `ролик ${p.timeline.totalFrames} кадров — короче 30 с`);
});

test('реплика без озвучки — ошибка', () => {
  const voiced = script.lines.slice(1).map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: ms[l.id] }));
  assert.throws(() => buildProps(capture, script, voiced, '/run'), /нет озвучки реплики h/);
});
```

Строка `test`:

```json
    "test": "tsx --test src/guard.test.ts src/timeline.test.ts src/captions.test.ts src/pan.test.ts src/boxes.test.ts src/plural.test.ts src/script.test.ts src/answer.test.ts src/ffprobe.test.ts src/config.test.ts src/tts.test.ts src/render/props.test.ts",
```

- [ ] **Step 2: Красный коммит и прогон**

```bash
git -C "$WT" add studio/src/render/props.test.ts studio/package.json
git -C "$WT" commit -q -m "test(studio): пропсы композиции из съёмки, сценария и озвучки (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: FAIL — `Cannot find module '…/src/render/props'`.

- [ ] **Step 3: Реализация**

`studio/src/render/props.ts`:

```ts
import path from 'node:path';
import { buildTimeline, FPS } from '../timeline';
import type { TtsResult } from '../tts';
import type { CaptureResult, Script, ShortProps, VoicedLine } from '../types';

/**
 * Склеивает съёмку, сценарий и озвучку в пропсы композиции Short. Пути к
 * файлам — относительно папки съёмки: она же publicDir бандла, staticFile()
 * ищет файлы в ней.
 */
export function buildProps(capture: CaptureResult, script: Script, voiced: TtsResult[], runDir: string): ShortProps {
  const byId = new Map(voiced.map((v) => [v.id, v]));
  const lines: VoicedLine[] = script.lines.map((l) => {
    const v = byId.get(l.id);
    if (!v) throw new Error(`props: нет озвучки реплики ${l.id}`);
    return { ...l, durationMs: v.durationMs, audio: path.relative(runDir, v.file) };
  });
  return {
    fps: FPS,
    hook: script.hook,
    questionShot: capture.questionShot,
    answerShot: capture.answerShot,
    answerShotHeight: capture.answerShotHeight,
    boxes: capture.boxes,
    timeline: buildTimeline(lines, FPS),
    final: { assistantsCount: capture.assistantsCount, disclaimer: script.final.disclaimer },
  };
}
```

- [ ] **Step 4: Зелёный коммит и прогон**

```bash
git -C "$WT" add studio/src/render/props.ts
git -C "$WT" commit -q -m "feat(studio): пропсы композиции из съёмки, сценария и озвучки" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm test"
```

Expected: `# pass 44`, `# fail 0`.

---

### Task 13: Композиция Remotion

Композиция проверяется рендером в задаче 14. Здесь — код и проверка типов.

**Files:**
- Create: `studio/public/logo.png` (копия `spirits_front/public/android-chrome-512x512.png`, 512×512, прозрачный фон)
- Create: `studio/src/remotion/theme.ts`, `Caption.tsx`, `scenes/Hook.tsx`, `scenes/Question.tsx`, `scenes/Answer.tsx`, `scenes/Final.tsx`, `Short.tsx`, `Root.tsx`, `index.ts`

- [ ] **Step 1: Логотип**

```bash
mkdir -p "$WT/studio/public"
cp /Users/dmitry/Downloads/spirits_front/public/android-chrome-512x512.png "$WT/studio/public/logo.png"
file "$WT/studio/public/logo.png"
```

Expected: `PNG image data, 512 x 512, 8-bit/color RGBA`.

- [ ] **Step 2: Тема**

`studio/src/remotion/theme.ts`:

```ts
import { loadFont } from '@remotion/google-fonts/Nunito';

// Nunito — как в мультфильме Linkeon. Кириллица обязательна.
export const { fontFamily } = loadFont('normal', { weights: ['700', '800', '900'], subsets: ['cyrillic', 'latin'] });

export const W = 1080;
export const H = 1920;
/** Линия, на которую встаёт середина абзаца: выше субтитров и нижних кнопок площадок. */
export const ANCHOR_Y = 760;

/** Палитра кабинета (tailwind forest). */
export const C = {
  forest500: '#4ade80',
  forest600: '#2dd4bf',
  forest700: '#0d9488',
  forest900: '#134e4a',
  ink: '#0b1f1e',
  white: '#ffffff',
  shade: 'rgba(11, 31, 30, 0.78)',
};
```

- [ ] **Step 3: Субтитры**

`studio/src/remotion/Caption.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { captionCues, splitCaption } from '../captions';
import type { Segment } from '../types';
import { C, fontFamily } from './theme';

/**
 * Субтитры реплик: крупно, в средней трети кадра — снизу и справа Shorts и
 * Клипы рисуют свои кнопки и подпись.
 */
export const Captions: React.FC<{ segments: Segment[] }> = ({ segments }) => (
  <>
    {segments.flatMap((s) =>
      captionCues(splitCaption(s.text), s.from, s.duration).map((cue, i) => (
        <Sequence key={`${s.lineId}-${i}`} from={cue.from} durationInFrames={cue.duration}>
          <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', padding: '0 160px 560px 80px' }}>
            <div
              style={{
                fontFamily,
                fontWeight: 900,
                fontSize: 62,
                lineHeight: 1.15,
                color: C.white,
                background: C.shade,
                borderRadius: 28,
                padding: '18px 30px',
                textAlign: 'center',
              }}
            >
              {cue.text}
            </div>
          </AbsoluteFill>
        </Sequence>
      )),
    )}
  </>
);
```

- [ ] **Step 4: Сцены**

`studio/src/remotion/scenes/Hook.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, fontFamily } from '../theme';

/** Зацепка: снимок вопроса под затемнением, поверх — крупный текст. */
export const Hook: React.FC<{ hook: string; questionShot: string }> = ({ hook, questionShot }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14 } });
  return (
    <AbsoluteFill style={{ backgroundColor: C.ink }}>
      <Img src={staticFile(questionShot)} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.3 }} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 90px' }}>
        <div
          style={{
            fontFamily,
            fontWeight: 900,
            fontSize: 92,
            lineHeight: 1.08,
            color: C.white,
            textAlign: 'center',
            textShadow: '0 6px 24px rgba(0,0,0,0.45)',
            transform: `scale(${interpolate(pop, [0, 1], [0.85, 1])})`,
          }}
        >
          {hook}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
```

`studio/src/remotion/scenes/Question.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { C } from '../theme';

/** Задача: снимок чата с вопросом и лёгкое приближение. */
export const Question: React.FC<{ questionShot: string; durationInFrames: number }> = ({ questionShot, durationInFrames }) => {
  const frame = useCurrentFrame();
  const zoom = interpolate(frame, [0, Math.max(1, durationInFrames)], [1, 1.06], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ backgroundColor: C.white }}>
      <Img
        src={staticFile(questionShot)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom})`, transformOrigin: '50% 70%' }}
      />
    </AbsoluteFill>
  );
};
```

`studio/src/remotion/scenes/Answer.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { panOffset } from '../../pan';
import type { ImageBox, Segment } from '../../types';
import { ANCHOR_Y, C, H, W } from '../theme';

/** Кадров на переезд к следующему абзацу. */
const MOVE = 15;
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/**
 * Ответ: высокий скриншот едет к абзацу, о котором говорит голос,
 * приближается к нему и обводит рамкой. segments — реплики сцены answer
 * с кадрами от начала ролика; sceneFrom переводит их в кадры сцены.
 */
export const Answer: React.FC<{
  answerShot: string;
  imageHeight: number;
  boxes: ImageBox[];
  segments: Segment[];
  sceneFrom: number;
}> = ({ answerShot, imageHeight, boxes, segments, sceneFrom }) => {
  const frame = useCurrentFrame();
  if (segments.length === 0 || boxes.length === 0) return <AbsoluteFill style={{ backgroundColor: C.white }} />;

  let idx = 0;
  segments.forEach((s, i) => {
    if (s.from - sceneFrom <= frame) idx = i;
  });
  const boxOf = (s: Segment): ImageBox => boxes.find((b) => b.n === s.box) ?? boxes[0];
  const offsetOf = (s: Segment): number => {
    const b = boxOf(s);
    return panOffset({ boxTop: b.top, boxHeight: b.height, imageHeight, frameHeight: H, anchorY: ANCHOR_Y });
  };

  const seg = segments[idx];
  const t = frame - (seg.from - sceneFrom);
  const prev = idx > 0 ? offsetOf(segments[idx - 1]) : 0;
  const y = interpolate(t, [0, MOVE], [prev, offsetOf(seg)], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const hold = Math.max(MOVE + 1, seg.duration - 10);
  const stop = Math.max(hold + 1, seg.duration);
  const zoom = interpolate(t, [0, MOVE, hold, stop], [1, 1.08, 1.08, 1], clamp);
  const ring = interpolate(t, [MOVE, MOVE + 10], [0, 1], clamp);
  const b = boxOf(seg);

  return (
    <AbsoluteFill style={{ backgroundColor: C.white, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: W, transform: `translateY(${y}px)` }}>
        <div
          style={{
            position: 'relative',
            width: W,
            height: imageHeight,
            transform: `scale(${zoom})`,
            transformOrigin: `50% ${b.top + b.height / 2}px`,
          }}
        >
          <Img src={staticFile(answerShot)} style={{ width: W, height: imageHeight, display: 'block' }} />
          <div
            style={{
              position: 'absolute',
              left: 24,
              right: 24,
              top: b.top - 14,
              height: b.height + 28,
              borderRadius: 24,
              border: `6px solid ${C.forest600}`,
              opacity: ring,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

`studio/src/remotion/scenes/Final.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, Img, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { assistantsLabel } from '../../plural';
import { C, fontFamily } from '../theme';

/** Финал: логотип, число ассистентов из базы, адрес и где искать ссылку. */
export const Final: React.FC<{ assistantsCount: number; disclaimer?: string }> = ({ assistantsCount, disclaimer }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12 } });
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(160deg, ${C.forest700}, ${C.forest900})`,
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily,
        color: C.white,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 300,
          height: 300,
          borderRadius: 150,
          background: C.white,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${pop})`,
        }}
      >
        <Img src={staticFile('logo.png')} style={{ width: 240, height: 240 }} />
      </div>
      <div style={{ fontWeight: 900, fontSize: 104, marginTop: 44 }}>Linkeon</div>
      <div style={{ fontWeight: 800, fontSize: 58, marginTop: 8 }}>{assistantsLabel(assistantsCount)}</div>
      <div style={{ fontWeight: 900, fontSize: 64, marginTop: 72, color: C.forest500 }}>my.linkeon.io</div>
      <div style={{ fontWeight: 700, fontSize: 44, marginTop: 18 }}>Ссылка — в описании и в профиле</div>
      {disclaimer ? (
        <div style={{ position: 'absolute', bottom: 140, left: 80, right: 80, fontWeight: 700, fontSize: 34, opacity: 0.85 }}>
          {disclaimer}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 5: Композиция, корень, точка входа**

`studio/src/remotion/Short.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import type { ShortProps } from '../types';
import { Captions } from './Caption';
import { Answer } from './scenes/Answer';
import { Final } from './scenes/Final';
import { Hook } from './scenes/Hook';
import { Question } from './scenes/Question';

export const Short: React.FC<ShortProps> = (p) => {
  const { scenes, segments } = p.timeline;
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <Sequence from={scenes.hook.from} durationInFrames={scenes.hook.duration}>
        <Hook hook={p.hook} questionShot={p.questionShot} />
      </Sequence>
      <Sequence from={scenes.question.from} durationInFrames={scenes.question.duration}>
        <Question questionShot={p.questionShot} durationInFrames={scenes.question.duration} />
      </Sequence>
      <Sequence from={scenes.answer.from} durationInFrames={scenes.answer.duration}>
        <Answer
          answerShot={p.answerShot}
          imageHeight={p.answerShotHeight}
          boxes={p.boxes}
          segments={segments.filter((s) => s.scene === 'answer')}
          sceneFrom={scenes.answer.from}
        />
      </Sequence>
      <Sequence from={scenes.final.from} durationInFrames={scenes.final.duration}>
        <Final assistantsCount={p.final.assistantsCount} disclaimer={p.final.disclaimer} />
      </Sequence>
      {/* Зацепку и финал дублирует крупный текст сцены — субтитры только у вопроса и ответа. */}
      <Captions segments={segments.filter((s) => s.scene === 'question' || s.scene === 'answer')} />
      {segments.map((s) => (
        // У каждой реплики своя длина: отыгравший звук размонтируется (урок веб-плеера мультфильма).
        <Sequence key={s.lineId} from={s.from} durationInFrames={s.duration}>
          <Audio src={staticFile(s.audio)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
```

`studio/src/remotion/Root.tsx`:

```tsx
import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import type { ShortProps } from '../types';
import { Short } from './Short';
import { H, W } from './theme';

/** Длина ролика — из таймлайна в пропсах: её задаёт озвучка. */
const calculateMetadata: CalculateMetadataFunction<ShortProps> = ({ props }) => ({
  durationInFrames: props.timeline.totalFrames,
  fps: props.fps,
});

/** Пропсы-заглушка. Настоящие приходят из src/render/run-render.ts. */
const PLACEHOLDER: ShortProps = {
  fps: 30,
  hook: 'Зацепка',
  questionShot: 'question.png',
  answerShot: 'answer.png',
  answerShotHeight: 1920,
  boxes: [{ n: 1, top: 400, height: 200, text: '' }],
  timeline: {
    segments: [],
    scenes: {
      hook: { from: 0, duration: 60 },
      question: { from: 60, duration: 90 },
      answer: { from: 150, duration: 600 },
      final: { from: 750, duration: 150 },
    },
    totalFrames: 900,
  },
  final: { assistantsCount: 18 },
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Short"
    component={Short}
    width={W}
    height={H}
    fps={30}
    durationInFrames={PLACEHOLDER.timeline.totalFrames}
    defaultProps={PLACEHOLDER}
    calculateMetadata={calculateMetadata}
  />
);
```

`studio/src/remotion/index.ts`:

```ts
import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';

registerRoot(RemotionRoot);
```

- [ ] **Step 6: Проверка типов**

```bash
git -C "$WT" add studio/public/logo.png studio/src/remotion
git -C "$WT" commit -q -m "feat(studio): композиция Short — зацепка, вопрос, ответ с приближением, финал, субтитры" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm run typecheck && npm test"
```

Expected: `tsc` без ошибок; `# pass 44`, `# fail 0`.

---

### Task 14: Команда render и рендер фикстуры

**Files:**
- Create: `studio/src/render/run-render.ts`
- Create: `studio/src/render/render.fixture.ts`

- [ ] **Step 1: Сквозной тест на фикстуре (красный)**

`studio/src/render/render.fixture.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ttsKey } from '../tts';
import { renderRun } from './run-render';

/**
 * Сборка ролика из фикстуры без сети: картинки и «голос» (синус) делает
 * ffmpeg, озвучка берётся из кеша. Папка не удаляется — по ней смотрят кадры.
 */
test('рендер фикстуры: 1080×1920, 30–60 с, звук по всей длине', { timeout: 15 * 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fixture-'));
  console.log(`fixture: ${dir}`);
  const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ff('-f', 'lavfi', '-i', 'color=c=0xedfaed:s=1080x1920', '-frames:v', '1', path.join(dir, 'question.png'));
  ff('-f', 'lavfi', '-i', 'color=c=white:s=1080x5400', '-frames:v', '1', path.join(dir, 'answer.png'));

  const lines = [
    { id: 'h', scene: 'hook', text: 'Юрист нашёл три ловушки', ms: 2000 },
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист. Пришлите договор — проверю.', ms: 5000 },
    { id: 'a1', scene: 'answer', text: 'Первая ловушка — залог без срока возврата.', ms: 9000, box: 1 },
    { id: 'a2', scene: 'answer', text: 'Вторая — ремонт за ваш счёт.', ms: 9000, box: 2 },
    { id: 'a3', scene: 'answer', text: 'Третья — выселение без уведомления.', ms: 9000, box: 3 },
    { id: 'f', scene: 'final', text: 'Linkeon. Ссылка — в описании.', ms: 4000 },
  ] as const;
  fs.mkdirSync(path.join(dir, 'voice'));
  const manifest: Record<string, { key: string; durationMs: number }> = {};
  for (const l of lines) {
    ff('-f', 'lavfi', '-i', `sine=frequency=440:duration=${l.ms / 1000}`, '-ac', '1', '-ar', '44100', path.join(dir, 'voice', `${l.id}.mp3`));
    manifest[l.id] = { key: ttsKey({ text: l.text, voice: 'madirus', speed: 1 }), durationMs: l.ms };
  }
  fs.writeFileSync(path.join(dir, 'voice', 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(dir, 'capture.json'),
    JSON.stringify({
      scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Проверьте договор', followups: [] },
      cabinetUrl: 'fixture',
      capturedAt: new Date(0).toISOString(),
      questionShot: 'question.png',
      answerShot: 'answer.png',
      answerShotWidth: 1080,
      answerShotHeight: 5400,
      answerText: 'x'.repeat(500),
      turns: 1,
      assistantsCount: 18,
      boxes: [
        { n: 1, top: 900, height: 300, text: 'a' },
        { n: 2, top: 2400, height: 300, text: 'b' },
        { n: 3, top: 4200, height: 300, text: 'c' },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'script.json'),
    JSON.stringify({
      hook: 'Юрист нашёл три ловушки',
      voice: 'madirus',
      speed: 1,
      lines: lines.map((l) => ({ id: l.id, scene: l.scene, text: l.text, ...('box' in l ? { box: l.box } : {}) })),
      final: { disclaimer: 'Ответ ИИ, не заменяет специалиста' },
    }),
  );

  const r = await renderRun(dir, { skipTts: true });
  assert.deepEqual(r.problems, []);
  assert.ok(fs.statSync(r.cover).size > 10_000, 'обложка подозрительно мала');
});
```

```bash
git -C "$WT" add studio/src/render/render.fixture.ts
git -C "$WT" commit -q -m "test(studio): сквозной рендер фикстуры без сети (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm run test:render"
```

Expected: FAIL — `Cannot find module '…/src/render/run-render'`.

- [ ] **Step 2: Команда render**

`studio/src/render/run-render.ts`:

```ts
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { parseConfig } from '../config';
import { detectSilences, probeFile, verifyVideo } from '../ffprobe';
import { validateScript } from '../script';
import { synthesizeAll } from '../tts';
import type { CaptureResult, Script } from '../types';
import { buildProps } from './props';

const STUDIO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface RenderResult {
  video: string;
  cover: string;
  problems: string[];
}

/**
 * Папка съёмки (capture.json, script.json, скриншоты) → video.mp4 и cover.jpg
 * в той же папке. Папка служит publicDir бандла: staticFile() берёт файлы из неё.
 * skipTts — озвучка только из кеша (для фикстуры без сети).
 */
export async function renderRun(runDir: string, opts: { skipTts?: boolean } = {}): Promise<RenderResult> {
  const capture = JSON.parse(fs.readFileSync(path.join(runDir, 'capture.json'), 'utf8')) as CaptureResult;
  const script = JSON.parse(fs.readFileSync(path.join(runDir, 'script.json'), 'utf8')) as Script;
  const scriptProblems = validateScript(script, capture);
  if (scriptProblems.length) throw new Error(`render: сценарий не прошёл проверку:\n- ${scriptProblems.join('\n- ')}`);

  const cfg = parseConfig(process.env, { capture: false, tts: !opts.skipTts });
  const reqs = script.lines.map((l) => ({ id: l.id, text: l.text, voice: l.voice ?? script.voice, speed: script.speed ?? 1 }));
  const voiced = await synthesizeAll(reqs, path.join(runDir, 'voice'), { apiKey: cfg.speechkitKey, folderId: cfg.speechkitFolder });
  const inputProps = buildProps(capture, script, voiced, runDir);

  fs.copyFileSync(path.join(STUDIO_ROOT, 'public', 'logo.png'), path.join(runDir, 'logo.png'));
  const serveUrl = await bundle({ entryPoint: path.join(STUDIO_ROOT, 'src', 'remotion', 'index.ts'), publicDir: runDir });
  const composition = await selectComposition({ serveUrl, id: 'Short', inputProps });
  const video = path.join(runDir, 'video.mp4');
  await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation: video, inputProps, concurrency: 2 });
  const cover = path.join(runDir, 'cover.jpg');
  await renderStill({ composition, serveUrl, output: cover, frame: 20, inputProps, imageFormat: 'jpeg' });

  const probe = await probeFile(video);
  const silences = await detectSilences(video, probe.durationSec);
  return { video, cover, problems: verifyVideo(probe, silences) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('usage: npm run render -- <out/папка-съёмки>');
    process.exit(2);
  }
  const r = await renderRun(path.resolve(runDir));
  if (r.problems.length) {
    console.error(`render: проверка файла не прошла:\n- ${r.problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`render: готово → ${r.video} (обложка ${r.cover})`);
}
```

- [ ] **Step 3: Рендер фикстуры проходит**

Первый запуск скачивает Chrome Headless Shell для Remotion (~100 МБ) и шрифт Nunito — это нормально.

```bash
git -C "$WT" add studio/src/render/run-render.ts
git -C "$WT" commit -q -m "feat(studio): команда render — озвучка, сборка, обложка, проверка файла" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm run typecheck && npm run test:render"
```

Expected: строка `fixture: /tmp/studio-fixture-XXXXXX`, затем `# pass 1`, `# fail 0`.

- [ ] **Step 4: Посмотреть кадры фикстуры**

Подставить путь из строки `fixture:`:

```bash
FIX=/tmp/studio-fixture-XXXXXX
ssh dv@85.192.61.231 "cd ${FIX} && for t in 1 4 12 30 37; do ffmpeg -hide_banner -loglevel error -y -ss \$t -i video.mp4 -frames:v 1 -vf scale=540:-1 frame-\$t.png; done && ls frame-*.png"
mkdir -p /private/tmp/claude-501/-Users-dmitry-Downloads-spirits-front/2dfa10fc-8d93-4800-9126-cf101c4ca608/scratchpad/fixture
scp "dv@85.192.61.231:${FIX}/frame-*.png" /private/tmp/claude-501/-Users-dmitry-Downloads-spirits-front/2dfa10fc-8d93-4800-9126-cf101c4ca608/scratchpad/fixture/
```

Открыть каждый `frame-*.png` инструментом Read и проверить:
- 1 с — зацепка «Юрист нашёл три ловушки» крупно, кириллица Nunito, а не запасной шрифт;
- 4 с — субтитр реплики вопроса в средней трети, не у нижнего края;
- 12 с и 30 с — на белом поле видна бирюзовая рамка абзаца, субтитр не перекрывает её;
- 37 с — финал: логотип в белом круге, «Linkeon», «18 ассистентов», «my.linkeon.io», строка про ссылку, внизу — оговорка.

Если что-то не так (шрифт, обрезанный текст, рамка не там), исправить в `src/remotion/*`, закоммитить `fix(studio): …` и повторить шаги 3–4.

---

### Task 15: Вход демо-аккаунта и съёмка чата

**Files:**
- Create: `studio/src/capture/login.ts`, `studio/src/capture/chat-scene.ts`, `studio/src/capture/run-capture.ts`

- [ ] **Step 1: Вход через API**

`studio/src/capture/login.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { StudioConfig } from '../config';

// UUID-вебхуки входа — из spirits_front/src/services/authService.ts
// (те же стоят в e2e-помощниках фронта, tests/e2e/helpers/login.ts).
const SMS_WEBHOOK = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WEBHOOK = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';

export interface Session {
  accessToken: string;
  refreshToken: string;
  userData: Record<string, unknown>;
}

async function fetchCode(cfg: StudioConfig): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await fetch(`${cfg.apiUrl}/webhook/debug/sms-code/${cfg.demoPhone}`, { headers: { 'X-Debug-Secret': cfg.debugSecret } });
    if (r.status === 404) throw new Error('login: debug-ручка ответила 404 — неверный DEBUG_SECRET или ручки в этой среде выключены');
    if (r.ok) {
      const body = (await r.json()) as { code?: string };
      if (body.code) return body.code;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error('login: код не появился за 10 секунд');
}

/** Вход демо-аккаунта через API, без интерфейса: SMS → код из debug-ручки → check-code → профиль. */
export async function loginDemo(cfg: StudioConfig): Promise<Session> {
  const sms = await fetch(`${cfg.apiUrl}/webhook/${SMS_WEBHOOK}/sms/${cfg.demoPhone}`);
  if (!sms.ok) throw new Error(`login: запрос SMS — ${sms.status}`);
  const code = await fetchCode(cfg);
  const check = await fetch(`${cfg.apiUrl}/webhook/${CHECK_WEBHOOK}/check-code/${cfg.demoPhone}/${code}`);
  if (!check.ok) throw new Error(`login: check-code — ${check.status}`);
  const tokens = (await check.json()) as { 'access-token'?: string; 'refresh-token'?: string };
  const accessToken = tokens['access-token'];
  const refreshToken = tokens['refresh-token'];
  if (!accessToken || !refreshToken) throw new Error('login: в ответе check-code нет токенов');

  const prof = await fetch(`${cfg.apiUrl}/webhook/profile`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!prof.ok) throw new Error(`login: профиль — ${prof.status}`);
  const raw = (await prof.json()) as unknown;
  const rec = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  const pj = ((rec?.profileJson as Record<string, unknown> | undefined) ?? rec ?? {}) as Record<string, unknown>;
  // Та же форма userData, что у AuthContext и e2e-помощников фронта.
  const userData = {
    id: cfg.demoPhone,
    phone: cfg.demoPhone,
    firstName: pj.name ?? '',
    lastName: pj.family_name ?? '',
    isAdmin: pj.isadmin === true,
    tokens: typeof pj.tokens === 'string' ? Number(pj.tokens) : (pj.tokens ?? 0),
    email: pj.email ?? '',
    preferredAgent: pj.preferred_agent ?? '',
  };
  return { accessToken, refreshToken, userData };
}

/**
 * Вход с кешем: SMS на номер ограничены по частоте, поэтому живой токен
 * переиспользуется. Файл лежит в out/ (вне git) с правами 600.
 */
export async function loginDemoCached(cfg: StudioConfig, cacheFile: string): Promise<Session> {
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Session & { phone?: string; apiUrl?: string };
    if (cached.phone === cfg.demoPhone && cached.apiUrl === cfg.apiUrl) {
      const r = await fetch(`${cfg.apiUrl}/webhook/profile`, { headers: { Authorization: `Bearer ${cached.accessToken}` } });
      if (r.ok) return cached;
    }
  }
  const s = await loginDemo(cfg);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ ...s, phone: cfg.demoPhone, apiUrl: cfg.apiUrl }), { mode: 0o600 });
  return s;
}

/** Число ассистентов — тем же публичным запросом, что список в кабинете. */
export async function countAssistants(cfg: StudioConfig): Promise<number> {
  const r = await fetch(`${cfg.apiUrl}/webhook/agents?lang=ru`);
  if (!r.ok) throw new Error(`agents — ${r.status}`);
  const list = (await r.json()) as unknown;
  if (!Array.isArray(list)) throw new Error('agents: ответ не список');
  return list.length;
}
```

- [ ] **Step 2: Съёмка сцены чата**

`studio/src/capture/chat-scene.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { answerProblems, isCounterQuestion } from '../answer';
import { toImageBoxes, type CssRect } from '../boxes';
import type { StudioConfig } from '../config';
import { probeFile } from '../ffprobe';
import type { CaptureResult, Scene } from '../types';
import type { Session } from './login';

/** 360×640 при плотности 3 — ровно кадр 1080×1920. */
export const VIEWPORT = { width: 360, height: 640 };
export const SCALE = 3;
/** Ответ готов, если он не меняется столько и в ленте нет признаков набора. */
const STABLE_MS = 3000;
const ANSWER_TIMEOUT_MS = 5 * 60_000;
/** Предел высокого кадра: 5000 CSS px × 3 = 15000 px, ниже предела скриншота Chromium. */
const MAX_TALL_CSS = 5000;
const ASSISTANT_MSG = '[data-testid="chat-message"].justify-start';
const USER_MSG = '[data-testid="chat-message"].justify-end';

export interface CaptureOptions {
  minAnswerChars: number;
  assistantsCount: number;
  probeOnly?: boolean;
}

interface AnswerState {
  count: number;
  text: string;
  streaming: boolean;
  busy: boolean;
}

/**
 * Последний ответ ассистента: текст его блоков (без строки с временем и
 * кнопками) и признаки, что набор ещё идёт — точка-пульс в пузыре
 * (ChatInterface, message.isStreaming), «печатает» и «работает» в ленте.
 */
function answerState(page: Page): Promise<AnswerState> {
  return page.evaluate((sel) => {
    const msgs = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    const last = msgs[msgs.length - 1];
    const blocks = last ? (Array.from(last.querySelectorAll('p, li, h1, h2, h3, h4, pre, blockquote')) as HTMLElement[]) : [];
    const leaves = blocks.filter((el) => !blocks.some((o) => o !== el && el.contains(o)));
    const list = document.querySelector('[data-testid="chat-messages-list"]');
    return {
      count: msgs.length,
      text: leaves.map((el) => el.innerText.trim()).filter(Boolean).join('\n'),
      streaming: Boolean(last?.querySelector('.animate-pulse')),
      busy: Boolean(list?.querySelector('.animate-bounce, .animate-spin')),
    };
  }, ASSISTANT_MSG);
}

async function waitAnswer(page: Page, before: number): Promise<string> {
  const started = Date.now();
  let last = '';
  let since = Date.now();
  while (Date.now() - started < ANSWER_TIMEOUT_MS) {
    const s = await answerState(page);
    const text = s.count > before ? s.text : '';
    if (text !== last) {
      last = text;
      since = Date.now();
    } else if (text && !s.streaming && !s.busy && Date.now() - since >= STABLE_MS) {
      return text;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('capture: ответ не закончился за 5 минут');
}

/** Отправляет реплику и ждёт её пузырь; возвращает число ответов ассистента до отправки. */
async function send(page: Page, text: string): Promise<number> {
  const before = (await answerState(page)).count;
  await page.locator('[data-testid="chat-input"]').fill(text);
  await page.locator('[data-testid="chat-send-btn"]').click();
  await page.locator(USER_MSG).filter({ hasText: text.slice(0, 30) }).last().waitFor({ timeout: 15_000 });
  return before;
}

/**
 * Снимает сцену чата на демо-аккаунте: вопрос, ответ целиком высоким
 * кадром, координаты абзацев. probeOnly — только открыть чат и снять probe.png.
 */
export async function captureChat(
  scene: Scene,
  cfg: StudioConfig,
  session: Session,
  outDir: string,
  opts: CaptureOptions,
): Promise<CaptureResult | null> {
  fs.mkdirSync(outDir, { recursive: true });
  const shot = (name: string) => path.join(outDir, name);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      isMobile: true,
      hasTouch: true,
      locale: 'ru-RU',
      httpCredentials: cfg.basicAuth ?? undefined,
    });
    // Вход без интерфейса: токены в localStorage, как кладёт AuthContext;
    // «чистый лист» — ключ fresh_ts_<id> в sessionStorage (ChatInterface).
    await context.addInitScript(
      (a: { session: Session; assistantId: number; freshTs: string }) => {
        localStorage.setItem('jwt_access_token', a.session.accessToken);
        localStorage.setItem('jwt_refresh_token', a.session.refreshToken);
        localStorage.setItem('authToken', a.session.accessToken);
        localStorage.setItem('userData', JSON.stringify(a.session.userData));
        sessionStorage.setItem(`fresh_ts_${a.assistantId}`, a.freshTs);
      },
      { session, assistantId: scene.assistantId, freshTs: String(Date.now()) },
    );
    const page = await context.newPage();
    await page.goto(`${cfg.cabinetUrl}/chat?assistant=${scene.assistantId}&lang=ru&utm_source=studio`, { waitUntil: 'domcontentloaded' });
    try {
      await page.locator('[data-testid="chat-input"]').waitFor({ timeout: 30_000 });
    } catch {
      await page.screenshot({ path: shot('blocked.png') });
      throw new Error(`capture: кабинет не дошёл до чата — см. ${shot('blocked.png')}`);
    }
    await page.waitForTimeout(1500);
    const picked = (await page.locator('[data-testid="assistant-dropdown-btn"]').innerText().catch(() => '')).trim();
    if (!picked.includes(scene.assistantName)) {
      await page.screenshot({ path: shot('wrong-assistant.png') });
      throw new Error(`capture: открыт не тот ассистент: «${picked}» вместо «${scene.assistantName}»`);
    }
    if (opts.probeOnly) {
      await page.screenshot({ path: shot('probe.png') });
      return null;
    }

    let before = await send(page, scene.question);
    await page.waitForTimeout(800);
    await page.screenshot({ path: shot('question.png') });
    let answer = await waitAnswer(page, before);
    let turns = 1;
    for (const followup of scene.followups.slice(0, 2)) {
      if (!isCounterQuestion(answer, opts.minAnswerChars)) break;
      before = await send(page, followup);
      answer = await waitAnswer(page, before);
      turns += 1;
    }
    const problems = answerProblems(answer, opts.minAnswerChars);
    if (problems.length) {
      await page.screenshot({ path: shot('rejected.png') });
      throw new Error(`capture: ответ не годится — ${problems.join('; ')}`);
    }

    // Высокий кадр: окно раскрывается на всю ленту, и ответ виден целиком без прокрутки.
    const need = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="chat-messages-list"]') as HTMLElement;
      return Math.ceil(document.documentElement.scrollHeight - list.clientHeight + list.scrollHeight);
    });
    await page.setViewportSize({ width: VIEWPORT.width, height: Math.min(MAX_TALL_CSS, Math.max(VIEWPORT.height, need)) });
    await page.waitForTimeout(800);
    const stillScrolls = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="chat-messages-list"]') as HTMLElement;
      return list.scrollHeight > list.clientHeight + 2;
    });
    if (stillScrolls) {
      // Запасной путь: лента не растёт вместе с окном — снимаем с неё ограничение высоты.
      await page.addStyleTag({
        content: '[data-testid="chat-messages-list"]{overflow:visible!important;height:auto!important;max-height:none!important;flex:none!important}',
      });
      await page.waitForTimeout(500);
    }
    const rects: CssRect[] = await page.evaluate((sel) => {
      const msgs = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
      const last = msgs[msgs.length - 1];
      const all = Array.from(last.querySelectorAll('p, li, h1, h2, h3, h4, pre, blockquote, img')) as HTMLElement[];
      const leaves = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
      return leaves.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top + window.scrollY, height: r.height, text: el.tagName === 'IMG' ? '[картинка]' : el.innerText };
      });
    }, ASSISTANT_MSG);
    await page.screenshot({ path: shot('answer.png'), fullPage: true });

    const img = await probeFile(shot('answer.png'));
    const boxes = toImageBoxes(rects, SCALE, img.height);
    if (boxes.length === 0) throw new Error('capture: в ответе не нашлось ни одного абзаца');
    for (const f of ['question.png', 'answer.png']) {
      if (fs.statSync(shot(f)).size < 20_000) throw new Error(`capture: ${f} меньше 20 КБ — похоже на пустой кадр`);
    }
    return {
      scene,
      cabinetUrl: cfg.cabinetUrl,
      capturedAt: new Date().toISOString(),
      questionShot: 'question.png',
      answerShot: 'answer.png',
      answerShotWidth: img.width,
      answerShotHeight: img.height,
      answerText: answer,
      turns,
      boxes,
      assistantsCount: opts.assistantsCount,
    };
  } finally {
    await browser.close();
  }
}
```

- [ ] **Step 3: Команда capture**

`studio/src/capture/run-capture.ts`:

```ts
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '../config';
import type { Scene } from '../types';
import { captureChat } from './chat-scene';
import { countAssistants, loginDemoCached } from './login';

/** Порог длины ответа по спеке (short_settings.min_answer_chars во втором плане). */
const MIN_ANSWER_CHARS = 400;

const [sceneFile, ...flags] = process.argv.slice(2);
if (!sceneFile) {
  console.error('usage: npm run capture -- <scene.json> [--probe]');
  process.exit(2);
}
const scene = JSON.parse(fs.readFileSync(sceneFile, 'utf8')) as Scene;
const cfg = parseConfig(process.env, { capture: true, tts: false });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.resolve('out', `${path.basename(sceneFile, '.json')}-${stamp}`);
const session = await loginDemoCached(cfg, path.resolve('out', '.session.json'));
const assistantsCount = await countAssistants(cfg);
const result = await captureChat(scene, cfg, session, runDir, {
  minAnswerChars: MIN_ANSWER_CHARS,
  assistantsCount,
  probeOnly: flags.includes('--probe'),
});
if (!result) {
  console.log(`capture: проба → ${path.join(runDir, 'probe.png')}`);
} else {
  fs.writeFileSync(path.join(runDir, 'capture.json'), JSON.stringify(result, null, 2));
  console.log(`capture: готово → ${runDir} (ходов: ${result.turns}, абзацев: ${result.boxes.length})`);
  for (const b of result.boxes) console.log(`  [${b.n}] ${b.text}`);
}
```

- [ ] **Step 4: Проверка типов и коммит**

```bash
git -C "$WT" add studio/src/capture
git -C "$WT" commit -q -m "feat(studio): вход демо-аккаунта и съёмка сцены чата" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT/studio/scripts/node-run.sh" "npm run typecheck && npm test"
```

Expected: `tsc` без ошибок; `# pass 44`, `# fail 0`.

---

### Task 16: Демо-аккаунт на стенде — проба

**Files:**
- Create: `studio/scenes/sample-lawyer-lease.json`
- На ноде (не в git): `~/ci/wt/promo-shorts/studio/.env`

- [ ] **Step 1: Окружение студии на ноде**

Секреты не печатаются: значения идут из файлов прямо в `.env`, на экран — только имена переменных. Живой `~/spirits_back/.env` только читается.

```bash
ssh dv@85.192.61.231 'cd ~/ci/wt/promo-shorts/studio && umask 077 && {
  echo "CABINET_URL=https://test.linkeon.io"
  echo "API_URL=https://test.linkeon.io"
  echo "DEMO_PHONE=79030000001"
  grep -E "^(DEBUG_SECRET|YANDEX_SPEECHKIT_API_KEY|YANDEX_TTS_FOLDER_ID)=" ~/spirits_back/.env
} > .env && cut -d= -f1 .env'
grep '^TEST_BASIC_AUTH=' /Users/dmitry/Downloads/spirits_back/scripts/test-server.env.local \
  | sed 's/^TEST_BASIC_AUTH=/CABINET_BASIC_AUTH=/' \
  | ssh dv@85.192.61.231 'cat >> ~/ci/wt/promo-shorts/studio/.env && cut -d= -f1 ~/ci/wt/promo-shorts/studio/.env'
```

Expected — семь имён: `CABINET_URL`, `API_URL`, `DEMO_PHONE`, `DEBUG_SECRET`, `YANDEX_SPEECHKIT_API_KEY`, `YANDEX_TTS_FOLDER_ID`, `CABINET_BASIC_AUTH`. Если ключей SpeechKit в `.env` стенда нет — **остановиться и спросить владельца**, можно ли взять их из `.env` прода. Сами не переносить.

Номер `79030000001` выбран намеренно: e2e-тесты генерируют номера `790300` + 10000…99999 (`generateTempReferralPhone`), с ними он не пересечётся.

- [ ] **Step 2: Сцена образца**

`studio/scenes/sample-lawyer-lease.json` (Алексей — id 10 и на стенде, и на проде; голос `madirus` по `src/speech/voices.ts`):

```json
{
  "kind": "chat",
  "assistantId": 10,
  "assistantName": "Алексей",
  "question": "Собираюсь снять квартиру, хозяин прислал договор аренды. На что обратить внимание, чтобы потом не потерять залог и не оплачивать ремонт за свой счёт?",
  "followups": [
    "Квартира в Москве, срок 11 месяцев, залог равен месячной плате, договор между частными лицами. Перечислите главные ловушки по пунктам."
  ]
}
```

```bash
mkdir -p "$WT/studio/scenes"
git -C "$WT" add studio/scenes/sample-lawyer-lease.json
git -C "$WT" commit -q -m "feat(studio): сцена ролика-образца — юрист и договор аренды" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Проба — вход и открытие чата**

```bash
"$WT/studio/scripts/node-run.sh" "npm run capture -- scenes/sample-lawyer-lease.json --probe"
```

Expected: `capture: проба → …/out/sample-lawyer-lease-…/probe.png`.

Скопировать снимок на мак и открыть инструментом Read:

```bash
SP=/private/tmp/claude-501/-Users-dmitry-Downloads-spirits-front/2dfa10fc-8d93-4800-9126-cf101c4ca608/scratchpad/sample
mkdir -p "$SP"
RUN=$(ssh dv@85.192.61.231 'ls -td ~/ci/wt/promo-shorts/studio/out/sample-lawyer-lease-* | head -1')
scp "dv@85.192.61.231:${RUN}/probe.png" "$SP/probe.png"
```

На `probe.png` должны быть мобильный кабинет, открытый чат с Алексеем и поле ввода; в кадре нет модалок и чужих данных.

Если команда упала с `кабинет не дошёл до чата` — скопировать `blocked.png` той же командой `scp` и открыть. Если чат закрывает окно для нового пользователя (онбординг, согласие), найти компонент этого окна в `spirits_front/src/components/onboarding/` или `src/components/chat/` по тексту на снимке и взять подпись его кнопки закрытия из `src/i18n/locales/ru.json`. Затем добавить в `captureChat` сразу после `page.goto` закрытие этого окна — `await page.getByRole('button', { name: <подпись из ru.json> }).click({ timeout: 5000 }).catch(() => {});` — отдельным коммитом `fix(studio): закрыть окно … перед съёмкой` и повторить шаг 3.

Если упало на `открыт не тот ассистент` — скопировать `wrong-assistant.png`, сверить имя в шапке чата с `assistantName` сцены и поправить сцену.

---

### Task 17: Съёмка образца и сценарий

**Files:**
- Create: `studio/scenes/sample-lawyer-lease.script.json` (копия сценария образца для истории)
- На ноде: `out/sample-lawyer-lease-…/script.json`

- [ ] **Step 1: Съёмка**

```bash
"$WT/studio/scripts/node-run.sh" "npm run capture -- scenes/sample-lawyer-lease.json"
```

Expected: `capture: готово → …/out/sample-lawyer-lease-… (ходов: 1 или 2, абзацев: N)` и список абзацев `[1] …`, `[2] …`. Ответ юриста идёт до нескольких минут — это нормально.

- [ ] **Step 2: Посмотреть снятое**

```bash
RUN=$(ssh dv@85.192.61.231 'ls -td ~/ci/wt/promo-shorts/studio/out/sample-lawyer-lease-* | head -1')
echo "$RUN"
# По одному файлу: scp нового OpenSSH (протокол SFTP) не раскрывает {a,b} на удалённой стороне.
for f in question.png answer.png capture.json; do scp "dv@85.192.61.231:${RUN}/${f}" "$SP/"; done
```

Открыть `question.png` и `answer.png` инструментом Read, прочитать `capture.json`. Проверить: на `question.png` виден пузырь вопроса, на `answer.png` — весь ответ, без обрезки снизу; в `boxes` номера абзацев совпадают с тем, что видно на картинке сверху вниз.

- [ ] **Step 3: Написать сценарий по настоящему ответу**

Файл `$SP/script.json`. Правила (из спеки, раздел «Правила текста»):

- зацепка — не длиннее 8 слов и про то, что **реально** есть в ответе;
- реплика `hook` дословно равна зацепке;
- одна реплика `question` от первого лица Алексея: кто он и что его спросили;
- три реплики `answer`, каждая пересказывает **свой** абзац (поле `box` — номер из `capture.json`). Никаких цифр, сроков и сумм, которых нет в этом абзаце;
- одна реплика `final` голосом `alena`: «Linkeon — восемнадцать ассистентов. Ссылка — в описании и в профиле.»;
- `final.disclaimer`: «Ответ ИИ, не заменяет юриста»;
- `voice`: `madirus`, `speed`: `1.1`;
- никаких «анонимно», сравнений с конкурентами, слова «агент».

Форма файла (тексты и номера абзацев заменить настоящими из съёмки):

```json
{
  "hook": "Три ловушки в договоре аренды",
  "voice": "madirus",
  "speed": 1.1,
  "lines": [
    { "id": "h", "scene": "hook", "text": "Три ловушки в договоре аренды" },
    { "id": "q", "scene": "question", "text": "Я Алексей, юрист в Linkeon. Меня спросили, на что смотреть в договоре аренды квартиры." },
    { "id": "a1", "scene": "answer", "box": 3, "text": "<пересказ абзаца 3 своими словами>" },
    { "id": "a2", "scene": "answer", "box": 6, "text": "<пересказ абзаца 6 своими словами>" },
    { "id": "a3", "scene": "answer", "box": 9, "text": "<пересказ абзаца 9 своими словами>" },
    { "id": "f", "scene": "final", "voice": "alena", "text": "Linkeon — восемнадцать ассистентов. Ссылка — в описании и в профиле." }
  ],
  "final": { "disclaimer": "Ответ ИИ, не заменяет юриста" }
}
```

Длина ролика складывается из озвучки и обязана попасть в 30–60 с: при темпе 1.1 это примерно 70–130 слов на все реплики. Если `render` в задаче 18 скажет «короче 30 с» или «длиннее 60 с», поправить реплики `answer` и повторить рендер: неизменённые реплики не озвучиваются заново.

- [ ] **Step 4: Положить сценарий в папку съёмки и сохранить копию в git**

```bash
scp "$SP/script.json" "dv@85.192.61.231:${RUN}/script.json"
cp "$SP/script.json" "$WT/studio/scenes/sample-lawyer-lease.script.json"
git -C "$WT" add studio/scenes/sample-lawyer-lease.script.json
git -C "$WT" commit -q -m "feat(studio): сценарий ролика-образца по настоящему ответу юриста" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Рендер образца и передача владельцу

- [ ] **Step 1: Рендер**

`RUN` — путь папки съёмки из задачи 17. В `node-run.sh` команда выполняется в `studio/`, поэтому путь — относительно неё:

```bash
REL="out/$(basename "$RUN")"
"$WT/studio/scripts/node-run.sh" "npm run render -- ${REL}"
```

Expected: `render: готово → …/video.mp4 (обложка …/cover.jpg)`, код выхода 0. При «проверка файла не прошла» — прочитать список: «тишина N с» значит, что реплика не прозвучала (проверить `voice/manifest.json` и mp3); длина вне 30–60 с — поправить сценарий (задача 17, шаг 3).

- [ ] **Step 2: Кадры для самопроверки**

```bash
ssh dv@85.192.61.231 "cd ${RUN} && D=\$(ffprobe -v error -show_entries format=duration -of csv=p=0 video.mp4) && for p in 0.03 0.12 0.35 0.6 0.85 0.97; do t=\$(awk -v d=\"\$D\" -v p=\"\$p\" 'BEGIN{print d*p}'); ffmpeg -hide_banner -loglevel error -y -ss \$t -i video.mp4 -frames:v 1 -vf scale=540:-1 frame-\$p.png; done && ls frame-*.png && echo \$D"
scp "dv@85.192.61.231:${RUN}/frame-*.png" "$SP/"
```

Открыть кадры инструментом Read и проверить:
- зацепка читается целиком;
- на кадре вопроса виден настоящий вопрос в чате Алексея;
- на кадрах ответа рамка стоит на том абзаце, который пересказывает голос в это время (сверить с `script.json` и таймингом), субтитр не закрывает рамку;
- финал: «18 ассистентов», адрес, оговорка юриста.

Найденные огрехи исправить в `src/remotion/*` (`fix(studio): …`), повторить шаги 1–2.

- [ ] **Step 3: Отдать ролик владельцу**

```bash
mkdir -p /Users/dmitry/Downloads/linkeon_shorts
scp "dv@85.192.61.231:${RUN}/video.mp4" /Users/dmitry/Downloads/linkeon_shorts/sample-1-lawyer-lease.mp4
scp "dv@85.192.61.231:${RUN}/cover.jpg" /Users/dmitry/Downloads/linkeon_shorts/sample-1-lawyer-lease.jpg
ls -la /Users/dmitry/Downloads/linkeon_shorts/
```

Сообщить владельцу путь к файлу и что оценить: зацепку и темп, голоса Алексея и Linkeon, размер и место субтитров, прокрутку и приближение к абзацам, финальный кадр. Записать ответы в рабочее состояние `promo-video-channels` (work_state_write) — они станут входом для планов 2 и 3.

---

### Task 19: README студии

**Files:**
- Create: `studio/README.md`

- [ ] **Step 1: README**

`studio/README.md`:

````markdown
# Студия коротких роликов Linkeon

Снимает настоящий кабинет на демо-аккаунте, озвучивает реплики в SpeechKit и
собирает вертикальный ролик 1080×1920 в Remotion. Спека:
`docs/superpowers/specs/2026-10-24-promo-shorts-design.md`.

Всё запускается на тестовой ноде, не на маке (CLAUDE.md):

```bash
studio/scripts/node-run.sh "npm test"            # юнит-тесты
studio/scripts/node-run.sh "npm run test:render" # сквозной рендер фикстуры, без сети
studio/scripts/node-run.sh "npm run capture -- scenes/<сцена>.json [--probe]"
studio/scripts/node-run.sh "npm run render -- out/<папка-съёмки>"
```

`node-run.sh` пушит ветку и ставит `~/ci/wt/promo-shorts` на точный коммит.

## Окружение

`studio/.env` — по образцу `.env.example`. Демо-номер — только `790300XXXXX`:
под него настроены фильтры аналитики и белый список debug-ручек.

## Как устроен ролик

1. `capture`: вход через API (SMS → debug-код → токены), чат в «чистом листе»,
   вопрос, ответ целиком высоким кадром, координаты абзацев → `capture.json`.
2. Сценарий `script.json`: зацепка, реплики вопроса, ответа (каждая — со своим
   абзацем `box`) и финала. Пока его пишут руками, во втором плане — ИИ.
3. `render`: SpeechKit (кеш по тексту, голосу и темпу), таймлайн по длительности
   озвучки (30–60 с), Remotion → `video.mp4` и `cover.jpg`, затем проверка
   длины, кадра и тишины по всей длине.

Лицензия Remotion — бесплатная, пока в компании не больше трёх человек
(remotion.pro/license).
````

- [ ] **Step 2: Коммит и пуш**

```bash
git -C "$WT" add studio/README.md
git -C "$WT" commit -q -m "docs(studio): как снимать и собирать ролики" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C "$WT" push -q origin feat/promo-shorts
git -C "$WT" log --oneline -1
```

Ветка `feat/promo-shorts` в main не вливается: студия пока не используется кодом бэкенда и не выкатывается. Слияние и выкат — в плане 2.
