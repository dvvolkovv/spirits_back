# Ролики со сценками, план 3: движок сценок и ролик-образец — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Студия умеет оживлять сценки (кадр Nano Banana Pro → клип Gemini Omni → проверка речи → громкость и субтитры) и собирать ролик «сценка → настоящий ответ → сценка → финал». Этим кодом собран ролик-образец про залог, и владелец его принял.

**Architecture:** Паспорта труппы и сборка промптов — чистые функции в API (`src/shorts/short-troupe.ts`, `short-skit-prompts.ts`): в плане 4 их вызовут режиссёр и сценарист. Студия получает папку `src/animate/` (клиент Google, распознавание SpeechKit, сверка речи, время реплик, проверка клипа, задание `animate`) и композицию `SkitShort`. Образец собирается командами на ноде из настоящей съёмки стенда: CLI бэкенда кладёт в сценарий готовые промпты, `npm run animate` оживляет сценки, `npm run render` собирает ролик. Очередь, база и бот в этом плане не меняются.

**Tech Stack:** NestJS 10 (commonjs, `strictNullChecks: false`, jest + ts-jest, ts-node). Студия — Node 22 ESM, `tsx --test` (`node:test`), Remotion 4.0.530, ffmpeg/ffprobe с libx264 и libopus. Google Generative Language API: `gemini-3-pro-image-preview` (`generateContent`), `gemini-omni-1.1-flash` (Interactions API). SpeechKit v1: синтез (уже есть) и распознавание.

**Спека:** `docs/superpowers/specs/2026-10-26-shorts-skits-design.md`, разделы «Ролик», «Труппа», «Кто пишет сценки» (форма `Skit`, сборка промптов кодом), «Задание `animate`», «Сборка», «Отказы» (кроме того, что относится к очереди), «Порядок работ», шаг 1.

**Вне этого плана — план 4 «Сценки в конвейере»** (пишется после того, как владелец примет образец, с учётом того, что образец уточнил):
- миграция `shorts/002`: `short_video.format`, `short_video.animation`, статусы `animate_queued` и `animating`, `short_settings.format` и `max_omni_seconds`;
- переходы статусов, `IN_WORK_STATUSES`, `RESUME_FROM`, «Повторить» после сбоя на оживлении;
- режиссёр пишет сценку 1, сценарист — сценку 2; разбор, правила 16–18 в `short-rules.ts`, паспорта и приёмы юмора в промптах, описания сценок последних 20 роликов;
- задание `animate` в рабочем процессе студии: клипы в MinIO (`shorts/<id>/skits/<отпечаток>/…`), срок этапа 25 минут, аренда 30 минут;
- состав и траты Omni в подписи владельцу; настройки «Формат» и «Предел секунд Omni» и предпросмотр сценок в админке;
- формат `chat` как запасной; остаток задачи 37 плана 2 (сквозной прогон на стенде) на новом формате.

**Что план уточняет в спеке** (дописывается в спеку в задаче 17):
- `SkitPlan` несёт `troupeVersion`. Отпечаток сценки — первые 16 hex от sha256 версии труппы и двух промптов: промпты собирает код, поэтому порядок полей сценки на отпечаток не влияет, а правка шаблона промпта переснимает сценку.
- Кадры рисуются по очереди: кадр развязки рисуется по кадру конфликта. Клипы снимаются параллельно.
- Секунды Omni резервируются до запуска клипа и возвращаются, если запуск не состоялся (квота, сеть). Так две параллельные сценки не проходят предел вдвоём.
- Ошибки распознавания не пересъёмка: SpeechKit повторяется сам до трёх раз, затем задание падает без повтора — клип Omni уже оплачен.
- Пауза в клипе и в ролике со сценками — до 3 с (стартовое значение; сверяется на образце). Паузы между репликами ищутся порогом −30 дБ, от 0,25 с.
- Место и действие сценки пишутся по-английски: они идут прямо в промпты генераторов. Реплики — по-русски.

---

## Как работать

- **Воркдерево на маке:** `/Users/dmitry/Downloads/spirits_back/.worktrees/promo-shorts`, ветка `feat/promo-shorts` (спека сценок — `96bf5b8`). Ниже `WT` — этот путь. Git — через `git -C "$WT"`, без `cd` в цепочках.
- **Всё тяжёлое — на тестовой ноде** через `"$WT"/studio/scripts/node-run.sh "<команда>"`. Скрипт пушит ветку и ставит `~/ci/wt/promo-shorts` на точный коммит. **Незакоммиченное на ноду не уезжает:** красный тест сначала коммитится (`test(...): … (красный)`), потом гоняется.
  - Студия (команда выполняется в `studio/`): `"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/match.test.ts"`.
  - Бэкенд (команда выполняется в корне): `NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-troupe.spec.ts"`.
  - Гейт типов бэкенда: `NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`. jest типы не проверяет (`isolatedModules`).
  - Гейт типов студии: `"$WT"/studio/scripts/node-run.sh "npm run typecheck && echo TSC_OK"`.
- **Любой вызов `node-run.sh` — с `timeout: 600000`;** долгие (рендер, оживление) — с `run_in_background`. Код 75 — воркдерево ноды занято другим прогоном (повторить позже), 3 — воркдерево не встало на коммит (команда не запускалась; это не «ожидаемый красный»), 255 — ssh сброшен по `MaxStartups` (повторить через 1–2 минуты, не петлёй).
- **SSH к ноде — через одно мастер-соединение:** все `ssh` и `scp` в плане идут с `-o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m`. Ниже это `$SSHO`:
  ```bash
  SSHO='-o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o ControlPath=$HOME/.ssh/cm-%C -o ControlPersist=30m'
  ```
- **Живой чекаут `~/spirits_back` на ноде не трогать:** из него работает test.linkeon.io. Из его `.env` можно только читать.
- **Ничего не вливать в main и не выкатывать.** Этот план выкат не требует вовсе.
- **Секреты.** Ключ Google живёт только в `~/ci/wt/promo-shorts/studio/.env` на ноде. Не печатать его, не класть в репозиторий (репозитории Linkeon публичные), не передавать в командной строке.
- **Деньги.** Каждый запуск Omni — $0,80 (8 с при 720p), кадр Nano Banana Pro — около $0,13. Живые вызовы Google — только в задачах 16–17. На образец со всеми итерациями — не больше $10 без отдельного вопроса владельцу.
- **Ревьюерам-субагентам:** никаких `git checkout` и `git switch` в общем воркдереве. «Красное» состояние смотреть через `git show <sha>:<путь>`.
- **Коммиты** — по-русски, с префиксом (`feat(shorts):`, `test(shorts):`, `feat(studio):`, `test(studio):`, `fix(...)`, `docs(...)`). Последняя строка каждого сообщения — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Кириллица и эмодзи пишутся в файлы как есть.** Escape-последовательностей вида `\uXXXX` в коде нет и не вводить: инструмент записи их портит.
- **Список тестов студии — явный.** `scripts.test` в `studio/package.json` перечисляет файлы. Новый файл теста, не дописанный туда, в `npm test` не попадёт.

## Файлы

| Файл | За что отвечает |
|---|---|
| `studio/assets/troupe/v1/sheet.png`, `<id>.png` | Утверждённый лист труппы и портреты героев |
| `src/shorts/short-troupe.ts` | Паспорта героев, версия труппы |
| `src/shorts/short-skit-prompts.ts` | Форма сценки, промпты кадра и видео, отпечаток, `planSkit` |
| `scripts/shorts-skit-plan.ts` | CLI: сценки + сценарий → сценарий студии с готовыми промптами |
| `studio/samples/zalog/skits.json`, `script.base.json` | Сценки и сценарий образца |
| `src/shorts/shorts.contract.spec.ts` | Сторож полей сценок в типах студии |
| `studio/src/types.ts` | `SkitPlan`, `SkitClip`, `Animation`, `SkitTimeline`, `SkitShortProps` |
| `studio/src/errors.ts` | Коды ошибок оживления |
| `studio/src/config.ts`, `studio/.env.example` | Ключ Google |
| `studio/src/animate/match.ts` | Сверка распознанной речи с репликами |
| `studio/src/animate/cues.ts` | Отрезки речи и время реплик по паузам |
| `studio/src/animate/google.ts` | Nano Banana Pro и Omni |
| `studio/src/animate/stt.ts` | Звук клипа → SpeechKit v1 |
| `studio/src/animate/clip-check.ts` | Проверка клипа и выравнивание громкости |
| `studio/src/animate/run-animate.ts` | Задание `animate` и CLI `npm run animate` |
| `studio/src/ffprobe.ts` | Пороги поиска пауз, пределы ролика со сценками |
| `studio/src/timeline.ts` | `buildSkitTimeline` |
| `studio/src/script.ts` | Проверка сценария со сценками |
| `studio/src/remotion/Caption.tsx`, `scenes/Hook.tsx`, `scenes/Clip.tsx`, `SkitShort.tsx`, `Root.tsx` | Композиция `SkitShort` |
| `studio/src/render/props.ts` | `buildSkitProps` |
| `studio/src/render/run-render.ts` | Сборка ролика со сценками |
| `studio/src/render/render-skit.fixture.ts` | Сборка ролика со сценками из фикстуры без сети |

---

### Task 1: Портреты труппы в студии

Лист утверждён владельцем 26.10.2026 (`~/Downloads/linkeon_shorts/troupe-v1.png`, 1376×768). Портреты вырезаются по проверенным границам: в кадр не попадают соседи.

**Files:**
- Create: `studio/assets/troupe/v1/sheet.png`, `kesha.png`, `galina.png`, `boris.png`, `mikhalych.png`, `zhorik.png`

- [ ] **Step 1: Скопировать лист и вырезать портреты**

Это лёгкая операция, её можно делать на маке.

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/promo-shorts
D="$WT/studio/assets/troupe/v1"
mkdir -p "$D"
cp ~/Downloads/linkeon_shorts/troupe-v1.png "$D/sheet.png"
for spec in kesha:262:560:30:130 galina:252:560:302:120 boris:282:560:542:130 mikhalych:250:560:815:130 zhorik:276:560:1070:130; do
  IFS=: read n w h x y <<<"$spec"
  ffmpeg -hide_banner -loglevel error -y -i "$D/sheet.png" -vf "crop=$w:$h:$x:$y" "$D/$n.png"
done
ls -la "$D"
```

Expected: шесть файлов `sheet.png`, `kesha.png`, `galina.png`, `boris.png`, `mikhalych.png`, `zhorik.png`.

- [ ] **Step 2: Посмотреть портреты рядом**

```bash
ffmpeg -hide_banner -loglevel error -y -i "$D/kesha.png" -i "$D/galina.png" -i "$D/boris.png" -i "$D/mikhalych.png" -i "$D/zhorik.png" \
  -filter_complex "[0][1][2][3][4]hstack=inputs=5" /tmp/troupe-strip.png
```

Открыть `/tmp/troupe-strip.png` (Read). Expected: слева направо капибара в свитере, гусыня в фартуке с ключами, кот в костюме со штампом, бобр в комбинезоне, енот в клетчатом пиджаке. У каждого портрета по краям нет кусков соседей. Если кусок соседа виден — сдвинуть `x` или уменьшить `w` этого героя на 5–10 px и повторить шаги 1–2.

- [ ] **Step 3: Commit**

```bash
git -C "$WT" add studio/assets/troupe/v1
git -C "$WT" commit -m "feat(studio): лист труппы v1 и портреты пятерых героев — эталоны для кадров сценок

Лист утверждён владельцем 26.10.2026. Границы вырезки (w:h:x:y):
kesha 262:560:30:130, galina 252:560:302:120, boris 282:560:542:130,
mikhalych 250:560:815:130, zhorik 276:560:1070:130.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Паспорта труппы (API)

**Files:**
- Create: `src/shorts/short-troupe.ts`
- Test: `src/shorts/short-troupe.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-troupe.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { heroById, TROUPE, TROUPE_VERSION } from './short-troupe';

describe('труппа', () => {
  it('пятеро героев утверждённого листа, id без повторов', () => {
    expect(TROUPE.map((h) => h.id)).toEqual(['kesha', 'galina', 'boris', 'mikhalych', 'zhorik']);
    expect(TROUPE_VERSION).toBe('v1');
  });

  it('у каждого — облик и голос для промптов, роли и коронная фраза', () => {
    for (const h of TROUPE) {
      expect(h.look.length).toBeGreaterThan(20);
      expect(h.voice).toMatch(/voice$/);
      expect(h.who).toMatch(/^the [a-z]+$/);
      expect(h.roles.length).toBeGreaterThan(0);
      expect(h.catchphrases.length).toBeGreaterThan(0);
    }
  });

  it('heroById находит героя и не находит чужого', () => {
    expect(heroById('galina')?.name).toBe('Гусыня Галина Петровна');
    expect(heroById('fox')).toBeUndefined();
  });

  it('у каждого героя есть портрет в студии', () => {
    for (const h of TROUPE) {
      const f = path.join(__dirname, '..', '..', 'studio', 'assets', 'troupe', TROUPE_VERSION, `${h.id}.png`);
      expect(fs.existsSync(f)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/short-troupe.spec.ts
git -C "$WT" commit -m "test(shorts): паспорта труппы (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-troupe.spec.ts"
```

Expected: FAIL — `Cannot find module './short-troupe'`.

- [ ] **Step 3: Написать паспорта**

`src/shorts/short-troupe.ts`:

```ts
/**
 * Постоянная труппа роликов со сценками — паспорта героев.
 *
 * Спека: docs/superpowers/specs/2026-10-26-shorts-skits-design.md, «Труппа».
 * Облик (`look`), голос (`voice`) и короткое имя в кадре (`who`) — по-английски:
 * из них код собирает промпты Nano Banana и Omni (short-skit-prompts.ts).
 * Роли, манера и коронные фразы — по-русски: их читают режиссёр и сценарист.
 * Портреты — studio/assets/troupe/<версия>/<id>.png, вырезаны из листа,
 * утверждённого владельцем 26.10.2026. Новый герой или правка облика — новая
 * версия листа, а не правка этой: старые ролики остаются со своими портретами.
 */
export const TROUPE_VERSION = 'v1';

export type TroupeId = 'kesha' | 'galina' | 'boris' | 'mikhalych' | 'zhorik';

export interface Hero {
  id: TroupeId;
  /** Имя в подписях владельцу и в промптах режиссёра. */
  name: string;
  /** Кто это в кадре, коротко: им промпт Omni называет говорящего. */
  who: string;
  look: string;
  /** Описание голоса для Omni: одно и то же в каждом промпте держит голос узнаваемым. */
  voice: string;
  manner: string;
  roles: string[];
  catchphrases: string[];
}

export const TROUPE: readonly Hero[] = [
  {
    id: 'kesha',
    name: 'Капибара Кеша',
    who: 'the capybara',
    look: 'a brown capybara with a calm, slightly sleepy face, wearing a chunky beige knitted sweater',
    voice: 'calm, low, unhurried adult male voice',
    manner: 'Главный герой, «обычный человек». Невозмутим, сколько бы на него ни кричали. Не спорит и не паникует — открывает Linkeon.',
    roles: ['жилец', 'работник', 'покупатель', 'клиент', 'сосед', 'муж', 'предприниматель', 'заёмщик'],
    catchphrases: ['Спокойно. Сейчас спрошу.'],
  },
  {
    id: 'galina',
    name: 'Гусыня Галина Петровна',
    who: 'the goose',
    look: 'a white goose with an orange beak and orange feet, a grumpy elderly lady in a pink floral apron, holding a bunch of keys',
    voice: 'shrill, loud, grumpy elderly female voice',
    manner: 'Вечный противник. Скандалит, шипит, машет крыльями, тычет крылом. В развязке сдаётся.',
    roles: ['хозяйка квартиры', 'соседка', 'свекровь', 'вахтёрша', 'продавщица'],
    catchphrases: ['Га-га… ладно.'],
  },
  {
    id: 'boris',
    name: 'Кот Борис Аркадьевич',
    who: 'the cat',
    look: 'a fat grey tabby cat with yellow eyes, a pompous boss in a too-tight navy suit, white shirt and striped tie, holding a wooden rubber stamp',
    voice: 'lazy, deep, pompous male voice',
    manner: 'Начальник. Важный и ленивый, всё «не положено». Ставит печать — и засыпает.',
    roles: ['работодатель', 'начальник', 'чиновник', 'налоговая', 'управляющая компания'],
    catchphrases: ['Не положено.'],
  },
  {
    id: 'mikhalych',
    name: 'Бобр Михалыч',
    who: 'the beaver',
    look: 'a brown beaver with big front teeth, a handyman in blue denim overalls with a leather tool belt and a pencil behind the ear',
    voice: 'hoarse, cheerful middle-aged male voice',
    manner: 'Мастер. Работяга, вечно всё переделывает, смета растёт на глазах.',
    roles: ['подрядчик', 'сантехник', 'автосервис', 'строитель', 'мастер'],
    catchphrases: ['Тут всё переделывать, хозяин.'],
  },
  {
    id: 'zhorik',
    name: 'Енот Жорик',
    who: 'the raccoon',
    look: 'a raccoon with a sly grin, a salesman in a brown checkered jacket, white shirt and a gold chain',
    voice: 'fast-talking, slick, ingratiating male voice',
    manner: 'Хитрый продавец. Говорит быстро, обещает золотые горы, мелкий шрифт прячет.',
    roles: ['продавец', 'кредитный менеджер', 'мошенник по телефону', 'турагент', 'риелтор'],
    catchphrases: ['Только сегодня, только для вас!'],
  },
];

export function heroById(id: string): Hero | undefined {
  return TROUPE.find((h) => h.id === id);
}
```

