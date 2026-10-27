# Ролики со сценками, план 4: сценки в конвейере — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Конвейер роликов сам выпускает ролики со сценками: режиссёр пишет сценку 1, сценарист — развязку, студия оживляет обе этапом `animate` и собирает ролик, владелец видит в подписи состав и траты на Omni.

**Architecture:** Конвейер плана 2 не меняет устройства: API решает, что снимать, студия снимает и собирает, связь — строки `short_video`. Добавляется этап студии `animate` между сценаристом и сборкой: задание из плана 3 (`studio/src/animate/run-animate.ts`) запускает рабочий процесс студии, а счёт денег и id запущенных генераций по ходу пишутся в базу, кадры и клипы — в MinIO. Формат ролика (`skit` или запасной `chat`) задаёт настройка и запоминает ролик при запуске; формат `chat` идёт прежним путём.

**Tech Stack:** NestJS 10 (commonjs, `strictNullChecks: false`, jest + ts-jest), Postgres 16 (миграция модуля при старте API), студия — Node 22 ESM, `tsx --test` (`node:test`), Remotion 4.0.530, MinIO по S3, Google Generative Language API (Nano Banana Pro, Gemini Omni), SpeechKit v1.

**Спека:** `docs/superpowers/specs/2026-10-26-shorts-skits-design.md` — разделы «Кто пишет сценки», «Правила», «Архитектура», «Данные», «Отказы», «Одобрение», «Админка», «Тестирование», «Порядок работ» (шаги 2–3) и «Что уточнил образец (план 3)» с «Открыто на план 4». План 3 (движок и образец) — `docs/superpowers/plans/2026-10-26-shorts-skits-1-sample.md`; владелец принял образец 26.10.2026.

**Код плана прогнан до передачи исполнителям.** Все патчи ниже собраны из кода, который целиком прошёл на тестовой ноде: модуль роликов бэкенда 651 тест и гейт типов, живой Postgres 8/8, студия 211/211, typecheck, живая очередь 15/15. Каждая задача проверена отдельно в порядке плана: тест после первого шага падает, после реализации — зелёный, типы чистые. Промпты формата chat совпадают с прежними побайтно.

**После ревью задач 1–14** — три пары коммитов «Правки по ревью» (раздел перед задачей 15): бэкенд 665 тестов и гейт типов, живой Postgres 8/8, студия 222/222, typecheck, живая очередь 15/15; промпты chat по-прежнему побайтно те же.

**Вне этого плана:**
- выкат на прод — отдельным решением владельца, как в спеке роликов;
- вкладка «Ролики» в кабинете — её нет и в плане 2: настройки и предпросмотр сценария — через действия API `admin/shorts` (`get_settings`, `update_settings`, `get` отдаёт `script.skits` и `animation`);
- отложенное по ревью планов 3 и 4 (раздел «Открыто на план 4» спеки, кроме сделанного здесь): реплика-эхо в сверке речи, проверка тишины по участкам ролика, сумма за неудачные вызовы Nano Banana, вложенный `cast[].hero` в стороже контракта, свекровь или тёща в труппе (вопрос владельцу).

**Что план уточняет в спеке** (дописывается в спеку в задаче 18):
- Сценка 1 режиссёра лежит в `scene.skit`; конфликт, переписанный сценаристом по замечанию, — в `script.skits.conflict`. Сценарист видит последний принятый конфликт.
- Режиссёр, как сценарист, переписывает сценку 1 по нарушениям правил до двух раз; потом — `StageFatalError`.
- Ролик со сценками: зацепка — надпись до 6 слов без реплики hook; пересказ ответа — 1–2 реплики; коридор оценки озвучки — 11–26 с (с клипами 2 × 8 с — в пределах 25–45 с у студии).
- `animation` в базе — тот же `ShortAnimation`, что `animation.json` студии: пути относительно папки ролика, ключ MinIO — `shorts/<id>/<путь>` (`keyframes/<отпечаток кадра>.<jpg|png|webp>`, `skits/<отпечаток клипа>/{raw,clip}.mp4`). Полей `keyframeKey` и `clipKey` из раздела «Данные» нет.
- Задание `animate` по ходу пишет `animation` в базу своим захватом и кладёт файлы в MinIO; первое сохранение — до любых трат. Восстанавливает папку из базы и MinIO: «ключа нет» и сетевой сбой различаются. Срок задания — общий для студии, 28 мин (аренда 30), а не 25: запущенная генерация переживает обрыв, её id в базе.
- Рабочему процессу студии нужен `GOOGLE_AI_API_KEY`: без него он не стартует, а не роняет ролики на этапе `animate`.
- Новая генерация после 404 опроса Omni — только после трёх 404 подряд.
- При «Переснять» `animation` не сбрасывается: предел секунд Omni — на ролик целиком.
- Строка ролика без `format` — chat (поведение плана 2); в базе формат есть у каждой строки.
- Умолчание колонки `short_video.format` — `chat`, а не `skit`: формат всегда пишет запуск, а ролик, запущенный кодом плана 2 (откат, повтор с этапа), идёт прежним путём. CHECK статуса — под именем `short_video_status_002`, накат проверяет его по имени. «Повторить» с `from` берёт формат из настроек: после «модель Omni недоступна» ролик повторяется форматом «Только чат».
- Правила текста 1–15 проверяют и сценку 1 у режиссёра (числа — только из вопроса), и немую зацепку сценок. Кеша — в каждой сценке; в репликах — только звучащие слова по-русски, без ремарок; роль — из списка или она же с уточнением.
- Принятая развязка (из прошлого сценария) сценаристом не повторяется, пока её не касаются замечания или нарушения: «Замечание» и отзыв студии о длине озвучки не переснимают её клип.
- Брак клипа удаляется и из папки, и из MinIO; скачивание из MinIO — через временный файл. Сбой хранилища — повтор задания с паузой, а не попытка Omni. Запись `animation` в базу при сбое повторяется; id генерации, не дошедший до базы, задание берёт из своей папки. Кадр считается в трате до выгрузки и довыгружается из папки.
- Подпись владельцу показывает предел: «Omni: 16 из 48 с, кадров 2 ≈ $1,86».

---

## Как работать

- **Воркдерево на маке:** `/Users/dmitry/Downloads/spirits_back/.worktrees/promo-shorts`, ветка `feat/promo-shorts` (план начинается с `e763a55`). Ниже `WT` — этот путь. Git — через `git -C "$WT"`, без `cd` в цепочках.
- **Каждая задача — два коммита:** тест (`test(...): … (красный)`) и реализация. Изменения задачи — патчи: каждый файл меняется ровно в одной задаче, патчи ложатся по порядку на `e763a55`. Наложенный патч — `git -C "$WT" apply`; не лёг — не править руками, а остановиться и доложить.
- **Всё тяжёлое — на тестовой ноде** через `"$WT"/studio/scripts/node-run.sh "<команда>"` (студия; с `NODE_RUN_DIR=.` — корень бэкенда). Скрипт пушит ветку и ставит `~/ci/wt/promo-shorts` на точный коммит: незакоммиченное на ноду не уезжает. Вызов — с `timeout: 600000`. Коды: 75 — воркдерево занято (повторить позже), 3 — не встало на коммит (команда не запускалась), 255 — ssh (повторить через 1–2 минуты).
- **Пуш в GitHub с мака бывает недоступен** («Connection closed by … port 443»). Тогда перед `node-run.sh` — git-ssh через мастер-соединение к ноде:
  `export GIT_SSH_COMMAND="ssh -o 'ProxyCommand=ssh -o ControlMaster=auto -o ControlPath=$HOME/.ssh/cm-%%C -o ControlPersist=30m dv@85.192.61.231 -W %h:%p'"`.
- **SSH к ноде** — с опциями явно: `-o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m` (шелл — zsh, переменная с опциями в нём не делится на слова).
- **Живые проверки на Postgres** — одноразовые базы ноды: `postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it` (API) и `postgresql://studioit:studioit@127.0.0.1:5432/studio_it` (студия); тесты сами чистят таблицы. Живой чекаут `~/spirits_back` на ноде не трогать.
- **Живых вызовов Google и SpeechKit в задачах 1–16 нет:** всё на подделках. Деньги — только в задаче 17.
- **Ничего не вливать в main и не выкатывать** без явного OK владельца (задача 17). Выкат — только `deploy.sh`.
- **Секреты** не печатать и не коммитить: репозитории Linkeon публичные. Ключ Google — только в `.env` студии на ноде.
- **Ревьюерам-субагентам:** никаких `git checkout`, `switch`, `reset`, `stash` в общем воркдереве.
- **Коммиты** — по-русски, с префиксом; последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Файлы

| Файл | Задача | За что отвечает |
|---|---|---|
| `src/shorts/shorts.types.ts` | 1 | Статусы `animate_queued`/`animating`, переходы, `ShortFormat`, `ShortAnimation`, `scene.skit`, `script.skits` |
| `src/shorts/migrations/002_skits.sql`, `shorts-schema.service.ts` | 2 | Формат, `animation`, CHECK статуса, настройки сценок |
| `src/shorts/shorts-settings.service.ts`, `shorts-topic.service.ts` | 3 | Настройки «Формат» и «Предел секунд Omni»; формат при запуске |
| `src/shorts/short-rules.ts`, `short-skit-prompts.ts` | 4 | `checkSkitRules` (16–18), проверка сценария со сценками |
| `src/shorts/short-script.ts` | 5 | Сценарий без реплики зацепки, с промптами сценок |
| `src/shorts/short-parse.ts`, `short-prompts.ts` | 6 | Разбор сценок; промпты сценок режиссёра и сценариста |
| `src/shorts/shorts-director.service.ts` | 7 | Сценка 1, переписка по правилам, прошлые сценки |
| `src/shorts/shorts-writer.service.ts` | 8 | Развязка, конфликт по замечанию, `animate_queued` |
| `src/shorts/short-captions.ts`, `shorts-approval.service.ts` | 9 | Состав и траты в подписи; отказы во время оживления |
| `studio/src/types.ts`, `studio/src/script.ts` | 10 | `scene.skit`, зацепка сценок до 6 слов |
| `studio/src/animate/run-animate.ts` | 11 | `onSave`, `onFile`, первое сохранение до трат |
| `studio/src/animate/google.ts` | 12 | Три 404 опроса подряд |
| `studio/src/worker/{db,storage,jobs,worker}.ts`, `studio/README.md` | 13 | Очередь animate, задание, MinIO, сборка со сценками |
| `src/shorts/shorts.contract.spec.ts` | 14 | Сторож контракта оживления |

---

### Task 1: Статусы оживления, формат ролика и типы сценок в API

**Files:**
- Modify: `src/shorts/shorts.types.ts`
- Test: `src/shorts/shorts.types.spec.ts`

Машина состояний получает этап студии `animate`: `writing → animate_queued → animating → render_queued`, повтор задания (`animating → animate_queued`), сбой и «Повторить» (`failed → animate_queued`). Оба статуса — в работе (`IN_WORK_STATUSES`). У ролика появляются `format` и `animation`, у сцены — `skit` (сценка 1 режиссёра), у сценария — `skits` (промпты обеих сценок). Строка без поля `format` — chat: так ведут себя все ролики и фикстуры плана 2.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/shorts.types.spec.ts
+++ b/src/shorts/shorts.types.spec.ts
@@ -1,5 +1,6 @@
 import {
   ALLOWED_TRANSITIONS,
+  IN_WORK_STATUSES,
   MAX_OWNER_NOTE_CHARS,
   ShortStatus,
   appendOwnerNote,
@@ -31,6 +32,20 @@
     expect(canTransition('rendering', 'writing')).toBe(true);
     expect(canTransition('writing', 'directing')).toBe(true);
   });
+
+  it('оживление: сценарист → очередь → задание → сборка; повтор задания и сбой', () => {
+    expect(canTransition('writing', 'animate_queued')).toBe(true);
+    expect(ALLOWED_TRANSITIONS.animate_queued).toEqual(['animating']);
+    expect([...ALLOWED_TRANSITIONS.animating].sort()).toEqual(['animate_queued', 'failed', 'render_queued']);
+    expect(canTransition('failed', 'animate_queued')).toBe(true);
+    // На сборку — только из writing (chat) и из оживления (skit); мимо оживления skit не пройдёт по коду сценариста.
+    expect(STATUSES.filter((s) => canTransition(s, 'render_queued')).sort()).toEqual(['animating', 'failed', 'rendering', 'writing']);
+  });
+
+  it('ролик на оживлении — в работе: держит слот и считается в предел', () => {
+    expect(IN_WORK_STATUSES).toContain('animate_queued');
+    expect(IN_WORK_STATUSES).toContain('animating');
+  });
 });
 
 describe('retryTarget', () => {
@@ -41,6 +56,7 @@
     expect(retryTarget(failed('directing'))).toBe('directing');
     expect(retryTarget(failed('capturing'))).toBe('capture_queued');
     expect(retryTarget(failed('writing'))).toBe('writing');
+    expect(retryTarget(failed('animating'))).toBe('animate_queued');
     expect(retryTarget(failed('rendering'))).toBe('render_queued');
   });
 
@@ -55,7 +71,7 @@
   });
 
   it('повтор всегда ведёт по разрешённому переходу', () => {
-    const failedFroms: ShortStatus[] = ['directing', 'capturing', 'writing', 'rendering', 'publishing'];
+    const failedFroms: ShortStatus[] = ['directing', 'capturing', 'writing', 'animating', 'rendering', 'publishing'];
     for (const failedFrom of failedFroms) {
       const target = retryTarget(failed(failedFrom, new Date()));
       expect(target).not.toBeNull();
@@ -83,7 +99,14 @@
     expect(v.writerRounds).toBe(0);
     expect(v.angleLocked).toBe(true);
     expect(v.scene).toBeNull();
+    expect(v.animation).toBeNull();
   });
+
+  it('формат: skit — только явно; без поля — chat, как в плане 2', () => {
+    expect(rowToShort({ format: 'skit' }).format).toBe('skit');
+    expect(rowToShort({ format: 'chat' }).format).toBe('chat');
+    expect(rowToShort({}).format).toBe('chat');
+  });
 });
 
 describe('appendOwnerNote', () => {
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/shorts.types.spec.ts
git -C "$WT" commit -m "test(shorts): статусы оживления и формат ролика (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/shorts.types.spec.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts.types.spec.ts"
```

Expected: 6 failed, 9 passed.

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/shorts.types.ts
+++ b/src/shorts/shorts.types.ts
@@ -3,26 +3,37 @@
  *
  * Спека: docs/superpowers/specs/2026-10-24-promo-shorts-design.md.
  *
- * Поля jsonb (`scene`, `capture`, `script`) пишут две стороны: API — сцену и
- * сценарий, студия (`studio/`) — съёмку. Их форма — зеркало
- * `studio/src/types.ts` и `studio/src/worker/db.ts`. Импортировать оттуда
- * нельзя: студия — отдельный ESM-пакет вне сборки API. Совпадение имён полей
- * сторожит shorts.contract.spec.ts.
+ * Поля jsonb (`scene`, `capture`, `script`, `animation`) пишут две стороны:
+ * API — сцену и сценарий, студия (`studio/`) — съёмку и оживление. Их форма —
+ * зеркало `studio/src/types.ts` и `studio/src/worker/db.ts`. Импортировать
+ * оттуда нельзя: студия — отдельный ESM-пакет вне сборки API. Совпадение имён
+ * полей сторожит shorts.contract.spec.ts.
+ *
+ * Сценки: docs/superpowers/specs/2026-10-26-shorts-skits-design.md.
  */
+import type { Skit, SkitKind, SkitPlan } from './short-skit-prompts';
 
 export type ShortRubric = 'assistant' | 'feature' | 'news' | 'case';
 export type ShortAngle = 'uncomfortable' | 'roast' | 'myth' | 'calm';
 export type ShortSource = 'catalog' | 'git' | 'manual';
 export type ShortStatus =
   | 'idea' | 'directing' | 'capture_queued' | 'capturing' | 'writing'
+  | 'animate_queued' | 'animating'
   | 'render_queued' | 'rendering' | 'pending_review' | 'approved'
   | 'publishing' | 'published' | 'rejected' | 'failed';
+/**
+ * Формат ролика: `skit` — сценки с героями вокруг настоящего ответа, `chat` —
+ * только съёмка чата (запасной, если Google снимет Omni). Ролик запоминает
+ * формат при запуске, чтобы переключение настройки посреди работы его не ломало.
+ */
+export type ShortFormat = 'skit' | 'chat';
 export type ShortPlatform = 'telegram' | 'vk' | 'youtube';
 export type PublicationStatus =
   | 'pending' | 'publishing' | 'published' | 'failed' | 'manual_pending' | 'manual_done';
 
 export const RUBRICS: readonly ShortRubric[] = ['assistant', 'feature', 'news', 'case'];
 export const ANGLES: readonly ShortAngle[] = ['uncomfortable', 'roast', 'myth', 'calm'];
+export const FORMATS: readonly ShortFormat[] = ['skit', 'chat'];
 /** Провокационные подачи: два ролика из трёх в неделю (спека, «Подача»). */
 export const PROVOCATIVE_ANGLES: readonly ShortAngle[] = ['uncomfortable', 'roast', 'myth'];
 
@@ -42,7 +53,7 @@
 
 /** Ролик в работе: предназначен своему слоту и считается в предел MAX_IN_WORK. */
 export const IN_WORK_STATUSES: readonly ShortStatus[] = [
-  'directing', 'capture_queued', 'capturing', 'writing', 'render_queued', 'rendering', 'pending_review',
+  'directing', 'capture_queued', 'capturing', 'writing', 'animate_queued', 'animating', 'render_queued', 'rendering', 'pending_review',
 ];
 
 /** Слот держат ровно эти статусы — предикат uq_short_video_slot (сверяет shorts-schema.spec.ts). */
@@ -60,7 +71,9 @@
  * открыл бы ему канал мимо человека.
  *
  * Возвраты на ту же стадию (`capturing → capture_queued`,
- * `rendering → render_queued`) — повтор задания студии после сбоя.
+ * `animating → animate_queued`, `rendering → render_queued`) — повтор задания
+ * студии после сбоя. Сценарист отдаёт ролик формата `skit` на оживление
+ * (`writing → animate_queued`), формата `chat` — сразу на сборку.
  * `rendering → writing` — озвучка вышла за 30–60 с или реплика ответа короче
  * 1,5 с: сценарий уходит на переписку с пояснением. `writing → directing` —
  * сценарист просит другую сцену.
@@ -70,7 +83,9 @@
   directing:      ['capture_queued', 'failed'],
   capture_queued: ['capturing'],
   capturing:      ['writing', 'capture_queued', 'failed'],
-  writing:        ['render_queued', 'directing', 'failed'],
+  writing:        ['animate_queued', 'render_queued', 'directing', 'failed'],
+  animate_queued: ['animating'],
+  animating:      ['render_queued', 'animate_queued', 'failed'],
   render_queued:  ['rendering'],
   rendering:      ['pending_review', 'render_queued', 'writing', 'failed'],
   pending_review: ['approved', 'writing', 'directing', 'rejected'],
@@ -78,7 +93,7 @@
   publishing:     ['published', 'approved', 'failed'],
   published:      [],
   rejected:       [],
-  failed:         ['directing', 'capture_queued', 'writing', 'render_queued', 'approved', 'rejected'],
+  failed:         ['directing', 'capture_queued', 'writing', 'animate_queued', 'render_queued', 'approved', 'rejected'],
 };
 
 export function canTransition(from: ShortStatus, to: ShortStatus): boolean {
@@ -90,6 +105,8 @@
   directing: 'directing',
   capturing: 'capture_queued',
   writing: 'writing',
+  // Готовые кадры и клипы задание возьмёт по отпечатку, запущенную генерацию — дождётся.
+  animating: 'animate_queued',
   rendering: 'render_queued',
 };
 
@@ -141,6 +158,8 @@
   question: string;
   /** Ответы на встречный вопрос ассистента, по порядку; используется не больше двух. */
   followups: string[];
+  /** Сценка 1 (конфликт) от режиссёра — у ролика формата `skit`. Съёмка её не читает. */
+  skit?: Skit;
 }
 
 export interface ShortBox {
@@ -191,8 +210,34 @@
   speed: number;
   lines: ShortScriptLine[];
   final: { assistantsCount: number; disclaimer?: string };
+  /** Сценки с готовыми промптами и отпечатками — у ролика формата `skit` (planSkits). */
+  skits?: Record<SkitKind, SkitPlan>;
 }
 
+/** Готовая сценка, как её пишет задание animate (зеркало SkitClip в studio/src/types.ts). Пути — относительно `shorts/<id>/`. */
+export interface ShortSkitClip {
+  fingerprint: string;
+  keyframe: string;
+  clip: string;
+  durationMs: number;
+  heard: string;
+  cues: { line: number; startMs: number; endMs: number }[];
+  attempts: number;
+  post: string;
+}
+
+/**
+ * Итог задания animate (зеркало ShortAnimation в studio/src/types.ts): секунды
+ * Omni и кадры — счёт денег ролика со всеми попытками, сценки — частично
+ * заполненные, `pending` — запущенные, но не скачанные генерации.
+ */
+export interface ShortAnimation {
+  omniSeconds: number;
+  keyframes?: number;
+  skits: Partial<Record<SkitKind, ShortSkitClip>>;
+  pending?: Partial<Record<SkitKind, { id: string; fingerprint: string }>>;
+}
+
 /** Подписи площадок — уже со ссылками и пометкой о синтезированном голосе. */
 export interface ShortCaptions {
   telegram: string;
@@ -215,10 +260,12 @@
   assistantId: number | null;
   slug: string | null;
   lang: string;
+  format: ShortFormat;
   scene: ShortScene | null;
   capture: ShortCapture | null;
   script: ShortScript | null;
   captions: ShortCaptions | null;
+  animation: ShortAnimation | null;
   videoKey: string | null;
   coverKey: string | null;
   durationMs: number | null;
@@ -274,10 +321,13 @@
     assistantId: num(row.assistant_id),
     slug: row.slug ?? null,
     lang: row.lang ?? 'ru',
+    // В базе формат есть у каждой строки (002); без поля — поведение плана 2, chat.
+    format: row.format === 'skit' ? 'skit' : 'chat',
     scene: row.scene ?? null,
     capture: row.capture ?? null,
     script: row.script ?? null,
     captions: row.captions ?? null,
+    animation: row.animation ?? null,
     videoKey: row.video_key ?? null,
     coverKey: row.cover_key ?? null,
     durationMs: num(row.duration_ms),
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add src/shorts/shorts.types.ts
git -C "$WT" commit -m "feat(shorts): статусы оживления, формат ролика, сценки в сцене и сценарии

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/shorts.types.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts.types.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: 15 passed, затем `TSC_OK`.

---

### Task 2: Миграция shorts/002

**Files:**
- Create: `src/shorts/migrations/002_skits.sql`
- Modify: `src/shorts/shorts-schema.service.ts`
- Test: `src/shorts/shorts-schema.spec.ts`
- Test: `src/shorts/shorts.integration.spec.ts`

Колонки `short_video.format` (старые ролики — chat, новые — skit) и `animation`, статусы оживления в CHECK, настройки `format` и `max_omni_seconds`. Форма — как у 001: один DO-блок под advisory-локом, `lock_timeout`, каждое изменение под проверкой каталога (не `ADD COLUMN IF NOT EXISTS`: он берёт ACCESS EXCLUSIVE на каждом старте). Живой тест накатывает 002 поверх таблицы без формата.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/shorts-schema.spec.ts
+++ b/src/shorts/shorts-schema.spec.ts
@@ -7,20 +7,38 @@
 import { ShortsSchemaService } from './shorts-schema.service';
 import { ALLOWED_TRANSITIONS, SLOT_HOLDING_STATUSES, RUBRICS, ANGLES } from './shorts.types';
 
-async function appliedSql(): Promise<string> {
+async function applied(): Promise<string[]> {
   const queries: string[] = [];
   const pg = { query: jest.fn(async (sql: string) => { queries.push(sql); return { rows: [] }; }) };
   await new ShortsSchemaService(pg as any).onModuleInit();
-  const text = queries.find((q) => q.includes('CREATE TABLE short_video'));
+  return queries.map((q) => q.replace(/--[^\n]*/g, ''));
+}
+
+async function appliedSql(): Promise<string> {
+  const text = (await applied()).find((q) => q.includes('CREATE TABLE short_video'));
   if (!text) throw new Error('миграция 001 не применена');
-  return text.replace(/--[^\n]*/g, '');
+  return text;
 }
 
+async function appliedSkitsSql(): Promise<string> {
+  const text = (await applied()).find((q) => q.includes("hashtext('shorts/002')"));
+  if (!text) throw new Error('миграция 002 не применена');
+  return text;
+}
+
 describe('ShortsSchemaService', () => {
   it('катит 001 при старте модуля', async () => {
     expect(await appliedSql()).toContain('CREATE TABLE short_publication');
   });
 
+  it('катит 002 после 001', async () => {
+    const qs = await applied();
+    const first = qs.findIndex((q) => q.includes('CREATE TABLE short_video'));
+    const second = qs.findIndex((q) => q.includes("hashtext('shorts/002')"));
+    expect(first).toBeGreaterThanOrEqual(0);
+    expect(second).toBeGreaterThan(first);
+  });
+
   it('не роняет старт, если база ответила ошибкой', async () => {
     const pg = { query: jest.fn(async () => { throw new Error('boom'); }) };
     await expect(new ShortsSchemaService(pg as any).onModuleInit()).resolves.toBeUndefined();
@@ -50,10 +68,11 @@
     expect(listed.sort()).toEqual([...SLOT_HOLDING_STATUSES].sort());
   });
 
-  it('статусы в CHECK совпадают с машиной состояний', async () => {
+  it('статусы в CHECK 001 — машина состояний без этапа animate', async () => {
     const m = (await appliedSql()).match(/status\s+text NOT NULL DEFAULT 'idea' CHECK \(status IN \(([\s\S]*?)\)\)/);
     const listed = (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
-    expect(listed.sort()).toEqual(Object.keys(ALLOWED_TRANSITIONS).sort());
+    const animate = ['animate_queued', 'animating'];
+    expect(listed.sort()).toEqual(Object.keys(ALLOWED_TRANSITIONS).filter((s) => !animate.includes(s)).sort());
   });
 
   it('строка настроек — под IF NOT EXISTS: обычный SELECT не ждёт чужую правку', async () => {
@@ -88,3 +107,35 @@
     expect(listed.sort()).toEqual([...ANGLES].sort());
   });
 });
+
+describe('текст 002_skits.sql', () => {
+  it('весь файл — один DO-блок под своим advisory-локом и lock_timeout', async () => {
+    const sql = (await appliedSkitsSql()).trim();
+    expect(sql.startsWith('DO $shorts$')).toBe(true);
+    expect(sql).toContain("set_config('lock_timeout', '5s', true)");
+  });
+
+  it('каждый ALTER TABLE — под проверкой каталога, без ADD COLUMN IF NOT EXISTS', async () => {
+    const sql = await appliedSkitsSql();
+    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS/);
+    const adds = sql.match(/ADD COLUMN ([a-z_]+)/g) ?? [];
+    expect(adds.length).toBe(4);
+    for (const [, column] of sql.matchAll(/ADD COLUMN ([a-z_]+)/g)) {
+      expect(sql).toMatch(new RegExp(`column_name = '${column}'\\) THEN\\s+ALTER TABLE \\w+ ADD COLUMN ${column}`));
+    }
+    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint[\s\S]*?LIKE '%''animating''%'\) THEN/);
+  });
+
+  it('новый CHECK статуса перечисляет ровно машину состояний', async () => {
+    const m = (await appliedSkitsSql()).match(/ADD CONSTRAINT short_video_status_check CHECK \(status IN \(([\s\S]*?)\)\)/);
+    const listed = (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
+    expect(listed.sort()).toEqual(Object.keys(ALLOWED_TRANSITIONS).sort());
+  });
+
+  it('формат ролика и настройки — только skit и chat; старые ролики — chat, новые — skit', async () => {
+    const sql = await appliedSkitsSql();
+    expect(sql).toMatch(/ADD COLUMN format text NOT NULL DEFAULT 'chat' CHECK \(format IN \('skit', 'chat'\)\);\s+ALTER TABLE short_video ALTER COLUMN format SET DEFAULT 'skit'/);
+    expect(sql).toContain("ALTER TABLE short_settings ADD COLUMN format text NOT NULL DEFAULT 'skit'");
+    expect(sql).toContain('ADD COLUMN max_omni_seconds int NOT NULL DEFAULT 48');
+  });
+});
--- a/src/shorts/shorts.integration.spec.ts
+++ b/src/shorts/shorts.integration.spec.ts
@@ -21,7 +21,10 @@
  */
 const PG = process.env.SHORTS_PG_URL;
 const maybe = PG ? describe : describe.skip;
-const MIGRATION = path.join(__dirname, 'migrations', '001_shorts.sql');
+const MIGRATIONS = ['001_shorts.sql', '002_skits.sql'].map((f) => path.join(__dirname, 'migrations', f));
+const migrate = async (pool: Pool) => {
+  for (const f of MIGRATIONS) await pool.query(fs.readFileSync(f, 'utf8'));
+};
 
 maybe('ролики против живого Postgres', () => {
   jest.setTimeout(60_000);
@@ -39,7 +42,7 @@
       const n = await pool.query('SELECT count(*)::int AS n FROM short_video');
       if (n.rows[0].n > 0) throw new Error('в short_video уже есть строки — нужна одноразовая база, TRUNCATE их сотрёт');
     }
-    await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
+    await migrate(pool);
     ours = true;
   });
 
@@ -75,7 +78,7 @@
       await holder.query(`UPDATE short_video SET topic_hint = 'держу строку'`);
       await holder.query(`UPDATE short_settings SET slot_hour_msk = 19 WHERE id = 1`);
       const t0 = Date.now();
-      await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
+      await migrate(pool);
       expect(Date.now() - t0).toBeLessThan(3000);
     } finally {
       await holder.query('ROLLBACK');
@@ -83,6 +86,26 @@
     }
   });
 
+  it('002 поверх роликов без формата: старые — chat, новые — skit; статусы оживления проходят CHECK', async () => {
+    await pool.query('ALTER TABLE short_video DROP COLUMN format');
+    const old = await insert({});
+    await migrate(pool);
+    const fresh = await insert({ status: 'animating' });
+    const rows = await pool.query('SELECT id, format FROM short_video');
+    const format = new Map(rows.rows.map((r) => [r.id, r.format]));
+    expect([format.get(old.id), format.get(fresh.id)]).toEqual(['chat', 'skit']);
+    await insert({ status: 'animate_queued' });
+    await expect(insert({ status: 'dancing' })).rejects.toThrow(/short_video_status_check/);
+    await expect(insert({ format: 'cartoon' })).rejects.toThrow(/check/);
+    const checks = await pool.query(
+      `SELECT count(*)::int AS n FROM pg_constraint
+        WHERE conrelid = 'public.short_video'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%''render_queued''%'`,
+    );
+    expect(checks.rows[0].n).toBe(1);
+    const s = await pool.query('SELECT format, max_omni_seconds FROM short_settings WHERE id = 1');
+    expect(s.rows[0]).toEqual({ format: 'skit', max_omni_seconds: 48 });
+  });
+
   it('два одобрения в один планируемый слот — разные слоты, планируемый достаётся одному', async () => {
     const schedule = { slotDays: [2, 4, 6], slotHourMsk: 18 };
     const planned = new Date('2026-10-27T15:00:00.000Z');
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/shorts-schema.spec.ts src/shorts/shorts.integration.spec.ts
git -C "$WT" commit -m "test(shorts): миграция 002 — формат, оживление, статусы (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/shorts-schema.spec.ts src/shorts/shorts.integration.spec.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts-schema.spec.ts"
```

Expected: 5 failed, 10 passed (нет файла 002).

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- /dev/null
+++ b/src/shorts/migrations/002_skits.sql
@@ -0,0 +1,66 @@
+-- 002_skits.sql — ролики со сценками: формат ролика, оживление, статусы этапа animate.
+--
+-- Спека: docs/superpowers/specs/2026-10-26-shorts-skits-design.md, «Данные».
+-- План: docs/superpowers/plans/2026-10-26-shorts-skits-2-pipeline.md, задача 1.
+--
+-- КАК КАТИТСЯ — как 001: ShortsSchemaService выполняет файл при КАЖДОМ старте
+-- API, весь файл — один DO-блок (одна транзакция) под advisory-локом, чужих
+-- замков ждём не дольше 5 с. Каждое изменение — под проверкой каталога:
+-- ALTER TABLE берёт ACCESS EXCLUSIVE даже с IF NOT EXISTS и на каждом старте
+-- ждал бы открытые записи (шапка 001).
+--
+-- ОТКАТ: убрать 002 из ShortsSchemaService, ролики в animate_queued и animating
+-- перевести в failed, затем
+--   ALTER TABLE short_video DROP COLUMN format, DROP COLUMN animation;
+--   ALTER TABLE short_settings DROP COLUMN format, DROP COLUMN max_omni_seconds;
+--   и вернуть CHECK статуса списком из 001.
+
+DO $shorts$
+DECLARE
+    c record;
+BEGIN
+    PERFORM pg_advisory_xact_lock(hashtext('shorts/002'));
+    PERFORM set_config('lock_timeout', '5s', true);
+
+    -- Ролики, запущенные до сценок, сняты по-старому: колонка приходит со
+    -- значением 'chat', затем умолчание меняется на 'skit'. Сам формат ролику
+    -- ставит запуск — из настроек (shorts-topic.service.ts, start).
+    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
+                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'format') THEN
+        ALTER TABLE short_video ADD COLUMN format text NOT NULL DEFAULT 'chat' CHECK (format IN ('skit', 'chat'));
+        ALTER TABLE short_video ALTER COLUMN format SET DEFAULT 'skit';
+    END IF;
+    -- Итог задания animate: секунды Omni, кадры, клипы сценок (studio/src/types.ts, ShortAnimation).
+    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
+                    WHERE table_schema = 'public' AND table_name = 'short_video' AND column_name = 'animation') THEN
+        ALTER TABLE short_video ADD COLUMN animation jsonb;
+    END IF;
+
+    -- Статусы этапа animate: CHECK пересоздаётся, только пока в нём их нет.
+    IF NOT EXISTS (SELECT 1 FROM pg_constraint
+                    WHERE conrelid = 'public.short_video'::regclass AND contype = 'c'
+                      AND pg_get_constraintdef(oid) LIKE '%''animating''%') THEN
+        FOR c IN SELECT conname FROM pg_constraint
+                  WHERE conrelid = 'public.short_video'::regclass AND contype = 'c'
+                    AND pg_get_constraintdef(oid) LIKE '%''render_queued''%'
+        LOOP
+            EXECUTE format('ALTER TABLE short_video DROP CONSTRAINT %I', c.conname);
+        END LOOP;
+        ALTER TABLE short_video ADD CONSTRAINT short_video_status_check CHECK (status IN (
+            'idea', 'directing', 'capture_queued', 'capturing', 'writing',
+            'animate_queued', 'animating', 'render_queued', 'rendering', 'pending_review', 'approved',
+            'publishing', 'published', 'rejected', 'failed'));
+    END IF;
+
+    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
+                    WHERE table_schema = 'public' AND table_name = 'short_settings' AND column_name = 'format') THEN
+        ALTER TABLE short_settings ADD COLUMN format text NOT NULL DEFAULT 'skit' CHECK (format IN ('skit', 'chat'));
+    END IF;
+    -- Предел секунд Omni на ролик: 48 с — шесть клипов, ≈ $4,8 (спека, «Отказы»).
+    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
+                    WHERE table_schema = 'public' AND table_name = 'short_settings' AND column_name = 'max_omni_seconds') THEN
+        ALTER TABLE short_settings ADD COLUMN max_omni_seconds int NOT NULL DEFAULT 48
+            CHECK (max_omni_seconds BETWEEN 8 AND 400);
+    END IF;
+END
+$shorts$;
--- a/src/shorts/shorts-schema.service.ts
+++ b/src/shorts/shorts-schema.service.ts
@@ -14,8 +14,10 @@
 
   constructor(private readonly pg: PgService) {}
 
+  /** По порядку: 002 правит таблицы, которые создаёт 001. */
   async onModuleInit() {
     await this.applyMigration('001_shorts.sql');
+    await this.applyMigration('002_skits.sql');
   }
 
   /**
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add src/shorts/migrations/002_skits.sql src/shorts/shorts-schema.service.ts
git -C "$WT" commit -m "feat(shorts): миграция 002 — формат ролика, animation, статусы оживления, настройки сценок

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/migrations/002_skits.sql src/shorts/shorts-schema.service.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts-schema.spec.ts && SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: 15 passed, живой Postgres — 8 passed, затем `TSC_OK`.

---

### Task 3: Настройки «Формат» и «Предел секунд Omni»; формат ролика при запуске

**Files:**
- Modify: `src/shorts/shorts-settings.service.ts`
- Modify: `src/shorts/shorts-topic.service.ts`
- Test: `src/shorts/shorts-settings.service.spec.ts`
- Test: `src/shorts/shorts-topic.service.spec.ts`

`short_settings.format` (skit — «Сценки», chat — «Только чат») и `max_omni_seconds` (8–400, по умолчанию 48) — в `get`/`update` и в проверке правки из админки. Ролик запоминает формат при запуске (`idea → directing`), чтобы переключение посреди работы его не ломало.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/shorts-settings.service.spec.ts
+++ b/src/shorts/shorts-settings.service.spec.ts
@@ -10,11 +10,13 @@
     const row = {
       slot_days: ['2', '4'], slot_hour_msk: '19', prepare_lead_hours: 12, min_answer_chars: 500,
       tg_channel_chat_id: '-1003290853538', platforms: ['telegram'], narrator_voice: 'jane',
+      format: 'chat', max_omni_seconds: '96',
     };
     const svc = new ShortsSettingsService({ query: jest.fn(async () => ({ rows: [row] })) } as any);
     expect(await svc.get()).toEqual({
       slotDays: [2, 4], slotHourMsk: 19, prepareLeadHours: 12, minAnswerChars: 500,
       tgChannelChatId: '-1003290853538', platforms: ['telegram'], narratorVoice: 'jane',
+      format: 'chat', maxOmniSeconds: 96,
     });
   });
 
@@ -32,8 +34,13 @@
     expect(validateSettingsPatch({ slotDays: [6, 2, 4], slotHourMsk: 18, tgChannelChatId: '-1003290853538' }))
       .toEqual({ slotDays: [2, 4, 6], slotHourMsk: 18, tgChannelChatId: '-1003290853538' });
     expect(validateSettingsPatch({ tgChannelChatId: null })).toEqual({ tgChannelChatId: null });
+    expect(validateSettingsPatch({ format: 'chat', maxOmniSeconds: 96 })).toEqual({ format: 'chat', maxOmniSeconds: 96 });
   });
 
+  it('по умолчанию — сценки и 48 с Omni на ролик', () => {
+    expect([SETTINGS_DEFAULTS.format, SETTINGS_DEFAULTS.maxOmniSeconds]).toEqual(['skit', 48]);
+  });
+
   it.each([
     [{ slotDays: [] }, /slotDays/],
     [{ slotDays: [8] }, /slotDays/],
@@ -45,6 +52,10 @@
     [{ platforms: ['vk'] }, /VK/],
     [{ platforms: [] }, /platforms/],
     [{ narratorVoice: 'nova' }, /narratorVoice/],
+    [{ format: 'cartoon' }, /format/],
+    [{ maxOmniSeconds: 4 }, /maxOmniSeconds/],
+    [{ maxOmniSeconds: 48.5 }, /maxOmniSeconds/],
+    [{ maxOmniSeconds: '48' }, /maxOmniSeconds/],
     [{ colour: 'red' }, /неизвестная настройка: colour/],
   ])('%j — ошибка', (body, message) => {
     expect(() => validateSettingsPatch(body)).toThrow(message);
--- a/src/shorts/shorts-topic.service.spec.ts
+++ b/src/shorts/shorts-topic.service.spec.ts
@@ -7,7 +7,7 @@
   { id: 4, name: 'Ирина', description: 'Карьера — резюме, собеседования и переговоры' },
   { id: 7, name: 'Полина', description: 'Врач-терапевт — симптомы, анализы и профилактика' },
 ];
-const SETTINGS = { slotDays: [2, 4, 6], slotHourMsk: 18, prepareLeadHours: 24 };
+const SETTINGS = { slotDays: [2, 4, 6], slotHourMsk: 18, prepareLeadHours: 24, format: 'skit' };
 const MON_NOON = new Date('2026-10-26T12:00:00.000Z'); // до вт 18:00 МСК — 27 ч
 const MON_EVENING = new Date('2026-10-26T17:00:00.000Z'); // до вт 18:00 МСК — 22 ч
 const TUE = '2026-10-27T15:00:00.000Z';
@@ -31,10 +31,10 @@
   return { getClient: async () => client, seen };
 }
 
-function setup(tx: ReturnType<typeof fakeTx>, poolQuery = jest.fn(async () => ({ rows: [] })), agentsList: any[] = AGENTS) {
+function setup(tx: ReturnType<typeof fakeTx>, poolQuery = jest.fn(async () => ({ rows: [] })), agentsList: any[] = AGENTS, settingsOver: Record<string, unknown> = {}) {
   const pg = { query: poolQuery, getClient: tx.getClient };
   const agents = { getAgents: jest.fn(async () => agentsList) };
-  const settings = { get: jest.fn(async () => SETTINGS) };
+  const settings = { get: jest.fn(async () => ({ ...SETTINGS, ...settingsOver })) };
   return new ShortsTopicService(pg as any, agents as any, settings as any);
 }
 
@@ -212,9 +212,17 @@
     const v = await setup(tx).start({ force: false }, () => MON_EVENING);
     expect(v?.status).toBe('directing');
     const update = tx.seen.find((q) => q.sql.includes('UPDATE short_video'));
-    expect(update.params).toEqual(['i1', TUE, 'uncomfortable']);
+    // Формат — из настроек: SETTINGS теста — по умолчанию, сценки.
+    expect(update.params).toEqual(['i1', TUE, 'uncomfortable', 'skit']);
+    expect(update.sql).toContain('format = $4');
   });
 
+  it('формат «Только чат» в настройках — ролик запускается в нём', async () => {
+    const tx = routes();
+    await setup(tx, undefined, AGENTS, { format: 'chat' }).start({ force: false }, () => MON_EVENING);
+    expect(tx.seen.find((q) => q.sql.includes('UPDATE short_video')).params[3]).toBe('chat');
+  });
+
   it('до слота больше суток — крон ждёт, start_now — запускает', async () => {
     expect(await setup(routes()).start({ force: false }, () => MON_NOON)).toBeNull();
     expect((await setup(routes()).start({ force: true }, () => MON_NOON))?.status).toBe('directing');
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/shorts-settings.service.spec.ts src/shorts/shorts-topic.service.spec.ts
git -C "$WT" commit -m "test(shorts): настройки сценок и формат при запуске (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/shorts-settings.service.spec.ts src/shorts/shorts-topic.service.spec.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts-settings.service.spec.ts src/shorts/shorts-topic.service.spec.ts"
```

Expected: 5 failed, 41 passed.

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/shorts-settings.service.ts
+++ b/src/shorts/shorts-settings.service.ts
@@ -1,7 +1,7 @@
 import { Injectable } from '@nestjs/common';
 import { PgService } from '../common/services/pg.service';
 import { isValidVoice } from '../speech/voices';
-import { ShortPlatform } from './shorts.types';
+import { FORMATS, ShortFormat, ShortPlatform } from './shorts.types';
 
 export interface ShortSettings {
   /** ISO-дни: 1 — понедельник … 7 — воскресенье. */
@@ -15,6 +15,10 @@
   platforms: ShortPlatform[];
   /** Голос Linkeon в финале. */
   narratorVoice: string;
+  /** Формат новых роликов: «Сценки» или «Только чат» (запасной, если Omni недоступен). */
+  format: ShortFormat;
+  /** Предел секунд Omni на ролик со всеми пересъёмками (спека сценок, «Отказы»). */
+  maxOmniSeconds: number;
 }
 
 export const SETTINGS_DEFAULTS: ShortSettings = {
@@ -25,6 +29,8 @@
   tgChannelChatId: null,
   platforms: ['telegram', 'youtube'],
   narratorVoice: 'alena',
+  format: 'skit',
+  maxOmniSeconds: 48,
 };
 
 export type ShortSettingsPatch = Partial<ShortSettings>;
@@ -40,6 +46,8 @@
   tgChannelChatId: 'tg_channel_chat_id',
   platforms: 'platforms',
   narratorVoice: 'narrator_voice',
+  format: 'format',
+  maxOmniSeconds: 'max_omni_seconds',
 };
 
 const intIn = (v: any, min: number, max: number): boolean => Number.isInteger(v) && v >= min && v <= max;
@@ -92,6 +100,15 @@
     if (!isValidVoice(b.narratorVoice, 'yandex')) throw new Error('narratorVoice — голос SpeechKit из каталога voices.ts');
     p.narratorVoice = b.narratorVoice;
   }