- [ ] **Step 4: Прогнать тест и гейт типов**

```bash
git -C "$WT" add src/shorts/short-troupe.ts
git -C "$WT" commit -m "feat(shorts): паспорта труппы — облик и голос для промптов, роли и коронные фразы

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-troupe.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: `Tests: 4 passed`, затем `TSC_OK`.

---

### Task 3: Промпты сценок и отпечаток (API)

**Files:**
- Create: `src/shorts/short-skit-prompts.ts`
- Test: `src/shorts/short-skit-prompts.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-skit-prompts.spec.ts`:

```ts
import { buildKeyframePrompt, buildVideoPrompt, planSkit, Skit, SKIT_FORBIDDEN, skitFingerprint } from './short-skit-prompts';

const conflict = (): Skit => ({
  cast: [
    { hero: 'galina', role: 'хозяйка квартиры' },
    { hero: 'kesha', role: 'жилец' },
  ],
  setting: 'shabby hallway of a rented flat',
  action: 'The goose blocks the doorway and hisses.',
  lines: [
    { hero: 'galina', text: 'Обои потёрли! Залог мой!' },
    { hero: 'kesha', text: 'Спокойно. Спрошу у юриста.' },
  ],
});

describe('промпт кадра', () => {
  it('облик героев из паспортов, роли, место, начало действия и постоянные запреты', () => {
    const p = buildKeyframePrompt(conflict(), { continuity: false });
    expect(p).toContain('a white goose');
    expect(p).toContain('a brown capybara');
    expect(p).toContain('«хозяйка квартиры»');
    expect(p).toContain('shabby hallway of a rented flat');
    expect(p).toContain('The goose blocks the doorway and hisses.');
    expect(p).toContain('Exactly 2 characters');
    expect(p).toContain(SKIT_FORBIDDEN);
    expect(p).not.toContain('previous scene');
  });

  it('у развязки — опора на кадр конфликта', () => {
    expect(buildKeyframePrompt(conflict(), { continuity: true })).toContain('previous scene');
  });

  it('герой не из труппы — ошибка', () => {
    const s = conflict();
    s.cast[0] = { hero: 'fox' as any, role: 'лиса' };
    expect(() => buildKeyframePrompt(s, { continuity: false })).toThrow(/fox.*нет в труппе/);
  });
});

describe('промпт видео', () => {
  it('реплики по порядку, слово в слово, с голосом говорящего', () => {
    const p = buildVideoPrompt(conflict());
    const first = p.indexOf('«Обои потёрли! Залог мой!»');
    const second = p.indexOf('«Спокойно. Спрошу у юриста.»');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(p).toContain('the goose, shrill, loud, grumpy elderly female voice: «Обои');
    expect(p).toContain('in Russian');
    expect(p).toContain(SKIT_FORBIDDEN);
  });

  it('реплика героя не из состава сценки — ошибка', () => {
    const s = conflict();
    s.lines.push({ hero: 'boris', text: 'Не положено.' });
    expect(() => buildVideoPrompt(s)).toThrow(/boris.*не в составе/);
  });
});

describe('отпечаток и план', () => {
  it('та же сценка — тот же отпечаток; другая реплика — другой', () => {
    const a = planSkit(conflict(), 'conflict');
    expect(planSkit(conflict(), 'conflict').fingerprint).toBe(a.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const s = conflict();
    s.lines[1].text = 'Спокойно.';
    expect(planSkit(s, 'conflict').fingerprint).not.toBe(a.fingerprint);
  });

  it('отпечаток зависит от версии труппы', () => {
    const p = planSkit(conflict(), 'conflict');
    expect(skitFingerprint({ ...p, troupeVersion: 'v2' })).not.toBe(p.fingerprint);
  });

  it('развязка отличается опорой на кадр; герои — без повторов, в порядке состава', () => {
    const c = planSkit(conflict(), 'conflict');
    expect(planSkit(conflict(), 'punchline').fingerprint).not.toBe(c.fingerprint);
    expect(c.heroes).toEqual(['galina', 'kesha']);
    expect(c.troupeVersion).toBe('v1');
    expect(c.skit).toEqual(conflict());
  });
});
```

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/short-skit-prompts.spec.ts
git -C "$WT" commit -m "test(shorts): промпты сценок и отпечаток (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-skit-prompts.spec.ts"
```

Expected: FAIL — `Cannot find module './short-skit-prompts'`.

- [ ] **Step 3: Написать модуль**

`src/shorts/short-skit-prompts.ts`:

```ts
/**
 * Сценки роликов: форма, промпты для Nano Banana и Omni, отпечаток.
 *
 * Спека: docs/superpowers/specs/2026-10-26-shorts-skits-design.md, «Кто пишет
 * сценки». Режиссёр и сценарист отдают сценку полями, а промпт собирает код:
 * так облик и голос героев одинаковы из ролика в ролик, а запреты (текст,
 * экраны, логотипы, дети) не забываются. Место и действие пишутся
 * по-английски — они идут прямо в промпт; реплики — по-русски.
 *
 * `SkitPlan` — то, что читает студия (зеркало studio/src/types.ts).
 */
import { createHash } from 'crypto';
import { Hero, heroById, TROUPE_VERSION, TroupeId } from './short-troupe';

export type SkitKind = 'conflict' | 'punchline';

export interface SkitLine {
  hero: TroupeId;
  /** По-русски, до 12 слов. */
  text: string;
  /** Абзац ответа, на который опирается утверждение по существу (только в развязке). */
  box?: number;
}

export interface Skit {
  /** 2–3 героя; role — из ролей героя. */
  cast: { hero: TroupeId; role: string }[];
  setting: string;
  action: string;
  /** 1–3 реплики, всего до 25 слов. */
  lines: SkitLine[];
}

export interface SkitPlan {
  skit: Skit;
  troupeVersion: string;
  /** Чьи портреты нужны кадру — по порядку состава, без повторов. */
  heroes: TroupeId[];
  keyframePrompt: string;
  videoPrompt: string;
  fingerprint: string;
}

export const SKIT_STYLE =
  'Claymation stop-motion: handmade plasticine characters with visible fingerprints and clay texture, warm miniature set lighting.';
export const SKIT_FRAMING =
  'Tall vertical 9:16 phone frame. The picture fills the whole frame edge to edge: no borders, no letterbox bars, no split screen. The camera is close, the characters are big.';
export const SKIT_FORBIDDEN =
  'No text, letters, subtitles or logos anywhere. Any phone is seen from the back, its screen is not visible. No real people and no children.';

function castHeroes(skit: Skit): Hero[] {
  return skit.cast.map((c) => {
    const h = heroById(c.hero);
    if (!h) throw new Error(`skit: героя «${c.hero}» нет в труппе ${TROUPE_VERSION}`);
    return h;
  });
}

/** Кадр-эталон: начало сценки. У развязки — опора на кадр конфликта (последний из присланных портретов). */
export function buildKeyframePrompt(skit: Skit, o: { continuity: boolean }): string {
  const heroes = castHeroes(skit);
  const cast = skit.cast.map((c, i) => `${i + 1}) ${heroes[i].look}, playing «${c.role}»`).join('; ');
  return [
    SKIT_STYLE,
    `Keep every character exactly as in the reference portraits: ${cast}.`,
    `Exactly ${heroes.length} characters, each appears once.`,
    o.continuity ? 'Same place, costumes and lighting as in the last reference image (the previous scene).' : '',
    `Setting: ${skit.setting}.`,
    `The opening moment of the scene: ${skit.action}`,
    SKIT_FRAMING,
    SKIT_FORBIDDEN,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Клип: действие и реплики по порядку, каждая — с голосом говорящего из паспорта. */
export function buildVideoPrompt(skit: Skit): string {
  const cast = new Set(castHeroes(skit).map((h) => h.id));
  const said = skit.lines
    .map((l, i) => {
      const h = heroById(l.hero);
      if (!h || !cast.has(h.id)) throw new Error(`skit: «${l.hero}» говорит реплику, но не в составе сценки`);
      return `${i + 1}) ${h.who}, ${h.voice}: «${l.text}»`;
    })
    .join(' ');
  return [
    SKIT_STYLE,
    'Animate this image: keep the characters, the set and the lighting exactly as in it.',
    skit.action,
    `Dialogue in Russian, spoken clearly in this order, each line word for word: ${said}`,
    'Lips move with the speech. Slightly jerky stop-motion movement, small comic gestures, no camera cuts, no music.',
    SKIT_FORBIDDEN,
  ].join(' ');
}

/** Отпечаток — от версии труппы и обоих промптов: правка шаблона тоже переснимает сценку. */
export function skitFingerprint(p: Pick<SkitPlan, 'troupeVersion' | 'keyframePrompt' | 'videoPrompt'>): string {
  return createHash('sha256').update([p.troupeVersion, p.keyframePrompt, p.videoPrompt].join('\n')).digest('hex').slice(0, 16);
}

export function planSkit(skit: Skit, kind: SkitKind): SkitPlan {
  const keyframePrompt = buildKeyframePrompt(skit, { continuity: kind === 'punchline' });
  const videoPrompt = buildVideoPrompt(skit);
  const heroes = [...new Set(skit.cast.map((c) => c.hero))];
  return {
    skit,
    troupeVersion: TROUPE_VERSION,
    heroes,
    keyframePrompt,
    videoPrompt,
    fingerprint: skitFingerprint({ troupeVersion: TROUPE_VERSION, keyframePrompt, videoPrompt }),
  };
}
```

- [ ] **Step 4: Прогнать тест и гейт типов**

```bash
git -C "$WT" add src/shorts/short-skit-prompts.ts
git -C "$WT" commit -m "feat(shorts): промпты сценок кодом — облик и голос из паспортов, постоянные запреты, отпечаток

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-skit-prompts.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: `Tests: 8 passed`, затем `TSC_OK`.

---

### Task 4: Сценарий образца с готовыми промптами

CLI бэкенда превращает сценки образца в `SkitPlan` и кладёт их в сценарий студии. Студия — отдельный ESM-пакет и не может импортировать код бэкенда, поэтому промпты собираются здесь.

Сценарий образца построен на настоящей съёмке стенда (ролик `987f6045`, юрист Алексей, залог). Абзацы его ответа: 1 — «Нормальный износ за три года жизни — не повод оставлять залог себе…», 3 — ст. 622 ГК РФ про нормальный износ, 5 — ст. 15 ГК РФ: ущерб хозяйка должна доказать.

**Files:**
- Create: `scripts/shorts-skit-plan.ts`
- Create: `studio/samples/zalog/skits.json`, `studio/samples/zalog/script.base.json`

- [ ] **Step 1: Сценки образца**

`studio/samples/zalog/skits.json`:

```json
{
  "conflict": {
    "cast": [
      { "hero": "galina", "role": "хозяйка квартиры" },
      { "hero": "kesha", "role": "жилец" }
    ],
    "setting": "shabby hallway of a rented flat, an open door, a suitcase by the wall",
    "action": "The capybara with a suitcase holds out a paw for the deposit. The goose blocks the doorway, jabs a wing at a tiny scuff on the wallpaper, hisses and flaps her wings. At the end the capybara calmly takes out a phone.",
    "lines": [
      { "hero": "galina", "text": "Обои потёрли! Залог мой, весь до копейки!" },
      { "hero": "kesha", "text": "Спокойно. Спрошу у юриста." }
    ]
  },
  "punchline": {
    "cast": [
      { "hero": "kesha", "role": "жилец" },
      { "hero": "galina", "role": "хозяйка квартиры" }
    ],
    "setting": "shabby hallway of a rented flat, an open door, a suitcase by the wall",
    "action": "The capybara calmly holds the phone up towards the goose like a document. The goose freezes, her feathers stand on end, the bunch of keys drops from her wing, then she slowly lowers her wings.",
    "lines": [
      { "hero": "kesha", "text": "Три года — это нормальный износ. Залог верните.", "box": 1 },
      { "hero": "galina", "text": "Га-га… ладно." }
    ]
  }
}
```

`studio/samples/zalog/script.base.json` — сценарий студии без сценок. Зацепки-реплики `hook` нет: у ролика со сценками зацепка — надпись поверх конфликта.

```json
{
  "hook": "Хозяйка оставит весь залог из-за потёртых обоев?",
  "hookBox": 1,
  "voice": "madirus",
  "speed": 1.1,
  "lines": [
    { "id": "q", "scene": "question", "text": "Я Алексей, юрист. Жилец спросил: хозяйка не отдаёт залог из-за потёртых обоев — она вправе?" },
    { "id": "a1", "scene": "answer", "box": 3, "text": "Квартиру возвращают с учётом нормального износа. Потёртые обои и пара царапин за три года — это он и есть." },
    { "id": "a2", "scene": "answer", "box": 5, "text": "Ущерб хозяйка должна доказать и обосновать сумму. Сказать «не верну, и всё» нельзя." },
    { "id": "f", "scene": "final", "voice": "alena", "text": "Линкеон — восемнадцать ассистентов. Ссылка — в описании и в профиле." }
  ],
  "final": { "assistantsCount": 18, "disclaimer": "Ответ ИИ, не заменяет юриста" }
}
```

- [ ] **Step 2: Написать CLI**

`scripts/shorts-skit-plan.ts`:

```ts
#!/usr/bin/env ts-node
/**
 * Сценки + сценарий студии → сценарий с готовыми промптами (ролик-образец
 * со сценками, план 3). В конвейере (план 4) то же самое сделает сценарист.
 *
 *   npx ts-node scripts/shorts-skit-plan.ts <skits.json> <script.base.json> <out/script.json>
 *
 * skits.json — { conflict: Skit, punchline: Skit } (src/shorts/short-skit-prompts.ts);
 * script.base.json — сценарий студии без сценок (studio/src/types.ts, Script).
 */
import * as fs from 'fs';
import * as path from 'path';
import { planSkit, Skit } from '../src/shorts/short-skit-prompts';

const [skitsPath, basePath, outPath] = process.argv.slice(2);
if (!skitsPath || !basePath || !outPath) {
  console.error('usage: npx ts-node scripts/shorts-skit-plan.ts <skits.json> <script.base.json> <out/script.json>');
  process.exit(2);
}
const skits = JSON.parse(fs.readFileSync(skitsPath, 'utf8')) as { conflict: Skit; punchline: Skit };
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const script = {
  ...base,
  skits: { conflict: planSkit(skits.conflict, 'conflict'), punchline: planSkit(skits.punchline, 'punchline') },
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(script, null, 2));
console.log(`skit-plan: ${outPath} — conflict ${script.skits.conflict.fingerprint}, punchline ${script.skits.punchline.fingerprint}`);
```

- [ ] **Step 3: Закоммитить и прогнать CLI на ноде**

```bash
git -C "$WT" add scripts/shorts-skit-plan.ts studio/samples/zalog
git -C "$WT" commit -m "feat(shorts): сценарий образца со сценками — CLI кладёт в сценарий студии готовые промпты

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx ts-node scripts/shorts-skit-plan.ts studio/samples/zalog/skits.json studio/samples/zalog/script.base.json /tmp/skit-plan-check.json && node -e 'const s=require(\"/tmp/skit-plan-check.json\"); for (const k of [\"conflict\",\"punchline\"]) { const p=s.skits[k]; if (p.fingerprint.length !== 16 || !p.videoPrompt.includes(\"«\") || p.troupeVersion !== \"v1\") throw new Error(k); } console.log(\"PLAN_OK\", s.skits.punchline.heroes.join(\",\"))'"
```

Expected: `skit-plan: /tmp/skit-plan-check.json — conflict <16 hex>, punchline <16 hex>`, затем `PLAN_OK kesha,galina`.

---

### Task 5: Типы сценок, коды ошибок и ключ Google в студии

**Files:**
- Modify: `studio/src/types.ts`
- Modify: `studio/src/errors.ts`
- Modify: `studio/src/config.ts`, `studio/src/config.test.ts`
- Modify: `studio/.env.example`
- Modify: `src/shorts/shorts.contract.spec.ts`

- [ ] **Step 1: Падающие тесты — ключ Google в конфиге и поля сценок в контракте**

В конец `studio/src/config.test.ts`:

```ts
test('оживлению сценок нужен ключ Google', () => {
  const animate = { capture: false, tts: false, animate: true };
  assert.throws(() => parseConfig({}, animate), /GOOGLE_AI_API_KEY/);
  assert.equal(parseConfig({ GOOGLE_AI_API_KEY: 'g' }, animate).googleKey, 'g');
  assert.equal(parseConfig({}, none).googleKey, '');
});
```

В `src/shorts/shorts.contract.spec.ts` в первый тест, в список полей, после `'disclaimer',` дописать поля сценок:

```ts
      'paragraphs', 'hookBox', 'badge', 'assistantsCount', 'disclaimer',
      'skits', 'troupeVersion', 'heroes', 'keyframePrompt', 'videoPrompt', 'fingerprint',
```

(строка `'paragraphs', 'hookBox', 'badge', 'assistantsCount', 'disclaimer',` уже есть — после неё добавляется вторая строка).

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git -C "$WT" add studio/src/config.test.ts src/shorts/shorts.contract.spec.ts
git -C "$WT" commit -m "test(studio): ключ Google для оживления и поля сценок в контракте (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/config.test.ts"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts.contract.spec.ts"
```