+  if (b.format !== undefined) {
+    if (!FORMATS.includes(b.format)) throw new Error('format — skit («Сценки») или chat («Только чат»)');
+    p.format = b.format;
+  }
+  if (b.maxOmniSeconds !== undefined) {
+    // Клип Omni — 8 с: предел меньше одного клипа сценки не снимет ни одной; CHECK базы — 8–400.
+    if (!intIn(b.maxOmniSeconds, 8, 400)) throw new Error('maxOmniSeconds — 8–400 секунд Omni на ролик (клип — 8 с)');
+    p.maxOmniSeconds = b.maxOmniSeconds;
+  }
   return p;
 }
 
@@ -102,7 +119,7 @@
   async get(): Promise<ShortSettings> {
     const r = await this.pg.query(
       `SELECT slot_days, slot_hour_msk, prepare_lead_hours, min_answer_chars,
-              tg_channel_chat_id, platforms, narrator_voice
+              tg_channel_chat_id, platforms, narrator_voice, format, max_omni_seconds
          FROM short_settings WHERE id = 1`,
     );
     const row = r.rows[0];
@@ -115,6 +132,8 @@
       tgChannelChatId: row.tg_channel_chat_id ?? null,
       platforms: Array.isArray(row.platforms) && row.platforms.length ? row.platforms : SETTINGS_DEFAULTS.platforms,
       narratorVoice: row.narrator_voice || SETTINGS_DEFAULTS.narratorVoice,
+      format: row.format === 'chat' ? 'chat' : SETTINGS_DEFAULTS.format,
+      maxOmniSeconds: Number(row.max_omni_seconds ?? SETTINGS_DEFAULTS.maxOmniSeconds),
     };
   }
 
--- a/src/shorts/shorts-topic.service.ts
+++ b/src/shorts/shorts-topic.service.ts
@@ -244,12 +244,13 @@
       if (!plan) return null;
 
       const r = await tx.query(
+        // Формат — из настроек в момент запуска: переключение посреди работы ролик не ломает.
         `UPDATE short_video
-            SET status = 'directing', slot_at = $2, angle = $3, attempts = 0, lease_until = NULL,
+            SET status = 'directing', slot_at = $2, angle = $3, format = $4, attempts = 0, lease_until = NULL,
                 last_error = NULL, updated_at = now()
           WHERE id = $1 AND status = 'idea'
           RETURNING *`,
-        [plan.ideaId, slot.toISOString(), plan.angle],
+        [plan.ideaId, slot.toISOString(), plan.angle, settings.format],
       );
       return r.rows[0] ? rowToShort(r.rows[0]) : null;
     });
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add src/shorts/shorts-settings.service.ts src/shorts/shorts-topic.service.ts
git -C "$WT" commit -m "feat(shorts): настройки «Формат» и «Предел секунд Omni», формат ролика — при запуске

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/shorts-settings.service.ts src/shorts/shorts-topic.service.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts-settings.service.spec.ts src/shorts/shorts-topic.service.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: 46 passed, затем `TSC_OK`.

---

### Task 4: Правила 16–18 и проверка сценария со сценками

**Files:**
- Modify: `src/shorts/short-skit-prompts.ts`
- Modify: `src/shorts/short-rules.ts`
- Test: `src/shorts/short-rules.spec.ts`

`checkSkitRules` — правила 16 (только герои труппы, разные, роль из списка героя), 17 (до 12 слов в реплике, до 3 реплик и 25 слов), 18 (в конфликте нет box, в развязке box обязателен и указывает на снятый абзац) и форма сценки (английские поля без кавычек). Каждое сообщение называет сценку — его прочтёт модель на переписке. `checkScriptRules` для формата skit: зацепка — надпись до 6 слов без реплики hook, ответ — 1–2 реплики, коридор оценки озвучки 11–26 с, текстовые правила, числа и название сервиса — и в репликах героев.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/short-rules.spec.ts
+++ b/src/shorts/short-rules.spec.ts
@@ -1,4 +1,5 @@
-import { RulesInput, checkScriptRules, estimateSpeechSec, numbersIn } from './short-rules';
+import { RulesInput, checkScriptRules, checkSkitRules, estimateSpeechSec, numbersIn } from './short-rules';
+import { Skit } from './short-skit-prompts';
 import { ShortScript } from './shorts.types';
 
 const paragraphs = [
@@ -521,5 +522,154 @@
     const sec = estimateSpeechSec(script());
     expect(sec).toBeGreaterThan(32);
     expect(sec).toBeLessThan(55);
+  });
+});
+
+// ── Сценки (спека docs/superpowers/specs/2026-10-26-shorts-skits-design.md, «Правила») ──
+
+const conflict = (): Skit => ({
+  cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
+  setting: 'a small rented flat hallway, a tiny scuff on the wallpaper by the door',
+  opening: 'The goose stands in the doorway, the capybara holds a suitcase.',
+  action: 'The goose points a wing at the scuff and hisses. The capybara takes out a phone.',
+  lines: [{ hero: 'galina', text: 'Обои потёрли! Залог мой!' }, { hero: 'kesha', text: 'Спокойно. Спрошу у юриста.' }],
+});
+
+const punchline = (): Skit => ({
+  cast: [{ hero: 'kesha', role: 'жилец' }, { hero: 'galina', role: 'хозяйка квартиры' }],
+  setting: 'the same hallway',
+  opening: 'The capybara holds up the phone, the goose freezes.',
+  action: 'The capybara speaks calmly, the goose drops the keys and lowers her wings.',
+  lines: [{ hero: 'kesha', text: 'Нормальный износ — не повреждение. Залог верните.', box: 3 }, { hero: 'galina', text: 'Га-га… ладно.' }],
+});
+
+describe('checkSkitRules — правила 16–18 и форма сценки', () => {
+  it('корректные сценки проходят', () => {
+    expect(checkSkitRules(conflict(), 'conflict', paragraphs)).toEqual([]);
+    expect(checkSkitRules(punchline(), 'punchline', paragraphs)).toEqual([]);
+  });
+
+  it('правило 16: только герои труппы, разные, с ролью из своего списка (регистр и ё не важны)', () => {
+    const s = conflict();
+    s.cast = [{ hero: 'fox' as any, role: 'лиса' }, { hero: 'kesha', role: 'Жилец' }, { hero: 'kesha', role: 'сосед' }];
+    expect(checkSkitRules(s, 'conflict', null)).toEqual([
+      'сценка 1 (конфликт): правило 16: героя «fox» нет в труппе',
+      'сценка 1 (конфликт): правило 16: Капибара Кеша в составе дважды',
+      'сценка 1 (конфликт): реплика 1: говорит «galina», а его нет в составе',
+    ]);
+    const r = conflict();
+    r.cast[0].role = 'тёща';
+    expect(checkSkitRules(r, 'conflict', null)).toEqual([
+      'сценка 1 (конфликт): правило 16: роль «тёща» не из ролей героя Гусыня Галина Петровна (хозяйка квартиры, соседка, свекровь, вахтёрша, продавщица)',
+    ]);
+  });
+
+  it('правило 17: реплика до 12 слов, 1–3 реплики, вместе до 25 слов', () => {
+    const s = conflict();
+    s.lines = [
+      { hero: 'galina', text: 'Раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать.' },
+      { hero: 'kesha', text: 'Раз два три четыре пять шесть семь.' },
+      { hero: 'galina', text: 'Раз два три четыре пять шесть.' },
+      { hero: 'kesha', text: 'Да.' },
+    ];
+    expect(checkSkitRules(s, 'conflict', null)).toEqual([
+      'сценка 1 (конфликт): правило 17: реплик 4 — нужно 1–3',
+      'сценка 1 (конфликт): правило 17: реплика 1 — 13 слов, больше 12',
+      'сценка 1 (конфликт): правило 17: в репликах 27 слов, больше 25',
+    ]);
+  });
+
+  it('правило 18: в конфликте без box; в развязке box обязателен и указывает на снятый абзац', () => {
+    const c = conflict();
+    c.lines[1].box = 3;
+    expect(checkSkitRules(c, 'conflict', null)).toEqual([
+      'сценка 1 (конфликт): правило 18: в конфликте герои не дают советов по существу — у реплик сценки 1 не бывает box',
+    ]);
+    const p = punchline();
+    delete p.lines[0].box;
+    expect(checkSkitRules(p, 'punchline', paragraphs)).toEqual([
+      'сценка 2 (развязка): правило 18: утверждение по существу в развязке ссылается на абзац ответа — укажи box у этой реплики',
+    ]);
+    const q = punchline();
+    q.lines[0].box = 9;
+    expect(checkSkitRules(q, 'punchline', paragraphs)).toEqual(['сценка 2 (развязка): правило 18: box 9 — такого абзаца в ответе нет']);
+  });
+
+  it('форма: место, первый кадр и действие — английские строки без кавычек; сценки нет — одно сообщение', () => {
+    const s = conflict();
+    s.setting = 'коридор съёмной квартиры';
+    s.opening = 'a sign "FOR RENT" on the door';
+    (s as any).action = '';
+    expect(checkSkitRules(s, 'conflict', null)).toEqual([
+      'сценка 1 (конфликт): поле setting — по-английски и без кавычек: оно идёт прямо в промпт генератора',
+      'сценка 1 (конфликт): поле opening — по-английски и без кавычек: оно идёт прямо в промпт генератора',
+      'сценка 1 (конфликт): нет поля action',
+    ]);
+    expect(checkSkitRules(null, 'punchline', paragraphs)).toEqual(['сценка 2 (развязка): сценки нет']);
   });
 });