Expected: оба FAIL — в конфиге нет `googleKey` (тест ждёт ошибку про `GOOGLE_AI_API_KEY`), в `types.ts` нет `skits?:`.

- [ ] **Step 3: Типы сценок**

В `studio/src/types.ts` в интерфейс `Script` после поля `final` добавить поле `skits`:

```ts
  /** Число ассистентов — из базы; его же словами произносит финальная реплика (сценарий пишет бэкенд). */
  final: { assistantsCount: number; disclaimer?: string };
  /** Сценки — у ролика формата «Сценки». Без них ролик собирается по-старому (композиция Short). */
  skits?: Record<SkitKind, SkitPlan>;
}
```

В конец `studio/src/types.ts`:

```ts
// ── Сценки (спека docs/superpowers/specs/2026-10-26-shorts-skits-design.md) ──

export type SkitKind = 'conflict' | 'punchline';

export interface SkitLine {
  /** id героя труппы (src/shorts/short-troupe.ts бэкенда). */
  hero: string;
  text: string;
  /** Абзац ответа, на который опирается утверждение по существу (только в развязке). */
  box?: number;
}

export interface Skit {
  cast: { hero: string; role: string }[];
  setting: string;
  action: string;
  lines: SkitLine[];
}

/** Сценка, готовая к оживлению: промпты собрал бэкенд (src/shorts/short-skit-prompts.ts, SkitPlan). */
export interface SkitPlan {
  skit: Skit;
  /** Версия листа труппы: портреты — assets/troupe/<версия>/<id>.png. */
  troupeVersion: string;
  /** Чьи портреты нужны кадру — по порядку состава, без повторов. */
  heroes: string[];
  keyframePrompt: string;
  videoPrompt: string;
  /** Отпечаток промптов и версии труппы: клип с тем же отпечатком не переснимается. */
  fingerprint: string;
}

/** Время реплики сценки в клипе. */
export interface SkitCue {
  line: number;
  startMs: number;
  endMs: number;
}

/** Готовая сценка. Пути — относительно папки ролика. */
export interface SkitClip {
  fingerprint: string;
  keyframe: string;
  clip: string;
  durationMs: number;
  /** Что распознал SpeechKit в клипе. */
  heard: string;
  cues: SkitCue[];
  /** Сколько клипов Omni ушло на эту сценку. */
  attempts: number;
}

/** animation.json папки ролика — итог задания animate. */
export interface Animation {
  /** Секунды Omni, потраченные на ролик, со всеми попытками. */
  omniSeconds: number;
  skits: Partial<Record<SkitKind, SkitClip>>;
}

export interface SkitTimeline {
  segments: Segment[];
  scenes: Record<SkitKind | 'question' | 'answer' | 'final', SceneSpan>;
  totalFrames: number;
}

/** Субтитр с абсолютным кадром начала — у реплик сценок. */
export interface ClipCue {
  key: string;
  text: string;
  from: number;
  duration: number;
}

/** Пропсы композиции SkitShort. Как и ShortProps — type, а не interface. */
export type SkitShortProps = {
  fps: number;
  hook: string;
  badge?: string;
  questionShot: string;
  answerShot: string;
  answerShotHeight: number;
  boxes: ImageBox[];
  timeline: SkitTimeline;
  final: { assistantsCount: number; disclaimer?: string };
  clips: Record<SkitKind, { video: string; cues: ClipCue[] }>;
};
```

- [ ] **Step 4: Коды ошибок оживления**

В `studio/src/errors.ts` в объединение `StudioErrorCode` перед `| 'unknown';` дописать:

```ts
  | 'no_input'
  | 'keyframe'
  | 'omni_rejected'
  | 'omni_failed'
  | 'omni_budget'
  | 'google_quota'
  | 'google_auth'
  | 'model_gone'
  | 'speech_mismatch'
  | 'clip_invalid'
  | 'stt'
  | 'unknown';
```

(строка `| 'no_input'` уже есть — заменить хвост `| 'no_input'\n  | 'unknown';` на блок выше).

- [ ] **Step 5: Ключ Google в конфиге**

В `studio/src/config.ts`:

1. В `StudioConfig` после `speechkitFolder: string;`:

```ts
  /** Ключ Google (Nano Banana Pro и Omni) — заданию animate. */
  googleKey: string;
```

2. Сигнатура: `needs: { capture: boolean; tts: boolean; worker?: boolean; animate?: boolean }`.

3. В возвращаемый объект после `speechkitFolder: …,`:

```ts
    googleKey: needs.animate === true ? required(env, 'GOOGLE_AI_API_KEY') : (env.GOOGLE_AI_API_KEY?.trim() ?? ''),
```

4. В комментарий над `parseConfig` дописать: «оживлению сценок — ключ Google».

В `studio/.env.example` после строки `YANDEX_TTS_FOLDER_ID=`:

```
# Ключ Google (Nano Banana Pro и Omni) — оживление сценок (npm run animate). Тот же, что GOOGLE_AI_API_KEY бэкенда.
GOOGLE_AI_API_KEY=
```

- [ ] **Step 6: Прогнать тесты и типы**

```bash
git -C "$WT" add studio/src/types.ts studio/src/errors.ts studio/src/config.ts studio/.env.example
git -C "$WT" commit -m "feat(studio): типы сценок, коды ошибок оживления и ключ Google

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/config.test.ts src/errors.test.ts && npm run typecheck && echo TSC_OK"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts.contract.spec.ts"
```

Expected: студия — все тесты `pass`, затем `TSC_OK`; бэкенд — `Tests: 3 passed`.

---

### Task 6: Сверка речи

**Files:**
- Create: `studio/src/animate/match.ts`
- Test: `studio/src/animate/match.test.ts`
- Modify: `studio/package.json` (`scripts.test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/animate/match.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATCH_THRESHOLD, speechMatch, speechWords } from './match';

test('слова — без регистра, знаков и с «е» вместо «ё»', () => {
  assert.deepEqual(speechWords('Обои потёрли! Залог — мой.'), ['обои', 'потерли', 'залог', 'мой']);
  assert.deepEqual(speechWords('Га-га… ладно.'), ['га', 'га', 'ладно']);
});

test('всё сказано — 1, ничего не услышано — 0', () => {
  const lines = ['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'];
  assert.equal(speechMatch(lines, 'обои потерли залог мой спокойно спрошу у юриста'), 1);
  assert.equal(speechMatch(lines, ''), 0);
});

test('часть реплик проглочена — доля услышанных слов', () => {
  assert.equal(speechMatch(['раз два три четыре'], 'раз два'), 0.5);
});

test('повтор слова считается столько раз, сколько сказан', () => {
  assert.equal(speechMatch(['га га ладно'], 'га ладно'), 2 / 3);
});

test('реплик нет — сверять нечего', () => {
  assert.equal(speechMatch([], 'что угодно'), 1);
});

test('стартовый порог — 0,6', () => {
  assert.equal(MATCH_THRESHOLD, 0.6);
});
```

В `studio/package.json` в `scripts.test` заменить хвост `src/capture/promo.test.ts"` на `src/capture/promo.test.ts src/animate/match.test.ts"`.

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/match.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): сверка распознанной речи с репликами (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/match.test.ts"
```

Expected: FAIL — модуля `./match` нет (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Написать модуль**

`studio/src/animate/match.ts`:

```ts
/**
 * Сверка речи клипа Omni с репликами сценки: проглотил ли Omni реплику или
 * переврал её. Распознаёт SpeechKit (stt.ts), сравниваются слова.
 */

/** Доля слов реплик, которая должна прозвучать. Стартовая; окончательная подбирается на ролике-образце. */
export const MATCH_THRESHOLD = 0.6;

export function speechWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Доля слов реплик (с повторами), найденных в распознанном тексте. Реплик нет — 1. */
export function speechMatch(lines: string[], heard: string): number {
  const expected = lines.flatMap(speechWords);
  if (!expected.length) return 1;
  const pool = new Map<string, number>();
  for (const w of speechWords(heard)) pool.set(w, (pool.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of expected) {
    const left = pool.get(w) ?? 0;
    if (left > 0) {
      hit++;
      pool.set(w, left - 1);
    }
  }
  return hit / expected.length;
}
```

- [ ] **Step 4: Прогнать тест**

```bash
git -C "$WT" add studio/src/animate/match.ts
git -C "$WT" commit -m "feat(studio): сверка речи клипа с репликами по словам

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/match.test.ts"
```

Expected: `# pass 6`, `# fail 0`.

---

### Task 7: Время реплик сценки по паузам

**Files:**
- Create: `studio/src/animate/cues.ts`
- Test: `studio/src/animate/cues.test.ts`
- Modify: `studio/src/ffprobe.ts` (`detectSilences` с порогами)
- Modify: `studio/package.json` (`scripts.test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/animate/cues.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineCues, voicedSpans } from './cues';

test('отрезки речи — между паузами; щелчки короче 300 мс отброшены', () => {
  const silences = [
    { start: 0, end: 0.4, duration: 0.4 },
    { start: 3.0, end: 3.6, duration: 0.6 },
    { start: 3.8, end: 4.5, duration: 0.7 },
    { start: 7.2, end: 8.0, duration: 0.8 },
  ];
  assert.deepEqual(voicedSpans(silences, 8000), [
    { startMs: 400, endMs: 3000 },
    { startMs: 4500, endMs: 7200 },
  ]);
});

test('без пауз — один отрезок на весь клип', () => {
  assert.deepEqual(voicedSpans([], 8000), [{ startMs: 0, endMs: 8000 }]);
});

test('отрезков столько же, сколько реплик, — реплика на отрезок', () => {
  const spans = [
    { startMs: 400, endMs: 3000 },
    { startMs: 4500, endMs: 7200 },
  ];
  assert.deepEqual(lineCues(['Обои потёрли!', 'Спокойно.'], spans, 8000), [
    { line: 0, startMs: 400, endMs: 3000 },
    { line: 1, startMs: 4500, endMs: 7200 },
  ]);
});

test('иначе речь от первого отрезка до последнего делится пропорционально длине реплик', () => {
  assert.deepEqual(lineCues(['aaaa', 'aa'], [{ startMs: 1000, endMs: 7000 }], 8000), [
    { line: 0, startMs: 1000, endMs: 5000 },
    { line: 1, startMs: 5000, endMs: 7000 },
  ]);
});

test('отрезков нет — делится весь клип; реплик нет — субтитров нет', () => {
  assert.deepEqual(lineCues(['a', 'b'], [], 8000), [
    { line: 0, startMs: 0, endMs: 4000 },
    { line: 1, startMs: 4000, endMs: 8000 },
  ]);
  assert.deepEqual(lineCues([], [{ startMs: 0, endMs: 8000 }], 8000), []);
});
```

В `studio/package.json` в `scripts.test` заменить хвост `src/animate/match.test.ts"` на `src/animate/match.test.ts src/animate/cues.test.ts"`.

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/cues.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): время реплик сценки по паузам (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/cues.test.ts"
```

Expected: FAIL — модуля `./cues` нет.

- [ ] **Step 3: Пороги поиска тишины в `detectSilences`**

В `studio/src/ffprobe.ts` заменить функцию `detectSilences` целиком:

```ts
/**
 * Тишина в файле. По умолчанию — провалы звука в готовом ролике (−45 дБ, от
 * 0,5 с); паузы между репликами сценки ищутся своими порогами (animate/cues.ts).
 */
export async function detectSilences(file: string, totalSec: number, o: { noise?: string; minSec?: number } = {}): Promise<Silence[]> {
  // silencedetect пишет в stderr, ffmpeg при этом выходит с кодом 0.
  const { stderr } = await run(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=noise=${o.noise ?? '-45dB'}:d=${o.minSec ?? 0.5}`, '-f', 'null', '-'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return parseSilences(stderr, totalSec);
}
```

- [ ] **Step 4: Написать модуль**

`studio/src/animate/cues.ts`:

```ts
import type { Silence } from '../ffprobe';
import type { SkitCue } from '../types';

/**
 * Паузы между репликами в клипе Omni: под репликами у Omni фон (шаги, шорох),
 * поэтому порог выше, чем у проверки провалов звука в готовом ролике.
 * Стартовые значения; сверяются на ролике-образце.
 */
export const PAUSE_DETECT = { noise: '-30dB', minSec: 0.25 };

/** Отрезок речи короче этого — щелчок или вздох, а не реплика. */
const MIN_SPAN_MS = 300;

export interface Span {
  startMs: number;
  endMs: number;
}

/** Отрезки речи — промежутки между паузами. */
export function voicedSpans(silences: Silence[], totalMs: number, minMs = MIN_SPAN_MS): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    const start = Math.round(s.start * 1000);
    if (start - cursor >= minMs) spans.push({ startMs: cursor, endMs: start });
    cursor = Math.max(cursor, Math.round(s.end * 1000));
  }
  if (totalMs - cursor >= minMs) spans.push({ startMs: cursor, endMs: totalMs });
  return spans;
}

/**
 * Время субтитров реплик сценки. Отрезков речи столько же, сколько реплик, —
 * реплика на отрезок. Иначе речь (от начала первого отрезка до конца
 * последнего; без отрезков — весь клип) делится пропорционально длине реплик.
 */
export function lineCues(lines: string[], spans: Span[], totalMs: number): SkitCue[] {
  if (!lines.length) return [];
  if (spans.length === lines.length) return spans.map((s, i) => ({ line: i, startMs: s.startMs, endMs: s.endMs }));
  const from = spans.length ? spans[0].startMs : 0;
  const to = spans.length ? spans[spans.length - 1].endMs : totalMs;
  const weights = lines.map((l) => Math.max(1, l.length));
  const total = weights.reduce((n, w) => n + w, 0);
  const cues: SkitCue[] = [];
  let at = from;
  lines.forEach((_, i) => {
    const end = i === lines.length - 1 ? to : Math.round(at + ((to - from) * weights[i]) / total);
    cues.push({ line: i, startMs: at, endMs: end });
    at = end;
  });
  return cues;
}
```

- [ ] **Step 5: Прогнать тесты**

```bash
git -C "$WT" add studio/src/animate/cues.ts studio/src/ffprobe.ts
git -C "$WT" commit -m "feat(studio): время реплик сценки по паузам в звуке клипа, пороги поиска тишины

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/cues.test.ts src/ffprobe.test.ts"
```

Expected: все `pass`, `# fail 0`.

---

### Task 8: Клиент Google — кадр Nano Banana Pro и клип Omni

Формы запросов и ответов сняты живыми вызовами 24–26.10.2026 (`src/misc/veo.service.ts` в `origin/main`, прототипы `~/shorts-style/keys.py` и `omni.py` на ноде).

**Files:**
- Create: `studio/src/animate/google.ts`
- Test: `studio/src/animate/google.test.ts`
- Modify: `studio/package.json` (`scripts.test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/animate/google.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioError } from '../errors';
import { CLIP_SEC, generateKeyframe, googleHttpError, KEYFRAME_MODEL, OMNI_MODEL, startClip, waitClip, type GoogleDeps } from './google';

type Reply = { status?: number; body: unknown } | Error;

/** Подделка fetch: отвечает по очереди и запоминает запросы. */
function fake(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = replies.shift();
    if (!r) throw new Error('fake: ответов больше нет');
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  const deps: GoogleDeps = { apiKey: 'KEY', fetch: f, sleep: async () => {}, pollEveryMs: 1, pollTimeoutMs: 3 };
  return { deps, calls };
}

const isErr = (code: string, retryable: boolean) => (e: unknown) =>
  e instanceof StudioError && e.code === code && e.retryable === retryable;

const done = (data: Buffer) => ({
  body: { status: 'completed', steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text: 'вот' }, { type: 'video', data: data.toString('base64') }] }] },
});

test('кадр: портреты инлайном перед текстом, 9:16, ключ в заголовке, картинка из ответа', async () => {
  const png = Buffer.from('PNG');
  const { deps, calls } = fake([
    { body: { candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] } },
  ]);
  const refs = [{ data: Buffer.from('a'), mime: 'image/png' }, { data: Buffer.from('b'), mime: 'image/png' }];
  assert.deepEqual(await generateKeyframe(deps, 'промпт', refs), png);
  assert.match(calls[0].url, new RegExp(`models/${KEYFRAME_MODEL}:generateContent$`));
  assert.equal((calls[0].init?.headers as Record<string, string>)['x-goog-api-key'], 'KEY');
  const body = JSON.parse(String(calls[0].init?.body));
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], { inlineData: { mimeType: 'image/png', data: Buffer.from('a').toString('base64') } });
  assert.equal(parts[2].text, 'промпт');
  assert.deepEqual(body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } });
});

test('кадр без картинки (RECITATION приходит без ошибки) — повторяемая ошибка с причиной', async () => {
  const { deps } = fake([{ body: { candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }] } }]);
  await assert.rejects(generateKeyframe(deps, 'p', []), (e: unknown) => isErr('keyframe', true)(e) && /RECITATION/.test((e as Error).message));
});

test('HTTP-ошибки Google: квота, ключ и снятая модель не повторяются', () => {
  assert.ok(isErr('google_quota', false)(googleHttpError('omni', 429, '{}')));
  assert.ok(isErr('google_quota', false)(googleHttpError('keyframe', 400, 'RESOURCE_EXHAUSTED')));
  assert.ok(isErr('google_auth', false)(googleHttpError('omni', 403, 'denied')));
  assert.ok(isErr('model_gone', false)(googleHttpError('omni', 404, 'not found')));
  assert.ok(isErr('omni_rejected', true)(googleHttpError('omni', 400, '{"error":{"status":"INVALID_ARGUMENT"}}')));
  assert.ok(isErr('omni_failed', true)(googleHttpError('omni', 503, 'unavailable')));
  assert.ok(isErr('keyframe', true)(googleHttpError('keyframe', 500, 'oops')));
});

test('запуск клипа: Omni, фоновый, кадр и текст, 9:16 720p 8 с', async () => {
  const { deps, calls } = fake([{ body: { id: 'int-1', status: 'in_progress' } }]);
  assert.equal(await startClip(deps, 'сценка', { data: Buffer.from('kf'), mime: 'image/png' }), 'int-1');
  assert.match(calls[0].url, /\/v1beta\/interactions$/);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.model, OMNI_MODEL);
  assert.equal(body.background, true);
  assert.deepEqual(body.input, [
    { type: 'image', data: Buffer.from('kf').toString('base64'), mime_type: 'image/png' },
    { type: 'text', text: 'сценка' },
  ]);
  assert.deepEqual(body.response_format, { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: `${CLIP_SEC}s` });
});

test('запуск без id — повторяемая ошибка', async () => {
  const { deps } = fake([{ body: { status: 'in_progress' } }]);
  await assert.rejects(startClip(deps, 'p', { data: Buffer.from('k'), mime: 'image/png' }), isErr('omni_failed', true));
});

test('ожидание: в работе → готово, видео из шага model_output', async () => {
  const mp4 = Buffer.from('MP4');
  const { deps, calls } = fake([{ body: { status: 'in_progress' } }, done(mp4)]);
  assert.deepEqual(await waitClip(deps, 'int-1'), mp4);
  assert.match(calls[0].url, /\/interactions\/int-1$/);
});

test('ожидание: сбой сети и 5xx при опросе не сжигают генерацию', async () => {
  const mp4 = Buffer.from('MP4');
  const { deps } = fake([new Error('ECONNRESET'), { status: 503, body: 'x' }, done(mp4)]);
  assert.deepEqual(await waitClip(deps, 'i'), mp4);
});

test('отказ фильтра приходит массивом errors — повторяемый omni_rejected', async () => {
  const { deps } = fake([{ body: { status: 'failed', errors: [{ code: 'INVALID_ARGUMENT', message: 'There was a problem processing your request' }] } }]);
  await assert.rejects(waitClip(deps, 'i'), isErr('omni_rejected', true));
});

test('прочий провал — omni_failed; квота в провале — google_quota', async () => {
  const a = fake([{ body: { status: 'failed', errors: [{ code: 'INTERNAL', message: 'boom' }] } }]);
  await assert.rejects(waitClip(a.deps, 'i'), isErr('omni_failed', true));
  const b = fake([{ body: { status: 'failed', errors: [{ code: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' }] } }]);
  await assert.rejects(waitClip(b.deps, 'i'), isErr('google_quota', false));
});

test('готово, но без видео — omni_rejected с текстом модели', async () => {
  const { deps } = fake([{ body: { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Не могу' }] }] } }]);
  await assert.rejects(waitClip(deps, 'i'), (e: unknown) => isErr('omni_rejected', true)(e) && /Не могу/.test((e as Error).message));
});

test('не дождались — omni_failed', async () => {
  const { deps } = fake([{ body: { status: 'in_progress' } }, { body: { status: 'in_progress' } }, { body: { status: 'in_progress' } }]);
  await assert.rejects(waitClip(deps, 'i'), (e: unknown) => isErr('omni_failed', true)(e) && /не дождались/.test((e as Error).message));
});
```

В `studio/package.json` в `scripts.test` заменить хвост `src/animate/cues.test.ts"` на `src/animate/cues.test.ts src/animate/google.test.ts"`.

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/google.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): клиент Google — кадр Nano Banana Pro и клип Omni (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/google.test.ts"
```

Expected: FAIL — модуля `./google` нет.

- [ ] **Step 3: Написать клиент**

`studio/src/animate/google.ts`:

```ts
import { StudioError } from '../errors';

/**
 * Google Generative Language API: кадр-эталон (Nano Banana Pro) и клип сценки
 * (Gemini Omni Flash, Interactions API). Формы запросов сняты живыми вызовами
 * 24–26.10.2026 — см. src/misc/veo.service.ts бэкенда. В ошибки не попадают
 * ни ключ, ни картинки.
 */
const API = 'https://generativelanguage.googleapis.com/v1beta';
export const KEYFRAME_MODEL = 'gemini-3-pro-image-preview';
export const OMNI_MODEL = 'gemini-omni-1.1-flash';
/** Длина клипа сценки, секунды: сценки по 8 с, без продления (спека). */
export const CLIP_SEC = 8;

export interface GoogleDeps {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Опрос Omni: шаг и предел на одну генерацию. */
  pollEveryMs?: number;
  pollTimeoutMs?: number;
}

export interface ImageInput {
  data: Buffer;
  mime: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const headers = (d: GoogleDeps) => ({ 'x-goog-api-key': d.apiKey, 'Content-Type': 'application/json' });

/**
 * HTTP-ошибка Google → StudioError. Квота, ключ и снятая модель повтором не
 * лечатся: каждая лишняя попытка Omni стоит денег.
 */
export function googleHttpError(what: 'keyframe' | 'omni', status: number, body: string): StudioError {
  const text = body.slice(0, 300);
  if (status === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota/i.test(body)) {
    return new StudioError('google_quota', `${what}: квота Google на сегодня исчерпана — повторить после ≈ 11:00 МСК (HTTP ${status})`, false);
  }
  if (status === 401 || status === 403) return new StudioError('google_auth', `${what}: Google отклонил ключ GOOGLE_AI_API_KEY (HTTP ${status})`, false);
  if (status === 404) {
    return new StudioError('model_gone', `${what}: модель недоступна (HTTP 404) — Google её снял; переключите формат на «Только чат». ${text}`, false);
  }
  if (what === 'omni' && status === 400 && /INVALID_ARGUMENT/.test(body)) {
    return new StudioError('omni_rejected', `omni: Google отклонил запрос (фильтр контента или промпт): ${text}`, true);
  }
  return new StudioError(what === 'omni' ? 'omni_failed' : 'keyframe', `${what}: Google ответил HTTP ${status}: ${text}`, true);
}

export async function generateKeyframe(d: GoogleDeps, prompt: string, refs: ImageInput[]): Promise<Buffer> {
  const f = d.fetch ?? fetch;
  const body = {
    contents: [{ parts: [...refs.map((r) => ({ inlineData: { mimeType: r.mime, data: r.data.toString('base64') } })), { text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } },
  };
  const resp = await f(`${API}/models/${KEYFRAME_MODEL}:generateContent`, { method: 'POST', headers: headers(d), body: JSON.stringify(body) });
  const raw = await resp.text();
  if (!resp.ok) throw googleHttpError('keyframe', resp.status, raw);
  const cand = (JSON.parse(raw) as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> })
    .candidates?.[0];
  const img = (cand?.content?.parts ?? []).find((p) => p?.inlineData?.data);
  // RECITATION и прочие отказы приходят без ошибки HTTP — просто без картинки.
  if (!img?.inlineData?.data) throw new StudioError('keyframe', `keyframe: Nano Banana не вернул картинку (${cand?.finishReason ?? 'без причины'})`, true);
  return Buffer.from(img.inlineData.data, 'base64');
}

export async function startClip(d: GoogleDeps, prompt: string, image: ImageInput): Promise<string> {
  const f = d.fetch ?? fetch;
  const body = {
    model: OMNI_MODEL,
    background: true,
    input: [
      { type: 'image', data: image.data.toString('base64'), mime_type: image.mime },
      { type: 'text', text: prompt },
    ],
    response_format: { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: `${CLIP_SEC}s` },
  };
  const resp = await f(`${API}/interactions`, { method: 'POST', headers: headers(d), body: JSON.stringify(body) });
  const raw = await resp.text();
  if (!resp.ok) throw googleHttpError('omni', resp.status, raw);
  const id = (JSON.parse(raw) as { id?: string }).id;
  if (!id) throw new StudioError('omni_failed', `omni: в ответе нет id взаимодействия: ${raw.slice(0, 200)}`, true);
  return id;
}

interface Interaction {
  status?: string;
  errors?: Array<{ code?: string; message?: string }>;
  error?: { code?: string; message?: string };
  steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string; text?: string }> }>;
}

/** Ждёт клип. Сбой сети и 5xx при опросе — не повод бросать оплаченную генерацию: опрос продолжается. */
export async function waitClip(d: GoogleDeps, id: string): Promise<Buffer> {
  const f = d.fetch ?? fetch;
  const sleep = d.sleep ?? realSleep;
  const every = d.pollEveryMs ?? 10_000;
  const limit = d.pollTimeoutMs ?? 6 * 60_000;
  for (let waited = 0; waited < limit; waited += every) {
    await sleep(every);
    let resp: Response;
    try {
      resp = await f(`${API}/interactions/${id}`, { headers: { 'x-goog-api-key': d.apiKey } });
    } catch {
      continue;
    }
    const raw = await resp.text();
    if (!resp.ok) {
      if (resp.status >= 500) continue;
      throw googleHttpError('omni', resp.status, raw);
    }
    const st = JSON.parse(raw) as Interaction;
    if (st.status === 'in_progress') continue;
    if (st.status !== 'completed') {
      // Провал приходит массивом errors: [{ code, message }] (живой ответ 24.10.2026).
      const errs = Array.isArray(st.errors) ? st.errors : st.error ? [st.error] : [];
      const first = errs.find((e) => e?.message) ?? errs[0];
      const msg = first?.message ?? `взаимодействие ${st.status ?? 'без статуса'}`;
      if (first?.code === 'INVALID_ARGUMENT') throw new StudioError('omni_rejected', `omni: отказ фильтра — ${msg}`, true);
      if (first?.code === 'RESOURCE_EXHAUSTED' || /quota/i.test(msg)) {
        throw new StudioError('google_quota', `omni: квота Google на сегодня исчерпана — повторить после ≈ 11:00 МСК (${msg})`, false);
      }
      throw new StudioError('omni_failed', `omni: ${msg}`, true);
    }
    const parts = (st.steps ?? []).filter((s) => s?.type === 'model_output').flatMap((s) => s.content ?? []);
    const video = parts.filter((c) => c?.type === 'video').pop();
    if (video?.data) return Buffer.from(video.data, 'base64');
    const said = parts
      .filter((c) => c?.type === 'text' && c.text)
      .map((c) => c.text)
      .join(' ')
      .trim();
    throw new StudioError('omni_rejected', `omni: видео нет${said ? ` — модель ответила: ${said.slice(0, 300)}` : ''}`, true);
  }
  throw new StudioError('omni_failed', `omni: не дождались клипа за ${Math.round(limit / 60_000)} мин`, true);
}
```

- [ ] **Step 4: Прогнать тест и типы**

```bash
git -C "$WT" add studio/src/animate/google.ts
git -C "$WT" commit -m "feat(studio): клиент Google — кадр Nano Banana Pro, запуск и ожидание клипа Omni, разбор отказов

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/google.test.ts && npm run typecheck && echo TSC_OK"
```

Expected: `# pass 11`, `# fail 0`, затем `TSC_OK`.

---

### Task 9: Распознавание речи клипа

**Files:**
- Create: `studio/src/animate/stt.ts`
- Test: `studio/src/animate/stt.test.ts`
- Modify: `studio/package.json` (`scripts.test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/animate/stt.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioError } from '../errors';
import { recognize } from './stt';

type Reply = { status?: number; body: unknown } | Error;

function fake(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = replies.shift();
    if (!r) throw new Error('fake: ответов больше нет');
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

const creds = { apiKey: 'K', folderId: 'F' };
const noSleep = async () => {};

test('распознавание: ru-RU, oggopus, каталог в адресе, ключ в заголовке, тело — звук', async () => {
  const { f, calls } = fake([{ body: { result: 'обои потерли' } }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: f, sleep: noSleep }), 'обои потерли');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize');
  assert.equal(url.searchParams.get('lang'), 'ru-RU');
  assert.equal(url.searchParams.get('format'), 'oggopus');
  assert.equal(url.searchParams.get('folderId'), 'F');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Api-Key K');
  assert.deepEqual(Buffer.from(calls[0].init?.body as Uint8Array), Buffer.from('OGG'));
});

test('пустой результат — пустая строка', async () => {
  const { f } = fake([{ body: {} }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: f, sleep: noSleep }), '');
});

test('сбой сети и 5xx повторяются здесь же', async () => {
  const { f, calls } = fake([new Error('ECONNRESET'), { status: 503, body: 'busy' }, { body: { result: 'да' } }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: f, sleep: noSleep }), 'да');
  assert.equal(calls.length, 3);
});

test('три сбоя подряд — ошибка без повтора: клип уже оплачен, пересъёмка не поможет', async () => {
  const { f, calls } = fake([{ status: 503, body: 'a' }, { status: 503, body: 'b' }, { status: 503, body: 'c' }]);
  await assert.rejects(
    recognize(Buffer.from('OGG'), creds, { fetch: f, sleep: noSleep }),
    (e: unknown) => e instanceof StudioError && e.code === 'stt' && !e.retryable,
  );
  assert.equal(calls.length, 3);
});

test('4xx (ключ, права) — сразу ошибка без повтора', async () => {
  const { f, calls } = fake([{ status: 401, body: 'unauthorized' }]);
  await assert.rejects(
    recognize(Buffer.from('OGG'), creds, { fetch: f, sleep: noSleep }),
    (e: unknown) => e instanceof StudioError && e.code === 'stt' && !e.retryable && /401/.test(e.message),
  );
  assert.equal(calls.length, 1);
});
```

В `studio/package.json` в `scripts.test` заменить хвост `src/animate/google.test.ts"` на `src/animate/google.test.ts src/animate/stt.test.ts"`.

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/stt.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): распознавание речи клипа в SpeechKit (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/stt.test.ts"
```

Expected: FAIL — модуля `./stt` нет.

- [ ] **Step 3: Написать модуль**

`studio/src/animate/stt.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StudioError } from '../errors';

const run = promisify(execFile);
const STT_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';
const STT_ATTEMPTS = 3;
const STT_PAUSE_MS = 2000;

export interface SttCreds {
  apiKey: string;
  folderId: string;
}

export interface SttOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Звук клипа → ogg/opus, моно 48 кГц: так его принимает SpeechKit v1 (до 30 с и 1 МБ). */
export async function speechAudio(clip: string, out: string): Promise<string> {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', clip, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', out]);
  return out;
}

/**
 * Распознавание SpeechKit v1 (те же ключи, что у синтеза). Сбой сети и 5xx
 * повторяются здесь же, до трёх раз: клип Omni уже оплачен, и пересъёмка из-за
 * моргнувшего SpeechKit стоила бы денег. Поэтому наружу ошибка выходит без
 * повтора. В ошибку не попадают ни ключ, ни звук.
 */
export async function recognize(ogg: Buffer, creds: SttCreds, o: SttOptions = {}): Promise<string> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${STT_URL}?${new URLSearchParams({ lang: 'ru-RU', format: 'oggopus', folderId: creds.folderId })}`;
  let last = '';
  for (let attempt = 1; attempt <= STT_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(STT_PAUSE_MS);
    let resp: Response;
    try {
      resp = await f(url, { method: 'POST', headers: { Authorization: `Api-Key ${creds.apiKey}` }, body: new Uint8Array(ogg) });
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      continue;
    }
    const raw = await resp.text();
    if (resp.ok) return String((JSON.parse(raw) as { result?: string }).result ?? '');
    last = `SpeechKit ${resp.status} ${raw.slice(0, 200)}`;
    if (resp.status < 500) break;
  }
  throw new StudioError('stt', `stt: распознать речь не удалось — ${last}`, false);
}
```

- [ ] **Step 4: Прогнать тест**

```bash
git -C "$WT" add studio/src/animate/stt.ts
git -C "$WT" commit -m "feat(studio): распознавание речи клипа в SpeechKit — повторы внутри, наружу без пересъёмки

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/stt.test.ts"
```

Expected: `# pass 5`, `# fail 0`.

---

### Task 10: Проверка клипа и выравнивание громкости

**Files:**
- Create: `studio/src/animate/clip-check.ts`
- Test: `studio/src/animate/clip-check.test.ts`
- Modify: `studio/package.json` (`scripts.test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/animate/clip-check.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIP_LIMITS, CLIP_LUFS, checkClip } from './clip-check';

const probe = { durationSec: 8, width: 720, height: 1280, hasAudio: true };

test('нормальный клип Omni проходит', () => {
  assert.deepEqual(checkClip(probe, [{ start: 3, end: 3.8, duration: 0.8 }]), []);
});

test('длина вне 6,5–9,5 с', () => {
  assert.match(checkClip({ ...probe, durationSec: 4 }, []).join(), /длина 4\.0 с/);
  assert.match(checkClip({ ...probe, durationSec: 12 }, []).join(), /длина 12\.0 с/);
});

test('нет видео, кадр не вертикальный, нет звука', () => {
  assert.match(checkClip({ ...probe, width: 0, height: 0 }, []).join(), /нет видеодорожки/);
  assert.match(checkClip({ ...probe, width: 1280, height: 720 }, []).join(), /не вертикальный/);
  assert.match(checkClip({ ...probe, hasAudio: false }, []).join(), /нет звука/);
});

test('тишина длиннее 3 с — реплика не прозвучала', () => {
  assert.match(checkClip(probe, [{ start: 4, end: 7.5, duration: 3.5 }]).join(), /тишина 3\.5 с с 4\.0 с/);
});

test('стартовые пределы и громкость', () => {
  assert.deepEqual(CLIP_LIMITS, { minSec: 6.5, maxSec: 9.5, maxSilenceSec: 3 });
  assert.equal(CLIP_LUFS, -16);
});
```

В `studio/package.json` в `scripts.test` заменить хвост `src/animate/stt.test.ts"` на `src/animate/stt.test.ts src/animate/clip-check.test.ts"`.

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/clip-check.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): проверка клипа сценки (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/clip-check.test.ts"
```

Expected: FAIL — модуля `./clip-check` нет.

- [ ] **Step 3: Написать модуль**

`studio/src/animate/clip-check.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbeInfo, Silence } from '../ffprobe';
import { CLIP_SEC } from './google';

const run = promisify(execFile);

/**
 * Пределы клипа сценки. Тишина до 3 с: между репликами сценки бывают паузы.
 * Стартовое значение; сверяется на ролике-образце.
 */
export const CLIP_LIMITS = { minSec: CLIP_SEC - 1.5, maxSec: CLIP_SEC + 1.5, maxSilenceSec: 3 };

/**
 * Громкость клипов, LUFS. Стартовая; на образце сверяется с голосом SpeechKit
 * (ffmpeg -af ebur128), чтобы после живой сценки ответ не звучал тише или громче.
 */
export const CLIP_LUFS = -16;

export function checkClip(probe: ProbeInfo, silences: Silence[]): string[] {
  const problems: string[] = [];
  if (!(probe.durationSec >= CLIP_LIMITS.minSec && probe.durationSec <= CLIP_LIMITS.maxSec)) {
    problems.push(`длина ${probe.durationSec.toFixed(1)} с вне ${CLIP_LIMITS.minSec}–${CLIP_LIMITS.maxSec} с`);
  }
  if (!probe.width || !probe.height) problems.push('нет видеодорожки');
  else if (probe.height <= probe.width) problems.push(`кадр ${probe.width}×${probe.height} не вертикальный`);
  if (!probe.hasAudio) problems.push('нет звука');
  for (const s of silences) {
    if (s.duration > CLIP_LIMITS.maxSilenceSec) problems.push(`тишина ${s.duration.toFixed(1)} с с ${s.start.toFixed(1)} с`);
  }
  return problems;
}

/** Громкость клипа — к CLIP_LUFS; видео не перекодируется. */
export async function normalizeLoudness(input: string, output: string, lufs = CLIP_LUFS): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-c:v', 'copy', '-af', `loudnorm=I=${lufs}:TP=-1.5:LRA=11`, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k',
    output,
  ]);
}
```

- [ ] **Step 4: Прогнать тест**

```bash
git -C "$WT" add studio/src/animate/clip-check.ts
git -C "$WT" commit -m "feat(studio): проверка клипа сценки и выравнивание громкости

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/clip-check.test.ts"
```

Expected: `# pass 5`, `# fail 0`.

---

### Task 11: Задание «оживление»

Сердце плана. Порядок: кадр конфликта → обе сценки параллельно (кадр развязки рисуется по кадру конфликта). У каждой сценки — до трёх клипов Omni. Готовая сценка с тем же отпечатком не переснимается.

**Files:**
- Create: `studio/src/animate/run-animate.ts`
- Test: `studio/src/animate/run-animate.test.ts`
- Modify: `studio/package.json` (`scripts.test`, `scripts.animate`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/animate/run-animate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioError } from '../errors';
import type { Animation, Script, SkitKind, SkitPlan } from '../types';
import { animateRun, type AnimateDeps } from './run-animate';

const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

const LINES: Record<SkitKind, string[]> = {
  conflict: ['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'],
  punchline: ['Три года — нормальный износ.', 'Га-га… ладно.'],
};

function plan(kind: SkitKind, lines = LINES[kind], fingerprint = `fp-${kind}`): SkitPlan {
  return {
    skit: {
      cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
      setting: 'hallway',
      action: 'argue',
      lines: lines.map((text, i) => ({ hero: i % 2 ? 'kesha' : 'galina', text })),
    },
    troupeVersion: 'v1',
    heroes: ['galina', 'kesha'],
    keyframePrompt: `kf ${kind}`,
    videoPrompt: `video ${kind}: ${lines.join(' / ')}`,
    fingerprint,
  };
}

/** Папка ролика с script.json и портретами; клип-фикстура — 8 с, 720×1280, синус. */
function setup(skits = { conflict: plan('conflict'), punchline: plan('punchline') }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-animate-'));
  const runDir = path.join(root, 'run');
  const troupeDir = path.join(root, 'troupe');
  fs.mkdirSync(runDir);
  fs.mkdirSync(path.join(troupeDir, 'v1'), { recursive: true });
  for (const h of ['galina', 'kesha']) ff('-f', 'lavfi', '-i', 'color=c=white:s=64x128', '-frames:v', '1', path.join(troupeDir, 'v1', `${h}.png`));
  const clip = path.join(root, 'clip.mp4');
  ff('-f', 'lavfi', '-i', 'color=c=green:s=720x1280:d=8', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=8', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip);
  writeScript(runDir, skits);
  return { root, runDir, troupeDir, clip: fs.readFileSync(clip), png: fs.readFileSync(path.join(troupeDir, 'v1', 'kesha.png')) };
}

function writeScript(runDir: string, skits: { conflict: SkitPlan; punchline: SkitPlan }) {
  const script = { hook: 'Зацепка', voice: 'madirus', lines: [], final: { assistantsCount: 18 }, skits } as unknown as Script;
  fs.writeFileSync(path.join(runDir, 'script.json'), JSON.stringify(script));
}

const kindOf = (prompt: string): SkitKind => (prompt.includes('punchline') ? 'punchline' : 'conflict');

/** Подделка Google и SpeechKit. «Услышанное» по умолчанию — реплики своей сценки. */
function fakes(
  env: ReturnType<typeof setup>,
  o: {
    heard?: (kind: SkitKind, attempt: number) => string;
    start?: (kind: SkitKind, n: number) => void;
    clip?: (kind: SkitKind, n: number) => Buffer;
    keyframeDelayMs?: Partial<Record<SkitKind, number>>;
  } = {},
) {
  const calls = { keyframe: [] as Array<{ kind: SkitKind; refs: number }>, start: [] as SkitKind[] };
  const ids = new Map<string, { kind: SkitKind; n: number }>();
  const deps: AnimateDeps = {
    keyframe: async (prompt, refs) => {
      const kind = kindOf(prompt);
      calls.keyframe.push({ kind, refs: refs.length });
      const delay = o.keyframeDelayMs?.[kind] ?? 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return env.png;
    },
    startClip: async (prompt) => {
      const kind = kindOf(prompt);
      const n = calls.start.filter((k) => k === kind).length + 1;
      calls.start.push(kind);
      o.start?.(kind, n);
      const id = `id-${calls.start.length}`;
      ids.set(id, { kind, n });
      return id;
    },
    waitClip: async (id) => {
      const { kind, n } = ids.get(id)!;
      return o.clip ? o.clip(kind, n) : env.clip;
    },
    recognize: async (_ogg, ctx) => (o.heard ? o.heard(ctx.kind, ctx.attempt) : LINES[ctx.kind].join(' ')),
    troupeDir: env.troupeDir,
  };
  return { deps, calls };
}

const readAnim = (runDir: string): Animation => JSON.parse(fs.readFileSync(path.join(runDir, 'animation.json'), 'utf8'));

test('обе сценки: кадры по очереди, клипы, речь сошлась, секунды Omni посчитаны', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env);
  const anim = await animateRun(env.runDir, deps);
  assert.deepEqual(calls.keyframe, [{ kind: 'conflict', refs: 2 }, { kind: 'punchline', refs: 3 }]);
  assert.deepEqual([...calls.start].sort(), ['conflict', 'punchline']);
  assert.equal(anim.omniSeconds, 16);
  for (const kind of ['conflict', 'punchline'] as const) {
    const s = anim.skits[kind]!;
    assert.equal(s.fingerprint, `fp-${kind}`);
    assert.equal(s.attempts, 1);
    assert.equal(s.cues.length, 2);
    assert.ok(Math.abs(s.durationMs - 8000) < 200, `длина ${s.durationMs}`);
    assert.ok(fs.statSync(path.join(env.runDir, s.clip)).size > 1000);
    assert.ok(fs.existsSync(path.join(env.runDir, s.keyframe)));
  }
  assert.deepEqual(readAnim(env.runDir), anim);
});