+
+describe('checkScriptRules — ролик со сценками', () => {
+  const skitScript = (): ShortScript => ({
+    hook: 'Весь залог — за потёртые обои?',
+    hookBox: 3,
+    voice: 'madirus',
+    speed: 1.1,
+    lines: [
+      { id: 'q', scene: 'question', text: 'Я Алексей, юрист. Меня спросили, может ли хозяйка оставить весь залог себе.' },
+      { id: 'a1', scene: 'answer', box: 3, text: 'Нормальный износ не является повреждением — впишите это в договор аренды.' },
+      { id: 'f', scene: 'final', voice: 'alena', text: 'Линкеон — восемнадцать ассистентов. Ссылка — в описании и в профиле.' },
+    ],
+    final: { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет юриста' },
+  });
+  const skitInput = (over: Partial<RulesInput> = {}): RulesInput =>
+    input({ format: 'skit', script: skitScript(), skits: { conflict: conflict(), punchline: punchline() }, ...over });
+
+  it('корректный проходит', () => {
+    expect(checkScriptRules(skitInput())).toEqual([]);
+  });
+
+  it('зацепка — надпись до 6 слов без реплики hook; ответ — 1–2 реплики', () => {
+    const s = skitScript();
+    s.hook = 'Может ли хозяйка оставить себе весь залог?';
+    s.lines = [
+      { id: 'h', scene: 'hook', text: s.hook },
+      ...s.lines.slice(0, 2),
+      { id: 'a2', scene: 'answer', box: 1, text: 'Залог возвращается в течение 7 дней после выезда.' },
+      { id: 'a3', scene: 'answer', box: 2, text: 'Ищите опасную фразу о досрочном выезде.' },
+      s.lines[2],
+    ];
+    const out = checkScriptRules(skitInput({ script: s }));
+    expect(out).toContain('зацепка длиннее 6 слов');
+    expect(out).toContain('у ролика со сценками зацепка — надпись поверх сценки: реплики hook быть не должно');
+    expect(out).toContain('реплик ответа 3 — нужно 1–2');
+  });
+
+  it('нарушения сценок — с именем сценки; нет развязки — так и сказано', () => {
+    const c = conflict();
+    c.lines[0].text = 'Раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать.';
+    const out = checkScriptRules(skitInput({ skits: { conflict: c } }));
+    expect(out).toContain('сценка 1 (конфликт): правило 17: реплика 1 — 13 слов, больше 12');
+    expect(out).toContain('сценка 2 (развязка): сценки нет');
+  });
+
+  it('текстовые правила, числа и название сервиса смотрят и реплики сценок', () => {
+    const c = conflict();
+    c.lines[0].text = 'Сорок тысяч! Нет, 50 тысяч за обои!';
+    c.lines[1].text = 'Спокойно. Спрошу в Linkeon.';
+    const out = checkScriptRules(skitInput({ skits: { conflict: c, punchline: punchline() } }));
+    expect(out).toContain('правило 1: числа «50 тысяч» нет в ответе ассистента (сценка 1 (конфликт), реплика 1)');
+    expect(out).toContain('название сервиса звучит только в финале — убери его из реплик');
+  });
+
+  it('длина озвучки — коридор сценок 11–26 с, а не 32–55 с', () => {
+    expect(checkScriptRules(skitInput()).some((m) => m.startsWith('сценарий звучит'))).toBe(false);
+    const s = skitScript();
+    s.lines = s.lines.map((l) => (l.id === 'a1' ? { ...l, text: `${l.text} `.repeat(6).trim() } : l));
+    expect(checkScriptRules(skitInput({ script: s }))).toContainEqual(expect.stringMatching(/^сценарий звучит примерно \d+ с, нужно 11–26 с: сократи реплики$/));
+  });
+
+  it('без формата — по-старому: у chat реплика hook обязательна', () => {
+    expect(checkScriptRules(input({ script: skitScript() }))).toContain('зацепка — ровно одна реплика');
+  });
+});
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/short-rules.spec.ts
git -C "$WT" commit -m "test(shorts): правила сценок 16–18 и сценарий со сценками (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/short-rules.spec.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-rules.spec.ts"
```

Expected: 10 failed, 259 passed.

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/short-skit-prompts.ts
+++ b/src/shorts/short-skit-prompts.ts
@@ -22,6 +22,9 @@
 
 export type SkitKind = 'conflict' | 'punchline';
 
+/** Сценки по порядку в ролике: конфликт открывает ролик, развязка идёт после ответа. */
+export const SKIT_KINDS: readonly SkitKind[] = ['conflict', 'punchline'];
+
 export interface SkitLine {
   hero: TroupeId;
   /** По-русски, до 12 слов. */
@@ -78,7 +81,7 @@
 export const MAX_SKIT_LINE_WORDS = 12;
 export const MAX_SKIT_WORDS = 25;
 /** Слово — токен с буквой или цифрой, как в short-rules.ts: тире между словами не слово. */
-const wordCount = (s: string): number => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
+export const wordCount = (s: string): number => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
 
 /**
  * Поля сценки проверяются до промптов: опечатка в имени поля дала бы «undefined»
--- a/src/shorts/short-rules.ts
+++ b/src/shorts/short-rules.ts
@@ -1,5 +1,7 @@
 import { isHealthAssistant } from './short-assistants';
-import { PROVOCATIVE_ANGLES, ShortAngle, ShortParagraph, ShortScript } from './shorts.types';
+import { MAX_SKIT_LINE_WORDS, MAX_SKIT_WORDS, SKIT_KINDS, Skit, SkitKind, wordCount } from './short-skit-prompts';
+import { heroById } from './short-troupe';
+import { PROVOCATIVE_ANGLES, ShortAngle, ShortFormat, ShortParagraph, ShortScript } from './shorts.types';
 
 /**
  * Проверка сценария до отправки владельцу (спека, «Правила текста»).
@@ -29,6 +31,10 @@
   /** Вопрос режиссёра: он стоит в кадре, его числа и слова — не выдумка сценариста. */
   sceneQuestion?: string;
   assistantsCount: number;
+  /** Формат ролика; без него — chat, как в плане 2. */
+  format?: ShortFormat;
+  /** Сценки ролика формата skit — поля от режиссёра и сценариста, до сборки промптов. */
+  skits?: Partial<Record<SkitKind, Skit>>;
 }
 
 /**
@@ -47,6 +53,93 @@
 export const WELCOME_GIFT_TOKENS = 25000;
 const GAP_SEC = 0.25;
 const MIN_HOOK_SEC = 2;
+
+/**
+ * Зацепка ролика со сценками — немая надпись поверх конфликта: её читают за 3 с,
+ * поэтому она короче, чем у озвученной зацепки (спека сценок, «Что уточнил образец»).
+ */
+export const MAX_SKIT_HOOK_WORDS = 6;
+/** Пересказ ответа голосом ассистента в ролике со сценками — 1–2 реплики (спека сценок, «Кто пишет сценки»). */
+export const MIN_SKIT_ANSWER_LINES = 1;
+export const MAX_SKIT_ANSWER_LINES = 2;
+/**
+ * Коридор оценки озвучки ролика со сценками: с двумя клипами по 8 с ролик
+ * должен уложиться в 25–45 с у студии; запас — на погрешность оценки.
+ */
+export const MIN_SKIT_ESTIMATED_SEC = 11;
+export const MAX_SKIT_ESTIMATED_SEC = 26;
+/** Как сценка называется в нарушениях и подписях владельцу — так же её зовёт студия. */
+export const SKIT_LABELS: Record<SkitKind, string> = { conflict: 'сценка 1 (конфликт)', punchline: 'сценка 2 (развязка)' };
+
+const normRole = (s: unknown): string => String(s ?? '').trim().toLowerCase().replace(/ё/g, 'е');
+
+/**
+ * Правила 16–18 и форма сценки — до промптов и до денег (спека сценок,
+ * «Правила»). Режиссёр проверяет сценку 1 (абзацев ответа у него ещё нет —
+ * paragraphs = null), сценарист — обе. Каждое сообщение называет сценку.
+ */
+export function checkSkitRules(skit: unknown, kind: SkitKind, paragraphs: ShortParagraph[] | null): string[] {
+  const at = SKIT_LABELS[kind];
+  const out: string[] = [];
+  const add = (m: string) => {
+    const t = `${at}: ${m}`;
+    if (!out.includes(t)) out.push(t);
+  };
+  if (!skit || typeof skit !== 'object') return [`${at}: сценки нет`];
+  const s = skit as Partial<Skit>;
+  // Место, первый кадр и действие идут прямо в промпты генераторов: русский текст
+  // и текст в кавычках генератор картинок рисует надписью.
+  for (const f of ['setting', 'opening', 'action'] as const) {
+    const v: unknown = s[f];
+    if (typeof v !== 'string' || !v.trim()) add(`нет поля ${f}`);
+    else if (/[а-яё«»"“”„]/i.test(v)) add(`поле ${f} — по-английски и без кавычек: оно идёт прямо в промпт генератора`);
+  }
+  // Правило 16: только герои труппы, разные, у каждого роль из его списка.
+  const cast = Array.isArray(s.cast) ? s.cast : [];
+  if (cast.length < 2 || cast.length > 3) add(`в составе ${cast.length} героев — нужно 2–3`);
+  const inCast = new Set<string>();
+  for (const c of cast) {
+    const hero = heroById(String(c?.hero ?? ''));
+    if (!hero) {
+      add(`правило 16: героя «${c?.hero}» нет в труппе`);
+      continue;
+    }
+    if (inCast.has(hero.id)) add(`правило 16: ${hero.name} в составе дважды`);
+    inCast.add(hero.id);
+    if (!hero.roles.map(normRole).includes(normRole(c?.role))) {
+      add(`правило 16: роль «${String(c?.role ?? '').trim()}» не из ролей героя ${hero.name} (${hero.roles.join(', ')})`);
+    }
+  }
+  // Правило 17: 1–3 реплики, каждая до 12 слов, вместе до 25.
+  const lines = Array.isArray(s.lines) ? s.lines : [];
+  if (lines.length < 1 || lines.length > 3) add(`правило 17: реплик ${lines.length} — нужно 1–3`);
+  let total = 0;
+  lines.forEach((l, i) => {
+    const text = typeof l?.text === 'string' ? l.text.trim() : '';
+    if (!text) {
+      add(`реплика ${i + 1} пустая`);
+      return;
+    }
+    if (!inCast.has(String(l?.hero))) add(`реплика ${i + 1}: говорит «${l?.hero}», а его нет в составе`);
+    const n = wordCount(text);
+    total += n;
+    if (n > MAX_SKIT_LINE_WORDS) add(`правило 17: реплика ${i + 1} — ${n} слов, больше ${MAX_SKIT_LINE_WORDS}`);
+  });
+  if (total > MAX_SKIT_WORDS) add(`правило 17: в репликах ${total} слов, больше ${MAX_SKIT_WORDS}`);
+  // Правило 18: советов по существу герои не дают; утверждение по существу —
+  // только в развязке и со ссылкой на абзац настоящего ответа.
+  const boxed = lines.filter((l) => l?.box !== undefined && l?.box !== null);
+  if (kind === 'conflict') {
+    if (boxed.length) add('правило 18: в конфликте герои не дают советов по существу — у реплик сценки 1 не бывает box');
+  } else {
+    if (!boxed.length) add('правило 18: утверждение по существу в развязке ссылается на абзац ответа — укажи box у этой реплики');
+    if (paragraphs) {
+      const known = new Set(paragraphs.map((p) => p.n));
+      for (const l of boxed) if (!known.has(Number(l.box))) add(`правило 18: box ${l.box} — такого абзаца в ответе нет`);
+    }
+  }
+  return out;
+}
 
 const chars = (s: string): number => Array.from(String(s ?? '')).length;
 
@@ -392,30 +485,36 @@
   const s = i.script;
   const known = new Set(i.paragraphs.map((p) => p.n));
   const scene = (name: string) => s.lines.filter((l) => l.scene === name);
+  // Ролик со сценками: зацепка — немая надпись поверх конфликта, ответ пересказывают 1–2 реплики.
+  const skitFormat = i.format === 'skit';
 
-  // Раскадровка: зацепка → вопрос → ответ → финал.
+  // Раскадровка: зацепка → вопрос → ответ → финал (у сценок зацепка не звучит).
   const hook = String(s.hook ?? '').trim();
   // Тире и прочие знаки — не слова.
   const hookWords = hook.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
+  const maxHookWords = skitFormat ? MAX_SKIT_HOOK_WORDS : MAX_HOOK_WORDS;
   if (!hook) add('нет зацепки');
-  else if (hookWords > MAX_HOOK_WORDS) add(`зацепка длиннее ${MAX_HOOK_WORDS} слов`);
-  const ORDER = ['hook', 'question', 'answer', 'final'];
+  else if (hookWords > maxHookWords) add(`зацепка длиннее ${maxHookWords} слов`);
+  const ORDER = skitFormat ? ['question', 'answer', 'final'] : ['hook', 'question', 'answer', 'final'];
   let at = 0;
   for (const l of s.lines) {
     const k = ORDER.indexOf(l.scene);
     if (k < at) {
-      add(`реплика ${l.id}: сцены идут не по порядку зацепка → вопрос → ответ → финал`);
+      add(`реплика ${l.id}: сцены идут не по порядку ${skitFormat ? 'вопрос → ответ → финал' : 'зацепка → вопрос → ответ → финал'}`);
       break;
     }
     at = k;
   }
   const hooks = scene('hook');
-  if (hooks.length !== 1) add('зацепка — ровно одна реплика');
+  if (skitFormat) {
+    if (hooks.length) add('у ролика со сценками зацепка — надпись поверх сценки: реплики hook быть не должно');
+  } else if (hooks.length !== 1) add('зацепка — ровно одна реплика');
   else if (hooks[0].text.trim() !== hook) add('текст реплики зацепки должен совпадать с зацепкой');
   if (!scene('question').length) add('нет реплики вопроса');
   const answers = scene('answer');
-  if (answers.length < MIN_ANSWER_LINES || answers.length > MAX_ANSWER_LINES) {
-    add(`реплик ответа ${answers.length} — нужно ${MIN_ANSWER_LINES}–${MAX_ANSWER_LINES}`);
+  const [minAnswers, maxAnswers] = skitFormat ? [MIN_SKIT_ANSWER_LINES, MAX_SKIT_ANSWER_LINES] : [MIN_ANSWER_LINES, MAX_ANSWER_LINES];
+  if (answers.length < minAnswers || answers.length > maxAnswers) {
+    add(`реплик ответа ${answers.length} — нужно ${minAnswers}–${maxAnswers}`);
   }
   for (const l of answers) {
     if (l.box === undefined || l.box === null || !known.has(l.box)) {
@@ -426,6 +525,9 @@
     if (l.scene !== 'answer' && l.box !== undefined && l.box !== null) add(`реплика ${l.id} сцены ${l.scene} не должна ссылаться на абзац`);
   }
   if (scene('final').length !== 1) add('финал — ровно одна реплика');
+  if (skitFormat) {
+    for (const kind of SKIT_KINDS) for (const m of checkSkitRules(i.skits?.[kind], kind, i.paragraphs)) add(m);
+  }
 
   // Подача.
   const provocative = PROVOCATIVE_ANGLES.includes(i.angle);
@@ -444,21 +546,33 @@
   }
   if (provocative && isHealthAssistant(i.assistantName)) add('правило 12: темы здоровья — только в спокойной подаче');
 
-  // Длина по оценке.
+  // Длина по оценке. У сценок озвучка — только голос ассистента и финал: клипы идут своим звуком.
   const est = estimateSpeechSec(s);
-  if (est < MIN_ESTIMATED_SEC) {
-    add(`сценарий звучит примерно ${Math.round(est)} с, нужно ${MIN_ESTIMATED_SEC}–${MAX_ESTIMATED_SEC} с: добавь реплику или перескажи абзац подробнее`);
+  const [minSec, maxSec] = skitFormat ? [MIN_SKIT_ESTIMATED_SEC, MAX_SKIT_ESTIMATED_SEC] : [MIN_ESTIMATED_SEC, MAX_ESTIMATED_SEC];
+  if (est < minSec) {
+    add(`сценарий звучит примерно ${Math.round(est)} с, нужно ${minSec}–${maxSec} с: добавь реплику или перескажи абзац подробнее`);
   }
-  if (est > MAX_ESTIMATED_SEC) {
-    add(`сценарий звучит примерно ${Math.round(est)} с, нужно ${MIN_ESTIMATED_SEC}–${MAX_ESTIMATED_SEC} с: сократи реплики`);
+  if (est > maxSec) {
+    add(`сценарий звучит примерно ${Math.round(est)} с, нужно ${minSec}–${maxSec} с: сократи реплики`);
   }
 
-  // Тексты сценариста, у каждого — место. Финал пишет код, его здесь нет.
+  // Тексты сценариста, у каждого — место. Финал пишет код, его здесь нет. Реплики сценок — тоже тексты ролика.
   const spoken = s.lines.filter((l) => l.scene !== 'final');
-  if (spoken.some((l) => BRAND_SPOKEN.test(l.text))) add('название сервиса звучит только в финале — убери его из реплик');
+  const skitLines = skitFormat
+    ? SKIT_KINDS.flatMap((kind) =>
+        (Array.isArray(i.skits?.[kind]?.lines) ? i.skits[kind].lines : []).map((l, n) => ({
+          place: `${SKIT_LABELS[kind]}, реплика ${n + 1}`,
+          text: String(l?.text ?? ''),
+        })),
+      )
+    : [];
+  if ([...spoken.map((l) => l.text), ...skitLines.map((l) => l.text)].some((t) => BRAND_SPOKEN.test(t))) {
+    add('название сервиса звучит только в финале — убери его из реплик');
+  }
   const c = i.captions;
   const texts = [
     ...spoken.map((l) => ({ place: `реплика ${l.id}`, text: l.text })),
+    ...skitLines,
     { place: 'подпись telegram', text: c.telegram },
     { place: 'подпись vk', text: c.vk },
     { place: 'youtube.title', text: c.youtube.title },
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add src/shorts/short-skit-prompts.ts src/shorts/short-rules.ts
git -C "$WT" commit -m "feat(shorts): правила сценок 16–18, проверка сценария со сценками

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/short-skit-prompts.ts src/shorts/short-rules.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-rules.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: 269 passed, затем `TSC_OK`.

---

### Task 5: Сценарий ролика со сценками

**Files:**
- Modify: `src/shorts/short-script.ts`
- Test: `src/shorts/short-script.spec.ts`

`buildScript` с готовыми промптами сценок (`skits`, от `planSkits`) не кладёт реплику зацепки: у сценок зацепка — немая надпись поверх конфликта, её рисует студия из `hook`.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/short-script.spec.ts
+++ b/src/shorts/short-script.spec.ts
@@ -1,4 +1,5 @@
 import { CASE_BADGE, SPEECH_SPEED, buildScript } from './short-script';
+import { planSkits } from './short-skit-prompts';
 
 const reply = {
   hook: 'Снимаете квартиру? Как не потерять залог',
@@ -29,3 +30,24 @@
     expect(s.badge).toBe('Реальная история, разговор повторён на демо-аккаунте');
   });
 });
+
+describe('buildScript — ролик со сценками', () => {
+  const conflict = {
+    cast: [{ hero: 'galina' as const, role: 'хозяйка квартиры' }, { hero: 'kesha' as const, role: 'жилец' }],
+    setting: 'a rented flat hallway', opening: 'The goose blocks the door.', action: 'The goose hisses.',
+    lines: [{ hero: 'galina' as const, text: 'Залог мой!' }],
+  };
+  const punchline = { ...conflict, lines: [{ hero: 'kesha' as const, text: 'Это износ.', box: 11 }] };
+
+  it('без реплики зацепки: она надпись поверх сценки; сценки с промптами — в сценарии', () => {
+    const skits = planSkits({ conflict, punchline });
+    const s = buildScript(reply, { voice: 'madirus', narratorVoice: 'alena', assistantsCount: 18, skits });
+    expect(s.lines.map((l) => l.id)).toEqual(['q', 'a1', 'a2', 'f']);
+    expect(s.hook).toBe(reply.hook);
+    expect(s.skits).toBe(skits);
+  });
+
+  it('у chat поля skits нет вовсе', () => {
+    expect('skits' in buildScript(reply, { voice: 'madirus', narratorVoice: 'alena', assistantsCount: 18 })).toBe(false);
+  });
+});
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/short-script.spec.ts
git -C "$WT" commit -m "test(shorts): сценарий ролика со сценками (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/short-script.spec.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-script.spec.ts"
```

Expected: 1 failed, 4 passed.

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/short-script.ts
+++ b/src/shorts/short-script.ts
@@ -1,5 +1,6 @@
 import { finalLine } from './short-numbers';
 import { WriterReply } from './short-parse';
+import { SkitKind, SkitPlan } from './short-skit-prompts';
 import { ShortScript, ShortScriptLine } from './shorts.types';
 
 /** Темп принятого образца (владелец, 25.10.2026). */
@@ -16,12 +17,17 @@
   assistantsCount: number;
   disclaimer?: string;
   badge?: string;
+  /**
+   * Сценки с готовыми промптами (planSkits) — ролик формата skit. Зацепка у него —
+   * немая надпись поверх конфликта: реплики hook нет, студия рисует hook текстом.
+   */
+  skits?: Record<SkitKind, SkitPlan>;
 }
 
-/** Ответ сценариста → `Script` студии: id реплик h, q, a1…, f — как у образца. */
+/** Ответ сценариста → `Script` студии: id реплик h, q, a1…, f — как у образца; у сценок — без h. */
 export function buildScript(reply: Pick<WriterReply, 'hook' | 'hookBox' | 'question' | 'lines'>, o: ScriptOptions): ShortScript {
   const lines: ShortScriptLine[] = [
-    { id: 'h', scene: 'hook', text: reply.hook },
+    ...(o.skits ? [] : [{ id: 'h', scene: 'hook' as const, text: reply.hook }]),
     { id: 'q', scene: 'question', text: reply.question },
     ...reply.lines.map((l, i): ShortScriptLine => ({ id: `a${i + 1}`, scene: 'answer', box: l.box, text: l.text })),
     { id: 'f', scene: 'final', voice: o.narratorVoice, text: finalLine(o.assistantsCount) },
@@ -34,5 +40,6 @@
     speed: SPEECH_SPEED,
     lines,
     final: { assistantsCount: o.assistantsCount, ...(o.disclaimer ? { disclaimer: o.disclaimer } : {}) },
+    ...(o.skits ? { skits: o.skits } : {}),
   };
 }
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add src/shorts/short-script.ts
git -C "$WT" commit -m "feat(shorts): сценарий со сценками — без реплики зацепки, с промптами сценок

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/short-script.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-script.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: 5 passed, затем `TSC_OK`.

---

### Task 6: Разбор сценок и промпты режиссёра и сценариста

**Files:**
- Modify: `src/shorts/short-parse.ts`
- Modify: `src/shorts/short-prompts.ts`
- Test: `src/shorts/short-parse.spec.ts`
- Test: `src/shorts/short-prompts.spec.ts`

`parseSkit` — сценка полями; разбор отвергает только то, что не назвать нарушением (не объект, кривой box), остальное уходит правилам. Режиссёр формата skit отдаёт `skit`, сценарист — `punchline` и, по замечанию, `conflict`. Промпты сценок — отдельные `DIRECTOR_SKIT_SYSTEM` и `WRITER_SKIT_SYSTEM`: паспорта труппы, как устроена сценка, приёмы юмора, правила 16–20; прежние промпты формата chat не меняются ни на символ (части вынесены в константы). В сообщениях — прошлые сценки (режиссёру), конфликт и прошлая развязка (сценаристу), всё между метками данных.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/short-parse.spec.ts
+++ b/src/shorts/short-parse.spec.ts
@@ -1,4 +1,4 @@
-import { MAX_QUESTION_CHARS, MIN_QUESTION_CHARS, extractJsonObject, parseDirectorReply, parseWriterReply } from './short-parse';
+import { MAX_QUESTION_CHARS, MIN_QUESTION_CHARS, extractJsonObject, parseDirectorReply, parseSkit, parseWriterReply } from './short-parse';
 
 describe('extractJsonObject', () => {
   it('берёт объект из забора и из обвязки', () => {
@@ -39,9 +39,19 @@
   };
 
   it('нормальный ответ', () => {
-    expect(parseDirectorReply(JSON.stringify(ok), free)).toEqual(ok);
+    expect(parseDirectorReply(JSON.stringify(ok), free)).toEqual({ ...ok, skit: null });
   });
 
+  it('ролик со сценками — сценка 1 полями; без неё ответ не годится', () => {
+    const skit = {
+      cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
+      setting: 'a hallway', opening: 'The goose blocks the door.', action: 'The goose hisses.',
+      lines: [{ hero: 'galina', text: 'Залог мой!' }],
+    };
+    expect(parseDirectorReply(JSON.stringify({ ...ok, skit }), { ...free, skit: true }).skit).toEqual(skit);
+    expect(() => parseDirectorReply(JSON.stringify(ok), { ...free, skit: true })).toThrow(/режиссёр: skit — объект/);
+  });
+
   it('ассистент не из списка и не тот, что задан темой', () => {
     expect(() => parseDirectorReply(JSON.stringify({ ...ok, assistantId: 5 }), free)).toThrow(/ассистента 5 нет/);
     expect(() => parseDirectorReply(JSON.stringify(ok), { assistantIds: ids, fixedAssistantId: 22 })).toThrow(/задана для 22/);
@@ -119,8 +129,46 @@
     expect(() => parseWriterReply(JSON.stringify({ ...w, lines: [{ text: 'без номера' }] }))).toThrow(/box/);
   });
 
+  it('ролик со сценками: развязка обязательна, конфликт — только если переписан', () => {
+    const punchline = {
+      cast: [{ hero: 'kesha', role: 'жилец' }, { hero: 'galina', role: 'хозяйка квартиры' }],
+      setting: 'the same hallway', opening: 'The capybara holds up the phone.', action: 'The goose drops the keys.',
+      lines: [{ hero: 'kesha', text: 'Это износ.', box: '3' }, { hero: 'galina', text: 'Га-га… ладно.' }],
+    };
+    const r = parseWriterReply(JSON.stringify({ ...w, punchline }), { skit: true });
+    expect(r.skits.conflict).toBeNull();
+    expect(r.skits.punchline?.lines).toEqual([{ hero: 'kesha', text: 'Это износ.', box: 3 }, { hero: 'galina', text: 'Га-га… ладно.' }]);
+    const conflict = { ...punchline, lines: [{ hero: 'galina', text: 'Залог мой!' }] };
+    expect(parseWriterReply(JSON.stringify({ ...w, punchline, conflict }), { skit: true }).skits.conflict?.lines).toEqual([{ hero: 'galina', text: 'Залог мой!' }]);
+    expect(() => parseWriterReply(JSON.stringify(w), { skit: true })).toThrow(/сценарист: punchline — объект/);
+    // Без формата skit сценки не разбираются вовсе.
+    expect(parseWriterReply(JSON.stringify({ ...w, punchline })).skits).toEqual({ conflict: null, punchline: null });
+  });
+
   it('нет зацепки или заголовка YouTube — ошибка', () => {
     expect(() => parseWriterReply(JSON.stringify({ ...w, hook: '' }))).toThrow(/зацепк/);
     expect(() => parseWriterReply(JSON.stringify({ ...w, captions: { ...w.captions, youtube: { ...w.captions.youtube, title: '' } } }))).toThrow(/YouTube/);
   });
 });
+
+describe('parseSkit', () => {
+  it('поля — строками без пробелов по краям; пустой box — нет box; кривой box — ошибка с местом', () => {
+    const s = parseSkit({
+      cast: [{ hero: ' kesha ', role: ' жилец ' }],
+      setting: ' a hallway ', opening: 'o', action: 'a',
+      lines: [{ hero: 'kesha', text: ' Спокойно. ', box: '' }, { hero: 'kesha', text: 'Да', box: null }],
+    }, 'режиссёр', 'skit');
+    expect(s).toEqual({
+      cast: [{ hero: 'kesha', role: 'жилец' }],
+      setting: 'a hallway', opening: 'o', action: 'a',
+      lines: [{ hero: 'kesha', text: 'Спокойно.' }, { hero: 'kesha', text: 'Да' }],
+    });
+    expect(() => parseSkit({ lines: [{ hero: 'kesha', text: 'x', box: 'три' }] }, 'сценарист', 'punchline'))
+      .toThrow('сценарист: punchline, реплика 1 — box должен быть номером абзаца');
+    expect(() => parseSkit([], 'режиссёр', 'skit')).toThrow(/объект/);
+  });
+
+  it('нехватку полей не прячет: пустые строки и массивы уходят на проверку правил', () => {
+    expect(parseSkit({}, 'режиссёр', 'skit')).toEqual({ cast: [], setting: '', opening: '', action: '', lines: [] });
+  });
+});
--- a/src/shorts/short-prompts.spec.ts
+++ b/src/shorts/short-prompts.spec.ts
@@ -1,7 +1,15 @@
 import { parseDirectorReply, parseWriterReply } from './short-parse';
-import { DIRECTOR_SYSTEM, WRITER_SYSTEM, buildDirectorMessage, buildWriterMessage, toAgents } from './short-prompts';
-import { MAX_ANSWER_LINES, MAX_ESTIMATED_SEC, MIN_ANSWER_LINES, MIN_ESTIMATED_SEC, estimateSpeechSec } from './short-rules';
+import {
+  DIRECTOR_SKIT_SYSTEM, DIRECTOR_SYSTEM, WRITER_SKIT_SYSTEM, WRITER_SYSTEM, buildDirectorMessage, buildWriterMessage, describeSkit,
+  recentSkitLine, toAgents, troupeBrief,
+} from './short-prompts';
+import {
+  MAX_ANSWER_LINES, MAX_ESTIMATED_SEC, MAX_SKIT_ANSWER_LINES, MAX_SKIT_ESTIMATED_SEC, MIN_ANSWER_LINES, MIN_ESTIMATED_SEC,
+  MIN_SKIT_ANSWER_LINES, MIN_SKIT_ESTIMATED_SEC, checkSkitRules, estimateSpeechSec,
+} from './short-rules';
 import { buildScript } from './short-script';
+import { Skit, planSkits } from './short-skit-prompts';
+import { TROUPE } from './short-troupe';
 import { PROVOCATIVE_ANGLES } from './shorts.types';
 
 describe('системные промпты', () => {
@@ -89,7 +97,7 @@
     expect(rest).toHaveLength(0);
     const q = 'Хозяин квартиры не возвращает залог — что делать?';
     expect(parseDirectorReply(fill(t, q, 10), { assistantIds: new Set([10]), fixedAssistantId: null }))
-      .toEqual({ assistantId: 10, question: q, followups: [q], title: q });
+      .toEqual({ assistantId: 10, question: q, followups: [q], title: q, skit: null });
   });
 
   it('оба шаблона сценариста разбираются parseWriterReply', () => {
@@ -244,3 +252,122 @@
     expect(m.split('ОТВЕТ АССИСТЕНТА>>>')).toHaveLength(2);
   });
 });