test('повторный запуск с теми же сценками ничего не генерирует', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  const again = fakes(env);
  const anim = await animateRun(env.runDir, again.deps);
  assert.deepEqual(again.calls, { keyframe: [], start: [] });
  assert.equal(anim.omniSeconds, 16);
});

test('правка развязки переснимает только развязку', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  const lines = ['Это износ, верните залог.', 'Га-га… ладно.'];
  LINES.punchline = lines;
  try {
    writeScript(env.runDir, { conflict: plan('conflict'), punchline: plan('punchline', lines, 'fp-punchline-2') });
    const second = fakes(env);
    const anim = await animateRun(env.runDir, second.deps);
    assert.deepEqual(second.calls.keyframe, [{ kind: 'punchline', refs: 3 }]);
    assert.deepEqual(second.calls.start, ['punchline']);
    assert.equal(anim.skits.conflict!.fingerprint, 'fp-conflict');
    assert.equal(anim.skits.punchline!.fingerprint, 'fp-punchline-2');
    assert.equal(anim.omniSeconds, 24);
  } finally {
    LINES.punchline = ['Три года — нормальный износ.', 'Га-га… ладно.'];
  }
});

test('речь не сошлась — пересъёмка клипа без нового кадра', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, { heard: (kind, attempt) => (kind === 'conflict' && attempt === 1 ? '' : LINES[kind].join(' ')) });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
  assert.equal(calls.keyframe.length, 2);
  assert.equal(anim.omniSeconds, 24);
});

test('отказ фильтра — новый кадр и новая попытка', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, {
    start: (kind, n) => {
      if (kind === 'conflict' && n === 1) throw new StudioError('omni_rejected', 'omni: отказ фильтра', true);
    },
  });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
  assert.equal(calls.keyframe.filter((k) => k.kind === 'conflict').length, 2);
  assert.equal(anim.omniSeconds, 16, 'несостоявшийся запуск не списывается');
});

test('битый файл от Omni — пересъёмка', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { clip: (kind, n) => (kind === 'conflict' && n === 1 ? Buffer.from('not a video') : env.clip) });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
});

test('квота — сразу ошибка без повтора, секунды не списаны, готовая сценка сохранена', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, {
    start: (kind) => {
      if (kind === 'conflict') throw new StudioError('google_quota', 'omni: квота', false);
    },
  });
  await assert.rejects(animateRun(env.runDir, deps), (e: unknown) => e instanceof StudioError && e.code === 'google_quota');
  assert.equal(calls.start.filter((k) => k === 'conflict').length, 1);
  const anim = readAnim(env.runDir);
  assert.equal(anim.omniSeconds, 8);
  assert.equal(anim.skits.conflict, undefined);
  assert.equal(anim.skits.punchline!.fingerprint, 'fp-punchline');
});

test('предел секунд Omni на ролик', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { keyframeDelayMs: { punchline: 50 } });
  await assert.rejects(
    animateRun(env.runDir, { ...deps, maxOmniSeconds: 8 }),
    (e: unknown) => e instanceof StudioError && e.code === 'omni_budget' && !e.retryable && /предел — 8 с/.test(e.message),
  );
  const anim = readAnim(env.runDir);
  assert.equal(anim.omniSeconds, 8);
  assert.ok(anim.skits.conflict);
});

test('три несовпадения речи — сдаётся с причиной', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { heard: (kind) => (kind === 'conflict' ? 'совсем другое' : LINES[kind].join(' ')) });
  await assert.rejects(
    animateRun(env.runDir, deps),
    (e: unknown) => e instanceof StudioError && e.code === 'speech_mismatch' && !e.retryable && /после 3 попыток/.test(e.message),
  );
  assert.equal(readAnim(env.runDir).omniSeconds, 32);
});

test('в сценарии нет сценок — ошибка до трат', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-animate-'));
  fs.writeFileSync(path.join(root, 'script.json'), JSON.stringify({ hook: 'x', voice: 'v', lines: [], final: { assistantsCount: 18 } }));
  await assert.rejects(
    animateRun(root, {} as AnimateDeps),
    (e: unknown) => e instanceof StudioError && e.code === 'script_invalid',
  );
});

test('нет портрета героя — ошибка без повтора', async () => {
  const env = setup();
  fs.rmSync(path.join(env.troupeDir, 'v1', 'kesha.png'));
  await assert.rejects(
    animateRun(env.runDir, fakes(env).deps),
    (e: unknown) => e instanceof StudioError && e.code === 'script_invalid' && /kesha/.test(e.message),
  );
});
```

В `studio/package.json`:
- в `scripts.test` заменить хвост `src/animate/clip-check.test.ts"` на `src/animate/clip-check.test.ts src/animate/run-animate.test.ts"`;
- после строки `"render": "tsx src/render/run-render.ts",` добавить `"animate": "tsx src/animate/run-animate.ts",`.

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/run-animate.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): задание «оживление» — кадры, клипы, повторы, предел секунд Omni (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts"
```

Expected: FAIL — модуля `./run-animate` нет.

- [ ] **Step 3: Написать задание**

`studio/src/animate/run-animate.ts`:

```ts
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../config';
import { StudioError, toStudioError } from '../errors';
import { detectSilences, probeFile } from '../ffprobe';
import type { Animation, Script, SkitClip, SkitKind, SkitPlan } from '../types';
import { checkClip, normalizeLoudness } from './clip-check';
import { lineCues, PAUSE_DETECT, voicedSpans } from './cues';
import { CLIP_SEC, generateKeyframe, startClip, waitClip, type GoogleDeps, type ImageInput } from './google';
import { MATCH_THRESHOLD, speechMatch } from './match';
import { recognize, speechAudio } from './stt';

const STUDIO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SKIT_KINDS: readonly SkitKind[] = ['conflict', 'punchline'];
/** Клипов Omni на сценку — не больше (спека, «Отказы»). */
export const MAX_SKIT_ATTEMPTS = 3;
/** Предел секунд Omni на ролик: шесть клипов, ≈ $4,8 (спека, «Отказы»). */
export const DEFAULT_MAX_OMNI_SECONDS = 48;

export interface AnimateDeps {
  keyframe(prompt: string, refs: ImageInput[]): Promise<Buffer>;
  startClip(prompt: string, image: ImageInput): Promise<string>;
  waitClip(id: string): Promise<Buffer>;
  recognize(ogg: Buffer, ctx: { kind: SkitKind; attempt: number }): Promise<string>;
  /** Корень портретов труппы; по умолчанию studio/assets/troupe. */
  troupeDir?: string;
  maxOmniSeconds?: number;
  log?(msg: string): void;
}

/**
 * Оживление сценок папки ролика: script.json (со сценками) → animation.json и
 * skits/<отпечаток>/{keyframe.png, raw.mp4, speech.ogg, clip.mp4}.
 *
 * Кадр развязки рисуется по кадру конфликта (то же место и костюмы), поэтому
 * сначала кадр конфликта, потом обе сценки параллельно. Сценка с тем же
 * отпечатком и файлами на месте не переснимается — так замечание, которое
 * правит одну сценку, переснимает только её.
 */
export async function animateRun(runDir: string, deps: AnimateDeps): Promise<Animation> {
  const script = JSON.parse(fs.readFileSync(path.join(runDir, 'script.json'), 'utf8')) as Script;
  const plans = script.skits;
  if (!plans?.conflict || !plans?.punchline) {
    throw new StudioError('script_invalid', 'animate: в сценарии нет сценок (skits.conflict и skits.punchline)', false);
  }
  const animPath = path.join(runDir, 'animation.json');
  const anim: Animation = fs.existsSync(animPath) ? JSON.parse(fs.readFileSync(animPath, 'utf8')) : { omniSeconds: 0, skits: {} };
  const save = () => fs.writeFileSync(animPath, JSON.stringify(anim, null, 2));
  const budget = deps.maxOmniSeconds ?? DEFAULT_MAX_OMNI_SECONDS;
  const troupeDir = deps.troupeDir ?? path.join(STUDIO_ROOT, 'assets', 'troupe');
  const log = deps.log ?? (() => {});
  const abs = (rel: string) => path.join(runDir, rel);
  const rel = (kind: SkitKind, name: string) => path.posix.join('skits', plans[kind].fingerprint, name);
  const giveUp = (e: StudioError) => new StudioError(e.code, `${e.message} — после ${MAX_SKIT_ATTEMPTS} попыток`, false);

  const reusable = (kind: SkitKind): boolean => {
    const prev = anim.skits[kind];
    return !!prev && prev.fingerprint === plans[kind].fingerprint && fs.existsSync(abs(prev.clip)) && fs.existsSync(abs(prev.keyframe));
  };

  const portraits = (plan: SkitPlan): ImageInput[] =>
    plan.heroes.map((h) => {
      const f = path.join(troupeDir, plan.troupeVersion, `${h}.png`);
      if (!fs.existsSync(f)) throw new StudioError('script_invalid', `animate: нет портрета героя ${h} (труппа ${plan.troupeVersion})`, false);
      return { data: fs.readFileSync(f), mime: 'image/png' };
    });

  /** Кадр-эталон сценки; нарисованный с тем же отпечатком не перерисовывается. */
  const ensureKeyframe = async (kind: SkitKind): Promise<string> => {
    const kf = rel(kind, 'keyframe.png');
    if (fs.existsSync(abs(kf))) return kf;
    const refs = portraits(plans[kind]);
    if (kind === 'punchline') refs.push({ data: fs.readFileSync(abs(rel('conflict', 'keyframe.png'))), mime: 'image/png' });
    let last: StudioError | null = null;
    for (let attempt = 1; attempt <= MAX_SKIT_ATTEMPTS; attempt++) {
      try {
        const png = await deps.keyframe(plans[kind].keyframePrompt, refs);
        fs.mkdirSync(path.dirname(abs(kf)), { recursive: true });
        fs.writeFileSync(abs(kf), png);
        return kf;
      } catch (e) {
        last = toStudioError(e);
        if (!last.retryable) throw last;
        log(`animate ${kind}: кадр, попытка ${attempt} — ${last.message}`);
      }
    }
    throw giveUp(last!);
  };

  /** Сбой ffmpeg на уже проверенном файле — не повод платить за новый клип. */
  const local = async <T>(kind: SkitKind, what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StudioError) throw e;
      throw new StudioError('unknown', `animate ${kind}: ${what} — ${e instanceof Error ? e.message : String(e)}`, false);
    }
  };

  const animateSkit = async (kind: SkitKind): Promise<SkitClip> => {
    const plan = plans[kind];
    const texts = plan.skit.lines.map((l) => l.text);
    const raw = abs(rel(kind, 'raw.mp4'));
    const clip = rel(kind, 'clip.mp4');
    let last: StudioError | null = null;
    for (let attempt = 1; attempt <= MAX_SKIT_ATTEMPTS; attempt++) {
      let reserved = false;
      let started = false;
      try {
        const kf = await ensureKeyframe(kind);
        if (anim.omniSeconds + CLIP_SEC > budget) {
          throw new StudioError('omni_budget', `animate: на ролик ушло ${anim.omniSeconds} с Omni, предел — ${budget} с: лимит пересъёмок сценок`, false);
        }
        // Секунды резервируются до запуска: сценки идут параллельно, и обе не
        // должны пройти предел, когда места осталось на одну.
        anim.omniSeconds += CLIP_SEC;
        reserved = true;
        const id = await deps.startClip(plan.videoPrompt, { data: fs.readFileSync(abs(kf)), mime: 'image/png' });
        started = true;
        save();
        fs.writeFileSync(raw, await deps.waitClip(id));

        // Нечитаемый файл — вина клипа, а не студии: такой клип переснимается.
        const probe = await probeFile(raw).catch((e: unknown): never => {
          throw new StudioError('clip_invalid', `animate ${kind}: файл от Omni не читается — ${e instanceof Error ? e.message : String(e)}`, true);
        });
        const problems = checkClip(probe, await local(kind, 'поиск тишины', () => detectSilences(raw, probe.durationSec)));
        if (problems.length) throw new StudioError('clip_invalid', `animate ${kind}: клип не прошёл проверку — ${problems.join('; ')}`, true);

        const ogg = await local(kind, 'звук для распознавания', () => speechAudio(raw, abs(rel(kind, 'speech.ogg'))));
        const heard = await deps.recognize(fs.readFileSync(ogg), { kind, attempt });
        const score = speechMatch(texts, heard);
        if (score < MATCH_THRESHOLD) {
          throw new StudioError('speech_mismatch', `animate ${kind}: речь не сошлась с репликами (${Math.round(score * 100)}%), услышано: «${heard.slice(0, 200)}»`, true);
        }

        await local(kind, 'громкость', () => normalizeLoudness(raw, abs(clip)));
        const totalMs = Math.round(probe.durationSec * 1000);
        const pauses = await local(kind, 'поиск пауз', () => detectSilences(abs(clip), probe.durationSec, PAUSE_DETECT));
        log(`animate ${kind}: готово с попытки ${attempt}, речь ${Math.round(score * 100)}%`);
        return {
          fingerprint: plan.fingerprint,
          keyframe: kf,
          clip,
          durationMs: totalMs,
          heard,
          cues: lineCues(texts, voicedSpans(pauses, totalMs), totalMs),
          attempts: attempt,
        };
      } catch (e) {
        // Запуск не состоялся — деньги не ушли, резерв возвращается.
        if (reserved && !started) anim.omniSeconds -= CLIP_SEC;
        save();
        last = toStudioError(e);
        if (!last.retryable) throw last;
        // Фильтр мог зацепиться за сам кадр — следующая попытка рисует новый.
        if (last.code === 'omni_rejected') fs.rmSync(abs(rel(kind, 'keyframe.png')), { force: true });
        log(`animate ${kind}: попытка ${attempt} — ${last.message}`);
      }
    }
    throw giveUp(last!);
  };

  const todo = SKIT_KINDS.filter((k) => !reusable(k));
  if (todo.length) {
    await ensureKeyframe('conflict');
    const results = await Promise.allSettled(
      todo.map(async (kind) => {
        anim.skits[kind] = await animateSkit(kind);
        save();
      }),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw toStudioError(failed.reason);
  }
  save();
  return anim;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('usage: npm run animate -- <out/папка-ролика>   (MAX_OMNI_SECONDS — предел секунд Omni, по умолчанию 48)');
    process.exit(2);
  }
  const cfg = parseConfig(process.env, { capture: false, tts: true, animate: true });
  const g: GoogleDeps = { apiKey: cfg.googleKey };
  const stt = { apiKey: cfg.speechkitKey, folderId: cfg.speechkitFolder };
  try {
    const anim = await animateRun(path.resolve(runDir), {
      keyframe: (prompt, refs) => generateKeyframe(g, prompt, refs),
      startClip: (prompt, image) => startClip(g, prompt, image),
      waitClip: (id) => waitClip(g, id),
      recognize: (ogg) => recognize(ogg, stt),
      maxOmniSeconds: Number(process.env.MAX_OMNI_SECONDS || DEFAULT_MAX_OMNI_SECONDS),
      log: (m) => console.log(m),
    });
    for (const k of SKIT_KINDS) {
      const s = anim.skits[k];
      console.log(`animate ${k}: попыток ${s?.attempts}, услышано «${s?.heard}»`);
    }
    console.log(`animate: готово — Omni ${anim.omniSeconds} с (≈ $${(anim.omniSeconds * 0.1).toFixed(2)})`);
  } catch (e) {
    const err = toStudioError(e);
    console.error(`animate: ${err.code} — ${err.message}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Прогнать тест и типы**

```bash
git -C "$WT" add studio/src/animate/run-animate.ts
git -C "$WT" commit -m "feat(studio): задание «оживление» — кадр по портретам, клип Omni, сверка речи, громкость, время реплик

Готовая сценка с тем же отпечатком не переснимается. Секунды Omni
резервируются до запуска и возвращаются, если запуск не состоялся.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts && npm run typecheck && echo TSC_OK"
```

Expected: `# pass 11`, `# fail 0`, затем `TSC_OK`. Если тест «предел секунд Omni» нестабилен (конфликт и развязка резервируют в другом порядке) — увеличить `keyframeDelayMs.punchline` до 200 мс, а не ослаблять проверку.

---

### Task 12: Таймлайн и проверка сценария со сценками

**Files:**
- Modify: `studio/src/timeline.ts`, `studio/src/timeline.test.ts`
- Modify: `studio/src/script.ts`, `studio/src/script.test.ts`

- [ ] **Step 1: Написать падающие тесты**

В `studio/src/timeline.test.ts` заменить строку импорта:

```ts
import { buildSkitTimeline, buildTimeline, MIN_ANSWER_LINE_MS } from './timeline';
```

и дописать в конец файла:

```ts
const skitLines = (): VoicedLine[] => [line('q', 'question', 4000), line('a1', 'answer', 8000, 1), line('a2', 'answer', 8000, 2), line('f', 'final', 4000)];
const clips = { conflict: 8000, punchline: 8000 };

test('сценки: конфликт → вопрос → ответ → развязка → финал', () => {
  const t = buildSkitTimeline(skitLines(), clips, 30);
  assert.deepEqual(t.scenes.conflict, { from: 0, duration: 240 });
  assert.deepEqual(t.scenes.question, { from: 240, duration: 128 });
  assert.deepEqual(t.scenes.answer, { from: 368, duration: 496 });
  assert.deepEqual(t.scenes.punchline, { from: 864, duration: 240 });
  assert.deepEqual(t.scenes.final, { from: 1104, duration: 128 });
  assert.equal(t.totalFrames, 1232);
  assert.deepEqual(t.segments.map((s) => [s.lineId, s.from]), [['q', 240], ['a1', 368], ['a2', 616], ['f', 1104]]);
});

test('сценки: реплики hook нет — зацепка идёт надписью поверх сценки', () => {
  assert.throws(
    () => buildSkitTimeline([line('h', 'hook', 1500), ...skitLines()], clips, 30),
    (e: unknown) => e instanceof StudioError && e.code === 'script_invalid',
  );
});

test('сценки: ролик 25–45 с', () => {
  const ls = skitLines();
  const long = [...ls.slice(0, 3), line('a3', 'answer', 8000, 3), ls[3]];
  assert.throws(() => buildSkitTimeline(long, clips, 30), (e: unknown) => e instanceof StudioError && e.code === 'too_long');
  const short = [line('q', 'question', 2000), line('a1', 'answer', 2000, 1), line('f', 'final', 2000)];
  assert.throws(() => buildSkitTimeline(short, { conflict: 6000, punchline: 6000 }, 30), (e: unknown) => e instanceof StudioError && e.code === 'too_short');
});

test('сценки: короткая реплика ответа — line_too_short, как у обычного ролика', () => {
  const ls = skitLines();
  ls[1] = line('a1', 'answer', 1000, 1);
  assert.throws(() => buildSkitTimeline(ls, clips, 30), (e: unknown) => e instanceof StudioError && e.code === 'line_too_short');
});
```

В `studio/src/script.test.ts` заменить строку `import type { Script } from './types';` на `import type { Script, SkitPlan } from './types';` и дописать в конец файла:

```ts
const skitPlan = (lines: Array<{ hero: string; text: string; box?: number }>): SkitPlan => ({
  skit: { cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }], setting: 's', action: 'a', lines },
  troupeVersion: 'v1',
  heroes: ['galina', 'kesha'],
  keyframePrompt: 'k',
  videoPrompt: 'v',
  fingerprint: 'f',
});

const skitScript = (): Script => {
  const s = good();
  return {
    ...s,
    lines: s.lines.filter((l) => l.scene !== 'hook'),
    skits: { conflict: skitPlan([{ hero: 'galina', text: 'Залог мой!' }]), punchline: skitPlan([{ hero: 'kesha', text: 'Это износ.', box: 1 }]) },
  };
};

test('ролик со сценками: корректный проходит', () => {
  assert.deepEqual(validateScript(skitScript(), capture), []);
});

test('ролик со сценками: реплика hook лишняя', () => {
  const s = skitScript();
  s.lines.unshift({ id: 'h', scene: 'hook', text: s.hook });
  assert.ok(validateScript(s, capture).some((p) => /реплики hook быть не должно/.test(p)));
});

test('ролик со сценками: сценка без реплик и реплика с несуществующим абзацем', () => {
  const s = skitScript();
  s.skits = { conflict: skitPlan([]), punchline: skitPlan([{ hero: 'kesha', text: 'Износ.', box: 7 }]) };
  const problems = validateScript(s, capture);
  assert.ok(problems.includes('в сценке conflict нет реплик'));
  assert.ok(problems.some((p) => /сценки punchline ссылается на абзац 7/.test(p)));
});

test('ролик со сценками: без отпечатка студия не поймёт, что переснимать', () => {
  const s = skitScript();
  s.skits = { ...s.skits!, conflict: { ...s.skits!.conflict, fingerprint: '' } };
  assert.ok(validateScript(s, capture).includes('у сценки conflict нет отпечатка'));
});
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git -C "$WT" add studio/src/timeline.test.ts studio/src/script.test.ts
git -C "$WT" commit -m "test(studio): таймлайн и проверка сценария со сценками (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/timeline.test.ts src/script.test.ts"
```

Expected: FAIL — нет экспорта `buildSkitTimeline`; проверки сценок в `validateScript` нет.

- [ ] **Step 3: Таймлайн со сценками**

В `studio/src/timeline.ts`:

1. Импорт типов заменить на:

```ts
import type { LineScene, Segment, SkitKind, SkitTimeline, Timeline, VoicedLine } from './types';
```

2. После `export const MIN_ANSWER_LINE_MS = 1500;` добавить:

```ts
/** Ролик со сценками: 25–45 с (спека сценок, «Ролик»). */
export const SKIT_MIN_TOTAL_MS = 25_000;
export const SKIT_MAX_TOTAL_MS = 45_000;
```

3. После `const ORDER: LineScene[] = ['hook', 'question', 'answer', 'final'];` добавить:

```ts
/** Озвученные сцены ролика со сценками: зацепка — надпись поверх конфликта, реплики hook нет. */
const SKIT_LINE_ORDER: LineScene[] = ['question', 'answer', 'final'];
```

4. Вынести проверки порядка и длины реплик ответа в две функции перед `buildTimeline`:

```ts
function assertOrder(lines: VoicedLine[], order: LineScene[]): void {
  let at = 0;
  for (const l of lines) {
    const i = order.indexOf(l.scene);
    if (i < at) throw new StudioError('script_invalid', `timeline: сцена ${l.scene} после ${order[at]}; порядок ${order.join(' → ')}`, false);
    at = i;
  }
  for (const s of order) {
    if (!lines.some((l) => l.scene === s)) throw new StudioError('script_invalid', `timeline: в сцене ${s} нет реплик`, false);
  }
}

function assertAnswerLines(lines: VoicedLine[]): void {
  for (const l of lines) {
    if (l.scene === 'answer' && l.durationMs < MIN_ANSWER_LINE_MS) {
      throw new StudioError(
        'line_too_short',
        `timeline: реплика ${l.id} звучит ${(l.durationMs / 1000).toFixed(1)} с — короче ${MIN_ANSWER_LINE_MS / 1000} с: приближение к абзацу не успеет`,
        false,
      );
    }
  }
}
```

5. В `buildTimeline` заменить блок от `let at = 0;` до конца цикла проверки длины реплик ответа (три цикла подряд) на два вызова:

```ts
  assertOrder(lines, ORDER);
  assertAnswerLines(lines);
```

Сообщения ошибок от этого не меняются: `order.join(' → ')` для `ORDER` даёт прежнее «hook → question → answer → final».

6. В конец файла:

```ts
/**
 * Таймлайн ролика со сценками: конфликт (клип) → вопрос → ответ → развязка
 * (клип) → финал. Длину сценок задают клипы, длину остального — озвучка.
 */
export function buildSkitTimeline(lines: VoicedLine[], clips: Record<SkitKind, number>, fps = FPS): SkitTimeline {
  if (lines.some((l) => l.scene === 'hook')) {
    throw new StudioError('script_invalid', 'timeline: у ролика со сценками зацепка — надпись поверх сценки, реплики hook нет', false);
  }
  assertOrder(lines, SKIT_LINE_ORDER);
  assertAnswerLines(lines);

  const gap = msToFrames(GAP_MS, fps);
  const segments: Segment[] = [];
  const scenes = {} as SkitTimeline['scenes'];
  let cursor = 0;
  const clip = (kind: SkitKind) => {
    const duration = Math.max(1, msToFrames(clips[kind], fps));
    scenes[kind] = { from: cursor, duration };
    cursor += duration;
  };
  const voiced = (scene: 'question' | 'answer' | 'final') => {
    const from = cursor;
    for (const l of lines.filter((x) => x.scene === scene)) {
      const duration = Math.max(1, msToFrames(l.durationMs, fps));
      segments.push({ lineId: l.id, scene, text: l.text, box: l.box, audio: l.audio, from: cursor, duration });
      cursor += duration + gap;
    }
    scenes[scene] = { from, duration: cursor - from };
  };
  clip('conflict');
  voiced('question');
  voiced('answer');
  clip('punchline');
  voiced('final');

  const sec = cursor / fps;
  if (sec * 1000 < SKIT_MIN_TOTAL_MS) throw new StudioError('too_short', `timeline: ролик ${sec.toFixed(1)} с — короче 25 с`, false);
  if (sec * 1000 > SKIT_MAX_TOTAL_MS) throw new StudioError('too_long', `timeline: ролик ${sec.toFixed(1)} с — длиннее 45 с`, false);
  return { segments, scenes, totalFrames: cursor };
}
```

- [ ] **Step 4: Проверка сценария со сценками**

В `studio/src/script.ts` перед строкой `const count = script.final?.assistantsCount;` вставить:

```ts
  if (script.skits) {
    if (script.lines.some((l) => l.scene === 'hook')) {
      problems.push('у ролика со сценками зацепка — надпись поверх сценки, реплики hook быть не должно');
    }
    for (const kind of ['conflict', 'punchline'] as const) {
      const p = script.skits[kind];
      if (!p) {
        problems.push(`нет сценки ${kind}`);
        continue;
      }
      if (!p.fingerprint) problems.push(`у сценки ${kind} нет отпечатка`);
      if (!p.skit?.lines?.length) problems.push(`в сценке ${kind} нет реплик`);
      for (const l of p.skit?.lines ?? []) {
        if (l.box != null && !known.has(l.box)) {
          problems.push(`реплика сценки ${kind} ссылается на абзац ${l.box}, а снято абзацев: ${capture.boxes.length}`);
        }
      }
    }
  }
```