+
+// ── Сценки ──
+
+const conflict: Skit = {
+  cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
+  setting: 'a rented flat hallway', opening: 'The goose blocks the door.', action: 'The goose hisses and flaps.',
+  lines: [{ hero: 'galina', text: 'Обои потёрли! Залог мой!' }, { hero: 'kesha', text: 'Спокойно. Спрошу у юриста.' }],
+};
+
+describe('промпты сценок', () => {
+  it('режиссёр и сценарист знают труппу: id, роли и коронные фразы каждого героя', () => {
+    for (const system of [DIRECTOR_SKIT_SYSTEM, WRITER_SKIT_SYSTEM]) {
+      for (const h of TROUPE) {
+        expect(system).toContain(`- ${h.id} — ${h.name}`);
+        for (const role of h.roles) expect(system).toContain(role);
+        for (const c of h.catchphrases) expect(system).toContain(`«${c}»`);
+      }
+    }
+    expect(troupeBrief().split('\n')).toHaveLength(TROUPE.length + 1);
+  });
+
+  it('оба знают правила сценок 16–20, приёмы юмора и английские поля без кавычек', () => {
+    for (const system of [DIRECTOR_SKIT_SYSTEM, WRITER_SKIT_SYSTEM]) {
+      for (let n = 16; n <= 20; n++) expect(system).toContain(`\n${n}. `);
+      for (const s of ['контраст', 'эскалация', 'визуальный гэг', 'коронная фраза', 'по-английски и без кавычек', 'экраном от зрителя']) {
+        expect(system).toContain(s);
+      }
+    }
+  });
+
+  it('сценарист сценок: надпись до 6 слов, 1–2 реплики, развязка с box, конфликт — только по замечанию, правила 1–15', () => {
+    for (const s of ['до 6 слов', '1–2 реплики', 'с его номером в box', 'conflict — только если замечания', 'и для реплик героев']) {
+      expect(WRITER_SKIT_SYSTEM).toContain(s);
+    }
+    for (let n = 1; n <= 15; n++) expect(WRITER_SKIT_SYSTEM).toContain(`\n${n}. `);
+  });
+
+  it('шаблон режиссёра сценок разбирается parseDirectorReply со сценкой', () => {
+    const t = DIRECTOR_SKIT_SYSTEM.split('\n').filter((l) => l.startsWith('{'));
+    expect(t).toHaveLength(1);
+    const q = 'Хозяин квартиры не возвращает залог — что делать?';
+    const filled = t[0].replace(/"(?:<[^>"]*>|\.\.\.)"/g, JSON.stringify(q)).replace(/<[^>]*>/g, '10');
+    const r = parseDirectorReply(filled, { assistantIds: new Set([10]), fixedAssistantId: null, skit: true });
+    expect(r.skit).toMatchObject({ setting: q, opening: q, action: q, cast: [{ hero: q, role: q }], lines: [{ hero: q, text: q }] });
+  });
+
+  it('шаблоны сценариста сценок разбираются parseWriterReply со сценкой', () => {
+    const all = WRITER_SKIT_SYSTEM.split('\n').filter((l) => l.startsWith('{'));
+    expect(all).toHaveLength(2);
+    const script = all.find((t) => !t.includes('needsRecapture'));
+    const text = 'Залог?';
+    const filled = script.replace(/"(?:<[^>"]*>|\.\.\.)"/g, JSON.stringify(text)).replace(/<[^>]*>/g, '3');
+    const r = parseWriterReply(filled, { skit: true });
+    expect(r.skits.punchline?.lines).toEqual([{ hero: text, text, box: 3 }]);
+    expect(r.skits.conflict).toBeNull();
+  });
+
+  it('коридор знаков сценариста сценок сходится с оценкой длины (финал добавляет код)', () => {
+    const m = WRITER_SKIT_SYSTEM.match(/вопрос и реплики ответа вместе — (\d+)–(\d+) знаков/);
+    expect(m).not.toBeNull();
+    const [lo, hi] = [Number(m[1]), Number(m[2])];
+    const skits = planSkits({ conflict, punchline: { ...conflict, lines: [{ hero: 'kesha', text: 'Износ.', box: 1 }] } });
+    // Вопрос — 60 знаков, остальное — поровну на ответ.
+    const est = (total: number, answers: number): number => {
+      const each = Math.floor((total - 60) / answers);
+      const lines = Array.from({ length: answers }, (_, k) => ({ box: k + 1, text: 'х'.repeat(k === 0 ? total - 60 - each * (answers - 1) : each) }));
+      return estimateSpeechSec(buildScript(
+        { hook: 'х'.repeat(30), hookBox: 1, question: 'х'.repeat(60), lines },
+        { voice: 'madirus', narratorVoice: 'alena', assistantsCount: 18, skits },
+      ));
+    };
+    for (let answers = MIN_SKIT_ANSWER_LINES; answers <= MAX_SKIT_ANSWER_LINES; answers++) {
+      expect(est(lo, answers)).toBeGreaterThanOrEqual(MIN_SKIT_ESTIMATED_SEC);
+      expect(est(hi, answers)).toBeLessThanOrEqual(MAX_SKIT_ESTIMATED_SEC);
+    }
+  });
+
+  it('сценка в сообщении — теми же полями, с номером абзаца у реплики развязки', () => {
+    expect(describeSkit({ ...conflict, lines: [{ hero: 'kesha', text: 'Это\nизнос.', box: 3 }] })).toBe([
+      'cast: galina — хозяйка квартиры, kesha — жилец',
+      'setting: a rented flat hallway',
+      'opening: The goose blocks the door.',
+      'action: The goose hisses and flaps.',
+      'реплика 1, kesha [3]: Это износ.',
+    ].join('\n'));
+    expect(recentSkitLine({ ...conflict, action: 'х'.repeat(300) })).toHaveLength(200);
+  });
+
+  it('сообщение режиссёру сценок: прошлые сценки, отвергнутая сценка и нарушения — данными', () => {
+    const m = buildDirectorMessage({
+      rubric: 'assistant', angle: 'calm', topicHint: null, fixedAssistant: null, assistants: [], recentQuestions: [],
+      ownerNote: null, previousQuestion: null,
+      skit: { recent: ['a kitchen — the cat stamps a paper'], previous: conflict, violations: ['сценка 1 (конфликт): правило 17: реплика 1 — 13 слов, больше 12'] },
+    });
+    expect(m).toContain('<<<СЦЕНКИ\n- a kitchen — the cat stamps a paper\nСЦЕНКИ>>>');
+    expect(m).toContain('<<<СЦЕНКА 1\ncast: galina — хозяйка квартиры');
+    expect(m).toContain('Сценка нарушила правила — исправь:\n- сценка 1 (конфликт): правило 17');
+    const plain = buildDirectorMessage({
+      rubric: 'assistant', angle: 'calm', topicHint: null, fixedAssistant: null, assistants: [], recentQuestions: [], ownerNote: null, previousQuestion: null,
+    });
+    expect(plain).not.toContain('СЦЕНК');
+  });
+
+  it('сообщение сценаристу сценок: конфликт, который открывает ролик, и прошлая развязка — данными', () => {
+    const m = buildWriterMessage({
+      rubric: 'assistant', angle: 'uncomfortable', assistantName: 'Алексей', assistantDescription: 'юрист',
+      question: 'Вопрос', paragraphs: [{ n: 1, text: 'Абзац' }], ownerNote: null, writerFeedback: null,
+      previousScript: null, violations: [],
+      skit: { conflict, previousPunchline: { ...conflict, lines: [{ hero: 'kesha', text: 'Износ.', box: 1 }] } },
+    });
+    expect(m).toContain('Сценка 1 (конфликт) — открывает ролик:\n<<<СЦЕНКА 1\n');
+    expect(m).toContain('Прошлый вариант сценки 2:\n<<<СЦЕНКА 2\n');
+    expect(m).toContain('реплика 1, kesha [1]: Износ.');
+  });
+
+  it('пример конфликта из теста сам проходит правила сценок', () => {
+    expect(checkSkitRules(conflict, 'conflict', null)).toEqual([]);
+  });
+});
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/short-parse.spec.ts src/shorts/short-prompts.spec.ts
git -C "$WT" commit -m "test(shorts): разбор сценок и промпты режиссёра и сценариста (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/short-parse.spec.ts src/shorts/short-prompts.spec.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-parse.spec.ts src/shorts/short-prompts.spec.ts"
```

Expected: 15 failed, 38 passed.

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/short-parse.ts
+++ b/src/shorts/short-parse.ts
@@ -3,6 +3,8 @@
  * и в личку владельцу, поэтому несут начало ответа: без него неясно, что
  * модель прислала вместо JSON — переспросила, извинилась или оборвалась.
  */
+import { Skit, SkitLine } from './short-skit-prompts';
+import { TroupeId } from './short-troupe';
 
 /** Сколько символов сырого ответа кладём в ошибку — как RAW_SNIPPET_CHARS блога. */
 export const RAW_SNIPPET_CHARS = 300;
@@ -77,16 +79,44 @@
   return parsed;
 }
 
+/**
+ * Сценка из ответа модели — полями (спека сценок, «Кто пишет сценки»). Разбор
+ * отвергает только то, что не назвать нарушением: не объект, кривой номер
+ * абзаца. Правила 16–18 и английские поля проверяет checkSkitRules — их
+ * нарушения уходят модели на переписку, а не в повтор этапа.
+ */
+export function parseSkit(v: unknown, who: string, field: string): Skit {
+  if (!v || typeof v !== 'object' || Array.isArray(v)) {
+    throw new Error(`${who}: ${field} — объект {cast, setting, opening, action, lines}`);
+  }
+  const o = v as Record<string, any>;
+  const cast = Array.isArray(o.cast) ? o.cast.map((c: any) => ({ hero: str(c?.hero) as TroupeId, role: str(c?.role) })) : [];
+  const lines = Array.isArray(o.lines)
+    ? o.lines.map((l: any, i: number): SkitLine => {
+        const line: SkitLine = { hero: str(l?.hero) as TroupeId, text: str(l?.text) };
+        if (l?.box !== null && l?.box !== undefined && l?.box !== '') {
+          const box = Number(l.box);
+          if (!Number.isInteger(box)) throw new Error(`${who}: ${field}, реплика ${i + 1} — box должен быть номером абзаца`);
+          line.box = box;
+        }
+        return line;
+      })
+    : [];
+  return { cast, setting: str(o.setting), opening: str(o.opening), action: str(o.action), lines };
+}
+
 export interface DirectorReply {
   assistantId: number;
   question: string;
   followups: string[];
   title: string;
+  /** Сценка 1 (конфликт) — у ролика формата skit. */
+  skit: Skit | null;
 }
 
 export function parseDirectorReply(
   raw: string,
-  ctx: { assistantIds: ReadonlySet<number>; fixedAssistantId: number | null },
+  ctx: { assistantIds: ReadonlySet<number>; fixedAssistantId: number | null; skit?: boolean },
 ): DirectorReply {
   const o = extractJsonObject(raw, 'режиссёр');
   const assistantId = Number(o.assistantId);
@@ -111,7 +141,8 @@
   }
   const title = str(o.title);
   if (len(title) < 3) throw new Error('режиссёр: нет рабочего названия ролика');
-  return { assistantId, question, followups, title: Array.from(title).slice(0, MAX_TITLE_CHARS).join('') };
+  const skit = ctx.skit ? parseSkit(o.skit, 'режиссёр', 'skit') : null;
+  return { assistantId, question, followups, title: Array.from(title).slice(0, MAX_TITLE_CHARS).join(''), skit };
 }
 
 export interface WriterReply {
@@ -122,16 +153,23 @@
   question: string;
   lines: Array<{ box: number; text: string }>;
   captions: { telegram: string; vk: string; youtube: { title: string; description: string; tags: string[] } };
+  /**
+   * Сценки ролика формата skit: развязка обязательна, конфликт — только если
+   * сценарист его переписал по замечанию (иначе null: остаётся прежний).
+   */
+  skits: { conflict: Skit | null; punchline: Skit | null };
 }
 
+const NO_SKITS: WriterReply['skits'] = { conflict: null, punchline: null };
+
 const EMPTY_CAPTIONS: WriterReply['captions'] = { telegram: '', vk: '', youtube: { title: '', description: '', tags: [] } };
 
-export function parseWriterReply(raw: string): WriterReply {
+export function parseWriterReply(raw: string, opts: { skit?: boolean } = {}): WriterReply {
   const o = extractJsonObject(raw, 'сценарист');
   if (o.needsRecapture === true) {
     const reason = str(o.reason);
     if (!reason) throw new Error('сценарист: просит переснять, но не объяснил почему');
-    return { needsRecapture: true, reason, hook: '', hookBox: null, question: '', lines: [], captions: EMPTY_CAPTIONS };
+    return { needsRecapture: true, reason, hook: '', hookBox: null, question: '', lines: [], captions: EMPTY_CAPTIONS, skits: NO_SKITS };
   }
   const hook = str(o.hook);
   if (!hook) throw new Error('сценарист: нет зацепки');
@@ -157,5 +195,11 @@
   };
   if (!captions.telegram) throw new Error('сценарист: нет подписи для Telegram');
   if (!captions.youtube.title) throw new Error('сценарист: нет заголовка для YouTube');
-  return { needsRecapture: false, reason: '', hook, hookBox, question, lines, captions };
+  const skits = opts.skit
+    ? {
+        conflict: o.conflict === null || o.conflict === undefined ? null : parseSkit(o.conflict, 'сценарист', 'conflict'),
+        punchline: parseSkit(o.punchline, 'сценарист', 'punchline'),
+      }
+    : NO_SKITS;
+  return { needsRecapture: false, reason: '', hook, hookBox, question, lines, captions, skits };
 }
--- a/src/shorts/short-prompts.ts
+++ b/src/shorts/short-prompts.ts
@@ -1,5 +1,7 @@
 import { isHealthAssistant } from './short-assistants';
-import { WriterCaptions } from './short-rules';
+import { MAX_SKIT_HOOK_WORDS, WriterCaptions } from './short-rules';
+import { Skit } from './short-skit-prompts';
+import { TROUPE } from './short-troupe';
 import { ANGLE_TITLES, PROVOCATIVE_ANGLES, RUBRIC_TITLES, ShortAngle, ShortParagraph, ShortRubric, ShortScript } from './shorts.types';
 
 /** Ассистент так, как его видят режиссёр и сценарист. */
@@ -30,12 +32,10 @@
 /** Переводы строк — в пробел: «\n[3]» внутри абзаца подделал бы нумерацию, многострочный вопрос — пункт списка. */
 const oneLine = (text: string): string => String(text ?? '').replace(/\s+/g, ' ').trim();
 
-export const DIRECTOR_SYSTEM = [
-  'Ты — режиссёр коротких вертикальных роликов Linkeon (30–60 секунд) для VK, YouTube Shorts и Telegram.',
-  'Linkeon — сервис с ИИ-ассистентами: юрист, бухгалтер, коуч, дизайнер и другие. Ролик показывает настоящий ответ ассистента, снятый на демо-аккаунте.',
-  'Твоя задача — сцена: какому ассистенту и какой жизненный вопрос задать, чтобы ответ был полезным и цеплял.',
-  DATA_NOT_INSTRUCTIONS,
-  '',
+const LINKEON = 'Linkeon — сервис с ИИ-ассистентами: юрист, бухгалтер, коуч, дизайнер и другие. Ролик показывает настоящий ответ ассистента, снятый на демо-аккаунте.';
+
+/** Подачи, правила вопроса и уточнения — общие для обоих форматов. */
+const DIRECTOR_SCENE = [
   'Подача ролика задана в сообщении:',
   '- uncomfortable — неудобный вопрос: деньги, конфликты, ошибки, «а так можно?» — то, о чём спорят или стыдно спросить;',
   '- roast — разнос: ассистент жёстко разбирает плохой материал. Материал сочиняешь ты сам — короткий демонстрационный кусок (пара пунктов договора, продающий текст, план) — и вставляешь его в вопрос текстом;',
@@ -53,11 +53,92 @@
   '8. Не повторяй вопросы из списка «Уже было».',
   '',
   'Ассистент может переспросить (город, сроки, суммы). Заготовь 1–2 коротких уточнения — студия ответит ими на встречный вопрос.',
+];
+
+export const DIRECTOR_SYSTEM = [
+  'Ты — режиссёр коротких вертикальных роликов Linkeon (30–60 секунд) для VK, YouTube Shorts и Telegram.',
+  LINKEON,
+  'Твоя задача — сцена: какому ассистенту и какой жизненный вопрос задать, чтобы ответ был полезным и цеплял.',
+  DATA_NOT_INSTRUCTIONS,
   '',
+  ...DIRECTOR_SCENE,
+  '',
   'Ответь ТОЛЬКО JSON, без пояснений:',
   '{"assistantId": <id из списка>, "question": "<вопрос>", "followups": ["<уточнение>"], "title": "<рабочее название ролика, до 60 знаков>"}',
 ].join('\n');
 
+// ── Сценки (спека docs/superpowers/specs/2026-10-26-shorts-skits-design.md, «Кто пишет сценки») ──
+
+/** Паспорта героев так, как их читают режиссёр и сценарист: id, имя, манера, роли, коронное. */
+export function troupeBrief(): string {
+  return [
+    'Труппа — в сценках играют только эти герои (id — имя: манера; роли; коронное):',
+    ...TROUPE.map((h) => `- ${h.id} — ${h.name}: ${h.manner} Роли: ${h.roles.join(', ')}. Коронное: ${h.catchphrases.map((c) => `«${c}»`).join(' ')}`),
+  ].join('\n');
+}
+
+/** Как устроена сценка, приёмы юмора и правила 16–20 — одинаково для режиссёра и сценариста. */
+const SKIT_BRIEF = [
+  troupeBrief(),
+  '',
+  'Сценка — 8 секунд живого пластилинового видео:',
+  '- cast — 2–3 разных героя труппы, у каждого роль из его ролей;',
+  '- setting — место одной фразой; opening — первый кадр: где стоят герои и что держат, до начала действия; action — что происходит за 8 секунд и один визуальный гэг. Все три — по-английски и без кавычек: они идут прямо в генератор видео, а он рисует русский текст и текст в кавычках надписью;',
+  '- lines — 1–3 реплики по-русски: hero — кто говорит (из состава), text — реплика.',
+  'В кадре нет текста, экранов, логотипов, людей и детей: телефон Кеши повёрнут экраном от зрителя.',
+  '',
+  'Юмор:',
+  '- контраст: Кеша невозмутим, противник паникует, шипит, важничает;',
+  '- эскалация: противник накручивает требования, Кеша не спорит;',
+  '- один визуальный гэг на сценку — в action (перья дыбом, печать, падающие ключи);',
+  '- коронная фраза героя — в развязке.',
+  '',
+  'Правила сценок:',
+  '16. В сценках играют только герои труппы, у каждого роль из его ролей.',
+  '17. Реплика — до 12 слов; в сценке до 3 реплик и до 25 слов: длиннее не уложится в 8 секунд.',
+  '18. Герои не дают советов по существу: утверждение по существу — только в развязке, со ссылкой на абзац ответа (box).',
+  '19. Смеёмся над ситуацией и героями-зверями, а не над группами людей: возраст, пол, национальность, внешность, профессия.',
+  '20. Без насилия, даже мультяшного: гусыня шипит, но не щиплет. В темах здоровья и психологии — мягкий юмор, над ситуацией, а не над бедой.',
+];
+
+/** JSON сценки в шаблонах ответа. */
+const SKIT_JSON = (box: boolean) =>
+  `{"cast": [{"hero": "<id героя>", "role": "<роль из его ролей>"}], "setting": "<место по-английски>", "opening": "<первый кадр по-английски>", "action": "<действие за 8 секунд по-английски>", "lines": [{"hero": "<id героя>", "text": "<реплика по-русски>"${box ? ', "box": <номер абзаца или null>' : ''}}]}`;
+
+export const DIRECTOR_SKIT_SYSTEM = [
+  'Ты — режиссёр коротких вертикальных роликов Linkeon со сценками (25–45 секунд) для VK, YouTube Shorts и Telegram.',
+  LINKEON,
+  'Ролик со сценками: пластилиновые герои разыгрывают житейскую проблему, потом настоящий ассистент её решает, потом вторая сценка — развязка с шуткой.',
+  'Твоя задача — сцена (какому ассистенту и какой жизненный вопрос задать, чтобы ответ был полезным и цеплял) и сценка 1 — конфликт. Развязку напишет сценарист, когда будет ответ.',
+  DATA_NOT_INSTRUCTIONS,
+  '',
+  ...DIRECTOR_SCENE,
+  '',
+  ...SKIT_BRIEF,
+  '',
+  'Сценка 1 — конфликт: герои разыгрывают проблему из вопроса. Кеша — тот, кто спрашивает; противник — тот, с кем спор. В конце Кеша достаёт телефон и говорит, что спросит ассистента («Спрошу у юриста»). Советов по существу в конфликте нет: ответ даст настоящий ассистент.',
+  'Не повторяй места и шутки из «Сценки последних роликов».',
+  '',
+  'Ответь ТОЛЬКО JSON, без пояснений:',
+  `{"assistantId": <id из списка>, "question": "<вопрос>", "followups": ["<уточнение>"], "title": "<рабочее название ролика, до 60 знаков>", "skit": ${SKIT_JSON(false)}}`,
+].join('\n');
+
+/** Сценка в сообщении модели — теми же полями, что она пишет сама. */
+export function describeSkit(s: Skit): string {
+  return [
+    `cast: ${s.cast.map((c) => `${c.hero} — ${c.role}`).join(', ')}`,
+    `setting: ${oneLine(s.setting)}`,
+    `opening: ${oneLine(s.opening)}`,
+    `action: ${oneLine(s.action)}`,
+    ...s.lines.map((l, i) => `реплика ${i + 1}, ${l.hero}${l.box !== undefined && l.box !== null ? ` [${l.box}]` : ''}: ${oneLine(l.text)}`),
+  ].join('\n');
+}
+
+/** Сценка прошлого ролика одной строкой — режиссёру, чтобы не повторял места и шутки. */
+export function recentSkitLine(s: Skit): string {
+  return Array.from(oneLine(`${s.setting} — ${s.action}`)).slice(0, 200).join('');
+}
+
 export interface DirectorInput {
   rubric: ShortRubric;
   angle: ShortAngle;
@@ -67,6 +148,8 @@
   recentQuestions: string[];
   ownerNote: string | null;
   previousQuestion: string | null;
+  /** Ролик со сценками: сценки последних роликов (recentSkitLine) и отвергнутая сценка с нарушениями. */
+  skit?: { recent: string[]; previous: Skit | null; violations: string[] };
 }
 
 export function buildDirectorMessage(i: DirectorInput): string {
@@ -90,34 +173,36 @@
   if (i.recentQuestions.length) {
     parts.push(`Уже было (не повторяй):\n${fenced('УЖЕ БЫЛО', i.recentQuestions.map((q) => `- ${oneLine(q)}`).join('\n'))}`);
   }
+  if (i.skit?.recent.length) {
+    parts.push(`Сценки последних роликов (не повторяй места и шутки):\n${fenced('СЦЕНКИ', i.skit.recent.map((s) => `- ${oneLine(s)}`).join('\n'))}`);
+  }
+  if (i.skit?.previous) parts.push(`Прошлый вариант сценки 1:\n${fenced('СЦЕНКА 1', describeSkit(i.skit.previous))}`);
+  if (i.skit?.violations.length) parts.push(`Сценка нарушила правила — исправь:\n${i.skit.violations.map((v) => `- ${v}`).join('\n')}`);
   return parts.join('\n\n');
 }
 
-export const WRITER_SYSTEM = [
-  'Ты — сценарист коротких роликов Linkeon. Тебе дают настоящий ответ ИИ-ассистента, разбитый на абзацы с номерами, и подачу ролика. Напиши текст для озвучки и подписи площадок.',
-  DATA_NOT_INSTRUCTIONS,
-  '',
-  'Ролик идёт так: зацепка → вопрос в чате → ответ, где камера приближает абзацы, о которых говорит голос → финал.',
-  'Финальную реплику с названием сервиса добавит код. Сам её не пиши и название сервиса в своих репликах не называй.',
-  '',
+const WRITER_ANGLES = [
   'Подачи и примеры зацепок:',
   '- uncomfortable — неудобный вопрос: деньги, конфликты, ошибки, «а так можно?». «Хозяин может оставить залог себе — и будет прав».',
   '- roast — разнос: ассистент жёстко разбирает плохой материал из вопроса. «Юрист разнёс этот договор за минуту».',
   '- myth — ИИ против мифа: «правда ли, что…» с неожиданным ответом. «Вас уволят, если откажетесь от переработки?»',
   '- calm — спокойная демонстрация. «Сайт для кофейни — одной фразой».',
   'Зацепка цепляет смело, но только тем, что есть в ответе.',
-  '',
-  'Что написать:',
-  '- hook — зацепка до 8 слов под подачу. Может спрашивать («Боитесь подписать договор не глядя?»), но не утверждает за зрителя, что он чувствует.',
+];
+
+const WRITER_HOOK_BOX = [
   '- hookBox — номер абзаца, на котором держится смелая фраза зацепки. Для подач uncomfortable, roast и myth обязателен: зацепка без опоры на ответ — нарушение. Для calm можно null.',
   '  Смелая фраза — суть абзаца hookBox без усиления: «может» не превращай во «всегда», «часто» — во «все», последствий сверх абзаца не добавляй. «Вы потеряете квартиру!» — нельзя, если абзац этого не говорит.',
   '  Если ответ не даёт опоры смелой фразе (например, миф оказался правдой), зацепка — вопрос по теме абзаца, а не натяжка.',
-  '- question — реплика ассистента от первого лица о том, что у него спросили: «Я <имя>, <кто он>. Меня спросили…». Одно-два предложения, до ~100 знаков; материал для разноса не пересказывай — он виден в кадре.',
-  '- lines — 2–3 реплики, не больше 4. Каждая пересказывает ОДИН абзац ответа близко к тексту и указывает его номер в box. Ничего сверх абзаца не добавляй. В каждой — хотя бы одно полное предложение, от ~25 знаков: реплику короче полутора секунд студия не возьмёт.',
-  '- captions — подписи: telegram и vk (до 600 знаков, без ссылок — ссылку добавит код), youtube: title (до 90 знаков), description (до 600 знаков, без ссылок), tags (5–10 слов).',
-  '',
-  'Длина: твои реплики (зацепка, вопрос, ответ) вместе — 380–700 знаков; финал (~70 знаков) добавит код. С ним это 32–55 секунд озвучки, около 14 знаков в секунду.',
-  '',
+];
+
+const WRITER_QUESTION =
+  '- question — реплика ассистента от первого лица о том, что у него спросили: «Я <имя>, <кто он>. Меня спросили…». Одно-два предложения, до ~100 знаков; материал для разноса не пересказывай — он виден в кадре.';
+
+const WRITER_CAPTIONS =
+  '- captions — подписи: telegram и vk (до 600 знаков, без ссылок — ссылку добавит код), youtube: title (до 90 знаков), description (до 600 знаков, без ссылок), tags (5–10 слов).';
+
+const TEXT_RULES_PROMPT = [
   'Правила текста:',
   '1. Никаких выдуманных цифр, отзывов и числа пользователей: цифры — только из ответа ассистента или из вопроса.',
   '2. Никаких сравнений с конкурентами и их названий.',
@@ -135,14 +220,72 @@
   '14. Без брани, оскорблений и насмешек над теми, кто не пользуется сервисом.',
   '15. Не подталкивать к нарушению закона: «как не платить налог» — нельзя, «что будет, если не платить» — можно.',
   'Названия компаний, брендов, сервисов и моделей ИИ, политику и религию из ответа и вопроса не переноси — заменяй общим словом («сайт объявлений», «банк», «нейросеть»): проверка не прощает их даже в пересказе.',
-  '',
+];
+
+const WRITER_RECAPTURE = [
   'needsRecapture — только если нынешние вопрос и ответ не позволяют выполнить замечание. Замечание, которое эта сцена уже учла (в том числе твоя прошлая просьба «Сценарист: …»), — не повод. Тогда верни:',
   '{"needsRecapture": true, "reason": "<почему нужна новая сцена>"}',
+];
+
+const CAPTIONS_JSON = '"captions": {"telegram": "...", "vk": "...", "youtube": {"title": "...", "description": "...", "tags": ["..."]}}';
+
+export const WRITER_SYSTEM = [
+  'Ты — сценарист коротких роликов Linkeon. Тебе дают настоящий ответ ИИ-ассистента, разбитый на абзацы с номерами, и подачу ролика. Напиши текст для озвучки и подписи площадок.',
+  DATA_NOT_INSTRUCTIONS,
   '',
+  'Ролик идёт так: зацепка → вопрос в чате → ответ, где камера приближает абзацы, о которых говорит голос → финал.',
+  'Финальную реплику с названием сервиса добавит код. Сам её не пиши и название сервиса в своих репликах не называй.',
+  '',
+  ...WRITER_ANGLES,
+  '',
+  'Что написать:',
+  '- hook — зацепка до 8 слов под подачу. Может спрашивать («Боитесь подписать договор не глядя?»), но не утверждает за зрителя, что он чувствует.',
+  ...WRITER_HOOK_BOX,
+  WRITER_QUESTION,
+  '- lines — 2–3 реплики, не больше 4. Каждая пересказывает ОДИН абзац ответа близко к тексту и указывает его номер в box. Ничего сверх абзаца не добавляй. В каждой — хотя бы одно полное предложение, от ~25 знаков: реплику короче полутора секунд студия не возьмёт.',
+  WRITER_CAPTIONS,
+  '',
+  'Длина: твои реплики (зацепка, вопрос, ответ) вместе — 380–700 знаков; финал (~70 знаков) добавит код. С ним это 32–55 секунд озвучки, около 14 знаков в секунду.',
+  '',
+  ...TEXT_RULES_PROMPT,
+  '',
+  ...WRITER_RECAPTURE,
+  '',
   'Иначе ответь ТОЛЬКО JSON, без пояснений:',
-  '{"hook": "...", "hookBox": <номер или null>, "question": "...", "lines": [{"box": <номер>, "text": "..."}], "captions": {"telegram": "...", "vk": "...", "youtube": {"title": "...", "description": "...", "tags": ["..."]}}}',
+  `{"hook": "...", "hookBox": <номер или null>, "question": "...", "lines": [{"box": <номер>, "text": "..."}], ${CAPTIONS_JSON}}`,
 ].join('\n');
 
+export const WRITER_SKIT_SYSTEM = [
+  'Ты — сценарист коротких роликов Linkeon со сценками. Тебе дают настоящий ответ ИИ-ассистента, разбитый на абзацы с номерами, подачу ролика и сценку 1 — конфликт, который открывает ролик. Напиши надпись-зацепку, текст для озвучки, сценку 2 — развязку — и подписи площадок.',
+  DATA_NOT_INSTRUCTIONS,
+  '',
+  'Ролик идёт так: сценка 1 (конфликт, поверх — надпись-зацепка) → вопрос в чате → ответ, где камера приближает абзацы, о которых говорит голос → сценка 2 (развязка) → финал.',
+  'Финальную реплику с названием сервиса добавит код. Сам её не пиши; название сервиса не звучит ни в твоих репликах, ни в репликах героев.',
+  '',
+  ...WRITER_ANGLES,
+  '',
+  'Что написать:',
+  `- hook — надпись поверх сценки 1, до ${MAX_SKIT_HOOK_WORDS} слов: её читают, а не слушают. Может спрашивать, но не утверждает за зрителя, что он чувствует.`,
+  ...WRITER_HOOK_BOX,
+  WRITER_QUESTION,
+  '- lines — 1–2 реплики голосом ассистента. Каждая пересказывает ОДИН абзац ответа близко к тексту и указывает его номер в box. Ничего сверх абзаца не добавляй. В каждой — хотя бы одно полное предложение, от ~25 знаков.',
+  '- punchline — сценка 2, развязка: Кеша возвращается с ответом и побеждает спокойствием, противник сдаётся коронной фразой. Место и герои — как в сценке 1. Утверждение по существу — в одной реплике, близко к тексту абзаца, с его номером в box (правило 18); остальное — шутка.',
+  '- conflict — только если замечания требуют переписать сценку 1; иначе поле не пиши.',
+  WRITER_CAPTIONS,
+  '',
+  'Длина: вопрос и реплики ответа вместе — 100–280 знаков; со сценками по 8 секунд и финалом (~70 знаков, добавит код) это 25–45 секунд.',
+  '',
+  ...SKIT_BRIEF,
+  '',
+  ...TEXT_RULES_PROMPT,
+  'Правила текста — и для реплик героев.',
+  '',
+  ...WRITER_RECAPTURE,
+  '',
+  'Иначе ответь ТОЛЬКО JSON, без пояснений:',
+  `{"hook": "...", "hookBox": <номер или null>, "question": "...", "lines": [{"box": <номер>, "text": "..."}], "punchline": ${SKIT_JSON(true)}, ${CAPTIONS_JSON}}`,
+].join('\n');
+
 export interface WriterInput {
   rubric: ShortRubric;
   angle: ShortAngle;
@@ -156,6 +299,8 @@
   /** Подписи отвергнутого круга; у сценария из базы их нет — там они уже с хвостом ссылок. */
   previousCaptions?: WriterCaptions | null;
   violations: string[];
+  /** Ролик со сценками: конфликт, который открывает ролик, и прошлый вариант развязки. */
+  skit?: { conflict: Skit; previousPunchline: Skit | null };
 }
 
 /**
@@ -189,7 +334,9 @@
     `Спросили:\n${fenced('ВОПРОС', i.question)}`,
     `Ответ по абзацам:\n${fenced('ОТВЕТ АССИСТЕНТА', i.paragraphs.map((p) => `[${p.n}] ${oneLine(p.text)}`).join('\n'))}`,
   ];
+  if (i.skit) parts.push(`Сценка 1 (конфликт) — открывает ролик:\n${fenced('СЦЕНКА 1', describeSkit(i.skit.conflict))}`);
   if (i.previousScript) parts.push(previousVariant(i.previousScript, i.previousCaptions ?? null));
+  if (i.skit?.previousPunchline) parts.push(`Прошлый вариант сценки 2:\n${fenced('СЦЕНКА 2', describeSkit(i.skit.previousPunchline))}`);
   // Не «владельца»: здесь и прошлые замечания, и просьбы сценариста, которые новая сцена уже учла.
   if (i.ownerNote) parts.push(`Замечания (в том числе прошлые, уже учтённые сценой):\n${fenced('ЗАМЕЧАНИЯ', i.ownerNote)}`);
   if (i.writerFeedback) parts.push(`Студия: ${i.writerFeedback}`);
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add src/shorts/short-parse.ts src/shorts/short-prompts.ts
git -C "$WT" commit -m "feat(shorts): разбор сценок, промпты режиссёра и сценариста для роликов со сценками

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/short-parse.ts src/shorts/short-prompts.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-parse.spec.ts src/shorts/short-prompts.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: 53 passed, затем `TSC_OK`.

---

### Task 7: Режиссёр пишет сценку 1

**Files:**
- Modify: `src/shorts/shorts-director.service.ts`
- Test: `src/shorts/shorts-director.service.spec.ts`

У ролика формата skit режиссёр отдаёт сцену и сценку 1 одним ответом; сценка проверяется правилами 16–18 и при нарушениях переписывается до двух раз с перечнем (как сценарий у сценариста), потом — `StageFatalError`. Сценка ложится в `scene.skit`. Прошлые сценки (20 последних роликов) идут режиссёру, чтобы шутки не повторялись. `animation` при новой сцене не сбрасывается: секунды Omni — счёт денег ролика целиком.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/shorts-director.service.spec.ts
+++ b/src/shorts/shorts-director.service.spec.ts
@@ -1,6 +1,7 @@
 import { ShortsDirectorService } from './shorts-director.service';
 import { StageFatalError } from './short-jobs';
-import { DIRECTOR_SYSTEM } from './short-prompts';
+import { DIRECTOR_SKIT_SYSTEM, DIRECTOR_SYSTEM } from './short-prompts';
+import { MAX_SKIT_REWRITES } from './shorts-director.service';
 import { rowToShort } from './shorts.types';
 
 const AGENTS = [
@@ -122,3 +123,72 @@
     await expect(svc.direct(video({ angle: 'calm', assistant_id: null }))).resolves.toBeUndefined();
   });
 });
+
+describe('ShortsDirectorService.direct — ролик со сценками', () => {
+  const SKIT = {
+    cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
+    setting: 'a rented flat hallway, a tiny scuff on the wallpaper',
+    opening: 'The goose stands in the doorway, the capybara holds a suitcase.',
+    action: 'The goose points a wing at the scuff and hisses. The capybara takes out a phone.',
+    lines: [{ hero: 'galina', text: 'Обои потёрли! Залог мой!' }, { hero: 'kesha', text: 'Спокойно. Спрошу у юриста.' }],
+  };
+  const LONG = { ...SKIT, lines: [{ hero: 'galina', text: 'Раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать.' }] };
+
+  function skitSetup(replies: any[]) {
+    const queue = [...replies];
+    const pg = {
+      query: jest.fn(async (sql: string) => {
+        if (sql.includes("scene->>'question'")) return { rows: [{ q: 'Вопрос из прошлого ролика' }] };
+        if (sql.includes("scene->'skit'")) return { rows: [{ skit: { ...SKIT, setting: 'a kitchen', action: 'The cat stamps a paper.' } }, { skit: null }] };
+        return { rows: [], rowCount: 1 };
+      }),
+    };
+    const relay = { ask: jest.fn(async () => JSON.stringify(queue.shift())) };
+    const agents = { getAgents: jest.fn(async () => AGENTS) };
+    return { svc: new ShortsDirectorService(pg as any, relay as any, agents as any), pg, relay };
+  }
+
+  it('сцена и сценка 1 — из одного ответа; системный промпт сценок, прошлые сценки — режиссёру', async () => {
+    const { svc, pg, relay } = skitSetup([{ ...REPLY, skit: SKIT }]);
+    await svc.direct(video({ format: 'skit' }));
+    const [system, message] = relay.ask.mock.calls[0] as any[];
+    expect(system).toBe(DIRECTOR_SKIT_SYSTEM);
+    expect(message).toContain('<<<СЦЕНКИ\n- a kitchen — The cat stamps a paper.\nСЦЕНКИ>>>');
+    const update = pg.query.mock.calls.find(([sql]: [string]) => sql.includes("SET status = 'capture_queued'"));
+    expect(JSON.parse(update[1][1]).skit).toEqual(SKIT);
+    // Прошлые сценки — только у роликов, где они есть.
+    expect(pg.query.mock.calls.find(([sql]: [string]) => sql.includes("scene->'skit'"))[0]).toContain("scene ? 'skit'");
+  });
+
+  it('сценка нарушила правила — переписка с перечнем и прошлым вариантом; второй вариант записан', async () => {
+    const { svc, pg, relay } = skitSetup([{ ...REPLY, skit: LONG }, { ...REPLY, skit: SKIT }]);
+    await svc.direct(video({ format: 'skit' }));
+    expect(relay.ask).toHaveBeenCalledTimes(2);
+    const second = relay.ask.mock.calls[1][1] as string;
+    expect(second).toContain('Сценка нарушила правила — исправь:\n- сценка 1 (конфликт): правило 17: реплика 1 — 13 слов, больше 12');
+    expect(second).toContain('<<<СЦЕНКА 1\n');
+    const update = pg.query.mock.calls.find(([sql]: [string]) => sql.includes("SET status = 'capture_queued'"));
+    expect(JSON.parse(update[1][1]).skit).toEqual(SKIT);
+  });
+
+  it(`нарушения и после ${MAX_SKIT_REWRITES} переписок — StageFatalError, ролик не записан`, async () => {
+    const { svc, pg, relay } = skitSetup(Array.from({ length: MAX_SKIT_REWRITES + 1 }, () => ({ ...REPLY, skit: LONG })));
+    await expect(svc.direct(video({ format: 'skit' }))).rejects.toThrow(StageFatalError);
+    expect(relay.ask).toHaveBeenCalledTimes(MAX_SKIT_REWRITES + 1);
+    expect(pg.query.mock.calls.some(([sql]: [string]) => sql.includes("SET status = 'capture_queued'"))).toBe(false);
+  });
+
+  it('ответ без сценки у ролика со сценками — ошибка разбора (повтор этапа), а не сцена без сценки', async () => {
+    const { svc } = skitSetup([REPLY]);
+    await expect(svc.direct(video({ format: 'skit' }))).rejects.toThrow(/режиссёр: skit — объект/);
+  });
+
+  it('ролик «Только чат» — без сценки, без запроса прошлых сценок, прежний промпт', async () => {
+    const { svc, pg, relay } = skitSetup([REPLY]);
+    await svc.direct(video({ format: 'chat' }));
+    expect(relay.ask.mock.calls[0][0]).toBe(DIRECTOR_SYSTEM);
+    expect(pg.query.mock.calls.some(([sql]: [string]) => sql.includes("scene->'skit'"))).toBe(false);
+    const update = pg.query.mock.calls.find(([sql]: [string]) => sql.includes("SET status = 'capture_queued'"));
+    expect('skit' in JSON.parse(update[1][1])).toBe(false);
+  });
+});
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/shorts-director.service.spec.ts
git -C "$WT" commit -m "test(shorts): режиссёр пишет сценку 1 (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/shorts-director.service.spec.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts-director.service.spec.ts"
```

Expected: 4 failed, 10 passed.

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/shorts-director.service.ts
+++ b/src/shorts/shorts-director.service.ts
@@ -4,14 +4,20 @@
 import { BlogRelayClient } from '../blog/blog-relay.client';
 import { PgService } from '../common/services/pg.service';
 import { StageFatalError } from './short-jobs';
-import { parseDirectorReply } from './short-parse';
-import { DIRECTOR_SYSTEM, buildDirectorMessage, toAgents } from './short-prompts';
+import { DirectorReply, parseDirectorReply } from './short-parse';
+import { AgentLite, DIRECTOR_SKIT_SYSTEM, DIRECTOR_SYSTEM, buildDirectorMessage, recentSkitLine, toAgents } from './short-prompts';
+import { checkSkitRules } from './short-rules';
+import { Skit } from './short-skit-prompts';
 import { shortSlug } from './short-slug';
 import { isHealthAssistant } from './short-assistants';
 import { PROVOCATIVE_ANGLES, ShortScene, ShortVideo } from './shorts.types';
 
 /** Сколько прошлых вопросов показываем режиссёру, чтобы он не повторялся (спека, «Правила очереди»). */
 const RECENT_QUESTIONS = 20;
+/** Сценки скольких прошлых роликов показываем режиссёру, чтобы шутки не повторялись (спека сценок). */
+const RECENT_SKITS = 20;
+/** Сколько раз сценка 1 переписывается по нарушениям правил — как сценарий у сценариста. */
+export const MAX_SKIT_REWRITES = 2;
 
 @Injectable()
 export class ShortsDirectorService {
@@ -33,6 +39,8 @@
     const assistants = toAgents(await this.agents.getAgents('ru'));
     const fixed = v.assistantId ? assistants.find((a) => a.id === v.assistantId) ?? null : null;
     if (v.assistantId && !fixed) throw new StageFatalError(`режиссёр: ассистента ${v.assistantId} нет среди активных`);
+    // Ролик со сценками: режиссёр пишет ещё и сценку 1 — она зависит только от вопроса (спека сценок).
+    const skitFormat = v.format === 'skit';
 
     const recent = await this.pg.query(
       `SELECT scene->>'question' AS q FROM short_video
@@ -40,27 +48,60 @@
         ORDER BY created_at DESC LIMIT ${RECENT_QUESTIONS}`,
       [v.id],
     );
-    const message = buildDirectorMessage({
-      rubric: v.rubric,
-      angle: v.angle,
-      topicHint: v.topicHint,
-      fixedAssistant: fixed,
-      assistants,
-      recentQuestions: recent.rows.map((r: any) => r.q).filter(Boolean),
-      ownerNote: v.ownerNote,
-      previousQuestion: v.scene?.question ?? null,
-    });
+    const recentSkits = skitFormat
+      ? (
+          await this.pg.query(
+            `SELECT scene->'skit' AS skit FROM short_video
+              WHERE id <> $1 AND scene ? 'skit'
+              ORDER BY created_at DESC LIMIT ${RECENT_SKITS}`,
+            [v.id],
+          )
+        ).rows
+          .map((r: any) => r.skit as Skit)
+          .filter((s) => s && typeof s === 'object')
+          .map(recentSkitLine)
+      : [];
 
-    // Новая сессия на каждый вызов: совпавший sessionId стенда и прода 18.10.2026
-    // увёл новости блога не в тот канал.
-    const sessionId = `short-direct-${v.id}-${randomUUID()}`;
-    this.logger.log(`ролик ${v.id}: режиссёр, sessionId ${sessionId}`);
-    const raw = await this.relay.ask(DIRECTOR_SYSTEM, message, sessionId);
-    const reply = parseDirectorReply(raw, {
-      assistantIds: new Set(assistants.map((a) => a.id)),
-      fixedAssistantId: fixed?.id ?? null,
-    });
+    let previous: Skit | null = null;
+    let violations: string[] = [];
+    for (let round = 0; round <= MAX_SKIT_REWRITES; round++) {
+      const message = buildDirectorMessage({
+        rubric: v.rubric,
+        angle: v.angle,
+        topicHint: v.topicHint,
+        fixedAssistant: fixed,
+        assistants,
+        recentQuestions: recent.rows.map((r: any) => r.q).filter(Boolean),
+        ownerNote: v.ownerNote,
+        previousQuestion: v.scene?.question ?? null,
+        ...(skitFormat ? { skit: { recent: recentSkits, previous, violations } } : {}),
+      });
 
+      // Новая сессия на каждый вызов: совпавший sessionId стенда и прода 18.10.2026
+      // увёл новости блога не в тот канал.
+      const sessionId = `short-direct-${v.id}-${randomUUID()}`;
+      this.logger.log(`ролик ${v.id}: режиссёр, sessionId ${sessionId}`);
+      const raw = await this.relay.ask(skitFormat ? DIRECTOR_SKIT_SYSTEM : DIRECTOR_SYSTEM, message, sessionId);
+      const reply = parseDirectorReply(raw, {
+        assistantIds: new Set(assistants.map((a) => a.id)),
+        fixedAssistantId: fixed?.id ?? null,
+        skit: skitFormat,
+      });
+      // Правила 16–18 у сценки 1 — до записи: сценка с нарушением дошла бы до
+      // денег Omni. Нарушения уходят режиссёру на переписку, как сценаристу.
+      violations = skitFormat ? checkSkitRules(reply.skit, 'conflict', null) : [];
+      if (violations.length) {
+        this.logger.warn(`ролик ${v.id}: сценка 1 не прошла правила (круг ${round + 1}): ${violations.join('; ')}`);
+        previous = reply.skit;
+        continue;
+      }
+      await this.save(v, assistants, reply);
+      return;
+    }
+    throw new StageFatalError(`режиссёр: сценка 1 не прошла правила и после ${MAX_SKIT_REWRITES} переписок — ${violations.join('; ')}`);
+  }
+
+  private async save(v: ShortVideo, assistants: AgentLite[], reply: DirectorReply): Promise<void> {
     const assistant = assistants.find((a) => a.id === reply.assistantId);
     // Правило 12: здоровье — только в calm. buildDirectorMessage уже не
     // показывает ассистентов здоровья режиссёру при провокационной подаче,
@@ -75,11 +116,14 @@
       assistantName: assistant.name,
       question: reply.question,
       followups: reply.followups,
+      ...(reply.skit ? { skit: reply.skit } : {}),
     };
     // Новая сцена — новый круг с нуля («Переснять», просьба сценариста, повтор с
     // этапа режиссёра): съёмка, сценарий и подписи — от прошлой сцены, и
     // сценарист не должен получить их «прошлым вариантом» с номерами абзацев
     // чужого ответа; отзыв студии о прошлой озвучке и счёт её переписок — тоже.
+    // animation не трогается: секунды Omni — счёт денег ролика целиком, а клипы
+    // прошлой сценки с новыми отпечатками всё равно не совпадут.
     const r = await this.pg.query(
       `UPDATE short_video
           SET status = 'capture_queued', scene = $2::jsonb, assistant_id = $3, slug = $4, title = $5,
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add src/shorts/shorts-director.service.ts
git -C "$WT" commit -m "feat(shorts): режиссёр пишет сценку 1 — правила 16–18 и переписка до двух раз

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/shorts-director.service.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts-director.service.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: 14 passed, затем `TSC_OK`.

---

### Task 8: Сценарист пишет развязку; ролик уходит на оживление

**Files:**
- Modify: `src/shorts/shorts-writer.service.ts`
- Test: `src/shorts/shorts-writer.service.spec.ts`

Сценарист формата skit видит конфликт, который открывает ролик (последний принятый: из сценария, иначе из сцены), пишет развязку и по замечанию — новый конфликт. Код проверяет обе сценки, собирает промпты (`planSkits`) и ставит ролик в `animate_queued`; формат chat, как прежде, — в `render_queued`. Ролик со сценками без сценки 1 — `StageFatalError`: нужен режиссёр.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/shorts-writer.service.spec.ts
+++ b/src/shorts/shorts-writer.service.spec.ts
@@ -1,6 +1,7 @@
 import { MAX_RECAPTURES, ShortsWriterService } from './shorts-writer.service';
 import { StageFatalError } from './short-jobs';
-import { WRITER_SYSTEM } from './short-prompts';
+import { WRITER_SKIT_SYSTEM, WRITER_SYSTEM } from './short-prompts';
+import { planSkits } from './short-skit-prompts';
 import { rowToShort } from './shorts.types';
 
 const PARAGRAPHS = [
@@ -63,7 +64,8 @@
     expect(sessionId).toMatch(/^short-write-ab12cd34-0000-4000-8000-000000000000-[0-9a-f-]{36}$/);
 
     const [sql, params] = pg.query.mock.calls[0] as any[];
-    expect(sql).toMatch(/SET status = 'render_queued'/);
+    expect(sql).toMatch(/SET status = \$6/);
+    expect(params[5]).toBe('render_queued');
     expect(sql).toMatch(/writer_rounds = writer_rounds \+ 1/);
     const script = JSON.parse(params[1]);
     expect(script.voice).toBe('madirus');
@@ -87,7 +89,7 @@
     expect(second).toContain('Прошлый вариант:');
     expect(second).toContain('a1 [');
     expect(second).toContain('подпись telegram: Попробуйте бесплатно!');
-    expect((pg.query.mock.calls[0] as any[])[0]).toMatch(/render_queued/);
+    expect((pg.query.mock.calls[0] as any[])[1][5]).toBe('render_queued');
   });
 
   it('первый круг после отзыва студии — прошлый сценарий из базы, без его подписей (они уже с хвостом)', async () => {
@@ -146,3 +148,75 @@
     await expect(svc.write(video({ capture: null }))).rejects.toBeInstanceOf(StageFatalError);
   });
 });
+
+describe('ShortsWriterService.write — ролик со сценками', () => {
+  const CONFLICT = {
+    cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
+    setting: 'a rented flat hallway, a tiny scuff on the wallpaper',
+    opening: 'The goose stands in the doorway, the capybara holds a suitcase.',
+    action: 'The goose points a wing at the scuff and hisses. The capybara takes out a phone.',
+    lines: [{ hero: 'galina', text: 'Обои потёрли! Залог мой!' }, { hero: 'kesha', text: 'Спокойно. Спрошу у юриста.' }],
+  };
+  const PUNCHLINE = {
+    cast: [{ hero: 'kesha', role: 'жилец' }, { hero: 'galina', role: 'хозяйка квартиры' }],
+    setting: 'the same hallway',
+    opening: 'The capybara holds up the phone, the goose freezes.',
+    action: 'The capybara speaks calmly, the goose drops the keys and lowers her wings.',
+    lines: [{ hero: 'kesha', text: 'Нормальный износ — не повреждение. Залог верните.', box: 3 }, { hero: 'galina', text: 'Га-га… ладно.' }],
+  };
+  const SKIT_GOOD = {
+    hook: 'Весь залог — за потёртые обои?',
+    hookBox: 3,
+    question: 'Я Алексей, юрист. Меня спросили, может ли хозяйка оставить весь залог себе.',
+    lines: [{ box: 3, text: 'Нормальный износ не является повреждением — впишите это в договор аренды.' }],
+    punchline: PUNCHLINE,
+    captions: GOOD.captions,
+  };
+  const skitVideo = (over: Record<string, any> = {}) =>
+    video({ format: 'skit', scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Как не потерять залог?', followups: [], skit: CONFLICT }, ...over });
+
+  it('развязка и промпты обеих сценок — в сценарии; ролик — на оживление, а не на сборку', async () => {
+    const { svc, pg, relay } = setup([SKIT_GOOD]);
+    await svc.write(skitVideo());
+    const [system, message] = relay.ask.mock.calls[0] as any[];
+    expect(system).toBe(WRITER_SKIT_SYSTEM);
+    expect(message).toContain('Сценка 1 (конфликт) — открывает ролик:\n<<<СЦЕНКА 1\ncast: galina — хозяйка квартиры, kesha — жилец');
+    const [, params] = pg.query.mock.calls[0] as any[];
+    expect(params[5]).toBe('animate_queued');
+    const script = JSON.parse(params[1]);
+    expect(script.lines.map((l: any) => l.id)).toEqual(['q', 'a1', 'f']);
+    expect(script.skits).toEqual(JSON.parse(JSON.stringify(planSkits({ conflict: CONFLICT as any, punchline: PUNCHLINE as any }))));
+  });
+
+  it('конфликт, переписанный по замечанию, заменяет сценку режиссёра', async () => {
+    const rewritten = { ...CONFLICT, lines: [{ hero: 'galina', text: 'Обои потёрли! Весь залог мой!' }, CONFLICT.lines[1]] };
+    const { svc, pg } = setup([{ ...SKIT_GOOD, conflict: rewritten }]);
+    await svc.write(skitVideo({ owner_note: 'Галина должна злиться сильнее' }));
+    const script = JSON.parse((pg.query.mock.calls[0] as any[])[1][1]);
+    expect(script.skits.conflict.skit).toEqual(rewritten);
+  });
+
+  it('круг по замечанию: конфликт и прошлая развязка — из сценария, а не из сцены', async () => {
+    const accepted = planSkits({ conflict: { ...CONFLICT, setting: 'an accepted hallway' } as any, punchline: PUNCHLINE as any });
+    const { svc, relay } = setup([SKIT_GOOD]);
+    await svc.write(skitVideo({ script: { hook: 'Старая', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits: accepted } }));
+    const message = relay.ask.mock.calls[0][1] as string;
+    expect(message).toContain('setting: an accepted hallway');
+    expect(message).toContain('Прошлый вариант сценки 2:\n<<<СЦЕНКА 2\n');
+  });
+
+  it('развязка без box — переписка с перечнем; второй вариант проходит', async () => {
+    const noBox = { ...SKIT_GOOD, punchline: { ...PUNCHLINE, lines: [{ hero: 'kesha', text: 'Это износ.' }, PUNCHLINE.lines[1]] } };
+    const { svc, pg, relay } = setup([noBox, SKIT_GOOD]);
+    await svc.write(skitVideo());
+    expect(relay.ask).toHaveBeenCalledTimes(2);
+    expect(relay.ask.mock.calls[1][1]).toContain('сценка 2 (развязка): правило 18');
+    expect((pg.query.mock.calls[0] as any[])[1][5]).toBe('animate_queued');
+  });
+
+  it('у ролика со сценками нет сценки 1 — StageFatalError: нужен режиссёр', async () => {
+    const { svc, relay } = setup([SKIT_GOOD]);
+    await expect(svc.write(video({ format: 'skit' }))).rejects.toThrow(/нет сценки 1/);
+    expect(relay.ask).not.toHaveBeenCalled();
+  });
+});
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/shorts-writer.service.spec.ts
git -C "$WT" commit -m "test(shorts): сценарист пишет развязку (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/shorts-writer.service.spec.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts-writer.service.spec.ts"
```

Expected: 7 failed, 7 passed.

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/shorts-writer.service.ts
+++ b/src/shorts/shorts-writer.service.ts
@@ -8,9 +8,10 @@
 import { StageFatalError } from './short-jobs';
 import { linkBase, shortLinks, shortTarget } from './short-links';
 import { parseWriterReply } from './short-parse';
-import { WRITER_SYSTEM, buildWriterMessage, toAgents } from './short-prompts';
-import { WriterCaptions, checkScriptRules } from './short-rules';
+import { WRITER_SKIT_SYSTEM, WRITER_SYSTEM, buildWriterMessage, toAgents } from './short-prompts';
+import { WriterCaptions, checkScriptRules, checkSkitRules } from './short-rules';
 import { CASE_BADGE, buildScript } from './short-script';
+import { Skit, SkitKind, SkitPlan, planSkits } from './short-skit-prompts';
 import { shortSlug } from './short-slug';
 import { ShortsSettingsService } from './shorts-settings.service';
 import { ShortScript, ShortVideo, appendOwnerNote } from './shorts.types';
@@ -49,9 +50,20 @@
    * Снятый ответ → сценарий студии и подписи площадок, затем проверка правил.
    * Не прошёл — переписка с перечнем нарушений, до MAX_REWRITES раз; не
    * помогло — StageFatalError (повтор тем же ответом бессмыслен).
+   *
+   * Ролик со сценками: сценарист пишет ещё развязку и, по замечанию, переписывает
+   * конфликт; код собирает промпты обеих сценок (planSkits) и отдаёт ролик на
+   * оживление, а не на сборку. Сценка с прежним отпечатком не переснимется.
    */
   async write(v: ShortVideo): Promise<void> {
     if (!v.scene || !v.capture) throw new StageFatalError('сценарист: у ролика нет сцены или съёмки');
+    const skitFormat = v.format === 'skit';
+    // Конфликт — последний принятый: переписанный по замечанию лежит в сценарии, исходный — в сцене режиссёра.
+    let conflict: Skit | null = skitFormat ? v.script?.skits?.conflict?.skit ?? v.scene.skit ?? null : null;
+    if (skitFormat && !conflict) {
+      throw new StageFatalError('сценарист: у ролика со сценками нет сценки 1 — повторите с этапа режиссёра');
+    }
+    let previousPunchline: Skit | null = skitFormat ? v.script?.skits?.punchline?.skit ?? null : null;
     const [rows, settings] = await Promise.all([this.agents.getAgents('ru'), this.settings.get()]);
     const assistants = toAgents(rows);
     const name = v.scene.assistantName;
@@ -86,9 +98,10 @@
         previousScript: previous,
         previousCaptions,
         violations,
+        ...(skitFormat ? { skit: { conflict, previousPunchline } } : {}),
       });
-      const raw = await this.relay.ask(WRITER_SYSTEM, message, `short-write-${v.id}-${randomUUID()}`);
-      const reply = parseWriterReply(raw);
+      const raw = await this.relay.ask(skitFormat ? WRITER_SKIT_SYSTEM : WRITER_SYSTEM, message, `short-write-${v.id}-${randomUUID()}`);
+      const reply = parseWriterReply(raw, { skit: skitFormat });
       if (reply.needsRecapture) {
         if (recapturesInRow(v.ownerNote) >= MAX_RECAPTURES) {
           throw new StageFatalError(`сценарист: уже дважды просил другую сцену — нужен взгляд владельца; последняя причина: ${reply.reason}`);
@@ -96,30 +109,50 @@
         await this.backToDirector(v, reply.reason);
         return;
       }
-      const script = buildScript(reply, options);
+      const paragraphs = v.capture.paragraphs ?? [];
+      const skits = skitFormat ? { conflict: reply.skits.conflict ?? conflict, punchline: reply.skits.punchline } : null;
+      // Промпты сценок — только из сценок без нарушений: planSkits на кривой
+      // сценке бросает первую же ошибку, а правила называют все разом.
+      let planned: Record<SkitKind, SkitPlan> | undefined;
+      let planError: string | null = null;
+      if (skits && !checkSkitRules(skits.conflict, 'conflict', paragraphs).length && !checkSkitRules(skits.punchline, 'punchline', paragraphs).length) {
+        try {
+          planned = planSkits(skits);
+        } catch (e: any) {
+          planError = String(e?.message ?? e);
+        }
+      }
+      const script = buildScript(reply, { ...options, skits: planned });
       violations = checkScriptRules({
         angle: v.angle,
         assistantName: name,
         script,
         captions: reply.captions,
-        paragraphs: v.capture.paragraphs ?? [],
+        paragraphs,
         answerText: v.capture.answerText ?? '',
         sceneQuestion: v.scene.question,
         assistantsCount,
+        format: v.format,
+        ...(skits ? { skits } : {}),
       });
+      if (planError) violations.push(planError);
       if (violations.length) {
         this.logger.warn(`ролик ${v.id}: сценарий не прошёл правила (круг ${round + 1}): ${violations.join('; ')}`);
         previous = script;
         previousCaptions = reply.captions;
+        if (skits) {
+          conflict = skits.conflict;
+          previousPunchline = skits.punchline;
+        }
         continue;
       }
       const r = await this.pg.query(
         `UPDATE short_video
-            SET status = 'render_queued', script = $2::jsonb, captions = $3::jsonb, slug = $4,
+            SET status = $6, script = $2::jsonb, captions = $3::jsonb, slug = $4,
                 writer_feedback = NULL, writer_rounds = writer_rounds + 1,
                 attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
           WHERE id = $1 AND status = 'writing' AND attempts = $5`,
-        [v.id, JSON.stringify(script), JSON.stringify(buildCaptions(reply.captions, links)), slug, v.attempts],
+        [v.id, JSON.stringify(script), JSON.stringify(buildCaptions(reply.captions, links)), slug, v.attempts, skitFormat ? 'animate_queued' : 'render_queued'],
       );
       // attempts = номер захвата: опоздавший процесс не пишет поверх того, кто забрал этап после него.
       if (r.rowCount === 0) this.logger.warn(`ролик ${v.id} ушёл из writing или его забрал другой процесс — сценарий не записал`);
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add src/shorts/shorts-writer.service.ts
git -C "$WT" commit -m "feat(shorts): сценарист пишет развязку и переписывает конфликт по замечанию; сценки — на оживление

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/shorts-writer.service.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts-writer.service.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: 14 passed, затем `TSC_OK`.

---

### Task 9: Подпись владельцу: состав сценок и траты на Omni

**Files:**
- Modify: `src/shorts/short-captions.ts`
- Modify: `src/shorts/shorts-approval.service.ts`
- Test: `src/shorts/short-captions.spec.ts`
- Test: `src/shorts/shorts-approval.service.spec.ts`

В подписи видео на проверку — «Сценки: Гусыня Галина Петровна — хозяйка квартиры, Капибара Кеша — жилец» и «Omni: 16 с, кадров 2 ≈ $1,86» (цены — как в выводе студии). На замечание и кнопки во время оживления владелец получает человеческий отказ, а не имя статуса.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/short-captions.spec.ts
+++ b/src/shorts/short-captions.spec.ts
@@ -7,8 +7,11 @@
   buildCaptions,
   buildReviewCaption,
   clip,
+  omniSpendLine,
+  skitCastLine,
   tidyTags,
 } from './short-captions';