В комментарий над `validateScript` дописать: «У ролика со сценками — ещё сценки: реплики есть, абзацы существуют, отпечаток задан».

- [ ] **Step 5: Прогнать тесты**

```bash
git -C "$WT" add studio/src/timeline.ts studio/src/script.ts
git -C "$WT" commit -m "feat(studio): таймлайн ролика со сценками и проверка сценок в сценарии

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/timeline.test.ts src/script.test.ts && npm run typecheck && echo TSC_OK"
```

Expected: все `pass` (прежние тесты таймлайна и сценария тоже), `# fail 0`, затем `TSC_OK`.

---

### Task 13: Композиция `SkitShort` и её пропсы

**Files:**
- Modify: `studio/src/remotion/Caption.tsx`, `studio/src/remotion/scenes/Hook.tsx`, `studio/src/remotion/Root.tsx`
- Create: `studio/src/remotion/scenes/Clip.tsx`, `studio/src/remotion/SkitShort.tsx`
- Modify: `studio/src/render/props.ts`, `studio/src/render/props.test.ts`

- [ ] **Step 1: Падающий тест пропсов**

В `studio/src/render/props.test.ts` заменить импорты на:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProps, buildSkitProps } from './props';
import type { Animation, CaptureResult, Script, SkitPlan } from '../types';
import { StudioError } from '../errors';
```

и дописать в конец:

```ts
const skitPlan = (fingerprint: string, lines: string[]): SkitPlan => ({
  skit: { cast: [{ hero: 'galina', role: 'хозяйка' }, { hero: 'kesha', role: 'жилец' }], setting: 's', action: 'a', lines: lines.map((text) => ({ hero: 'kesha', text })) },
  troupeVersion: 'v1',
  heroes: ['galina', 'kesha'],
  keyframePrompt: 'k',
  videoPrompt: 'v',
  fingerprint,
});

const skitScript: Script = {
  hook: 'Хозяйка оставит залог?',
  voice: 'madirus',
  lines: [
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист.' },
    { id: 'a1', scene: 'answer', text: 'Первая.', box: 1 },
    { id: 'a2', scene: 'answer', text: 'Вторая.', box: 2 },
    { id: 'f', scene: 'final', text: 'Ссылка в описании.' },
  ],
  final: { assistantsCount: 18 },
  skits: { conflict: skitPlan('fc', ['Обои потёрли! Залог мой!', 'Спокойно.']), punchline: skitPlan('fp', ['Это износ.']) },
};

const skitMs: Record<string, number> = { q: 4000, a1: 8000, a2: 8000, f: 4000 };
const skitVoiced = skitScript.lines.map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: skitMs[l.id] }));

const animation: Animation = {
  omniSeconds: 16,
  skits: {
    conflict: { fingerprint: 'fc', keyframe: 'skits/fc/keyframe.png', clip: 'skits/fc/clip.mp4', durationMs: 8000, heard: '', attempts: 1,
      cues: [{ line: 0, startMs: 500, endMs: 3500 }, { line: 1, startMs: 4000, endMs: 7000 }] },
    punchline: { fingerprint: 'fp', keyframe: 'skits/fp/keyframe.png', clip: 'skits/fp/clip.mp4', durationMs: 8000, heard: '', attempts: 1,
      cues: [{ line: 0, startMs: 500, endMs: 3000 }] },
  },
};

test('пропсы со сценками: клипы и субтитры реплик на своих кадрах', () => {
  const p = buildSkitProps(capture, skitScript, skitVoiced, animation, '/run');
  assert.equal(p.clips.conflict.video, 'skits/fc/clip.mp4');
  assert.equal(p.clips.punchline.video, 'skits/fp/clip.mp4');
  assert.deepEqual(p.clips.conflict.cues[0], { key: 'conflict-0-0', text: 'Обои потёрли! Залог мой!', from: 15, duration: 90 });
  assert.equal(p.timeline.scenes.punchline.from, 864);
  assert.deepEqual(p.clips.punchline.cues[0], { key: 'punchline-0-0', text: 'Это износ.', from: 879, duration: 75 });
  assert.equal(p.hook, 'Хозяйка оставит залог?');
  assert.equal(p.timeline.segments[0].audio, 'voice/q.mp3');
});

test('клип снят под другую сценку — no_input без повтора', () => {
  const stale: Animation = { ...animation, skits: { ...animation.skits, punchline: { ...animation.skits.punchline!, fingerprint: 'old' } } };
  assert.throws(
    () => buildSkitProps(capture, skitScript, skitVoiced, stale, '/run'),
    (e: unknown) => e instanceof StudioError && e.code === 'no_input' && !e.retryable && /punchline/.test(e.message),
  );
});
```

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/render/props.test.ts
git -C "$WT" commit -m "test(studio): пропсы композиции со сценками (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/render/props.test.ts"
```

Expected: FAIL — нет экспорта `buildSkitProps`.

- [ ] **Step 3: Пропсы**

`studio/src/render/props.ts` целиком:

```ts
import path from 'node:path';
import { captionCues, splitCaption } from '../captions';
import { StudioError } from '../errors';
import { FRAME } from '../frame';
import { buildSkitTimeline, buildTimeline, FPS, msToFrames } from '../timeline';
import type { TtsResult } from '../tts';
import type { Animation, CaptureResult, ClipCue, Script, ShortProps, SkitClip, SkitKind, SkitShortProps, VoicedLine } from '../types';

function assertFrame(capture: CaptureResult): void {
  if (capture.answerShotWidth !== FRAME.width) {
    throw new StudioError(
      'frame_size',
      `props: снимок ответа шириной ${capture.answerShotWidth} px, нужен ${FRAME.width} — съёмка шла не в кадре ${FRAME.width}×${FRAME.height}`,
      false,
    );
  }
}

function voicedLines(script: Script, voiced: TtsResult[], runDir: string): VoicedLine[] {
  const byId = new Map(voiced.map((v) => [v.id, v]));
  return script.lines.map((l) => {
    const v = byId.get(l.id);
    if (!v) throw new Error(`props: нет озвучки реплики ${l.id}`);
    return { ...l, durationMs: v.durationMs, audio: path.relative(runDir, v.file) };
  });
}

/**
 * Склеивает съёмку, сценарий и озвучку в пропсы композиции Short. Пути к
 * файлам — относительно папки съёмки: она же publicDir бандла, staticFile()
 * ищет файлы в ней.
 */
export function buildProps(capture: CaptureResult, script: Script, voiced: TtsResult[], runDir: string): ShortProps {
  assertFrame(capture);
  return {
    fps: FPS,
    hook: script.hook,
    badge: script.badge,
    questionShot: capture.questionShot,
    answerShot: capture.answerShot,
    answerShotHeight: capture.answerShotHeight,
    boxes: capture.boxes,
    timeline: buildTimeline(voicedLines(script, voiced, runDir), FPS),
    final: { assistantsCount: script.final.assistantsCount, disclaimer: script.final.disclaimer },
  };
}

/** Пропсы композиции SkitShort: то же плюс клипы сценок и субтитры их реплик в кадрах ролика. */
export function buildSkitProps(capture: CaptureResult, script: Script, voiced: TtsResult[], animation: Animation, runDir: string): SkitShortProps {
  assertFrame(capture);
  const skits = script.skits;
  if (!skits) throw new StudioError('script_invalid', 'props: в сценарии нет сценок', false);
  const clips = {} as Record<SkitKind, SkitClip>;
  for (const kind of ['conflict', 'punchline'] as const) {
    const c = animation.skits[kind];
    if (!c || c.fingerprint !== skits[kind].fingerprint) {
      throw new StudioError('no_input', `props: клип сценки ${kind} не снят под этот сценарий — сначала npm run animate`, false);
    }
    clips[kind] = c;
  }
  const timeline = buildSkitTimeline(voicedLines(script, voiced, runDir), { conflict: clips.conflict.durationMs, punchline: clips.punchline.durationMs }, FPS);
  const cues = (kind: SkitKind): ClipCue[] =>
    clips[kind].cues.flatMap((c) => {
      const text = skits[kind].skit.lines[c.line]?.text ?? '';
      const from = timeline.scenes[kind].from + msToFrames(c.startMs, FPS);
      const duration = Math.max(1, msToFrames(c.endMs - c.startMs, FPS));
      return captionCues(splitCaption(text), from, duration).map((q, i) => ({ key: `${kind}-${c.line}-${i}`, ...q }));
    });
  return {
    fps: FPS,
    hook: script.hook,
    badge: script.badge,
    questionShot: capture.questionShot,
    answerShot: capture.answerShot,
    answerShotHeight: capture.answerShotHeight,
    boxes: capture.boxes,
    timeline,
    final: { assistantsCount: script.final.assistantsCount, disclaimer: script.final.disclaimer },
    clips: {
      conflict: { video: clips.conflict.clip, cues: cues('conflict') },
      punchline: { video: clips.punchline.clip, cues: cues('punchline') },
    },
  };
}
```

- [ ] **Step 4: Субтитры с готовыми кадрами**

`studio/src/remotion/Caption.tsx` целиком:

```tsx
import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { captionCues, splitCaption } from '../captions';
import type { ClipCue, Segment } from '../types';
import { C, fontFamily } from './theme';

/**
 * Субтитр: крупно, в средней трети кадра — снизу и справа Shorts и Клипы
 * рисуют свои кнопки и подпись.
 */
const CaptionBox: React.FC<{ text: string }> = ({ text }) => (
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
      {text}
    </div>
  </AbsoluteFill>
);

/** Субтитры с готовыми кадрами — у реплик сценок. */
export const CueCaptions: React.FC<{ cues: ClipCue[] }> = ({ cues }) => (
  <>
    {cues.map((c) => (
      <Sequence key={c.key} from={c.from} durationInFrames={c.duration}>
        <CaptionBox text={c.text} />
      </Sequence>
    ))}
  </>
);

/** Субтитры озвученных реплик: длинная режется на куски по словам. */
export const Captions: React.FC<{ segments: Segment[] }> = ({ segments }) => (
  <CueCaptions
    cues={segments.flatMap((s) => captionCues(splitCaption(s.text), s.from, s.duration).map((cue, i) => ({ key: `${s.lineId}-${i}`, ...cue })))}
  />
);
```

- [ ] **Step 5: Текст зацепки отдельным компонентом**

`studio/src/remotion/scenes/Hook.tsx` целиком:

```tsx
import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, fontFamily } from '../theme';

/** Крупный текст зацепки с «выскакиванием». Им же подписан конфликт ролика со сценками (Clip). */
export const HookText: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14 } });
  return (
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
      {text}
    </div>
  );
};

/** Зацепка: снимок вопроса под затемнением, поверх — крупный текст. */
export const Hook: React.FC<{ hook: string; questionShot: string }> = ({ hook, questionShot }) => (
  <AbsoluteFill style={{ backgroundColor: C.ink }}>
    <Img src={staticFile(questionShot)} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.3 }} />
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 90px' }}>
      <HookText text={hook} />
    </AbsoluteFill>
  </AbsoluteFill>
);
```

- [ ] **Step 6: Сцена-клип и композиция**

`studio/src/remotion/scenes/Clip.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile } from 'remotion';
import { HookText } from './Hook';

/**
 * Сценка — клип Omni на весь кадр (720×1280 растягивается до 1080×1920),
 * со своим звуком. У конфликта первые секунды поверх идёт надпись-зацепка:
 * в верхней трети, выше субтитров реплик.
 */
export const Clip: React.FC<{ video: string; hook?: string; hookFrames?: number }> = ({ video, hook, hookFrames = 0 }) => (
  <AbsoluteFill style={{ backgroundColor: '#000' }}>
    <OffthreadVideo src={staticFile(video)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    {hook && hookFrames > 0 ? (
      <Sequence durationInFrames={hookFrames}>
        <AbsoluteFill
          style={{
            justifyContent: 'flex-start',
            alignItems: 'center',
            padding: '260px 90px 0',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 45%)',
          }}
        >
          <HookText text={hook} />
        </AbsoluteFill>
      </Sequence>
    ) : null}
  </AbsoluteFill>
);
```

`studio/src/remotion/SkitShort.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { MIN_HOOK_MS, msToFrames } from '../timeline';
import type { SkitShortProps } from '../types';
import { Captions, CueCaptions } from './Caption';
import { Answer } from './scenes/Answer';
import { Clip } from './scenes/Clip';
import { Final } from './scenes/Final';
import { Question } from './scenes/Question';

/**
 * Ролик со сценками: конфликт (Omni) → вопрос → настоящий ответ → развязка
 * (Omni) → финал. Зацепка — надпись поверх первых секунд конфликта.
 */
export const SkitShort: React.FC<SkitShortProps> = (p) => {
  const { scenes, segments } = p.timeline;
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <Sequence from={scenes.conflict.from} durationInFrames={scenes.conflict.duration}>
        <Clip video={p.clips.conflict.video} hook={p.hook} hookFrames={msToFrames(MIN_HOOK_MS, p.fps)} />
      </Sequence>
      <Sequence from={scenes.question.from} durationInFrames={scenes.question.duration}>
        <Question questionShot={p.questionShot} durationInFrames={scenes.question.duration} badge={p.badge} />
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
      <Sequence from={scenes.punchline.from} durationInFrames={scenes.punchline.duration}>
        <Clip video={p.clips.punchline.video} />
      </Sequence>
      <Sequence from={scenes.final.from} durationInFrames={scenes.final.duration}>
        <Final assistantsCount={p.final.assistantsCount} disclaimer={p.final.disclaimer} />
      </Sequence>
      <Captions segments={segments.filter((s) => s.scene === 'question' || s.scene === 'answer')} />
      <CueCaptions cues={[...p.clips.conflict.cues, ...p.clips.punchline.cues]} />
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

`studio/src/remotion/Root.tsx` целиком:

```tsx
import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import type { ShortProps, SkitShortProps } from '../types';
import { Short } from './Short';
import { SkitShort } from './SkitShort';
import { H, W } from './theme';

/** Длина ролика — из таймлайна в пропсах: её задаёт озвучка (и клипы сценок). */
const calculateMetadata: CalculateMetadataFunction<ShortProps> = ({ props }) => ({
  durationInFrames: props.timeline.totalFrames,
  fps: props.fps,
});
const calculateSkitMetadata: CalculateMetadataFunction<SkitShortProps> = ({ props }) => ({
  durationInFrames: props.timeline.totalFrames,
  fps: props.fps,
});

/** Пропсы-заглушки. Настоящие приходят из src/render/run-render.ts. */
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

const SKIT_PLACEHOLDER: SkitShortProps = {
  fps: 30,
  hook: 'Зацепка',
  questionShot: 'question.png',
  answerShot: 'answer.png',
  answerShotHeight: 1920,
  boxes: [{ n: 1, top: 400, height: 200, text: '' }],
  timeline: {
    segments: [],
    scenes: {
      conflict: { from: 0, duration: 240 },
      question: { from: 240, duration: 120 },
      answer: { from: 360, duration: 360 },
      punchline: { from: 720, duration: 240 },
      final: { from: 960, duration: 120 },
    },
    totalFrames: 1080,
  },
  final: { assistantsCount: 18 },
  clips: { conflict: { video: 'conflict.mp4', cues: [] }, punchline: { video: 'punchline.mp4', cues: [] } },
};

export const RemotionRoot: React.FC = () => (
  <>
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
    <Composition
      id="SkitShort"
      component={SkitShort}
      width={W}
      height={H}
      fps={30}
      durationInFrames={SKIT_PLACEHOLDER.timeline.totalFrames}
      defaultProps={SKIT_PLACEHOLDER}
      calculateMetadata={calculateSkitMetadata}
    />
  </>
);
```

- [ ] **Step 7: Прогнать тесты и типы**

```bash
git -C "$WT" add studio/src/render/props.ts studio/src/remotion
git -C "$WT" commit -m "feat(studio): композиция SkitShort — клипы сценок, зацепка поверх конфликта, субтитры реплик

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/render/props.test.ts src/captions.test.ts && npm run typecheck && echo TSC_OK"
```

Expected: все `pass`, `# fail 0`, затем `TSC_OK`.

---

### Task 14: Сборка ролика со сценками

**Files:**
- Modify: `studio/src/ffprobe.ts` (`SKIT_LIMITS`)
- Modify: `studio/src/render/run-render.ts`
- Create: `studio/src/render/render-skit.fixture.ts`
- Modify: `studio/package.json` (`scripts.test:render`)

- [ ] **Step 1: Падающая фикстура сборки**

`studio/src/render/render-skit.fixture.ts`:

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
 * Сборка ролика со сценками из фикстуры без сети: клипы сценок, картинки и
 * «голос» (синус) делает ffmpeg, озвучка берётся из кеша. Папка не удаляется —
 * по ней смотрят кадры.
 */