+import { planSkits } from './short-skit-prompts';
 
 /** Одиночный суррогат без пары — признак того, что эмодзи разрезали пополам. */
 const hasLoneSurrogate = (s: string): boolean =>
@@ -127,9 +130,34 @@
     expect(buildReviewCaption({ ...base, stand: true }).caption.startsWith('[СТЕНД]')).toBe(true);
   });
 
+  it('ролик со сценками — состав и траты на Omni после вопроса', () => {
+    const r = buildReviewCaption({ ...base, skits: { cast: 'Гусыня Галина Петровна — хозяйка квартиры, Капибара Кеша — жилец', animation: { omniSeconds: 16, keyframes: 2, skits: {} } } });
+    expect(r.caption).toContain('Вопрос: «Проверьте договор»\nСценки: Гусыня Галина Петровна — хозяйка квартиры, Капибара Кеша — жилец\nOmni: 16 с, кадров 2 ≈ $1,86\nВыйдет:');
+    expect(buildReviewCaption(base).caption).not.toContain('Omni');
+  });
+
   it('вопрос из эмодзи — подпись укладывается в предел по единицам UTF-16', () => {
     const r = buildReviewCaption({ ...base, question: '😀'.repeat(2000) });
     expect(r.caption.length).toBeLessThanOrEqual(TG_CAPTION_MAX);
     expect(hasLoneSurrogate(r.caption)).toBe(false);
   });
 });
+
+describe('skitCastLine и omniSpendLine', () => {
+  const skit = (cast: Array<{ hero: any; role: string }>) => ({
+    cast, setting: 's', opening: 'o', action: 'a', lines: [{ hero: cast[0].hero, text: 'Реплика', box: 1 }],
+  });
+
+  it('герои — по первому появлению, у каждого его роль; повтор в развязке не дублируется', () => {
+    const skits = planSkits({
+      conflict: skit([{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }]) as any,
+      punchline: skit([{ hero: 'kesha', role: 'жилец' }, { hero: 'boris', role: 'чиновник' }]) as any,
+    });
+    expect(skitCastLine(skits)).toBe('Гусыня Галина Петровна — хозяйка квартиры, Капибара Кеша — жилец, Кот Борис Аркадьевич — чиновник');
+  });
+
+  it('траты: секунды Omni по $0,10 и кадры по $0,13; оживления ещё не было — нули', () => {
+    expect(omniSpendLine({ omniSeconds: 24, keyframes: 3, skits: {} })).toBe('Omni: 24 с, кадров 3 ≈ $2,79');
+    expect(omniSpendLine(null)).toBe('Omni: 0 с, кадров 0 ≈ $0,00');
+  });
+});
--- a/src/shorts/shorts-approval.service.spec.ts
+++ b/src/shorts/shorts-approval.service.spec.ts
@@ -7,6 +7,7 @@
 import { NoFreeSlotError } from '../blog/blog-slots';
 import { approveShortIntoSlot } from './short-slot-claim';
 import { REVIEW_LEASE_MINUTES, ShortsApprovalService } from './shorts-approval.service';
+import { planSkits } from './short-skit-prompts';
 
 const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
 const OWNER = 777;
@@ -273,6 +274,8 @@
         ['rejected', 'no', /^Ролик отклонён/],
         ['published', 'no', /^Ролик уже опубликован/],
         ['writing', 'note', /переписывается/],
+        ['animating', 'ok', /переделывается/],
+        ['animate_queued', 'note', /оживают/],
       ];
       for (const [status, action, text] of cases) {
         const { svc, tg, pg } = setup(row({ status }));
@@ -491,6 +494,37 @@
       await svc.notifyFailures();
       expect(tg.sendMessage).not.toHaveBeenCalled();
       expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).includes('failure_notified = false'))).toBe(false);
+    });
+  });
+});
+
+describe('ShortsApprovalService — ролик со сценками', () => {
+  const env = { ...process.env };
+  beforeEach(() => {
+    process.env.BLOG_APPROVER_TG_ID = String(OWNER);
+    process.env.SHORTS_ENABLED = 'true';
+    delete process.env.SHORTS_STAND;
+  });
+  afterAll(() => {
+    process.env = env;
+  });
+
+  it('в подписи владельцу — состав сценок и траты на Omni', async () => {
+    const skit = (cast: Array<{ hero: string; role: string }>, box?: number) => ({
+      cast, setting: 'a hallway', opening: 'o', action: 'a', lines: [{ hero: cast[0].hero, text: 'Реплика', ...(box ? { box } : {}) }],
     });
+    const skits = planSkits({
+      conflict: skit([{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }]) as any,
+      punchline: skit([{ hero: 'kesha', role: 'жилец' }, { hero: 'galina', role: 'хозяйка квартиры' }], 1) as any,
+    });
+    const { svc, tg } = setup(fresh({
+      format: 'skit',
+      script: { hook: 'h', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits },
+      animation: { omniSeconds: 16, keyframes: 2, skits: {} },
+    }));
+    await svc.sendPendingReviews();
+    const caption = (tg.sendVideo.mock.calls[0] as any[])[2].caption as string;
+    expect(caption).toContain('Сценки: Гусыня Галина Петровна — хозяйка квартиры, Капибара Кеша — жилец');
+    expect(caption).toContain('Omni: 16 с, кадров 2 ≈ $1,86');
   });
 });
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/short-captions.spec.ts src/shorts/shorts-approval.service.spec.ts
git -C "$WT" commit -m "test(shorts): состав сценок и траты в подписи владельцу (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/short-captions.spec.ts src/shorts/shorts-approval.service.spec.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-captions.spec.ts src/shorts/shorts-approval.service.spec.ts"
```

Expected: 5 failed, 53 passed.

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/short-captions.ts
+++ b/src/shorts/short-captions.ts
@@ -1,6 +1,15 @@
 import { LinkPlatform } from './short-links';
-import { ANGLE_TITLES, RUBRIC_TITLES, ShortAngle, ShortCaptions, ShortRubric } from './shorts.types';
+import { SKIT_KINDS, SkitKind, SkitPlan } from './short-skit-prompts';
+import { heroById } from './short-troupe';
+import { ANGLE_TITLES, RUBRIC_TITLES, ShortAnimation, ShortAngle, ShortCaptions, ShortRubric } from './shorts.types';
 
+/**
+ * Цены для подписи владельцу (прайс Google на 26.10.2026): секунда Omni при
+ * 720p и кадр Nano Banana Pro. Те же числа печатает студия (studio/src/animate/google.ts).
+ */
+export const OMNI_USD_PER_SEC = 0.1;
+export const KEYFRAME_USD = 0.13;
+
 /** Telegram молча обрезает подпись длиннее — на этом обжигались с блогом. */
 export const TG_CAPTION_MAX = 1000;
 export const VK_TEXT_MAX = 2000;
@@ -75,8 +84,29 @@
   question: string;
   when: string;
   captions: ShortCaptions;
+  /** Ролик со сценками: состав (skitCastLine) и траты на оживление. */
+  skits?: { cast: string; animation: ShortAnimation | null };
 }
 
+/** Состав сценок одной строкой: герой — роль, по первому появлению («Гусыня Галина Петровна — хозяйка квартиры, Капибара Кеша — жилец»). */
+export function skitCastLine(skits: Partial<Record<SkitKind, SkitPlan>>): string {
+  const seen = new Map<string, string>();
+  for (const kind of SKIT_KINDS) {
+    for (const c of skits[kind]?.skit?.cast ?? []) {
+      if (!seen.has(c.hero)) seen.set(c.hero, `${heroById(c.hero)?.name ?? c.hero} — ${c.role}`);
+    }
+  }
+  return [...seen.values()].join(', ');
+}
+
+/** Траты на оживление: «Omni: 16 с, кадров 2 ≈ $1,86». */
+export function omniSpendLine(a: ShortAnimation | null): string {
+  const seconds = a?.omniSeconds ?? 0;
+  const frames = a?.keyframes ?? 0;
+  const usd = (seconds * OMNI_USD_PER_SEC + frames * KEYFRAME_USD).toFixed(2).replace('.', ',');
+  return `Omni: ${seconds} с, кадров ${frames} ≈ $${usd}`;
+}
+
 /**
  * Подпись видео владельцу: рубрика, подача, ассистент, вопрос, время выхода и
  * подписи площадок. Не влезают в 1000 знаков — подписи идут вторым сообщением.
@@ -87,6 +117,7 @@
     `Рубрика: ${RUBRIC_TITLES[i.rubric]} · подача: ${ANGLE_TITLES[i.angle].toLowerCase()}`,
     `Ассистент: ${i.assistantName}`,
     `Вопрос: «${clip(i.question, 300)}»`,
+    ...(i.skits ? [`Сценки: ${clip(i.skits.cast, 200)}`, omniSpendLine(i.skits.animation)] : []),
     `Выйдет: ${i.when}`,
   ].join('\n');
   const texts = [
--- a/src/shorts/shorts-approval.service.ts
+++ b/src/shorts/shorts-approval.service.ts
@@ -7,7 +7,7 @@
 import { StorageService } from '../common/services/storage.service';
 import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
 import { buildReviewKeyboard, parseShortCallback, parseYoutubeUrl, shortCommandText } from './short-callback';
-import { STAND_MARK, buildReviewCaption, clip } from './short-captions';
+import { STAND_MARK, buildReviewCaption, clip, skitCastLine } from './short-captions';
 import { autoTopicsEnabled, isStand, shortsEnabled } from './short-env';
 import { approveShortIntoSlot } from './short-slot-claim';
 import { ShortsSettingsService } from './shorts-settings.service';
@@ -44,6 +44,7 @@
 
 const RESHOOT = 'Ролик сейчас переснимается — замечание напишите к новому варианту.';
 const REBUILD = 'Ролик сейчас пересобирается — замечание напишите к новому варианту.';
+const REANIMATE = 'Сценки ролика сейчас оживают — замечание напишите к новому варианту.';
 
 /**
  * Что делать с упавшим роликом. Вкладки «Ролики» в кабинете пока нет (план 3) —
@@ -57,6 +58,8 @@
   capture_queued: RESHOOT,
   capturing: RESHOOT,
   writing: 'Ролик сейчас переписывается — замечание напишите к новому варианту.',
+  animate_queued: REANIMATE,
+  animating: REANIMATE,
   render_queued: REBUILD,
   rendering: REBUILD,
   approved: 'Ролик уже одобрен и ждёт слота — замечание не принял. Переснять его можно кнопкой «🔄 Переснять».',
@@ -76,6 +79,8 @@
   capture_queued: REWORKING,
   capturing: REWORKING,
   writing: REWORKING,
+  animate_queued: REWORKING,
+  animating: REWORKING,
   render_queued: REWORKING,
   rendering: REWORKING,
   approved: 'Ролик уже одобрен',
@@ -235,6 +240,8 @@
       question: v.scene.question,
       when,
       captions: v.captions,
+      // Сценки: кто играл и во что обошлось оживление (спека сценок, «Одобрение»).
+      ...(v.script?.skits ? { skits: { cast: skitCastLine(v.script.skits), animation: v.animation } } : {}),
     });
     const msg: any = await this.tg.sendVideo(chatId, video, {
       caption,
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add src/shorts/short-captions.ts src/shorts/shorts-approval.service.ts
git -C "$WT" commit -m "feat(shorts): состав сценок и траты на Omni в подписи владельцу

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/short-captions.ts src/shorts/shorts-approval.service.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-captions.spec.ts src/shorts/shorts-approval.service.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: 58 passed, затем `TSC_OK`.

---

### Task 10: Студия: сценка в сцене, зацепка сценок до 6 слов

**Files:**
- Modify: `studio/src/types.ts`
- Modify: `studio/src/script.ts`
- Test: `studio/src/script.test.ts`

Тип сцены студии получает `skit` (зеркало API; съёмка его не читает). `validateScript` у ролика со сценками держит зацепку до 6 слов — тот же предел, что у API.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/studio/src/script.test.ts
+++ b/studio/src/script.test.ts
@@ -135,3 +135,11 @@
   s.skits = { ...s.skits!, conflict: { ...s.skits!.conflict, fingerprint: 'f', keyframeFingerprint: '' } };
   assert.ok(validateScript(s, capture).includes('у сценки conflict нет отпечатка'));
 });
+
+test('ролик со сценками: зацепка — надпись до 6 слов, как в API (MAX_SKIT_HOOK_WORDS)', () => {
+  const s = skitScript();
+  s.hook = 'раз два три четыре пять шесть';
+  assert.deepEqual(validateScript(s, capture), []);
+  s.hook = 'раз два три четыре пять шесть семь';
+  assert.deepEqual(validateScript(s, capture), ['зацепка длиннее 6 слов']);
+});
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/script.test.ts
git -C "$WT" commit -m "test(studio): зацепка ролика со сценками до 6 слов (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- studio/src/script.test.ts
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/script.test.ts"
```

Expected: `# fail 1`.

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- a/studio/src/types.ts
+++ b/studio/src/types.ts
@@ -7,6 +7,8 @@
   question: string;
   /** Ответы на встречный вопрос ассистента, по порядку. Используется не больше двух. */
   followups: string[];
+  /** Сценка 1 от режиссёра (ролик со сценками) — съёмка её не читает, оживление берёт сценки из сценария. */
+  skit?: Skit;
 }
 
 /** Абзац ответа на высоком скриншоте, в пикселях картинки. */
--- a/studio/src/script.ts
+++ b/studio/src/script.ts
@@ -1,5 +1,9 @@
 import { SKIT_KINDS, type CaptureResult, type Script } from './types';
 
+/** Предел слов зацепки — тот же, что у API (src/shorts/short-rules.ts: MAX_HOOK_WORDS, MAX_SKIT_HOOK_WORDS). */
+export const HOOK_MAX_WORDS = 8;
+export const SKIT_HOOK_MAX_WORDS = 6;
+
 /**
  * То, что студия может проверить сама до озвучки: у каждой реплики ответа
  * есть абзац, и такой абзац снят. Правила текста (цифры, конкуренты,
@@ -11,8 +15,9 @@
   const hook = script.hook?.trim() ?? '';
   if (!hook) problems.push('нет зацепки');
   // Словом считаем токен с буквой или цифрой — тем же фильтром, что API (short-rules.ts):
-  // тире и прочие знаки между репликами не слова.
-  if (hook.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length > 8) problems.push('зацепка длиннее 8 слов');
+  // тире и прочие знаки между репликами не слова. У сценок зацепка — надпись, её читают за 3 с.
+  const maxHookWords = script.skits ? SKIT_HOOK_MAX_WORDS : HOOK_MAX_WORDS;
+  if (hook.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length > maxHookWords) problems.push(`зацепка длиннее ${maxHookWords} слов`);
   if (!script.voice?.trim()) problems.push('не задан голос');
 
   const ids = new Set<string>();
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add studio/src/types.ts studio/src/script.ts
git -C "$WT" commit -m "feat(studio): сценка в сцене, предел слов зацепки сценок

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- studio/src/types.ts studio/src/script.ts
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/script.test.ts && npm run -s typecheck && echo TSC_OK"
```

Expected: `# pass 15`, `# fail 0`, затем `TSC_OK`.

---

### Task 11: Оживление сохраняет счёт денег и файлы по ходу

**Files:**
- Modify: `studio/src/animate/run-animate.ts`
- Test: `studio/src/animate/run-animate.test.ts`

`animateRun` получает крючки `onSave` (каждое сохранение animation.json — наружу, по порядку, без обгонов) и `onFile` (кадр, raw.mp4, clip.mp4 — наружу). Первое сохранение — до любых трат: задание, которое уже не наше, не нарисует ни кадра. Сбой выгрузки — повторяемый (файл уже в папке, новых денег повтор не стоит); оплаченный клип, уже лежащий в папке, выгружается снова; принятый клип снимает свой id генерации.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/studio/src/animate/run-animate.test.ts
+++ b/studio/src/animate/run-animate.test.ts
@@ -521,4 +521,70 @@
     (e: unknown) => isErr('google_auth', false)(e) && /сценка 1 \(конфликт\): omni: ключ; сценка 2 \(развязка\): omni: ключ/.test((e as Error).message),
   );
   assert.equal(readAnim(env.runDir).omniSeconds, 0);
+});
+
+test('наружу: резерв секунд — до запуска Omni, id генерации — до ожидания, файлы — по мере появления', { timeout: 120_000 }, async () => {
+  const env = setup();
+  const saved: ShortAnimation[] = [];
+  const files: string[] = [];
+  const { deps, calls } = fakes(env);
+  const startClip = deps.startClip;
+  const waitClip = deps.waitClip;
+  deps.startClip = async (prompt, image) => {
+    // К запуску резерв этой сценки уже снаружи.
+    const kind = kindOf(prompt);
+    const before = calls.start.filter((k) => k === kind).length;
+    assert.ok(saved.at(-1)!.omniSeconds >= 8 * (before + 1), 'резерв не сохранён до запуска');
+    return startClip(prompt, image);
+  };
+  deps.waitClip = async (id) => {
+    assert.ok(saved.some((a) => Object.values(a.pending ?? {}).some((p) => p?.id === id)), `id ${id} не сохранён до ожидания`);
+    return waitClip(id);
+  };
+  const anim = await animateRun(env.runDir, {
+    ...deps,
+    onSave: async (a) => {
+      saved.push(a);
+    },
+    onFile: async (rel) => {
+      files.push(rel);
+    },
+  });
+  assert.deepEqual(saved.at(-1), anim);
+  assert.deepEqual([...files].sort(), [
+    'keyframes/kf-conflict.png', 'keyframes/kf-punchline.png',
+    'skits/fp-conflict/clip.mp4', 'skits/fp-conflict/raw.mp4', 'skits/fp-punchline/clip.mp4', 'skits/fp-punchline/raw.mp4',
+  ]);
+  // Снимки идут по порядку: секунды Omni снаружи не убывают.
+  for (let i = 1; i < saved.length; i++) assert.ok(saved[i].omniSeconds >= saved[i - 1].omniSeconds);
 });
+
+test('наружу не сохранилось (задание уже не наше) — ни кадра, ни клипа', { timeout: 120_000 }, async () => {
+  const env = setup();
+  const { deps, calls } = fakes(env);
+  await assert.rejects(
+    animateRun(env.runDir, { ...deps, onSave: async () => { throw new StudioError('unknown', 'задание забрал другой процесс', false); } }),
+    (e: unknown) => isErr('unknown', false)(e) && /другой процесс/.test((e as Error).message),
+  );
+  assert.deepEqual([calls.keyframe.length, calls.start.length], [0, 0]);
+});
+
+test('файл не выгрузился — повторяемая ошибка; оплаченный клип при повторе берётся из папки', { timeout: 120_000 }, async () => {
+  const env = setup();
+  let failRaw = true;
+  const first = fakes(env);
+  await assert.rejects(
+    animateRun(env.runDir, {
+      ...first.deps,
+      onFile: async (rel) => {
+        if (rel.endsWith('raw.mp4') && failRaw) throw new Error('MinIO: 503');
+      },
+    }),
+    (e: unknown) => e instanceof StudioError && /не выгрузился в хранилище/.test((e as Error).message),
+  );
+  failRaw = false;
+  const second = fakes(env);
+  const anim = await animateRun(env.runDir, { ...second.deps, onFile: async () => {} });
+  assert.deepEqual(second.calls.start, []);
+  assert.equal(anim.omniSeconds, 16);
+});
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/run-animate.test.ts
git -C "$WT" commit -m "test(studio): оживление сохраняет счёт денег и файлы по ходу (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- studio/src/animate/run-animate.test.ts
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts"
```

Expected: `# fail 3`.

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- a/studio/src/animate/run-animate.ts
+++ b/studio/src/animate/run-animate.ts
@@ -45,6 +45,14 @@
   lufs?: number;
   maxOmniSeconds?: number;
   log?(msg: string): void;
+  /**
+   * Каждое сохранение animation.json — наружу: рабочий процесс пишет его в базу,
+   * чтобы резерв секунд и id генерации пережили падение процесса. Сохранения
+   * идут по порядку, без обгонов; сбой — ошибка без повтора (задание уже не наше).
+   */
+  onSave?(anim: ShortAnimation): Promise<void>;
+  /** Новый файл папки — кадр, raw.mp4, clip.mp4 (путь относительно неё): рабочий процесс кладёт его в MinIO. */
+  onFile?(rel: string): Promise<void>;
 }
 
 /** Расширение кадра по его типу: Nano Banana Pro отдаёт JPEG. */
@@ -144,13 +152,34 @@
 
   const animPath = path.join(runDir, 'animation.json');
   const anim = loadAnimation(animPath);
-  const save = (): void => {
+  // Снимок берётся в момент вызова, отправка наружу — цепочкой: две сценки
+  // сохраняются вперемешку, и запись постарше не должна лечь поверх новой.
+  let saving: Promise<void> = Promise.resolve();
+  const save = async (): Promise<void> => {
+    const text = JSON.stringify(anim, null, 2);
     try {
-      writeAtomic(animPath, JSON.stringify(anim, null, 2));
+      writeAtomic(animPath, text);
     } catch (e) {
       throw new StudioError('unknown', `animate: animation.json не записался — ${failText(e)}`, false);
     }
+    if (!deps.onSave) return;
+    const snapshot = JSON.parse(text) as ShortAnimation;
+    saving = saving.then(() => deps.onSave!(snapshot));
+    try {
+      await saving;
+    } catch (e) {
+      throw e instanceof StudioError ? e : new StudioError('unknown', `animate: animation.json не сохранился наружу — ${failText(e)}`, false);
+    }
   };
+  /** Файл — наружу; сетевой сбой повторяем: файл уже лежит в папке, новых денег повтор не стоит. */
+  const upload = async (rel: string): Promise<void> => {
+    if (!deps.onFile) return;
+    try {
+      await deps.onFile(rel);
+    } catch (e) {
+      throw new StudioError('unknown', `animate: ${rel} не выгрузился в хранилище — ${failText(e)}`, true);
+    }
+  };
   const lufs = deps.lufs ?? CLIP_LUFS;
   const post = `v${PROCESSING_VERSION};lufs=${lufs};pause=${PAUSE_DETECT.noiseDb}dB/${PAUSE_DETECT.minSec}s`;
   const troupeDir = deps.troupeDir ?? path.join(STUDIO_ROOT, 'assets', 'troupe');
@@ -230,8 +259,9 @@
       }
       const kf = `${keyframeBase(kind)}.${KEYFRAME_EXT[img.mime] ?? 'png'}`;
       await local('кадр не записался', () => writeAtomic(abs(kf), img.data));
+      await upload(kf);
       anim.keyframes = (anim.keyframes ?? 0) + 1;
-      save();
+      await save();
       return kf;
     }
     throw new StudioError(last!.code, `${last!.message} — кадр не нарисован за ${MAX_SKIT_ATTEMPTS} попытки`, false);
@@ -299,6 +329,7 @@
     const totalMs = Math.round((probe.videoSec ?? probe.durationSec) * 1000);
     const pauses = await local('поиск пауз', () => detectSilences(next, probe.durationSec, PAUSE_DETECT));
     await local('клип не записался', () => fs.renameSync(next, abs(clip)));
+    await upload(clip);
     log(`animate ${kind}: готово${accepted ? ' (переобработка без Omni)' : ` с попытки ${attempt}`}, речь ${Math.round(share * 100)}%`);
     return {
       fingerprint: plan.fingerprint,
@@ -338,9 +369,11 @@
         false,
       );
     }
+    // Оплаченный клип уже скачан, а id генерации остался (процесс упал между записью клипа и сохранением) — id больше не нужен.
+    if (hasRaw(kind) && hasPending(kind)) delete anim.pending![kind];
     // Запись под другой отпечаток больше не годится: сборка её и так не возьмёт.
     delete anim.skits[kind];
-    save();
+    await save();
 
     let last: StudioError | null = null;
     const codes: string[] = [];
@@ -362,11 +395,11 @@
             // должны пройти предел, когда места осталось на одну.
             anim.omniSeconds += CLIP_SEC;
             reserved = true;
-            save();
+            await save();
             id = await deps.startClip(plan.videoPrompt, image);
             started = true;
             anim.pending = { ...anim.pending, [kind]: { id, fingerprint: plan.fingerprint } };
-            save();
+            await save();
           }
           let mp4: Buffer;
           try {
@@ -375,15 +408,19 @@
             const err = toStudioError(e);
             if (!KEEP_PENDING.has(err.code)) {
               delete anim.pending![kind];
-              save();
+              await save();
               throw err;
             }
             // id остаётся: следующая попытка или запуск дождётся этой генерации.
             throw err.retryable ? err : new StudioError(err.code, `${err.message} (id ${id} — pending.${kind} в animation.json; удалите его, чтобы снять клип заново)`, false);
           }
           await local('клип не записался', () => writeAtomic(raw, mp4));
+          await upload(skitFile(kind, 'raw.mp4'));
           delete anim.pending![kind];
-          save();
+          await save();
+        } else {
+          // Оплаченный клип уже в папке (сбой распознавания, выгрузки, перезапуск) — он должен лежать и снаружи.
+          await upload(skitFile(kind, 'raw.mp4'));
         }
         return await finish(kind, attempt, null);
       } catch (e) {
@@ -392,7 +429,7 @@
         // потерянном ответе генерация могла начаться и будет оплачена.
         if (reserved && !started && CLEAR_REFUSALS.has(err.code)) {
           anim.omniSeconds -= CLIP_SEC;
-          save();
+          await save();
         }
         last = err;
         codes.push(err.code);
@@ -405,6 +442,8 @@
     throw new StudioError(last!.code, `${last!.message} — после ${MAX_SKIT_ATTEMPTS} попыток (${codes.join(', ')})`, false);
   };
 
+  // Первое сохранение — до любых трат: задание, которое уже не наше (onSave отказал), не нарисует ни кадра.
+  await save();
   const todo = SKIT_KINDS.filter((k) => !reusable(k));
   if (todo.length) {
     // Кадр конфликта нужен первым: по нему рисуется развязка. Если его нет, а по
@@ -427,7 +466,9 @@
     const results = await Promise.allSettled(
       todo.map(async (kind) => {
         anim.skits[kind] = await animateSkit(kind);
-        save();
+        // Клип принят — запущенной генерации этой сценки больше нет, что бы ни помешало убрать id раньше.
+        if (anim.pending?.[kind]?.fingerprint === plans[kind].fingerprint) delete anim.pending[kind];
+        await save();
       }),
     );
     const failures = results
@@ -444,7 +485,7 @@
       throw new StudioError(main.err.code, failures.map((f) => `${SCENE[f.kind]}: ${f.err.message}`).join('; '), main.err.retryable);
     }
   }
-  save();
+  await save();
   return anim;
 }
 
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add studio/src/animate/run-animate.ts
git -C "$WT" commit -m "feat(studio): оживление сохраняет animation и файлы наружу по ходу, первое сохранение — до трат

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- studio/src/animate/run-animate.ts
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts && npm run -s typecheck && echo TSC_OK"
```

Expected: `# pass 33`, `# fail 0`, затем `TSC_OK`.

---

### Task 12: Одиночный 404 опроса Omni не стоит новой генерации

**Files:**
- Modify: `studio/src/animate/google.ts`
- Test: `studio/src/animate/google.test.ts`