test('рендер фикстуры со сценками: 1080×1920, 25–45 с, звук по всей длине', { timeout: 15 * 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-skit-fixture-'));
  console.log(`fixture: ${dir}`);
  const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ff('-f', 'lavfi', '-i', 'color=c=0xedfaed:s=1080x1920', '-frames:v', '1', path.join(dir, 'question.png'));
  ff('-f', 'lavfi', '-i', 'color=c=white:s=1080x5400', '-frames:v', '1', path.join(dir, 'answer.png'));
  for (const [kind, color] of [['conflict', 'orange'], ['punchline', 'purple']] as const) {
    const d = path.join(dir, 'skits', `fx-${kind}`);
    fs.mkdirSync(d, { recursive: true });
    ff('-f', 'lavfi', '-i', `color=c=${color}:s=720x1280:d=8`, '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-shortest',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(d, 'clip.mp4'));
    ff('-f', 'lavfi', '-i', `color=c=${color}:s=720x1280`, '-frames:v', '1', path.join(d, 'keyframe.png'));
  }

  const lines = [
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист. Жилец спросил про залог.', ms: 5000 },
    { id: 'a1', scene: 'answer', text: 'Квартиру возвращают с учётом нормального износа.', ms: 6000, box: 1 },
    { id: 'a2', scene: 'answer', text: 'Ущерб хозяйка должна доказать.', ms: 6000, box: 2 },
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
      scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Хозяйка не отдаёт залог', followups: [] },
      cabinetUrl: 'fixture',
      capturedAt: new Date(0).toISOString(),
      questionShot: 'question.png',
      answerShot: 'answer.png',
      answerShotWidth: 1080,
      answerShotHeight: 5400,
      answerText: 'x'.repeat(500),
      turns: 1,
      boxes: [{ n: 1, top: 900, height: 300, text: 'a' }, { n: 2, top: 2400, height: 300, text: 'b' }],
      paragraphs: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }],
    }),
  );
  const plan = (kind: string, texts: string[]) => ({
    skit: { cast: [{ hero: 'galina', role: 'хозяйка' }, { hero: 'kesha', role: 'жилец' }], setting: 's', action: 'a', lines: texts.map((text) => ({ hero: 'kesha', text })) },
    troupeVersion: 'v1',
    heroes: ['galina', 'kesha'],
    keyframePrompt: 'k',
    videoPrompt: 'v',
    fingerprint: `fx-${kind}`,
  });
  fs.writeFileSync(
    path.join(dir, 'script.json'),
    JSON.stringify({
      hook: 'Хозяйка оставит весь залог?',
      voice: 'madirus',
      speed: 1,
      lines: lines.map((l) => ({ id: l.id, scene: l.scene, text: l.text, ...('box' in l ? { box: l.box } : {}) })),
      final: { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет юриста' },
      skits: { conflict: plan('conflict', ['Обои потёрли! Залог мой!', 'Спокойно.']), punchline: plan('punchline', ['Это износ.', 'Га-га… ладно.']) },
    }),
  );
  const clip = (kind: string) => ({
    fingerprint: `fx-${kind}`,
    keyframe: `skits/fx-${kind}/keyframe.png`,
    clip: `skits/fx-${kind}/clip.mp4`,
    durationMs: 8000,
    heard: '',
    attempts: 1,
    cues: [{ line: 0, startMs: 500, endMs: 3500 }, { line: 1, startMs: 4000, endMs: 7000 }],
  });
  fs.writeFileSync(path.join(dir, 'animation.json'), JSON.stringify({ omniSeconds: 16, skits: { conflict: clip('conflict'), punchline: clip('punchline') } }));

  const r = await renderRun(dir, { skipTts: true });
  assert.deepEqual(r.problems, []);
  assert.ok(r.durationSec >= 25 && r.durationSec <= 45, `длина ${r.durationSec}`);
  assert.ok(fs.statSync(r.cover).size > 10_000, 'обложка подозрительно мала');
});
```

В `studio/package.json` заменить `"test:render": "tsx --test src/render/render.fixture.ts",` на `"test:render": "tsx --test src/render/render.fixture.ts src/render/render-skit.fixture.ts",`.

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git -C "$WT" add studio/src/render/render-skit.fixture.ts studio/package.json
git -C "$WT" commit -m "test(studio): сборка ролика со сценками из фикстуры (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/render/render-skit.fixture.ts"
```

Запускать с `run_in_background`. Expected: FAIL — `validateScript` пропускает сценарий, но `buildProps` строит обычный таймлайн и падает на отсутствии реплики `hook` («зацепка (hook) — первая и единственная реплика своей сцены»).

- [ ] **Step 3: Пределы ролика со сценками**

В `studio/src/ffprobe.ts` после `export const SHORT_LIMITS …;`:

```ts
/** Ролик со сценками: 25–45 с, паузы между репликами сценок — до 3 с (спека сценок, «Ролик»). */
export const SKIT_LIMITS: VerifyLimits = { ...SHORT_LIMITS, minSec: 25, maxSec: 45, maxSilenceSec: 3 };
```

- [ ] **Step 4: Сборка по формату сценария**

В `studio/src/render/run-render.ts`:

1. Импорты заменить на:

```ts
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { parseConfig } from '../config';
import { StudioError } from '../errors';
import { detectSilences, probeFile, SHORT_LIMITS, SKIT_LIMITS, verifyVideo } from '../ffprobe';
import { validateScript } from '../script';
import { synthesizeAll } from '../tts';
import type { Animation, CaptureResult, Script, ShortProps, SkitShortProps } from '../types';
import { buildProps, buildSkitProps } from './props';
```

2. Строку `const inputProps = buildProps(capture, script, voiced, runDir);` заменить на:

```ts
  // Ролик со сценками собирается своей композицией из клипов задания animate.
  let compositionId = 'Short';
  let limits = SHORT_LIMITS;
  let inputProps: ShortProps | SkitShortProps;
  if (script.skits) {
    const animPath = path.join(runDir, 'animation.json');
    if (!fs.existsSync(animPath)) throw new StudioError('no_input', 'render: у ролика со сценками нет animation.json — сначала npm run animate', false);
    const animation = JSON.parse(fs.readFileSync(animPath, 'utf8')) as Animation;
    inputProps = buildSkitProps(capture, script, voiced, animation, runDir);
    compositionId = 'SkitShort';
    limits = SKIT_LIMITS;
  } else {
    inputProps = buildProps(capture, script, voiced, runDir);
  }
```

3. `selectComposition({ serveUrl, id: 'Short', inputProps })` → `selectComposition({ serveUrl, id: compositionId, inputProps })`.

4. `verifyVideo(probe, silences)` → `verifyVideo(probe, silences, limits)`.

5. В комментарий над `renderRun` дописать: «Сценарий со сценками собирается композицией SkitShort: нужен animation.json задания animate (npm run animate)».

- [ ] **Step 5: Прогнать обе фикстуры сборки и типы**

```bash
git -C "$WT" add studio/src/ffprobe.ts studio/src/render/run-render.ts
git -C "$WT" commit -m "feat(studio): сборка ролика со сценками — композиция SkitShort, пределы 25–45 с

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npm run test:render && npm run typecheck && echo TSC_OK"
```

Запускать с `run_in_background`. Expected: обе фикстуры `pass` (прежняя — обычный ролик — тоже), затем `TSC_OK`. Скопировать кадр середины конфликта и развязки и посмотреть глазами — на них видны зацепка (первые 2 с) и субтитры реплик:

```bash
ssh $SSHO dv@85.192.61.231 'd=$(ls -dt /tmp/studio-skit-fixture-* | head -1); ffmpeg -hide_banner -loglevel error -y -i $d/video.mp4 -vf "select=eq(n\,30)+eq(n\,100)+eq(n\,900),scale=360:-1,tile=3x1" -frames:v 1 /tmp/skit-fixture-strip.jpg && echo $d'
scp $SSHO dv@85.192.61.231:/tmp/skit-fixture-strip.jpg /tmp/skit-fixture-strip.jpg
```

Открыть `/tmp/skit-fixture-strip.jpg` (Read). Expected: кадр 30 — оранжевый фон с крупной зацепкой сверху и субтитром «Обои потёрли! Залог мой!» ниже середины; кадр 100 — субтитр «Обои потёрли! Залог мой!» или «Спокойно.» без зацепки; кадр 900 — фиолетовая развязка с субтитром.

---

### Task 15: Полный прогон на ноде

**Files:** —

- [ ] **Step 1: Все тесты студии, типы и обе фикстуры сборки**

```bash
"$WT"/studio/scripts/node-run.sh "npm test && npm run typecheck && echo TSC_OK && npm run test:render"
```

Запускать с `run_in_background`. Expected: `npm test` — `# fail 0`; `TSC_OK`; `test:render` — обе фикстуры `pass`.

- [ ] **Step 2: Модуль роликов бэкенда и гейт типов**

```bash
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: все сюиты `src/shorts` зелёные (интеграционная `shorts.integration.spec.ts` без базы пропускается так же, как в плане 2), затем `TSC_OK`.

- [ ] **Step 3: Итоговое ревью кода плана**

Отдать ревьюеру (субагент `superpowers:code-reviewer`, модель opus) диапазон `96bf5b8..HEAD` ветки `feat/promo-shorts` со ссылкой на спеку сценок и этот план. Важные замечания исправляются до задачи 16 (тест → правка → прогон → коммит), мелкие — записываются в «Итоги образца» задачи 17.

---

### Task 16: Ролик-образец

Сценарий образца (задача 4) построен на настоящей съёмке стенда: папка `~/ci/wt/promo-shorts/studio/out/jobs/987f6045-3275-42fe-8922-7305630782dd/render-1/` на ноде. Живые вызовы Google стоят денег: ожидаемо ≈ $1,9 (два клипа Omni по $0,80 и два кадра).

**Files:** — (только папка `studio/out/skit-sample-1/` на ноде, она вне git)

- [ ] **Step 1: Ключ Google в `.env` студии на ноде — без вывода на экран**

```bash
ssh $SSHO dv@85.192.61.231 'f=~/ci/wt/promo-shorts/studio/.env; grep -q "^GOOGLE_AI_API_KEY=." "$f" || grep "^GOOGLE_AI_API_KEY=" ~/spirits_back/.env >> "$f"; grep -c "^GOOGLE_AI_API_KEY=." "$f"'
```

Expected: `1`. Если `0` — ключа нет и в `~/spirits_back/.env`: остановиться и спросить владельца.

- [ ] **Step 2: Папка образца из настоящей съёмки**

```bash
ssh $SSHO dv@85.192.61.231 'cd ~/ci/wt/promo-shorts/studio && src=out/jobs/987f6045-3275-42fe-8922-7305630782dd/render-1 && mkdir -p out/skit-sample-1 && cp $src/capture.json $src/question.png $src/answer.png out/skit-sample-1/ && ls out/skit-sample-1'
```

Expected: `answer.png  capture.json  question.png`. Если папки съёмки нет — остановиться и сообщить: нужна новая съёмка через рабочий процесс стенда, это отдельное решение.

- [ ] **Step 3: Сценарий с промптами**

```bash
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx ts-node scripts/shorts-skit-plan.ts studio/samples/zalog/skits.json studio/samples/zalog/script.base.json studio/out/skit-sample-1/script.json"
```

Expected: `skit-plan: studio/out/skit-sample-1/script.json — conflict <16 hex>, punchline <16 hex>`.

- [ ] **Step 4: Оживление**

```bash
"$WT"/studio/scripts/node-run.sh "npm run animate -- out/skit-sample-1"
```

Запускать с `run_in_background`. Expected (через 3–10 минут): строки `animate conflict: попыток 1…3, услышано «…»`, `animate punchline: …`, затем `animate: готово — Omni 16 с (≈ $1.60)` (больше, если были пересъёмки).

Если упало:
- `google_quota` — квота на сегодня; повторить после ≈ 11:00 МСК тем же шагом (готовая сценка не переснимется);
- `model_gone` или `google_auth` — остановиться и сообщить владельцу;
- `speech_mismatch` после 3 попыток — посмотреть `heard` в выводе и `skits/<отпечаток>/raw.mp4`. Если Omni говорит, но SpeechKit слышит иначе (имена, «га-га»), — это довод снизить `MATCH_THRESHOLD` в задаче 17, а не повод перезапускать вслепую.

- [ ] **Step 5: Сборка**

```bash
"$WT"/studio/scripts/node-run.sh "npm run render -- out/skit-sample-1"
```

Запускать с `run_in_background`. Expected: `render: готово → …/out/skit-sample-1/video.mp4`. Если `too_long` — ролик длиннее 45 с: сократить реплику `q` в `studio/samples/zalog/script.base.json`, закоммитить и повторить шаги 3 и 5 (шаг 4 ничего не переснимет: сценки не менялись).

- [ ] **Step 6: Самопроверка до показа владельцу**

```bash
ssh $SSHO dv@85.192.61.231 'cd ~/ci/wt/promo-shorts/studio/out/skit-sample-1 && ffmpeg -hide_banner -loglevel error -y -i video.mp4 -vf "fps=1/3,scale=270:-1,tile=7x2" -frames:v 1 strip.jpg && for f in skits/*/clip.mp4 voice/a1.mp3; do printf "%s " $f; ffmpeg -hide_banner -nostats -i $f -af ebur128 -f null - 2>&1 | grep -E "^ +I:" | tail -1; done'
mkdir -p ~/Downloads/linkeon_shorts
scp $SSHO dv@85.192.61.231:ci/wt/promo-shorts/studio/out/skit-sample-1/video.mp4 ~/Downloads/linkeon_shorts/skit-sample-1.mp4
scp $SSHO dv@85.192.61.231:ci/wt/promo-shorts/studio/out/skit-sample-1/strip.jpg /tmp/skit-sample-1-strip.jpg
```

Открыть `/tmp/skit-sample-1-strip.jpg` (Read) и проверить:
- герои узнаваемы по листу труппы, их ровно двое, лишних персонажей нет;
- в кадрах Omni нет надписей, экранов телефона и логотипов;
- зацепка видна в первые 2 с, субтитры реплик сценок стоят ниже середины и не наезжают на зацепку;
- вопрос, ответ с рамкой абзаца и финал — как у принятого образца плана 1.

Громкость: `I:` клипов и `voice/a1.mp3` расходятся не больше чем на 2 LU. Если больше — записать замер для задачи 17 (там меняется `CLIP_LUFS`).

Если что-то из списка не так — не показывать владельцу, а сначала разобраться (задача 17, шаг 2, без ворот).

- [ ] **Step 7: Показать владельцу**

Сообщение владельцу: путь `~/Downloads/linkeon_shorts/skit-sample-1.mp4`, длина, сколько ушло на Omni (из вывода шага 4), что распознал SpeechKit в каждой сценке, и прямой вопрос: «Принимаешь образец или что поправить — юмор, героев, голоса, темп, субтитры?».

---

### Task 17: Ворота владельца, донастройка и итоги

**Files:**
- Modify (по замечаниям): `studio/samples/zalog/*.json`, `src/shorts/short-troupe.ts`, `src/shorts/short-skit-prompts.ts`, `studio/src/animate/match.ts`, `studio/src/animate/clip-check.ts`, `studio/src/animate/cues.ts`
- Modify: `docs/superpowers/specs/2026-10-26-shorts-skits-design.md` (раздел «Что уточнил образец»)

- [ ] **Step 1: Дождаться ответа владельца**

Без ответа владельца план 4 не начинается.

- [ ] **Step 2: Итерация по замечанию**

Каждое замечание — отдельный цикл:
1. Решить, где правка: реплики и действие — `studio/samples/zalog/skits.json`; облик и голос героя — паспорт в `src/shorts/short-troupe.ts`; общая манера, стиль, запреты — константы `SKIT_*` в `src/shorts/short-skit-prompts.ts`; громкость — `CLIP_LUFS`; порог речи — `MATCH_THRESHOLD`; паузы — `PAUSE_DETECT`.
2. Правка кода — тестом вперёд, как в задачах 2–14; правка JSON образца — без теста.
3. Коммит, затем задача 16 с шага 3 (папка та же: сценки с прежним отпечатком не переснимаются). Если на ролик уже ушло 48 с Omni, шаг 4 запускать как `"MAX_OMNI_SECONDS=96 npm run animate -- out/skit-sample-1"`.
4. Новый файл — `~/Downloads/linkeon_shorts/skit-sample-<N>.mp4`, владельцу — что изменилось.

Траты на образец со всеми итерациями — не больше $10 без отдельного вопроса владельцу (сумма — по `omniSeconds` в `animation.json` × $0,10 плюс кадры).

- [ ] **Step 3: Итоги образца в спеке**

Когда владелец принял образец, дописать в конец спеки `docs/superpowers/specs/2026-10-26-shorts-skits-design.md` раздел:

```markdown
## Что уточнил образец (план 3)

- <дата>: владелец принял образец `skit-sample-<N>.mp4` (<что именно сказал>).
- Пороги: `MATCH_THRESHOLD` = <значение>, `CLIP_LUFS` = <значение>, `PAUSE_DETECT` = <значение>, пауза в клипе — до <N> с.
- Паспорта и шаблоны промптов: <что поменялось и почему>.
- Omni: <сколько попыток ушло, были ли отказы фильтра, как звучали голоса, держится ли облик героев>.
- Время этапа «оживление»: <минут>; траты на образец: <$>.
```

плюс пункты из раздела «Что план уточняет в спеке» этого плана и мелкие замечания итогового ревью (задача 15, шаг 3).

```bash
git -C "$WT" add docs/superpowers/specs/2026-10-26-shorts-skits-design.md
git -C "$WT" commit -m "docs(spec): ролики со сценками — что уточнил образец

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Переход к плану 4**

Обновить заметку памяти `project_promo_shorts_studio.md` (образец принят, где лежит, итоговые пороги) и строку в `MEMORY.md`. Затем — скилл `superpowers:writing-plans` для плана 4 «Сценки в конвейере» по разделу «Вне этого плана» выше и итогам образца.