Свежую генерацию Google иногда не показывает опросу; новая оплата — только после трёх 404 подряд.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/studio/src/animate/google.test.ts
+++ b/studio/src/animate/google.test.ts
@@ -270,8 +270,15 @@
   await assert.rejects(waitClip(a.deps, 'i'), isErr('omni_failed', true));
   const b = fake([{ body: { status: 'failed', errors: [{ code: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' }] } }]);
   await assert.rejects(waitClip(b.deps, 'i'), isErr('omni_failed', true));
-  const c = fake([{ status: 404, body: '{"error":{"message":"Interaction not found"}}' }]);
-  await assert.rejects(waitClip(c.deps, 'i'), isErr('omni_failed', true));
+  const gone = { status: 404, body: '{"error":{"message":"Interaction not found"}}' };
+  const c = fake([gone, gone, gone]);
+  c.deps.pollTimeoutMs = 100;
+  await assert.rejects(waitClip(c.deps, 'i'), (e: unknown) => isErr('omni_failed', true)(e) && /3 раза подряд/.test((e as Error).message));
+  // Одиночный 404 у живой генерации — не повод платить за новую.
+  const mp4 = Buffer.from('MP4');
+  const d = fake([gone, inProgress, gone, done(mp4)]);
+  d.deps.pollTimeoutMs = 100;
+  assert.deepEqual(await waitClip(d.deps, 'i'), mp4);
 });
 
 test('готово, но без видео — omni_rejected с текстом модели', async () => {
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/google.test.ts
git -C "$WT" commit -m "test(studio): одиночный 404 опроса Omni (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- studio/src/animate/google.test.ts
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/google.test.ts"
```

Expected: `# fail 1`.

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- a/studio/src/animate/google.ts
+++ b/studio/src/animate/google.ts
@@ -25,6 +25,8 @@
 const RATE_RETRIES = 2;
 const MAX_RATE_WAIT_MS = 90_000;
 const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
+/** 404 опроса подряд, после которых генерация считается потерянной: свежую Google иногда не показывает опросу секунды. */
+const POLL_NOT_FOUND_LIMIT = 3;
 
 export interface GoogleDeps {
   apiKey: string;
@@ -320,6 +322,7 @@
   const left = (): number => Math.max(1000, deadline - now());
   // Последний увиденный статус — в тексте срока: незнакомый конечный статус иначе выглядел бы как «долго».
   let lastStatus = 'ответа не было';
+  let notFound = 0;
   while (now() < deadline) {
     await sleep(Math.min(every, Math.max(0, deadline - now())));
     let st: Interaction;
@@ -331,12 +334,17 @@
           continue;
         }
         if (r.status >= 500 || r.status === 408) continue;
-        if (r.status === 404) throw new StudioError('omni_failed', `omni: взаимодействие ${id} не найдено (HTTP 404)`, true);
+        if (r.status === 404) {
+          // Новая оплата — только после нескольких 404 подряд: одиночный бывает и у живой генерации.
+          if (++notFound < POLL_NOT_FOUND_LIMIT) continue;
+          throw new StudioError('omni_failed', `omni: взаимодействие ${id} не найдено (HTTP 404, ${POLL_NOT_FOUND_LIMIT} раза подряд)`, true);
+        }
         const err = googleHttpError('omni', r.status, r.raw, d.apiKey);
         // Отказ на опросе своей генерации — не фильтр, а сбой API или студии: генерация может быть оплачена.
         throw err.code === 'google_auth' || err.code === 'google_quota' ? err : unreadable(id, `опрос отвергнут — ${err.message}`);
       }
       st = (JSON.parse(r.raw) ?? {}) as Interaction;
+      notFound = 0;
       lastStatus = typeof st.status === 'string' && st.status ? st.status : 'пустой';
     } catch (e) {
       if (e instanceof StudioError) throw e;
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add studio/src/animate/google.ts
git -C "$WT" commit -m "fix(studio): Omni — генерация потеряна только после трёх 404 опроса подряд

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- studio/src/animate/google.ts
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/google.test.ts && npm run -s typecheck && echo TSC_OK"
```

Expected: `# pass 25`, `# fail 0`, затем `TSC_OK`.

---

### Task 13: Задание animate в рабочем процессе студии

**Files:**
- Modify: `studio/src/worker/db.ts`
- Modify: `studio/src/worker/storage.ts`
- Modify: `studio/src/worker/jobs.ts`
- Modify: `studio/src/worker/worker.ts`
- Modify: `studio/README.md`
- Test: `studio/src/worker/db.integration.ts`
- Test: `studio/src/worker/storage.test.ts`
- Test: `studio/src/worker/jobs.test.ts`

Третья очередь — `animate_queued`/`animating` («оживление»). Захват отдаёт `animation`; по ходу оно пишется в базу тем же захватом (`saveAnimation`), итог — `render_queued` (`completeAnimate`); предел секунд — из настроек. Задание: проверка сценария, папка `out/jobs/<id>/animate` на все попытки, счёт денег — из базы, кадры и клипы этого сценария — из MinIO (`getIfExists`: «нет ключа» отличается от сетевого сбоя), новые файлы — в MinIO под `shorts/<id>/<путь>`. Сборка ролика со сценками берёт клипы и animation.json оттуда же. Порядок очередей — сборка, оживление, съёмка. Рабочему процессу нужен ключ Google.

- [ ] **Step 1: Тест**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/studio/src/worker/db.integration.ts
+++ b/studio/src/worker/db.integration.ts
@@ -17,11 +17,12 @@
 import pg from 'pg';
 import { StudioError } from '../errors';
 import {
-  LEASE_MINUTES, MAX_JOB_ATTEMPTS, claimJob, completeCapture, completeRender, failJob, minAnswerChars, type StoredCapture,
+  LEASE_MINUTES, MAX_JOB_ATTEMPTS, claimJob, completeAnimate, completeCapture, completeRender, failJob, maxOmniSeconds, minAnswerChars,
+  saveAnimation, type StoredCapture,
 } from './db';
 
 const DB_URL = process.env.STUDIO_PG_URL;
-const MIGRATION = fileURLToPath(new URL('../../../src/shorts/migrations/001_shorts.sql', import.meta.url));
+const MIGRATIONS = ['001_shorts.sql', '002_skits.sql'].map((f) => fileURLToPath(new URL(`../../../src/shorts/migrations/${f}`, import.meta.url)));
 const skip = DB_URL ? false : 'нет STUDIO_PG_URL — нужна одноразовая база (рецепт в шапке файла)';
 
 describe('очередь студии против живого Postgres', { skip }, () => {
@@ -38,7 +39,7 @@
       const n = await pool.query('SELECT count(*)::int AS n FROM short_video');
       if (n.rows[0].n > 0) throw new Error('в short_video уже есть строки — нужна одноразовая база');
     }
-    await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
+    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(f, 'utf8'));
     ours = true;
   });
 
@@ -112,6 +113,50 @@
     );
   });
 
+  it('оживление: захват отдаёт итог прошлых попыток; по ходу и итог — только своим захватом; готово — render_queued', async () => {
+    const before = { omniSeconds: 8, keyframes: 1, skits: {}, pending: { conflict: { id: 'gen-1', fingerprint: 'fp' } } };
+    const id = await insert('animate_queued', { animation: JSON.stringify(before) });
+    const job = await claimJob(pool, 'animate');
+    assert.deepEqual([job?.id, job?.attempts, (await row(id)).status], [id, 1, 'animating']);
+    assert.deepEqual(job?.animation, before);
+
+    const mid = { ...before, omniSeconds: 16 };
+    assert.equal(await saveAnimation(pool, job!, mid), true);
+    assert.deepEqual((await row(id)).animation, mid);
+    assert.equal(await saveAnimation(pool, { ...job!, attempts: 2 }, before), false, 'чужой захват не пишет');
+
+    const done = { omniSeconds: 16, keyframes: 2, skits: {}, pending: {} };
+    assert.equal(await completeAnimate(pool, job!, done), true);
+    const r = await row(id);
+    assert.deepEqual([r.status, r.attempts, r.lease_until, r.animation], ['render_queued', 0, null, done]);
+    assert.equal(await saveAnimation(pool, job!, before), false, 'после итога задание уже не на оживлении');
+  });
+
+  it('оживление упало без повтора — failed с этапа animating; с повтором — назад в очередь с паузой', async () => {
+    const a = await insert('animate_queued');
+    const ja = await claimJob(pool, 'animate');
+    assert.equal(await failJob(pool, ja!, new StudioError('omni_budget', 'лимит пересъёмок сценок', false)), 'failed');
+    const ra = await row(a);
+    assert.deepEqual([ra.status, ra.failed_from, ra.last_error], ['failed', 'animating', 'оживление: лимит пересъёмок сценок']);
+
+    const b = await insert('animate_queued');
+    const jb = await claimJob(pool, 'animate');
+    assert.equal(await failJob(pool, jb!, new StudioError('unknown', 'ECONNRESET', true)), 'retry');
+    const rb = await row(b);
+    assert.equal(rb.status, 'animate_queued');
+    assert.ok(new Date(rb.lease_until).getTime() > Date.now());
+  });
+
+  it('предел секунд Omni — из настроек', async () => {
+    assert.equal(await maxOmniSeconds(pool), 48);
+    await pool.query('UPDATE short_settings SET max_omni_seconds = 96 WHERE id = 1');
+    try {
+      assert.equal(await maxOmniSeconds(pool), 96);
+    } finally {
+      await pool.query('UPDATE short_settings SET max_omni_seconds = 48 WHERE id = 1');
+    }
+  });
+
   it('съёмка готова — writing и съёмка в базе', async () => {
     const id = await insert('capture_queued');
     const job = await claimJob(pool, 'capture');
--- a/studio/src/worker/storage.test.ts
+++ b/studio/src/worker/storage.test.ts
@@ -36,3 +36,18 @@
   assert.equal(fs.readFileSync(path.join(dir, 'got.mp4'), 'utf8'), 'видео');
   fs.rmSync(dir, { recursive: true, force: true });
 });
+
+test('файла может не быть: нет ключа — false и файла нет; сетевой сбой — ошибка, а не «нет»', async () => {
+  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-storage-'));
+  const missing = s3Storage(cfg, { send: async () => { throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }); } });
+  assert.equal(await missing.getIfExists('shorts/x/skits/f/raw.mp4', path.join(dir, 'raw.mp4')), false);
+  assert.equal(fs.existsSync(path.join(dir, 'raw.mp4')), false);
+
+  const present = s3Storage(cfg, { send: async () => ({ Body: Readable.from([Buffer.from('клип')]) }) });
+  assert.equal(await present.getIfExists('shorts/x/skits/f/raw.mp4', path.join(dir, 'raw.mp4')), true);
+  assert.equal(fs.readFileSync(path.join(dir, 'raw.mp4'), 'utf8'), 'клип');
+
+  const down = s3Storage(cfg, { send: async () => { throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }); } });
+  await assert.rejects(down.getIfExists('shorts/x/skits/f/raw.mp4', path.join(dir, 'other.mp4')), /socket hang up/);
+  fs.rmSync(dir, { recursive: true, force: true });
+});
--- a/studio/src/worker/jobs.test.ts
+++ b/studio/src/worker/jobs.test.ts
@@ -5,9 +5,9 @@
 import path from 'node:path';
 import { StudioError } from '../errors';
 import type { RenderResult } from '../render/run-render';
-import type { CaptureResult, Scene, Script } from '../types';
-import type { FailOutcome, Job, Queue, RenderOutput, StoredCapture } from './db';
-import { coverKey, pruneOld, runOne, shotKey, videoKey, type JobDeps } from './jobs';
+import type { CaptureResult, Scene, Script, ShortAnimation } from '../types';
+import type { FailOutcome, Job, JobKind, Queue, RenderOutput, StoredCapture } from './db';
+import { animationKey, coverKey, pruneOld, runOne, shotKey, videoKey, type JobDeps } from './jobs';
 import type { Storage } from './storage';
 
 const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
@@ -15,8 +15,8 @@
 const script = { hook: 'h', voice: 'madirus', lines: [], final: { assistantsCount: 18 } } as unknown as Script;
 
 /** written — что вернут записи итога; failOutcome — исход сбоя. jobs — задания, с которыми звали очередь. */
-function fakeQueue(jobs: Partial<Record<'capture' | 'render', Job>>, opts: { written?: boolean; failOutcome?: FailOutcome } = {}) {
-  const calls: Record<string, unknown[]> = { capture: [], render: [], fail: [], claim: [], jobs: [] };
+function fakeQueue(jobs: Partial<Record<JobKind, Job>>, opts: { written?: boolean; failOutcome?: FailOutcome; saved?: boolean } = {}) {
+  const calls: Record<string, unknown[]> = { capture: [], render: [], animate: [], save: [], fail: [], claim: [], jobs: [] };
   const queue: Queue = {
     async claim(kind) {
       calls.claim.push(kind);
@@ -34,6 +34,15 @@
       calls.jobs.push(j);
       return opts.written ?? true;
     },
+    async completeAnimate(j, animation) {
+      calls.animate.push([j.id, animation]);
+      calls.jobs.push(j);
+      return opts.written ?? true;
+    },
+    async saveAnimation(j, animation) {
+      calls.save.push([j.id, animation]);
+      return opts.saved ?? true;
+    },
     async fail(j, err): Promise<FailOutcome> {
       calls.fail.push([j.id, err]);
       calls.jobs.push(j);
@@ -42,21 +51,31 @@
     async minAnswerChars() {
       return 500;
     },
+    async maxOmniSeconds() {
+      return 48;
+    },
   };
   return { queue, calls };
 }
 
 function fakeStorage() {
   const files = new Map<string, string>();
+  const types = new Map<string, string>();
   const storage: Storage = {
-    async put(key, file) {
+    async put(key, file, contentType) {
       files.set(key, fs.readFileSync(file, 'utf8'));
+      types.set(key, contentType);
     },
     async get(key, dest) {
       fs.writeFileSync(dest, files.get(key) ?? '');
     },
+    async getIfExists(key, dest) {
+      if (!files.has(key)) return false;
+      fs.writeFileSync(dest, files.get(key)!);
+      return true;
+    },
   };
-  return { storage, files };
+  return { storage, files, types };
 }
 
 function deps(over: Partial<JobDeps> & Pick<JobDeps, 'queue' | 'storage'>): JobDeps {
@@ -65,6 +84,9 @@
     capture: async () => {
       throw new Error('съёмка не ожидалась');
     },
+    animate: async () => {
+      throw new Error('оживление не ожидалось');
+    },
     render: async () => {
       throw new Error('сборка не ожидалась');
     },
@@ -73,8 +95,8 @@
   };
 }
 
-const job = (kind: 'capture' | 'render', over: Partial<Job> = {}): Job => ({
-  id: ID, kind, attempts: 1, writerRounds: 0, scene, capture: null, script: null, ...over,
+const job = (kind: JobKind, over: Partial<Job> = {}): Job => ({
+  id: ID, kind, attempts: 1, writerRounds: 0, scene, capture: null, script: null, animation: null, ...over,
 });
 
 test('съёмка: снимки — в MinIO под ключами попытки, съёмка — в базу без путей', async () => {
@@ -126,10 +148,10 @@
   assert.deepEqual(calls.render[0], [ID, { videoKey: `shorts/${ID}/video.mp4`, coverKey: `shorts/${ID}/cover.jpg`, durationMs: 44200 } satisfies RenderOutput]);
 });
 
-test('сборка — первой: ролик ближе к концу пути', async () => {
-  const { queue, calls } = fakeQueue({ capture: job('capture'), render: job('render') });
+test('сборка — первой, оживление — до съёмки: ролик ближе к концу пути', async () => {
+  const { queue, calls } = fakeQueue({});
   await runOne(deps({ queue, storage: fakeStorage().storage }));
-  assert.equal(calls.claim[0], 'render');
+  assert.deepEqual(calls.claim, ['render', 'animate', 'capture']);
 });
 
 test('проверка файла не прошла — video_invalid с повтором', async () => {
@@ -223,3 +245,114 @@
   assert.deepEqual(fs.readdirSync(root), ['fresh']);
   assert.equal(pruneOld(path.join(root, 'нет такой'), 7), 0);
 });
+
+// ── Оживление сценок и сборка со сценками ──
+
+const skitPlan = (kind: string, box?: number) => ({
+  skit: {
+    cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
+    setting: 's', opening: 'o', action: 'a',
+    lines: [{ hero: 'kesha', text: 'Реплика', ...(box ? { box } : {}) }],
+  },
+  troupeVersion: 'v1', heroes: ['galina', 'kesha'], keyframePrompt: 'k', videoPrompt: 'v',
+  keyframeFingerprint: `kf-${kind}`, fingerprint: `fp-${kind}`,
+});
+const skitScript = {
+  hook: 'Залог за обои?', voice: 'madirus',
+  lines: [{ id: 'q', scene: 'question', text: 'Вопрос' }, { id: 'a1', scene: 'answer', text: 'Ответ', box: 1 }, { id: 'f', scene: 'final', text: 'Финал' }],
+  final: { assistantsCount: 18 },
+  skits: { conflict: skitPlan('c'), punchline: skitPlan('p', 1) },
+} as unknown as Script;
+const skitCapture = { scene, questionShotKey: 'q', answerShotKey: 'a', boxes: [{ n: 1, top: 0, height: 10, text: 'a' }], paragraphs: [] } as unknown as StoredCapture;
+
+test('оживление: счёт денег — из базы, готовое — из MinIO; по ходу — в базу и в MinIO; итог — очереди', async () => {
+  const stored: ShortAnimation = { omniSeconds: 8, keyframes: 1, skits: {}, pending: { conflict: { id: 'gen-1', fingerprint: 'fp-c' } } };
+  const { queue, calls } = fakeQueue({ animate: job('animate', { capture: skitCapture, script: skitScript, animation: stored }) });
+  const { storage, files, types } = fakeStorage();
+  files.set(animationKey(ID, 'keyframes/kf-c.jpg'), 'кадр конфликта');
+  files.set(animationKey(ID, 'skits/fp-c/raw.mp4'), 'оплаченный клип');
+  const final: ShortAnimation = { omniSeconds: 16, keyframes: 2, skits: {}, pending: {} };
+  const d = deps({
+    queue,
+    storage,
+    animate: async (runDir, hooks) => {
+      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'animation.json'), 'utf8')), stored);
+      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'script.json'), 'utf8')), skitScript);
+      assert.equal(fs.readFileSync(path.join(runDir, 'keyframes/kf-c.jpg'), 'utf8'), 'кадр конфликта');
+      assert.equal(fs.readFileSync(path.join(runDir, 'skits/fp-c/raw.mp4'), 'utf8'), 'оплаченный клип');
+      assert.equal(fs.existsSync(path.join(runDir, 'skits/fp-p/raw.mp4')), false);
+      assert.equal(hooks.maxOmniSeconds, 48);
+      await hooks.onSave({ ...stored, omniSeconds: 16 });
+      fs.mkdirSync(path.join(runDir, 'keyframes'), { recursive: true });
+      fs.writeFileSync(path.join(runDir, 'keyframes/kf-p.png'), 'кадр развязки');
+      await hooks.onFile('keyframes/kf-p.png');
+      return final;
+    },
+  });
+  assert.equal(await runOne(d), true);
+  assert.deepEqual(calls.save, [[ID, { ...stored, omniSeconds: 16 }]]);
+  assert.equal(files.get(animationKey(ID, 'keyframes/kf-p.png')), 'кадр развязки');
+  assert.equal(types.get(animationKey(ID, 'keyframes/kf-p.png')), 'image/png');
+  assert.deepEqual(calls.animate, [[ID, final]]);
+  assert.equal(calls.fail.length, 0);
+});
+
+test('оживление: задание уже не наше — сохранение по ходу отказывает, сбой без повтора', async () => {
+  const { queue, calls } = fakeQueue({ animate: job('animate', { capture: skitCapture, script: skitScript }) }, { saved: false });
+  const d = deps({
+    queue,
+    storage: fakeStorage().storage,
+    animate: async (_runDir, hooks) => {
+      await hooks.onSave({ omniSeconds: 0, skits: {} });
+      throw new Error('дальше идти нельзя');
+    },
+  });
+  await runOne(d);
+  const [, err] = calls.fail[0] as [string, StudioError];
+  assert.deepEqual([err.code, err.retryable], ['unknown', false]);
+  assert.match(err.message, /другой процесс/);
+});
+
+test('оживление: нет сценок — no_input; сценарий не прошёл проверку студии — script_invalid; до трат', async () => {
+  const a = fakeQueue({ animate: job('animate', { capture: skitCapture, script }) });
+  await runOne(deps({ queue: a.queue, storage: fakeStorage().storage }));
+  assert.equal((a.calls.fail[0] as [string, StudioError])[1].code, 'no_input');
+
+  const bad = { ...skitScript, hook: 'раз два три четыре пять шесть семь' } as Script;
+  const b = fakeQueue({ animate: job('animate', { capture: skitCapture, script: bad }) });
+  await runOne(deps({ queue: b.queue, storage: fakeStorage().storage }));
+  const [, err] = b.calls.fail[0] as [string, StudioError];
+  assert.deepEqual([err.code, err.retryable], ['script_invalid', false]);
+  assert.match(err.message, /зацепка длиннее 6 слов/);
+});
+
+test('сборка со сценками: клипы — из MinIO по animation, animation.json — в папку сборки', async () => {
+  const clip = (kind: string) => ({ fingerprint: `fp-${kind}`, keyframe: `keyframes/kf-${kind}.jpg`, clip: `skits/fp-${kind}/clip.mp4`, durationMs: 8000, heard: '', cues: [], attempts: 1, post: 'v2' });
+  const animation: ShortAnimation = { omniSeconds: 16, keyframes: 2, skits: { conflict: clip('c'), punchline: clip('p') } };
+  const { queue, calls } = fakeQueue({ render: job('render', { capture: skitCapture, script: skitScript, animation }) });
+  const { storage, files } = fakeStorage();
+  files.set(animationKey(ID, 'skits/fp-c/clip.mp4'), 'клип конфликта');
+  files.set(animationKey(ID, 'skits/fp-p/clip.mp4'), 'клип развязки');
+  const d = deps({
+    queue,
+    storage,
+    render: async (runDir): Promise<RenderResult> => {
+      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'animation.json'), 'utf8')), animation);
+      assert.equal(fs.readFileSync(path.join(runDir, 'skits/fp-c/clip.mp4'), 'utf8'), 'клип конфликта');
+      assert.equal(fs.readFileSync(path.join(runDir, 'skits/fp-p/clip.mp4'), 'utf8'), 'клип развязки');
+      fs.writeFileSync(path.join(runDir, 'video.mp4'), 'видео');
+      fs.writeFileSync(path.join(runDir, 'cover.jpg'), 'обложка');
+      return { video: path.join(runDir, 'video.mp4'), cover: path.join(runDir, 'cover.jpg'), problems: [], durationSec: 33 };
+    },
+  });
+  await runOne(d);
+  assert.equal(calls.fail.length, 0);
+  assert.equal(calls.render.length, 1);
+});
+
+test('сборка со сценками без оживления — no_input без повтора', async () => {
+  const { queue, calls } = fakeQueue({ render: job('render', { capture: skitCapture, script: skitScript }) });
+  await runOne(deps({ queue, storage: fakeStorage().storage }));
+  const [, err] = calls.fail[0] as [string, StudioError];
+  assert.deepEqual([err.code, err.retryable], ['no_input', false]);
+});
PATCH
````

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/worker/db.integration.ts studio/src/worker/storage.test.ts studio/src/worker/jobs.test.ts
git -C "$WT" commit -m "test(studio): задание animate в рабочем процессе (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- studio/src/worker/db.integration.ts studio/src/worker/storage.test.ts studio/src/worker/jobs.test.ts
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/worker/jobs.test.ts src/worker/storage.test.ts"
```

Expected: оба файла падают (нет getIfExists, animationKey, очереди animate).

- [ ] **Step 3: Реализация**

Наложить патч:

````bash
git -C "$WT" apply <<'PATCH'
--- a/studio/src/worker/db.ts
+++ b/studio/src/worker/db.ts
@@ -1,12 +1,12 @@
 import { WRITER_FEEDBACK_CODES, type StudioError, type StudioErrorCode } from '../errors';
-import type { CaptureResult, Scene, Script } from '../types';
+import type { CaptureResult, Scene, Script, ShortAnimation } from '../types';
 
 /** То, что нужно от pg.Pool, — чтобы в тестах рабочего процесса его можно было заменить. */
 export interface Queryable {
   query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
 }
 
-export type JobKind = 'capture' | 'render';
+export type JobKind = 'capture' | 'animate' | 'render';
 
 interface QueueSpec {
   queued: string;
@@ -18,6 +18,7 @@
 /** Очереди студии в short_video. Статусы и колонки — контракт с src/shorts/shorts.types.ts бэкенда. */
 export const QUEUES: Record<JobKind, QueueSpec> = {
   capture: { queued: 'capture_queued', running: 'capturing', label: 'съёмка' },
+  animate: { queued: 'animate_queued', running: 'animating', label: 'оживление' },
   render: { queued: 'render_queued', running: 'rendering', label: 'сборка' },
 };
 
@@ -52,6 +53,8 @@
   scene: Scene | null;
   capture: StoredCapture | null;
   script: Script | null;
+  /** Итог оживления: счёт секунд Omni, кадры, сценки, запущенные генерации. Пути — относительно shorts/<id>/ в MinIO. */
+  animation: ShortAnimation | null;
 }
 
 export interface RenderOutput {
@@ -77,8 +80,13 @@
   completeCapture(job: Job, capture: StoredCapture): Promise<boolean>;
   /** @returns false — итог не записан: задание уже не за этим захватом */
   completeRender(job: Job, out: RenderOutput): Promise<boolean>;
+  /** @returns false — итог не записан: задание уже не за этим захватом */
+  completeAnimate(job: Job, animation: ShortAnimation): Promise<boolean>;
+  /** Промежуточное сохранение оживления. @returns false — задание уже не за этим захватом */
+  saveAnimation(job: Job, animation: ShortAnimation): Promise<boolean>;
   fail(job: Job, err: StudioError): Promise<FailOutcome>;
   minAnswerChars(): Promise<number>;
+  maxOmniSeconds(): Promise<number>;
 }
 
 /**
@@ -112,7 +120,7 @@
          ORDER BY slot_at NULLS LAST, created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
-      RETURNING id, attempts, writer_rounds, scene, capture, script`,
+      RETURNING id, attempts, writer_rounds, scene, capture, script, animation`,
     [q.queued, q.running, LEASE_MINUTES, MAX_JOB_ATTEMPTS],
   );
   const row = r.rows[0];
@@ -125,6 +133,7 @@
     scene: row.scene ?? null,
     capture: row.capture ?? null,
     script: row.script ?? null,
+    animation: row.animation ?? null,
   };
 }
 
@@ -162,6 +171,35 @@
 }
 
 /**
+ * Сценки ожили — render_queued: сборка возьмёт клипы по animation.
+ * @returns false — итог не записан: задание уже не за этим захватом
+ */
+export async function completeAnimate(db: Queryable, job: Job, animation: ShortAnimation): Promise<boolean> {
+  const r = await db.query(
+    `UPDATE short_video
+        SET status = 'render_queued', animation = $2::jsonb, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
+      WHERE id = $1 AND status = 'animating' AND attempts = $3`,
+    [job.id, JSON.stringify(animation), job.attempts],
+  );
+  return (r.rowCount ?? 0) > 0;
+}
+
+/**
+ * Оживление по ходу: резерв секунд Omni, id запущенной генерации, готовые сценки.
+ * Падение процесса посреди задания иначе стоило бы новой оплаты: следующий захват
+ * не знал бы, что генерация уже запущена. Пишется тем же захватом, что и итог.
+ * @returns false — задание уже не за этим захватом: продолжать нельзя
+ */
+export async function saveAnimation(db: Queryable, job: Job, animation: ShortAnimation): Promise<boolean> {
+  const r = await db.query(
+    `UPDATE short_video SET animation = $2::jsonb, updated_at = now()
+      WHERE id = $1 AND status = 'animating' AND attempts = $3`,
+    [job.id, JSON.stringify(animation), job.attempts],
+  );
+  return (r.rowCount ?? 0) > 0;
+}
+
+/**
  * Слово-вводка перед сообщением сценаристу в writer_feedback: для кодов по длине
  * озвучки сообщение само по себе («timeline: ролик 63.2 с — длиннее 60 с») не
  * называет этап, вводка нужна. У script_invalid сообщение уже называет его
@@ -246,12 +284,21 @@
   return Number(r.rows[0]?.min_answer_chars ?? 400);
 }
 
+/** Предел секунд Omni на ролик — из настроек админки (спека сценок, «Отказы»). */
+export async function maxOmniSeconds(db: Queryable): Promise<number> {
+  const r = await db.query('SELECT max_omni_seconds FROM short_settings WHERE id = 1');
+  return Number(r.rows[0]?.max_omni_seconds ?? 48);
+}
+
 export function pgQueue(db: Queryable): Queue {
   return {
     claim: (kind) => claimJob(db, kind),
     completeCapture: (job, capture) => completeCapture(db, job, capture),
     completeRender: (job, out) => completeRender(db, job, out),
+    completeAnimate: (job, animation) => completeAnimate(db, job, animation),
+    saveAnimation: (job, animation) => saveAnimation(db, job, animation),
     fail: (job, err) => failJob(db, job, err),
     minAnswerChars: () => minAnswerChars(db),
+    maxOmniSeconds: () => maxOmniSeconds(db),
   };
 }
--- a/studio/src/worker/storage.ts
+++ b/studio/src/worker/storage.ts
@@ -4,10 +4,16 @@
 import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
 import type { MinioConfig } from '../config';
 
-/** Файлы заданий: снимки съёмки, видео и обложка (ключи — в jobs.ts). */
+/** Файлы заданий: снимки съёмки, кадры и клипы сценок, видео и обложка (ключи — в jobs.ts). */
 export interface Storage {
   put(key: string, file: string, contentType: string): Promise<void>;
   get(key: string, dest: string): Promise<void>;
+  /**
+   * Файл, которого может и не быть (кадр, клип прошлых попыток). false — ключа
+   * нет; сетевой сбой — ошибка: принять его за «нет» значило бы заплатить за
+   * клип второй раз.
+   */
+  getIfExists(key: string, dest: string): Promise<boolean>;
 }
 
 /**
@@ -32,5 +38,16 @@
       const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
       await pipeline(res.Body as Readable, fs.createWriteStream(dest));
     },
+    async getIfExists(key, dest) {
+      let res: any;
+      try {
+        res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
+      } catch (e: any) {
+        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return false;
+        throw e;
+      }
+      await pipeline(res.Body as Readable, fs.createWriteStream(dest));
+      return true;
+    },
   };
 }
--- a/studio/src/worker/jobs.ts
+++ b/studio/src/worker/jobs.ts
@@ -2,16 +2,25 @@
 import path from 'node:path';
 import { StudioError, toStudioError } from '../errors';
 import type { RenderResult } from '../render/run-render';
-import type { CaptureResult, Scene } from '../types';
+import { validateScript } from '../script';
+import { SKIT_KINDS, type CaptureResult, type Scene, type ShortAnimation } from '../types';
 import type { Job, JobKind, Queue } from './db';
 import type { Storage } from './storage';
 
+/** Что задание animate получает от рабочего процесса: предел секунд Omni и куда сохранять по ходу. */
+export interface AnimateHooks {
+  maxOmniSeconds: number;
+  onSave(anim: ShortAnimation): Promise<void>;
+  onFile(rel: string): Promise<void>;
+}
+
 export interface JobDeps {
   queue: Queue;
   storage: Storage;
-  /** Рабочие папки заданий: <workRoot>/<id>/capture-<попытка>, render-<попытка>. */
+  /** Рабочие папки заданий: <workRoot>/<id>/capture-<попытка>, render-<попытка>, animate (одна на все попытки). */
   workRoot: string;
   capture: (scene: Scene, runDir: string, minAnswerChars: number) => Promise<CaptureResult>;
+  animate: (runDir: string, hooks: AnimateHooks) => Promise<ShortAnimation>;
   render: (runDir: string) => Promise<RenderResult>;
   log: (line: string) => void;
 }
@@ -20,7 +29,16 @@
 export const shotKey = (id: string, attempt: number, name: string): string => `shorts/${id}/capture-${attempt}/${name}`;
 export const videoKey = (id: string): string => `shorts/${id}/video.mp4`;
 export const coverKey = (id: string): string => `shorts/${id}/cover.jpg`;
+/** Кадры и клипы сценок — по путям папки оживления (animation.json): shorts/<id>/keyframes/…, shorts/<id>/skits/<отпечаток>/…. */
+export const animationKey = (id: string, rel: string): string => `shorts/${id}/${rel}`;
 
+const CONTENT_TYPES: Record<string, string> = {
+  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.ogg': 'audio/ogg',
+};
+const contentType = (rel: string): string => CONTENT_TYPES[path.extname(rel)] ?? 'application/octet-stream';
+/** Расширения кадра: Nano Banana Pro отдаёт JPEG, но тип решает картинка (run-animate.ts, KEYFRAME_EXT). */
+const KEYFRAME_EXTS = ['jpg', 'png', 'webp'];
+
 /** Итог или сбой не записан: аренда истекла, и задание теперь не за этим захватом. */
 const GONE = 'задание забрал другой процесс — итог не записан';
 
@@ -47,6 +65,18 @@
   const { questionShotKey: _q, answerShotKey: _a, ...rest } = job.capture;
   fs.writeFileSync(path.join(runDir, 'capture.json'), JSON.stringify({ ...rest, questionShot: 'question.png', answerShot: 'answer.png' }, null, 2));
   fs.writeFileSync(path.join(runDir, 'script.json'), JSON.stringify(job.script, null, 2));
+  if (job.script.skits) {
+    // Ролик со сценками: клипы — из MinIO по animation; нет записи сценки — назовёт сборка (buildSkitProps).
+    if (!job.animation) throw new StudioError('no_input', 'у ролика со сценками нет оживления — сначала задание animate', false);
+    fs.writeFileSync(path.join(runDir, 'animation.json'), JSON.stringify(job.animation, null, 2));
+    for (const kind of SKIT_KINDS) {
+      const c = job.animation.skits?.[kind];
+      if (!c) continue;
+      const dest = path.join(runDir, c.clip);
+      fs.mkdirSync(path.dirname(dest), { recursive: true });
+      await d.storage.get(animationKey(job.id, c.clip), dest);
+    }
+  }
 
   const r = await d.render(runDir);
   if (r.problems.length) throw new StudioError('video_invalid', `проверка файла не прошла: ${r.problems.join('; ')}`, true);
@@ -56,9 +86,60 @@
   return d.queue.completeRender(job, out);
 }
 
-/** Сборка — первой: ролик ближе к концу пути и к владельцу. */
-const ORDER: JobKind[] = ['render', 'capture'];
+/**
+ * Папка оживления из MinIO: кадры и клипы сценок этого сценария, которых в ней
+ * нет (другой сервер, чистка старых папок). Готовое по отпечатку не
+ * переделывается, а оплаченный raw.mp4 не снимается заново.
+ */
+async function restoreAnimation(job: Job, runDir: string, storage: Storage): Promise<void> {
+  const skits = job.script!.skits!;
+  const want = new Set<string>();
+  for (const kind of SKIT_KINDS) {
+    const p = skits[kind];
+    for (const ext of KEYFRAME_EXTS) want.add(`keyframes/${p.keyframeFingerprint}.${ext}`);
+    want.add(`skits/${p.fingerprint}/raw.mp4`);
+    want.add(`skits/${p.fingerprint}/clip.mp4`);
+  }
+  for (const rel of want) {
+    const dest = path.join(runDir, rel);
+    if (fs.existsSync(dest)) continue;
+    fs.mkdirSync(path.dirname(dest), { recursive: true });
+    await storage.getIfExists(animationKey(job.id, rel), dest);
+  }
+}
 
+/**
+ * Оживление сценок (studio/src/animate/run-animate.ts). Счёт денег — из базы:
+ * локальный animation.json перезаписывается её версией. По ходу задание
+ * сохраняет animation в базу (резерв секунд, id генерации) и кладёт новые
+ * файлы в MinIO — падение процесса не стоит новой оплаты.
+ * @returns false — итог не записан: задание забрал другой процесс
+ */
+export async function runAnimate(job: Job, d: JobDeps): Promise<boolean> {
+  if (!job.script?.skits || !job.capture) throw new StudioError('no_input', 'у ролика нет сценок или съёмки', false);
+  const problems = validateScript(job.script, job.capture);
+  if (problems.length) throw new StudioError('script_invalid', `сценарий не прошёл проверку:\n- ${problems.join('\n- ')}`, false);
+  // Одна папка на все попытки: готовые кадры и клипы переживают повтор задания.
+  const runDir = path.join(d.workRoot, job.id, 'animate');
+  fs.mkdirSync(runDir, { recursive: true });
+  fs.writeFileSync(path.join(runDir, 'script.json'), JSON.stringify(job.script, null, 2));
+  const animPath = path.join(runDir, 'animation.json');
+  if (job.animation) fs.writeFileSync(animPath, JSON.stringify(job.animation, null, 2));
+  else fs.rmSync(animPath, { force: true });
+  await restoreAnimation(job, runDir, d.storage);
+  const animation = await d.animate(runDir, {
+    maxOmniSeconds: await d.queue.maxOmniSeconds(),
+    onSave: async (a) => {
+      if (!(await d.queue.saveAnimation(job, a))) throw new StudioError('unknown', GONE, false);
+    },
+    onFile: (rel) => d.storage.put(animationKey(job.id, rel), path.join(runDir, rel), contentType(rel)),
+  });
+  return d.queue.completeAnimate(job, animation);
+}
+
+/** Сборка — первой: ролик ближе к концу пути и к владельцу; оживление — до съёмки по той же причине. */
+const ORDER: JobKind[] = ['render', 'animate', 'capture'];
+
 /** Одно задание: взять, выполнить, при сбое — отдать очереди с кодом. @returns false — заданий нет */
 export async function runOne(d: JobDeps): Promise<boolean> {
   for (const kind of ORDER) {
@@ -66,7 +147,8 @@
     if (!job) continue;
     d.log(`${kind} ${job.id}: попытка ${job.attempts}`);
     try {
-      const written = kind === 'capture' ? await runCapture(job, d) : await runRender(job, d);
+      const run = kind === 'capture' ? runCapture : kind === 'animate' ? runAnimate : runRender;
+      const written = await run(job, d);
       d.log(`${kind} ${job.id}: ${written ? 'готово' : GONE}`);
     } catch (e) {
       const err = toStudioError(e);
--- a/studio/src/worker/worker.ts
+++ b/studio/src/worker/worker.ts
@@ -1,6 +1,9 @@
 import 'dotenv/config';
 import path from 'node:path';
 import pg from 'pg';
+import { generateKeyframe, startClip, waitClip, type GoogleDeps } from '../animate/google';
+import { animateRun } from '../animate/run-animate';
+import { recognize } from '../animate/stt';
 import { captureScene } from '../capture/run-capture';
 import { parseConfig } from '../config';
 import { renderRun } from '../render/run-render';
@@ -9,8 +12,10 @@
 import { s3Storage } from './storage';
 
 /**
- * Рабочий процесс студии: забирает задания capture и render из short_video,
- * по одному за раз (спека: «по одному заданию за раз»).
+ * Рабочий процесс студии: забирает задания capture, animate и render из
+ * short_video, по одному за раз (спека: «по одному заданию за раз»). Оживлению
+ * нужен ключ Google (GOOGLE_AI_API_KEY): без него процесс не стартует — громче,
+ * чем ролики, молча падающие на этапе animate.
  *   npm run worker            — цикл; без заданий — пауза IDLE_MS
  *   npm run worker -- --once  — одно задание и выход (стенд в плане 2)
  * SIGTERM/SIGINT — дождаться текущего задания и выйти; брошенное задание
@@ -27,7 +32,9 @@
  */
 const JOB_DEADLINE_MS = (LEASE_MINUTES - 2) * 60_000;
 
-const cfg = parseConfig(process.env, { capture: true, tts: true, worker: true });
+const cfg = parseConfig(process.env, { capture: true, tts: true, worker: true, animate: true });
+const google: GoogleDeps = { apiKey: cfg.googleKey };
+const stt = { apiKey: cfg.speechkitKey, folderId: cfg.speechkitFolder };
 const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
 const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);
 const deps: JobDeps = {
@@ -35,6 +42,17 @@
   storage: s3Storage(cfg.minio!),
   workRoot: path.resolve('out', 'jobs'),
   capture: (scene, runDir, minAnswerChars) => captureScene(scene, cfg, runDir, minAnswerChars),
+  animate: (runDir, hooks) =>
+    animateRun(runDir, {
+      keyframe: (prompt, refs) => generateKeyframe(google, prompt, refs),
+      startClip: (prompt, image) => startClip(google, prompt, image),
+      waitClip: (id) => waitClip(google, id),
+      recognize: (ogg) => recognize(ogg, stt),
+      maxOmniSeconds: hooks.maxOmniSeconds,
+      onSave: hooks.onSave,
+      onFile: hooks.onFile,
+      log,
+    }),
   render: (runDir) => renderRun(runDir),
   log,
 };
--- a/studio/README.md
+++ b/studio/README.md
@@ -11,6 +11,7 @@
 studio/scripts/node-run.sh "npm run test:render" # сквозной рендер фикстуры, без сети
 studio/scripts/node-run.sh "npm run capture -- scenes/<сцена>.json [--probe]"
 studio/scripts/node-run.sh "npm run render -- out/<папка-съёмки>"
+studio/scripts/node-run.sh "MAX_OMNI_SECONDS=16 npm run animate -- out/<папка-ролика>"  # сценки, платно
 ```
 
 `node-run.sh` пушит ветку и ставит `~/ci/wt/promo-shorts` на точный коммит.
@@ -30,6 +31,13 @@
    озвучки (30–60 с), Remotion → `video.mp4` и `cover.jpg`, затем проверка
    длины, кадра и тишины по всей длине.
 
+Ролик со сценками (`docs/superpowers/specs/2026-10-26-shorts-skits-design.md`)
+между сценарием и сборкой проходит `animate`: кадр-эталон каждой сценки (Nano
+Banana Pro), клип Omni на 8 с, сверка речи SpeechKit, громкость и время реплик →
+`animation.json`, `keyframes/`, `skits/`. Сборка — композиция `SkitShort`,
+ролик 25–45 с. Это деньги Google: клип ≈ $0,8, кадр ≈ $0,13, предел — секунд
+Omni на ролик (`MAX_OMNI_SECONDS`, в конвейере — настройка админки).
+
 Лицензия Remotion — бесплатная, пока в компании не больше трёх человек
 (remotion.pro/license).
 
@@ -37,7 +45,8 @@
 
 Ролики заказывает и ведёт API (`src/shorts/`): режиссёр пишет сцену, сценарист —
 сценарий, бот присылает готовый ролик владельцу. Студия — рабочий процесс,
-который забирает из `short_video` задания `capture` и `render`:
+который забирает из `short_video` задания `capture`, `animate` (ролики со
+сценками) и `render`:
 
 ```bash
 studio/scripts/node-run.sh "npm run worker -- --once"   # одно задание и выход
@@ -51,7 +60,12 @@
   озвучка вне 30–60 с — сценарий назад сценаристу; остальное — `failed`, и API
   пишет владельцу.
 - Файлы — в MinIO, бакет `MINIO_BUCKET_VIDEOS`:
-  `shorts/<id>/capture-<попытка>/{question,answer}.png`, `shorts/<id>/{video.mp4,cover.jpg}`.
+  `shorts/<id>/capture-<попытка>/{question,answer}.png`, `shorts/<id>/{video.mp4,cover.jpg}`,
+  у сценок — `shorts/<id>/keyframes/<отпечаток кадра>.jpg` и `shorts/<id>/skits/<отпечаток клипа>/{raw,clip}.mp4`.
+- Оживление по ходу пишет в базу `animation` (резерв секунд Omni, id запущенной
+  генерации) и кладёт кадры и клипы в MinIO: упавший процесс не стоит новой
+  оплаты, следующий захват дождётся запущенной генерации. Рабочему процессу
+  нужен `GOOGLE_AI_API_KEY` — без него он не стартует.
 - Рабочие папки — `out/jobs/<id>/`, старше недели удаляются при старте.
 
 Окружение рабочего процесса — `DATABASE_URL` и `MINIO_*` той же среды, что API
PATCH
````

- [ ] **Step 4: Закоммитить и прогнать**

```bash
git -C "$WT" add studio/src/worker/db.ts studio/src/worker/storage.ts studio/src/worker/jobs.ts studio/src/worker/worker.ts studio/README.md
git -C "$WT" commit -m "feat(studio): задание animate в рабочем процессе — очередь, сохранение по ходу, кадры и клипы в MinIO, сборка со сценками

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- studio/src/worker/db.ts studio/src/worker/storage.ts studio/src/worker/jobs.ts studio/src/worker/worker.ts studio/README.md
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/worker/jobs.test.ts src/worker/storage.test.ts && STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npx tsx --test src/worker/db.integration.ts && npm run -s typecheck && echo TSC_OK"
```

Expected: `# pass 16`, живая очередь — `# pass 15`, затем `TSC_OK`.

---

### Task 14: Сторож контракта: оживление

**Files:**
- Test: `src/shorts/shorts.contract.spec.ts`

Поля `ShortAnimation` и клипа сценки у API и студии, статусы и колонки очереди animate, ключи MinIO, цены в подписи и в выводе студии, пределы слов зацепки — одинаковы с обеих сторон. Тест сразу зелёный: он сторожит то, что сделали задачи 1–13.

- [ ] **Step 1: Тест-сторож**

Наложить патч из корня воркдерева:

````bash
git -C "$WT" apply <<'PATCH'
--- a/src/shorts/shorts.contract.spec.ts
+++ b/src/shorts/shorts.contract.spec.ts
@@ -6,8 +6,20 @@
  */
 import * as fs from 'fs';
 import * as path from 'path';
+import { KEYFRAME_USD, OMNI_USD_PER_SEC } from './short-captions';
+import { MAX_HOOK_WORDS, MAX_SKIT_HOOK_WORDS } from './short-rules';
 import { planSkits } from './short-skit-prompts';
 
+// Поле ищется внутри своего типа: skits и fingerprint есть и в соседних типах.
+const block = (src: string, file: string, name: string): string => {
+  const m = src.match(new RegExp(`(?:interface ${name}(?: extends [^{]+)? |type ${name} = )\\{([\\s\\S]*?)\\n\\}`));
+  if (!m) throw new Error(`${file}: нет типа ${name}`);
+  return m[1];
+};
+// Поля верхнего уровня — «имя:» или «имя?:» в начале строки; JSDoc и { … } в одну строку не мешают.
+const fields = (src: string, file: string, name: string): string[] =>
+  [...block(src, file, name).matchAll(/^\s*(\w+)(\?)?:/gm)].map((m) => m[1] + (m[2] ?? '')).sort();
+
 const studio = (p: string): string => fs.readFileSync(path.join(__dirname, '..', '..', 'studio', 'src', p), 'utf8');
 
 describe('контракт API и студии', () => {
@@ -15,7 +27,7 @@
     const types = studio('types.ts');
     for (const field of [
       'assistantId', 'assistantName', 'followups', 'answerShotWidth', 'answerShotHeight', 'answerText', 'turns',
-      'paragraphs', 'hookBox', 'badge', 'assistantsCount', 'disclaimer',
+      'paragraphs', 'hookBox', 'badge', 'assistantsCount', 'disclaimer', 'skit',
     ]) {
       expect(types).toMatch(new RegExp(`\\b${field}\\??:`));
     }
@@ -26,6 +38,7 @@
     for (const s of [
       "'capture_queued'", "'capturing'", "'render_queued'", "'rendering'", "status = 'writing'", "status = 'pending_review'",
       'writer_feedback', 'failed_from', 'failure_notified = false', 'questionShotKey', 'answerShotKey', 'review_message_id = NULL',
+      "'animate_queued'", "'animating'", "status = 'render_queued'", 'animation', 'max_omni_seconds',
     ]) {
       expect(db).toContain(s);
     }
@@ -40,15 +53,6 @@
   it('сценки: студия и бэкенд объявляют одни и те же поля, план сценок пишет ровно их', () => {
     const types = studio('types.ts');
     const back = fs.readFileSync(path.join(__dirname, 'short-skit-prompts.ts'), 'utf8');
-    // Поле ищется внутри своего типа: skits и fingerprint есть и в соседних типах.
-    const block = (src: string, file: string, name: string): string => {
-      const m = src.match(new RegExp(`(?:interface ${name}(?: extends [^{]+)? |type ${name} = )\\{([\\s\\S]*?)\\n\\}`));
-      if (!m) throw new Error(`${file}: нет типа ${name}`);
-      return m[1];
-    };
-    // Поля верхнего уровня — «имя:» или «имя?:» в начале строки; JSDoc и { … } в одну строку не мешают.
-    const fields = (src: string, file: string, name: string): string[] =>
-      [...block(src, file, name).matchAll(/^\s*(\w+)(\?)?:/gm)].map((m) => m[1] + (m[2] ?? '')).sort();
     for (const t of ['SkitLine', 'Skit', 'SkitPlan']) {
       expect({ [t]: fields(types, 'studio/src/types.ts', t) }).toEqual({ [t]: fields(back, 'short-skit-prompts.ts', t) });
     }
@@ -67,3 +71,29 @@
     expect(types.match(kind)?.[1]).toBe(back.match(kind)?.[1]);
   });
 });
+
+describe('контракт API и студии — оживление', () => {
+  const types = studio('types.ts');
+  const back = fs.readFileSync(path.join(__dirname, 'shorts.types.ts'), 'utf8');
+
+  it('animation: студия пишет те же поля, что читает API (подпись владельцу, сборка)', () => {
+    expect(fields(types, 'studio/src/types.ts', 'ShortAnimation')).toEqual(fields(back, 'shorts.types.ts', 'ShortAnimation'));
+    expect(fields(types, 'studio/src/types.ts', 'SkitClip')).toEqual(fields(back, 'shorts.types.ts', 'ShortSkitClip'));
+  });
+
+  it('кадры и клипы в MinIO — под shorts/<id>/ путями папки оживления', () => {
+    expect(studio('worker/jobs.ts')).toContain('shorts/${id}/${rel}');
+  });
+
+  it('цены в подписи владельцу и в выводе студии — одни и те же', () => {
+    const google = studio('animate/google.ts');
+    expect(google).toContain(`export const OMNI_USD_PER_SEC = ${OMNI_USD_PER_SEC};`);
+    expect(google).toContain(`export const KEYFRAME_USD = ${KEYFRAME_USD};`);
+  });
+
+  it('предел слов зацепки — один у API и у студии', () => {
+    const script = studio('script.ts');
+    expect(script).toContain(`export const HOOK_MAX_WORDS = ${MAX_HOOK_WORDS};`);
+    expect(script).toContain(`export const SKIT_HOOK_MAX_WORDS = ${MAX_SKIT_HOOK_WORDS};`);
+  });
+});
PATCH
````

- [ ] **Step 2: Закоммитить и прогнать**

```bash
git -C "$WT" add src/shorts/shorts.contract.spec.ts
git -C "$WT" commit -m "test(shorts): сторож контракта API и студии — оживление

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- src/shorts/shorts.contract.spec.ts
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts.contract.spec.ts"
```

Expected: 8 passed — сторож, а не красный тест.

---

### Правки по ревью (после задачи 14)

Ревью качества по трём группам задач (opus). Правки — коммитами поверх задачи 14, каждая пара «красный тест → правка» проверена на ноде; код — в самих коммитах (`git show <sha>`).

| Ревью | Итог | Красный | Правка | Что поправлено |
|---|---|---|---|---|
| Задачи 1–3 | одобрено с правками | `b02aa6b` | `d5b0b8e` | CHECK статуса по имени; умолчание формата `chat`; откат в шапке 002; живой тест 002 с чистого листа (все 13 статусов, накат дважды, oid CHECK стабилен); проверка схемы — парами «таблица + колонка»; настройки — `SELECT *`; `retry` с `from` — формат из настроек |
| Задачи 4–9 | одобрено с правками | `8c7d830` | `dbb9420` | правила 1–15 у сценки 1 режиссёра и у немой зацепки; название сервиса — с местом; ремарки и латиница в репликах, Кеша в каждой сценке, роль с уточнением, список id труппы в сообщении; id героя строчными, пустая сценка — null; реплика h — по формату, а не по спланированным сценкам; принятая развязка не повторяется и не переснимается; режиссёру — вопрос отвергнутого варианта и сценка прошлой сцены; прошлые развязки; промпты: кто в кадре (`who`), 8–14 слов на сценку, пример сценки, коронные фразы, правила 19–20, зацепки до 6 слов; «Omni: 16 из 48 с»; паспорт Кеши без названия сервиса |
| Итоговое (задача 16) | одобрено, Critical и Important нет | `013f7fa` | `8f1f843` | m5 в круге по отзыву студии сценарист оставляет принятые сценки, даже если модель их вернула; m6 у развязки — оговорка про уже учтённое замечание; «Повторить» с замечанием сбрасывает отзыв студии — новый круг идёт по замечанию |
| Задачи 10–14 | не одобрено → исправлено | `c392370` | `39ec974` | C1 брак удаляется из MinIO (`onDiscard`, `storage.remove`); I1 скачивание через временный файл; I2 повтор записи в базу и id генерации из папки; I3 кадр считается до выгрузки и довыгружается; I4 сбой хранилища выходит из попыток Omni и повторяет задание; m4 `NoSuchBucket` — не «ключа нет»; m7 тест на стыке `runAnimate` + `animateRun` + `s3Storage` (`studio/src/worker/animate-money.test.ts`) |

Итоговое ревью подтвердило отказ от «верить id» для падений процесса; узкое исключение — потеря питания до сброса файла на диск (rename без fsync): пустой raw.mp4 рядом с id стоит нового клипа (m1 итогового ревью). Не взято из итогового ревью (в итоги задачи 18): m1 fsync в `writeAtomic` и `download`; m2 брак после сбоя удаления из MinIO возвращается и может пройти сверку со второго раза (денег не теряет); m3 сбой базы дольше повторов — `failed` без автоповтора, «Повторить» берёт id из папки; m4 подсказки ошибок оживления про правку `animation.json` в конвейере невыполнимы — выход `retry from=writing` с замечанием или `from=directing`; m8 перед продом — `s3:DeleteObject` в политике `smm-rw`, ответ MinIO на отсутствующий ключ без `s3:ListBucket`.

Не взято из ревью (в итоги задачи 18): «бесплатно» в репликах героев, одинарные кавычки в английских полях; студия — m1 (не запускать клип за 3–4 минуты до срока задания), m2 (резерв на кадр), m3 (pid в `clip.next.mp4` и `speech.ogg`), m5 (пути из отпечатков до проверки), m6 (`script_invalid` на этапе animate повторяется только с `from=writing`). Совет «при raw.mp4 рядом с id верить id» не взят: с удалением брака raw.mp4 рядом с id бывает только после падения между скачиванием и сохранением, и он — клип этой генерации; повторная загрузка истёкшей генерации стоила бы новой оплаты.

---

### Task 15: Полный прогон на ноде

**Files:** —

- [ ] **Step 1: Модуль роликов бэкенда, гейт типов, живой Postgres**

```bash
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK && SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts"
```

Expected: `src/shorts` — все сюиты зелёные (интеграционная без базы — skipped; после правок по ревью — 667 passed), `TSC_OK`, живой Postgres — 8 passed.

- [ ] **Step 2: Студия — тесты, типы, живая очередь, обе фикстуры сборки**

```bash
"$WT"/studio/scripts/node-run.sh "npm test && npm run -s typecheck && echo TSC_OK && STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run -s test:db && npm run -s test:render"
```

Запускать с `run_in_background`. Expected: `npm test` — `# fail 0` (после правок по ревью — 222); `TSC_OK`; `test:db` — `# fail 0`; обе фикстуры сборки — `pass`.

---

### Task 16: Итоговое ревью

**Files:** —

- [ ] **Step 1: Ревью ветки**

Отдать ревьюеру (субагент `superpowers:code-reviewer`, модель opus) диапазон `e763a55..HEAD` со ссылкой на спеку сценок и этот план. Главный вопрос — готов ли конвейер к сквозному прогону на стенде за реальные деньги: что может заплатить дважды, потерять оплаченное, молча собрать не тот ролик или застрять в статусе. Critical и Important чинятся до задачи 17 (тест → правка → прогон → коммит), Minor — в итоги задачи 18.

---

### Task 17: Стенд и сквозной прогон с владельцем

**Только с явного OK владельца** на каждый пункт, отмеченный «OK».

- [ ] **Step 1 (OK): Слияние в main и выкат на стенд**

Слияние `feat/promo-shorts` в main — в свежем клоне, не в воркдереве; перед пушем сверить merge-base с `origin/main`. Выкат — `bash ~/Downloads/spirits_back/scripts/deploy.sh` с `TEST_ONLY=1 BACK_ONLY=1`, отвязанным запуском с логом. После выката — на стенде применилась 002:

```bash
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 'grep -h "shorts migration" ~/.pm2/logs/linkeon-api-out*.log | tail -3'
```

Expected: `shorts migration 002_skits.sql applied`.

- [ ] **Step 2: Ключ Google у рабочего процесса студии на ноде**

Тот же шаг, что задача 16 плана 3 (ключ уже мог быть перенесён): `grep -c "^GOOGLE_AI_API_KEY=." ~/ci/wt/promo-shorts/studio/.env` — `1`. Значение не печатать.

- [ ] **Step 3 (OK): Ролик со сценками сквозь конвейер стенда**

Заказ и запуск — из админского API стенда (`studio/scripts/stand-admin.ts`, как в задаче 37 плана 2), формат по умолчанию — «Сценки». Первый ролик — с пределом 16 с (`update_settings` `maxOmniSeconds: 16`, как просила спека в «Порогах после образца»): одна пересъёмка сверх двух клипов — уже отказ, а не трата; после первого ролика предел — обратно 48. Этапы студии — `"$WT"/studio/scripts/node-run.sh "npm run worker -- --once"` по одному заданию, между ними — тики API. Код 255 у node-run не значит, что рабочий процесс умер: сначала `status` и `lease_until` ролика, повтор упрётся в блокировку (75). Следить за `status`, `last_error` и `animation` ролика (`admin/shorts` `get`). Владелец получает ролик в личку с составом сценок и тратами Omni.

Траты: ≈ $1,9 на ролик; на прогон со всеми повторами — не больше $10 без отдельного вопроса владельцу.

- [ ] **Step 4 (OK): Одобрение, канал и учения**

Остаток задачи 37 плана 2 на новом формате: одобрение → @linkeontest → набор для YouTube. Учения со сбоем: предел секунд Omni меньше одного клипа (`update_settings` `maxOmniSeconds: 8` при уже потраченных 8 с) → `failed` «лимит пересъёмок сценок» → владельцу сообщение → предел обратно → «Повторить» (`retry`) — готовые сценки не переснимаются, траты в подписи не растут. Переключение формата на «Только чат» — следующий ролик собирается без сценок.

---

### Task 18: Итоги

- [ ] **Step 1: Итоги в спеке**

Дописать в конец `docs/superpowers/specs/2026-10-26-shorts-skits-design.md` раздел «Что уточнил конвейер (план 4)»: пункты из «Что план уточняет в спеке» этого плана, итог сквозного прогона (сколько этапов, время оживления на стенде, траты, что увидел владелец), мелкие замечания итогового ревью.

```bash
git -C "$WT" add docs/superpowers/specs/2026-10-26-shorts-skits-design.md
git -C "$WT" commit -m "docs(spec): ролики со сценками — что уточнил конвейер

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- docs/superpowers/specs/2026-10-26-shorts-skits-design.md
```

- [ ] **Step 2: Память и следующее решение**

Обновить заметку памяти `project_promo_shorts_studio.md` (конвейер со сценками на стенде, итоги) и строку в `MEMORY.md`. Выкат на прод — отдельный вопрос владельцу, как в спеке роликов.
