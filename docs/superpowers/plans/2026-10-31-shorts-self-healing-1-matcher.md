# Самовосстановление роликов, очередь 1 — сверка речи и перепроверка брака: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** студия перестаёт браковать годные клипы сценок из-за окончаний, перепутанных SpeechKit, и до новой оплаты Omni перепроверяет уже оплаченный брак — ролик `889b6423` (Лиана) поднимается без новых трат.

**Architecture:** только студия (`studio/` в `spirits_back`). `match.ts` сравнивает слова с точностью до окончания (`sameWord`) и получает версию сверки `MATCHER_VERSION = 2`; корпус настоящих пар «реплики → услышано» прода и стенда держит её от ложных отказов на настоящих клипах, а от ослабления — отрицательные пары `sameWord`. `run-animate.ts` кладёт рядом с каждым браком пометку `rejected-*.json` (код, услышанное, доля, версия сверки) и перед новой оплатой сценки перепроверяет её брак, который нынешняя сверка ещё не судила, — без проверки предела секунд. Спека: `docs/superpowers/specs/2026-10-31-shorts-self-healing-design.md`, раздел «Очередь 1».

**Tech Stack:** TypeScript ESM, `tsx --test` (node:test), ffmpeg в тестах оживления; прогоны — на тестовой ноде через `studio/scripts/node-run.sh`.

---

## Общие правила

- **Дерево:** `~/Downloads/spirits_back/.worktrees/shorts-self-healing`, ветка `feat/shorts-self-healing` (от `origin/main` `f4dad531`). Перед коммитом — `git branch --show-current`.
- **Тесты — только на ноде** (на маке зависимостей студии нет, и тяжёлое там не гоняем). Из корня дерева: `studio/scripts/node-run.sh "<команда>"` — команда выполняется в `studio/` на ноде, Bash timeout 600000. Скрипт пушит ветку и ставит `~/ci/wt/promo-shorts` на точный коммит; **незакоммиченное на ноду не уезжает — коммитить перед каждым прогоном** (красный тест — с «(красный)» в теме коммита). Коды выхода: 75 — воркдерево занято, повторить через 2 минуты; 255 — сбой ssh, повторить через 1–2 минуты; 3 — дерево не встало на коммит, сообщить контролёру. Если тесты падают на `Cannot find module` — `studio/scripts/node-run.sh "npm ci && <команда>"`.
- Сводка node:test по ssh приходит в формате tap: `# tests` / `# pass` / `# fail` вместо `ℹ tests` / `ℹ pass` / `ℹ fail` в ожиданиях ниже — числа те же.
- Импорты в студии — **без расширений** (`./match`, не `./match.ts`): композицию собирает webpack Remotion.
- `git add` — только поимённо. В `main` не пушить, не сливать, не выкатывать — это задача 6, её ведёт контролёр с OK владельца.
- Репозиторий публичный: в корпусе только реплики героев сценок, личных данных нет.
- Каждый коммит заканчивается строкой `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (второй `-m`).

---

### Task 1: Корпус сверки — настоящие пары прода и стенда

**Files:**
- Create: `studio/src/animate/match-corpus.ts`
- Modify: `studio/src/animate/match.test.ts` (импорт вверху, три теста в конце)

- [ ] **Step 1: Создать фикстуру корпуса**

`studio/src/animate/match-corpus.ts` — целиком:

```ts
/**
 * Настоящие пары «реплики сценки → что распознал SpeechKit»: по ним сверка речи
 * (match.ts) проверяется на деле, а не на выдуманных строках.
 *
 * - ACCEPTED — клипы, принятые в работу: прод и стенд (short_video.animation.skits.*.heard
 *   и реплики из script.skits на 31.10.2026) и ролик-образец сценок. Правка сверки
 *   не должна браковать ни один.
 * - FALSE_REJECTS — годные клипы, которые прежняя сверка отвергла: ролик 889b6423
 *   (Лиана, 31.10.2026) — SpeechKit слил «начинай уж» в «начинаешь».
 * - TRUE_REJECTS — настоящий брак: реплика не прозвучала или клип оборван. Первый —
 *   отказ из журнала; два других — принятые пары с вручную обрезанным услышанным:
 *   настоящих отказов такого вида в журналах пока нет.
 *
 * Только реплики героев — личных данных нет. Новый ложный отказ или пропуск —
 * дописать сюда вместе с правкой сверки.
 */
export interface CorpusCase {
  name: string;
  lines: string[];
  heard: string;
}

export const ACCEPTED: CorpusCase[] = [
  { name: 'прод b1c9513f развязка', lines: ['Клуб вправе удержать только то, что реально на меня потратил.', 'Только сегодня, только для вас… оформляем возврат.'], heard: 'клуб вправе удержать только то что реально на меня потратил только сегодня только для вас оформляем возврат' },
  { name: 'прод b1c9513f конфликт', lines: ['Деньги не возвращаем! В договоре всё написано, мелким шрифтом!', 'Спокойно. Сейчас спрошу у юриста.'], heard: 'деньги не возвращаем в договоре все написано мелким шрифтом хм спокойно сейчас спрошу у юриста' },
  { name: 'прод a79586b0 развязка', lines: ['Коуч говорит: в плане нет запаса на плохой день.', 'Га-га… ладно. Но попкорн — со мной.'], heard: 'коуч говорит в плане нет запаса на плохой день гага ладно но поп корн со мной' },
  { name: 'прод a79586b0 конфликт', lines: ['Третий понедельник подряд! Опять новая жизнь?', 'Спокойно. Сейчас спрошу у коуча.'], heard: 'третий понедельник подряд опять новая жизнь спокойно сейчас спрошу у коуча' },
  { name: 'прод 83559acf конфликт', lines: ['Повышение! Денег больше, свободы меньше. Подписывай.', 'Спокойно. Сейчас спрошу.'], heard: 'повышение денег больше свободы меньше подписывай спокойно сейчас спрошу' },
  { name: 'прод 83559acf развязка', lines: ['Составлю карту ценностей — и увижу, что в повышении моё.', 'Думать не положено… ладно, думай.'], heard: 'составлю карту ценностей и увижу что в повышении мое думать не положено ладно думай' },
  { name: 'прод 8f88c118 развязка', lines: ['Остановиться и посмотреть, куда идёшь, — это тоже дело.', 'Га-га… ладно. А мне фишку дадите?'], heard: 'остановиться и посмотреть куда идешь ветка это тоже дело гога ладно а мне фишку дадите' },
  { name: 'прод 8f88c118 конфликт', lines: ['Фишки? Взрослый же! Лучше бы делом занялся!', 'Спокойно. Сейчас спрошу у игропрактика.'], heard: 'фишки взрослый же лучше бы делом занялся спокойно сейчас спрошу у игропрактика' },
  { name: 'прод 1bb2c61b конфликт', lines: ['Семь лет без прибавки. А новичку дали больше.', 'Не положено. Денег нет.', 'Спокойно. Спрошу у карьерного консультанта.'], heard: 'семь лет без прибавки а новичку дали больше не положено денег нет спокойно спрошу у карьерного консультанта' },
  { name: 'прод 1bb2c61b развязка', lines: ['Новичку платят больше. Значит, компания признаёт: ставка выше.', 'Не положено… но так и быть, подпишу.'], heard: 'новичку платят больше значит компания признает ставка выше не положено но так и быть подпишу' },
  { name: 'прод 889b6423 конфликт', lines: ['Год неудачный! Ничего не начинай, сиди тихо!', 'Спокойно. Сейчас спрошу у нумеролога.'], heard: 'год неудачный ничего не начинай сиди тихо спокойно сейчас спрошу у нумеролога' },
  { name: 'стенд f3d9527f конфликт', lines: ['Завтра выходишь. Доплата? Не положено.', 'Спокойно. Сейчас спрошу у юриста.'], heard: 'завтра выходишь доплата не положено спокойно сейчас спрошу у юриста' },
  { name: 'стенд f3d9527f развязка', lines: ['Без моего письменного согласия — не выхожу.', 'Не положено… меня будить. Иди отдыхай.'], heard: 'без моего письменного согласия не выхожу не положено меня будить иди отдыхай' },
  { name: 'стенд fb31451b конфликт', lines: ['Тут всё переделывать, хозяин. Ещё триста сверху!', 'Спокойно. Сейчас спрошу у юриста.'], heard: 'все переделывать хозяин еще триста сверху спокойно сейчас спрошу у юриста' },
  { name: 'стенд fb31451b развязка', lines: ['Без моего согласия цену поднять нельзя.', 'Тут всё… доделывать по смете, хозяин.'], heard: 'без моего согласия цену поднять нельзя тут все доделывать по смете хозяин' },
  { name: 'образец skit-sample-1 конфликт', lines: ['Обои потёрли! Залог мой, весь до копейки!', 'Спокойно. Спрошу у юриста.'], heard: 'обои потерли залог мой весь до копейки спокойно спрошу у юриста' },
  { name: 'образец skit-sample-1 развязка', lines: ['За три года это нормальный износ. Залог верните.', 'Га-га… ладно.'], heard: 'за три года это нормальный износ залог верните гага ладно' },
];

/** Реплика Кеши в развязке ролика 889b6423 — во всех его клипах одна и та же. */
const KESHA_889 = 'Это только символика периода. Решение за мной.';

export const FALSE_REJECTS: CorpusCase[] = [
  { name: 'прод 889b6423 развязка, клип 1 (31.10, 16:11 UTC)', lines: [KESHA_889, 'Га-га… ладно. Начинай уж.'], heard: 'это только символика периода решение за мной гага ладно начинаешь' },
  { name: 'прод 889b6423 развязка после «Новый текст», клипы 1–2 (31.10, 16:29 UTC)', lines: [KESHA_889, 'Ладно, убедил. Начинай уж.'], heard: 'это только символика периода решение за мной ладно убедил начинаешь' },
];

export const TRUE_REJECTS: Array<CorpusCase & { silent: number[] }> = [
  { name: 'прод 889b6423 развязка, клипы 2–3: гусыня молчит', lines: [KESHA_889, 'Га-га… ладно. Начинай уж.'], heard: 'это только символика периода решение за мной', silent: [1] },
  { name: 'обрыв: от последнего предложения последней реплики не слышно ничего (по прод 1bb2c61b конфликт)', lines: ['Семь лет без прибавки. А новичку дали больше.', 'Не положено. Денег нет.', 'Спокойно. Спрошу у карьерного консультанта.'], heard: 'семь лет без прибавки а новичку дали больше не положено денег нет спокойно', silent: [2] },
  { name: 'вторая реплика не прозвучала (по прод b1c9513f конфликт)', lines: ['Деньги не возвращаем! В договоре всё написано, мелким шрифтом!', 'Спокойно. Сейчас спрошу у юриста.'], heard: 'деньги не возвращаем в договоре все написано мелким шрифтом', silent: [1] },
];
```

- [ ] **Step 2: Написать тесты корпуса**

В `studio/src/animate/match.test.ts` под строкой `import { MATCH_THRESHOLD, speechCheck, speechWords } from './match';` добавить:

```ts
import { ACCEPTED, FALSE_REJECTS, TRUE_REJECTS } from './match-corpus';
```

В конец файла:

Каждый тест сравнивает все случаи разом: при падении на удалённой ноде видны все провалы с долей и `silentLines`, а не только первый.

```ts
test('корпус: клипы, принятые на проде и стенде, остаются принятыми', () => {
  const bad = ACCEPTED.map((c) => ({ name: c.name, ...speechCheck(c.lines, c.heard) })).filter((r) => !r.ok);
  assert.deepEqual(bad, []);
});

test('корпус: годные клипы, которые прежняя сверка отвергла, — приняты', () => {
  const bad = FALSE_REJECTS.map((c) => ({ name: c.name, ...speechCheck(c.lines, c.heard) })).filter((r) => !r.ok);
  assert.deepEqual(bad, []);
});

test('корпус: настоящий брак отвергнут, непрозвучавшие реплики названы', () => {
  const got = TRUE_REJECTS.map((c) => {
    const { ok, silentLines } = speechCheck(c.lines, c.heard);
    return { name: c.name, ok, silentLines };
  });
  assert.deepEqual(got, TRUE_REJECTS.map((c) => ({ name: c.name, ok: false, silentLines: c.silent })));
});
```

- [ ] **Step 3: Закоммитить и убедиться, что падает ровно «ложные отказы»**

```bash
git add studio/src/animate/match-corpus.ts studio/src/animate/match.test.ts
git commit -m "test(studio): корпус сверки речи — настоящие пары прода и стенда (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npx tsx --test src/animate/match.test.ts"
```

Ожидается: `fail 1` (`ℹ` или `#` — репортер node:test по ssh выбирает tap) — падает «корпус: годные клипы, которые прежняя сверка отвергла, — приняты»; в диффе `deepEqual` оба случая FALSE_REJECTS (`ok: false`, `silentLines: [1]`, доля ≈ 0,82). Остальные 15 тестов зелёные (13 прежних + 2 корпуса).

---

### Task 2: Сверка с точностью до окончания

**Files:**
- Modify: `studio/src/animate/match.ts`
- Test: `studio/src/animate/match.test.ts`

- [ ] **Step 1: Написать падающие тесты `sameWord` и порядка пар**

В `match.test.ts` заменить строку импорта

```ts
import { MATCH_THRESHOLD, speechCheck, speechWords } from './match';
```

на

```ts
import { MATCH_THRESHOLD, sameWord, speechCheck, speechWords } from './match';
```

и добавить в конец файла:

```ts
test('одно слово с точностью до окончания: общее начало от 5 букв, у меньшего за ним — не больше 2', () => {
  // «спокойно»/«спокоен», «подпишу»/«подписывай» — на границе: общее начало ровно 5, у меньшего за ним ровно 2.
  for (const [a, b] of [['начинай', 'начинаешь'], ['убедил', 'убедила'], ['период', 'периода'], ['ладно', 'ладно'], ['спокойно', 'спокоен'], ['подпишу', 'подписывай']]) {
    assert.equal(sameWord(a, b), true, `${a} ≈ ${b}`);
    assert.equal(sameWord(b, a), true, `${b} ≈ ${a}`);
  }
  // Меняешь пороги или эти пары — подними MATCHER_VERSION (match.ts): по нему перепроверяется брак.
  // Корпус ловит ложные отказы, а не ослабление сверки: порог держат эти пары.
  // «день»/«деньги» — общее начало 4 буквы: сломается, если STEM_MIN опустить до 4;
  // «отказаться»/«отказник» — сломается, если STEM_SLACK поднять до 3.
  for (const [a, b] of [['начинай', 'начальник'], ['спрошу', 'спокойно'], ['отказаться', 'отказник'], ['день', 'деньги'], ['мой', 'мою']]) {
    assert.equal(sameWord(a, b), false, `${a} ≠ ${b}`);
  }
});

test('доля: сначала точные пары, потом по окончанию — точное слово не отдаёт свою пару неточному', () => {
  // Жадный один проход отдал бы «начинаешь» слову «начинай», и «начинаешь» остался бы без пары.
  assert.equal(speechCheck(['Начинай, начинаешь.'], 'начинаешь начинайте').share, 1);
});

test('эхо другой реплики в иной форме не скрывает обрыв', () => {
  const lines = ['Ничего не начинай, сиди тихо!', 'Ладно. Начинаю.'];
  assert.deepEqual(speechCheck(lines, 'ничего не начинай сиди тихо ладно').silentLines, [1]);
  // Обе реплики сказаны, SpeechKit записал «начинаю» как «начинай» — клип годен.
  assert.equal(speechCheck(lines, 'ничего не начинай сиди тихо ладно начинай').ok, true);
});

test('одно услышанное слово засчитывается за одно слово реплики — и по окончанию тоже', () => {
  assert.equal(speechCheck(['Начинай, начинаю, начинать.'], 'начинаешь').share, 1 / 3);
});
```

(Тесты «эхо» и «одно услышанное слово» добавлены по ревью задачи 2: сравнение по окончанию через весь услышанный текст давало слову другой реплики скрыть оборванную; пограничные пары держат пороги с обеих сторон.)

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git add studio/src/animate/match.test.ts
git commit -m "test(studio): сравнение слов с точностью до окончания (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npx tsx --test src/animate/match.test.ts"
```

Ожидается: файл не загружается — `SyntaxError: The requested module './match' does not provide an export named 'sameWord'`.

- [ ] **Step 3: Шапка модуля и константы**

В `studio/src/animate/match.ts` заменить шапку

```ts
/**
 * Сверка речи клипа Omni с репликами сценки: проглотил ли Omni реплику или
 * переврал её. Распознаёт SpeechKit (stt.ts), сравниваются слова.
 */
```

на

```ts
/**
 * Сверка речи клипа Omni с репликами сценки: проглотил ли Omni реплику или
 * переврал её. Распознаёт SpeechKit (stt.ts), сравниваются слова — с точностью
 * до окончания (sameWord).
 */
```

После строки `const MIN_LAST_WORD = 4;` вставить:

```ts
/**
 * Версия сверки — поднимать при любой правке её логики. Брак, отвергнутый
 * прежней версией, студия перепроверяет до новой оплаты (run-animate.ts,
 * reviveRejected). 2 — слова сравниваются с точностью до окончания (31.10.2026).
 */
export const MATCHER_VERSION = 2;
/** Общее начало от стольких букв — одно слово: SpeechKit путает окончания и сливает короткое слово с соседним. */
const STEM_MIN = 5;
/** Сколько букв меньшего слова может остаться за общим началом: «начинай» ≈ «начинаешь» (общее «начина» — 6 из 7). */
const STEM_SLACK = 2;
```

- [ ] **Step 4: Функция `sameWord`**

Перед строкой `export interface SpeechCheck {` вставить:

```ts
/**
 * Одно ли это слово с точностью до окончания: равны или у них общее начало от
 * STEM_MIN букв, а у меньшего слова за ним — не больше STEM_SLACK букв.
 * «начинай» ≈ «начинаешь» (SpeechKit слил «начинай уж», ролик 889b6423),
 * «убедил» ≈ «убедила»; «начинай» ≠ «начальник», «отказаться» ≠ «отказник».
 * Короткие слова — только точно.
 */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  let n = 0;
  while (n < shorter && a[n] === b[n]) n++;
  return n >= STEM_MIN && n >= shorter - STEM_SLACK;
}
```

В `interface SpeechCheck` заменить комментарий поля `share`

```ts
  /** Доля сверяемых слов реплик (с повторами), найденных в распознанном. */
```

на

```ts
  /** Доля сверяемых слов реплик (с повторами), найденных в распознанном с точностью до окончания. */
```

и комментарий поля `silentLines`

```ts
  /** Номера реплик (с 0), от которых — или от их последнего предложения — не услышано ни одного слова от трёх букв. */
```

на

```ts
  /** Номера реплик (с 0), от которых — или от их последнего предложения — не услышано ни одного слова от трёх букв (в последнем предложении — от четырёх): дословно — где угодно в услышанном, по окончанию — только своей парой из доли. */
```

- [ ] **Step 5: Подсчёт в `speechCheck`**

В `speechCheck` заменить блок от `const heardWords = new Set(pool.keys());` до строки `.map(({ i }) => i);` включительно:

```ts
  const heardWords = new Set(pool.keys());
  const expected = perLine.flat();
  let hit = 0;
  for (const w of expected) {
    const left = pool.get(w) ?? 0;
    if (left > 0) {
      hit++;
      pool.set(w, left - 1);
    }
  }
  const share = expected.length ? hit / expected.length : 1;
  const long = (s: string, min = MIN_LINE_WORD): string[] => words(s).filter((w) => w.length >= min && !shout(w));
  // Реплика проглочена, если от неё не услышано ни одного слова; при нескольких
  // предложениях — и если не услышано ни одного слова последнего (обрыв клипа).
  const silentLines = lines
    .map((l, i) => {
      const s = sentences(l);
      return { i, parts: s.length > 1 ? [long(l), long(s.at(-1) ?? '', MIN_LAST_WORD)] : [long(l)] };
    })
    .filter(({ parts }) => parts.some((p) => p.length > 0 && !p.some((w) => heardWords.has(w))))
    .map(({ i }) => i);
```

на:

```ts
  const heardWords = [...pool.keys()];
  const expected = perLine.flat();
  /** Номер реплики у каждого слова expected. */
  const lineOf = perLine.flatMap((ws, li) => ws.map(() => li));
  /** Слова каждой реплики, засчитанные по окончанию, — каждое своей парой из услышанного. */
  const byStem = perLine.map(() => new Set<string>());
  // Сначала точные пары, потом с точностью до окончания: иначе неточное слово
  // могло бы забрать пару, которая точно подходит другому.
  const matched = expected.map(() => false);
  const take = (i: number, h: string): void => {
    matched[i] = true;
    pool.set(h, (pool.get(h) ?? 0) - 1);
  };
  expected.forEach((w, i) => {
    if ((pool.get(w) ?? 0) > 0) take(i, w);
  });
  expected.forEach((w, i) => {
    if (matched[i]) return;
    const h = heardWords.find((x) => (pool.get(x) ?? 0) > 0 && sameWord(w, x));
    if (h === undefined) return;
    take(i, h);
    byStem[lineOf[i]].add(w);
  });
  const hit = matched.filter(Boolean).length;
  const share = expected.length ? hit / expected.length : 1;
  const long = (s: string, min = MIN_LINE_WORD): string[] => words(s).filter((w) => w.length >= min && !shout(w));
  // Прозвучало ли слово реплики li: дословно — где угодно в услышанном, как прежде
  // (ключи pool — все услышанные слова); по окончанию — только своей парой из доли:
  // иначе «начинай» другой реплики скрыл бы оборванное «Начинаю.».
  const heardIn = (li: number) => (w: string): boolean => pool.has(w) || byStem[li].has(w);
  // Реплика проглочена, если от неё не услышано ни одного слова; при нескольких
  // предложениях — и если не услышано ни одного слова последнего (обрыв клипа).
  const silentLines = lines
    .map((l, i) => {
      const s = sentences(l);
      return { i, parts: s.length > 1 ? [long(l), long(s.at(-1) ?? '', MIN_LAST_WORD)] : [long(l)] };
    })
    .filter(({ i, parts }) => parts.some((p) => p.length > 0 && !p.some(heardIn(i))))
    .map(({ i }) => i);
```

Строка `return { ok: share >= MATCH_THRESHOLD && silentLines.length === 0, share, silentLines };` остаётся.

- [ ] **Step 6: Закоммитить и прогнать**

```bash
git add studio/src/animate/match.ts
git commit -m "feat(studio): сверка речи с точностью до окончания — «начинай уж» ≈ «начинаешь»" -m "Ложные отказы ролика 889b6423: правило последнего предложения сравнивало слова точно, а SpeechKit слил «начинай уж» в «начинаешь». MATCHER_VERSION = 2." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npx tsx --test src/animate/match.test.ts"
```

Ожидается: `ℹ tests 20`, `ℹ fail 0`.

---

### Task 3: Пометка брака рядом с клипом

**Files:**
- Modify: `studio/src/animate/run-animate.ts`
- Test: `studio/src/animate/run-animate.test.ts`

- [ ] **Step 1: Написать падающие тесты**

В `studio/src/animate/run-animate.test.ts` под строкой `import { animateRun, type AnimateDeps } from './run-animate';` добавить:

```ts
import { MATCHER_VERSION } from './match';
```

В тесте `'речь не сошлась — пересъёмка без нового кадра; забракованный клип отложен, а не удалён'` заменить

```ts
  const rejected = fs.readdirSync(path.join(env.runDir, 'skits', 'fp-conflict')).filter((f) => f.startsWith('rejected-'));
```

на

```ts
  const rejected = fs.readdirSync(path.join(env.runDir, 'skits', 'fp-conflict')).filter((f) => f.startsWith('rejected-') && f.endsWith('.mp4'));
```

Сразу после этого теста добавить два новых:

```ts
test('брак откладывается с пометкой: код, версия сверки, услышанное и доля', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { heard: (kind, call) => (kind === 'conflict' && call === 1 ? 'совсем другое' : LINES[kind].join(' ')) });
  await animateRun(env.runDir, deps);
  const dir = path.join(env.runDir, 'skits', 'fp-conflict');
  const metas = fs.readdirSync(dir).filter((f) => /^rejected-.*\.json$/.test(f));
  assert.equal(metas.length, 1);
  assert.ok(fs.existsSync(path.join(dir, metas[0].replace(/\.json$/, '.mp4'))), 'пометка без клипа');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, metas[0]), 'utf8')), {
    code: 'speech_mismatch',
    matcher: MATCHER_VERSION,
    heard: 'совсем другое',
    share: 0,
  });
});

test('битый файл от Omni — брак с пометкой clip_invalid, без услышанного', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { wait: (kind, n) => (kind === 'conflict' && n === 1 ? Buffer.from('not a video') : env.clip) });
  await animateRun(env.runDir, deps);
  const dir = path.join(env.runDir, 'skits', 'fp-conflict');
  const metas = fs.readdirSync(dir).filter((f) => /^rejected-.*\.json$/.test(f));
  assert.equal(metas.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, metas[0]), 'utf8')), { code: 'clip_invalid', matcher: MATCHER_VERSION });
});
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падают ровно новые**

```bash
git add studio/src/animate/run-animate.test.ts
git commit -m "test(studio): пометка брака сценки (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts"
```

Ожидается: `ℹ fail 2` — оба новых теста (`metas.length` 0 вместо 1).

- [ ] **Step 3: Тип пометки и чтение**

В `studio/src/animate/run-animate.ts` заменить импорт

```ts
import { speechCheck } from './match';
```

на

```ts
import { MATCHER_VERSION, speechCheck } from './match';
```

После строки `class StorageError extends StudioError {}` вставить:

```ts

/**
 * Пометка брака рядом с skits/<отпечаток>/rejected-*.mp4. По ней студия решает,
 * перепроверять ли брак до новой оплаты (reviveRejected): сверка поменялась
 * (matcher меньше MATCHER_VERSION) — да, плохой файл (clip_invalid) — нет.
 */
export interface RejectedMeta {
  code: 'clip_invalid' | 'speech_mismatch';
  /** Версия сверки, которая забраковала клип или последней его перепроверила. */
  matcher: number;
  /** Что распознал SpeechKit — у speech_mismatch. */
  heard?: string;
  share?: number;
}

/** Пометка брака; нет файла или он битый — брак до пометок (до 31.10.2026): причина и сверка неизвестны. */
function readRejectedMeta(file: string): Partial<RejectedMeta> {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RejectedMeta> | null;
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Запись пометки**

Внутри `animateRun`, сразу после определения `local` (функция, которая заканчивается строкой `throw new StudioError('unknown', \`${what} — ${failText(e)}\`, false);` и закрывающими `}` / `};`), вставить:

```ts
  /** Пометка брака — подсказка перепроверке, не счёт денег: не записалась — брак перепроверится полной проверкой. */
  const writeRejectedMeta = (file: string, meta: RejectedMeta): void => {
    try {
      writeAtomic(file, JSON.stringify(meta, null, 2));
    } catch (e) {
      log(`animate: пометка брака ${path.basename(file)} не записалась — ${failText(e)}`);
    }
  };
```

В `finish` заменить начало `reject`

```ts
    const reject = async (code: 'clip_invalid' | 'speech_mismatch', msg: string): Promise<never> => {
```

на

```ts
    const reject = async (code: RejectedMeta['code'], msg: string, speech?: { heard: string; share: number }): Promise<never> => {
```

и в нём же заменить

```ts
      // Брак откладывается, а не удаляется: после подстройки порогов его можно перепроверить.
      fs.renameSync(raw, abs(skitFile(kind, `rejected-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`)));
```

на

```ts
      // Брак откладывается, а не удаляется: после правки сверки студия перепроверит его до новой оплаты (reviveRejected).
      const base = skitFile(kind, `rejected-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.renameSync(raw, abs(`${base}.mp4`));
      writeRejectedMeta(abs(`${base}.json`), { code, matcher: MATCHER_VERSION, ...speech });
```

Ниже в `finish` заменить вызов при несовпадении речи

```ts
        await reject('speech_mismatch', `${why}, услышано: «${heard.slice(0, 200)}»`);
```

на

```ts
        await reject('speech_mismatch', `${why}, услышано: «${heard.slice(0, 200)}»`, { heard, share: check.share });
```

- [ ] **Step 5: Закоммитить и прогнать**

```bash
git add studio/src/animate/run-animate.ts
git commit -m "feat(studio): брак сценки откладывается с пометкой — код, услышанное, версия сверки" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts"
```

Ожидается: `ℹ fail 0`.

---

### Task 4: Перепроверка брака до новой оплаты

**Files:**
- Modify: `studio/src/animate/run-animate.ts`
- Test: `studio/src/animate/run-animate.test.ts`

- [ ] **Step 1: Написать падающие тесты**

В конец `studio/src/animate/run-animate.test.ts`:

```ts
/**
 * Как у ролика 889b6423: обе сценки приняты (16 с), затем новый текст развязки
 * (fp-punchline-2, кадр прежний), и рядом — отложенный брак этого текста.
 */
async function withRejected(meta?: object) {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  const lines = ['Это износ, верните залог.', 'Ладно, убедил. Начинай уж.'];
  writeScript(env.runDir, { conflict: plan('conflict'), punchline: plan('punchline', lines, 'fp-punchline-2') });
  const dir = path.join(env.runDir, 'skits', 'fp-punchline-2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rejected-2026-10-31T16-29-00-469Z.mp4'), env.clip);
  if (meta) fs.writeFileSync(path.join(dir, 'rejected-2026-10-31T16-29-00-469Z.json'), JSON.stringify(meta));
  return { env, lines, dir };
}

const rejectedClips = (dir: string): string[] => fs.readdirSync(dir).filter((f) => /^rejected-.*\.mp4$/.test(f));

test('брак без пометки (до 31.10) перепроверяется до новой оплаты — принят без Omni, даже когда предел выбран', { timeout: 120_000 }, async () => {
  const { env, dir } = await withRejected();
  const heard = 'это износ верните залог ладно убедил начинаешь';
  const second = fakes(env, { heard: (kind) => (kind === 'punchline' ? heard : LINES[kind].join(' ')) });
  const anim = await animateRun(env.runDir, { ...second.deps, maxOmniSeconds: 16 });
  assert.deepEqual(second.calls.start, []);
  assert.deepEqual(second.calls.keyframe, []);
  assert.equal(second.calls.recognize, 1);
  assert.equal(anim.omniSeconds, 16);
  assert.equal(anim.skits.punchline!.fingerprint, 'fp-punchline-2');
  assert.equal(anim.skits.punchline!.heard, heard);
  assert.deepEqual(rejectedClips(dir), []);
  assert.ok(fs.existsSync(path.join(dir, 'raw.mp4')), 'принятый брак — оплаченный клип сценки');
});

test('брак, который эта сверка уже судила, и плохой файл не перепроверяются — снимается новый клип', { timeout: 120_000 }, async () => {
  for (const meta of [
    { code: 'speech_mismatch', matcher: MATCHER_VERSION, heard: 'это износ верните залог' },
    { code: 'clip_invalid', matcher: 1 },
  ]) {
    const { env, lines, dir } = await withRejected(meta);
    const second = fakes(env, { heard: (kind) => (kind === 'punchline' ? lines.join(' ') : LINES[kind].join(' ')) });
    const anim = await animateRun(env.runDir, second.deps);
    assert.deepEqual(second.calls.start, ['punchline'], meta.code);
    assert.equal(second.calls.recognize, 1, meta.code);
    assert.equal(anim.omniSeconds, 24, meta.code);
    assert.deepEqual(rejectedClips(dir), ['rejected-2026-10-31T16-29-00-469Z.mp4'], meta.code);
  }
});

test('брак прежней сверки, не прошедший сверку по записи, — без распознавания; пометка — этой сверки', { timeout: 120_000 }, async () => {
  const { env, lines, dir } = await withRejected({ code: 'speech_mismatch', matcher: 1, heard: 'это износ верните залог', share: 0.5 });
  const second = fakes(env, { heard: (kind) => (kind === 'punchline' ? lines.join(' ') : LINES[kind].join(' ')) });
  await animateRun(env.runDir, second.deps);
  assert.deepEqual(second.calls.start, ['punchline']);
  assert.equal(second.calls.recognize, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'rejected-2026-10-31T16-29-00-469Z.json'), 'utf8')), {
    code: 'speech_mismatch',
    matcher: MATCHER_VERSION,
    heard: 'это износ верните залог',
    share: 0.5,
  });
});

test('брак без пометки, не прошедший и новую сверку, — отложен снова с её пометкой, дальше обычная съёмка', { timeout: 120_000 }, async () => {
  const { env, lines, dir } = await withRejected();
  const second = fakes(env, {
    heard: (kind, call) => (kind === 'punchline' ? (call === 1 ? 'совсем другое' : lines.join(' ')) : LINES[kind].join(' ')),
  });
  const anim = await animateRun(env.runDir, second.deps);
  assert.deepEqual(second.calls.start, ['punchline']);
  assert.equal(second.calls.recognize, 2);
  assert.equal(anim.omniSeconds, 24);
  const left = rejectedClips(dir);
  assert.equal(left.length, 1);
  assert.notEqual(left[0], 'rejected-2026-10-31T16-29-00-469Z.mp4', 'брак лёг под новым именем, без дубля');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, left[0].replace(/\.mp4$/, '.json')), 'utf8'));
  assert.deepEqual([meta.code, meta.matcher, meta.heard], ['speech_mismatch', MATCHER_VERSION, 'совсем другое']);
});
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падают ровно новые**

```bash
git add studio/src/animate/run-animate.test.ts
git commit -m "test(studio): перепроверка брака сценки до новой оплаты (красный)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts"
```

Ожидается: `ℹ fail 3`:
- «брак без пометки … принят без Omni» — `omni_budget`: перепроверки ещё нет, а предел 16 с выбран;
- «… не прошедший сверку по записи …» — пометка осталась `matcher: 1`;
- «… отложен снова с её пометкой …» — два запуска Omni вместо одного (брак не перепроверен, первый новый клип забракован).

Тест «уже судила, и плохой файл» проходит и без перепроверки — он держит её от лишней работы.

- [ ] **Step 3: Функция `reviveRejected`**

В `animateRun`, сразу перед строкой `const assertBudget = (): void => {`, вставить:

```ts
  /**
   * Брак этого текста сценки, который нынешняя сверка ещё не судила, — до новой
   * оплаты, по одному, от старых к новым. С записанным услышанным он сначала
   * сверяется по записи (бесплатно); прошедший и брак без пометки (до 31.10.2026)
   * становятся оплаченным клипом сценки и проходят обычную проверку (finish:
   * громкость, тишина, распознавание, сверка). Не прошёл — finish отложит его
   * снова, уже с пометкой этой сверки. Предел секунд здесь не проверяется: Omni
   * не нужен, и ролик, упавший на пределе из-за ложных отказов, поднимается.
   * @returns принятый клип или null — снимать новый
   */
  const reviveRejected = async (kind: SkitKind): Promise<SkitClip | null> => {
    const dir = abs(path.posix.join('skits', plans[kind].fingerprint));
    if (!fs.existsSync(dir)) return null;
    const texts = plans[kind].skit.lines.map((l) => l.text);
    const rejected = fs.readdirSync(dir).filter((f) => /^rejected-.*\.mp4$/.test(f)).sort();
    for (let i = 0; i < rejected.length; i++) {
      const name = rejected[i];
      const metaFile = path.join(dir, name.replace(/\.mp4$/, '.json'));
      const meta = readRejectedMeta(metaFile);
      // Эта сверка его уже судила; плохой файл сверка не лечит.
      if (meta.matcher === MATCHER_VERSION || meta.code === 'clip_invalid') continue;
      if (typeof meta.heard === 'string' && !speechCheck(texts, meta.heard).ok) {
        writeRejectedMeta(metaFile, { code: 'speech_mismatch', heard: meta.heard, share: meta.share, matcher: MATCHER_VERSION });
        continue;
      }
      await local('брак не вернулся в работу', () => {
        fs.renameSync(path.join(dir, name), abs(skitFile(kind, 'raw.mp4')));
        fs.rmSync(metaFile, { force: true });
      });
      // Оплаченный клип — и в хранилище, как после скачивания: другой сервер его не потеряет.
      await upload(skitFile(kind, 'raw.mp4'));
      try {
        const clip = await finish(kind, i + 1, null);
        log(`animate ${kind}: принят клип из брака ${name} — сверка v${MATCHER_VERSION}, без Omni`);
        return clip;
      } catch (e) {
        const err = toStudioError(e);
        if (e instanceof StorageError || (err.code !== 'speech_mismatch' && err.code !== 'clip_invalid')) throw e;
        log(`animate ${kind}: брак ${name} не прошёл и сверку v${MATCHER_VERSION} — ${err.message}`);
      }
    }
    return null;
  };

```

- [ ] **Step 4: Вызов перед попытками сценки**

В `animateSkit` заменить

```ts
    // Запись под другой отпечаток больше не годится: сборка её и так не возьмёт.
    delete anim.skits[kind];
    await save();

    let last: StudioError | null = null;
```

на

```ts
    // Запись под другой отпечаток больше не годится: сборка её и так не возьмёт.
    delete anim.skits[kind];
    await save();
    // Оплаченный брак этого текста — до новой оплаты (reviveRejected). Запущенная
    // генерация или скачанный raw.mp4 важнее: их и так дождутся без новых денег.
    if (!fs.existsSync(raw) && !hasPending(kind)) {
      const revived = await reviveRejected(kind);
      if (revived) return revived;
    }

    let last: StudioError | null = null;
```

- [ ] **Step 5: Описание `animateRun`**

В комментарии над `export async function animateRun` заменить фразу

```ts
 * не стоит пересъёмки. Принятый клип при смене громкости или порогов пауз
 * переобрабатывается без Omni и без распознавания. Забракованный клип не
 * удаляется, а откладывается в skits/<отпечаток>/rejected-*.mp4 — его можно
 * разобрать и перепроверить.
```

на

```ts
 * не стоит пересъёмки. Принятый клип при смене громкости или порогов пауз
 * переобрабатывается без Omni и без распознавания. Забракованный клип не
 * удаляется, а откладывается в skits/<отпечаток>/rejected-*.mp4 с пометкой
 * rejected-*.json (код, услышанное, версия сверки); брак, который нынешняя
 * сверка ещё не судила, перепроверяется до новой оплаты (reviveRejected).
```

- [ ] **Step 6: Закоммитить и прогнать**

```bash
git add studio/src/animate/run-animate.ts
git commit -m "feat(studio): перепроверка оплаченного брака сценки до новой оплаты Omni" -m "Брак, который нынешняя сверка ещё не судила, перепроверяется до проверки предела: ролик, упавший на пределе из-за ложных отказов (889b6423), поднимается без Omni." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts"
```

Ожидается: `ℹ fail 0`.

---

### Task 5: Полный прогон студии и учение на клипах Лианы

**Files:** нет правок кода.

- [ ] **Step 1: Все юнит-тесты студии и типы** (сборку ролика задача не трогает — `test:render` не нужен)

```bash
studio/scripts/node-run.sh "s=0; npm test > ~/ci/selfheal-test.log 2>&1 || s=\$?; tail -12 ~/ci/selfheal-test.log; test \$s -eq 0; npm run typecheck"
```

Ожидается: `ℹ fail 0` в хвосте и пустой вывод `tsc --noEmit`. Красное — разобрать по `~/ci/selfheal-test.log` на ноде, не двигаться дальше.

- [ ] **Step 2 (контролёр): Учение на настоящих клипах ролика 889b6423**

Только чтение с прода; Omni потратить невозможно: в папке уже 48 с при пределе 48, любая попытка Omni падает на пределе до запуска.

```bash
ssh -o ConnectTimeout=15 dvolkov@212.113.106.202 'tar -C ~/spirits_back/studio/out/jobs/889b6423-53dd-4586-bb9f-c3f9cd5263a5/animate -czf - .' \
  | ssh -o ConnectTimeout=15 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 \
      'rm -rf ~/ci/drill-889b6423 && mkdir -p ~/ci/drill-889b6423 && tar -C ~/ci/drill-889b6423 -xzf - && find ~/ci/drill-889b6423 -name "rejected-*" | sort'
studio/scripts/node-run.sh "MAX_OMNI_SECONDS=48 npm run animate -- ~/ci/drill-889b6423"
```

Ожидается после копирования: пять `rejected-*.mp4` (три в `skits/122fa97812004038`, два в `skits/091df61907df2c5c`), ни одного `.json`. Ожидается в выводе animate:

```
animate punchline: принят клип из брака rejected-2026-10-31T16-29-00-469Z.mp4 — сверка v2, без Omni
...
animate: готово — Omni 48 с, кадров 2 (≈ $5.06)
```

Если вместо этого `omni_budget` — оба клипа не прошли и новую сверку: выписать строки `брак … не прошёл и сверку v2 — …` и остановиться, предел не поднимать.

- [ ] **Step 3 (контролёр): Убрать копию**

```bash
ssh -o ConnectTimeout=15 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 'rm -rf ~/ci/drill-889b6423 ~/ci/selfheal-test.log'
```

---

### Task 6 (контролёр, с OK владельца): Слияние, выкат, «Повторить» ролика 889b6423

Каждый шаг ниже, который меняет `main`, прод или ролик, — только после явного OK владельца на него.

- [ ] **Step 1: OK владельца на выкат** — коротко: что меняется (сверка, перепроверка брака), что проверено (тесты, учение), что выкат — `deploy.sh` с ноды, `BACK_ONLY=1 SKIP_BOTS=1` (фронт не меняется; машина ботов недоступна с ноды).

- [ ] **Step 2: Влить ветку в `main`**

```bash
cd ~/Downloads/spirits_back/.worktrees/shorts-self-healing
git fetch -q origin
git log --oneline origin/main..feat/shorts-self-healing
git checkout -q --detach origin/main
git merge --no-ff feat/shorts-self-healing -F - <<'EOF'
Merge feat/shorts-self-healing: очередь 1 — сверка речи без ложных отказов, перепроверка оплаченного брака

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
git push origin HEAD:main
git log --oneline -1
git checkout -q feat/shorts-self-healing
```

В выводе `git log origin/main..feat/shorts-self-healing` — только коммиты этой ветки (спека, план, задачи 1–4). Пуш отклонён (main ушёл) — повторить с `git fetch`, `checkout --detach origin/main`, `merge`. Записать sha слияния — `MERGE`.

- [ ] **Step 3: Свежие клоны на ноде**

```bash
N=selfheal1-1031
ssh -o ConnectTimeout=15 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 "N=$N bash -s" <<'EOF'
set -e
[ "$(ps -eo command | grep -c '^bash scripts/deploy.sh')" = 0 ] || { echo 'идёт другой выкат — ждать'; exit 1; }
test ! -e ~/deploy-clones/$N
mkdir -p ~/deploy-clones/$N ~/deploy-logs
cd ~/deploy-clones/$N
git clone -q --branch main git@github.com:dvvolkovv/spirits_back.git spirits_back
git clone -q --branch main git@github.com:dvvolkovv/spirits.git spirits_front
install -m 600 ~/dev/spirits_back/scripts/test-server.env.local spirits_back/scripts/
ln -s ~/dev/spirits_back/tests/node_modules spirits_back/tests/node_modules
git -C spirits_back log --oneline -1
EOF
```

Ожидается: sha клона бэка = `MERGE`.

- [ ] **Step 4: Запуск `deploy.sh` отвязанно**

```bash
ssh -o ConnectTimeout=15 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 "N=$N bash -s" <<'EOF'
cd ~/deploy-clones/$N/spirits_back
source ~/.nvm/nvm.sh >/dev/null
BACK_ONLY=1 SKIP_BOTS=1 LOCAL_BACK_DIR=$PWD LOCAL_FRONT_DIR=$HOME/deploy-clones/$N/spirits_front \
  setsid -f bash -c 'echo $$ > ~/deploy-logs/'"$N"'.pid; exec bash scripts/deploy.sh' > ~/deploy-logs/$N.log 2>&1 < /dev/null
sleep 3
cat ~/deploy-logs/$N.pid
EOF
```

Ждать в фоне (Bash `run_in_background`), без `tail -f`:

```bash
until ! ssh -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 "kill -0 \$(cat ~/deploy-logs/$N.pid) 2>/dev/null"; do sleep 60; done
ssh -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 "tail -40 ~/deploy-logs/$N.log"
```

Ожидается `ALL PHASES GREEN`. Красное — разобрать по логу, прод без зелёного test не трогается сам.

- [ ] **Step 5: Проверить, что на проде новый код**

```bash
ssh -o ConnectTimeout=15 dvolkov@212.113.106.202 'git -C ~/spirits_back log --oneline -1; grep -c "MATCHER_VERSION = 2" ~/spirits_back/studio/src/animate/match.ts; pm2 describe linkeon-studio | grep -E "status|uptime"'
```

Ожидается: sha `MERGE`, `1`, `online` и свежий uptime.

- [ ] **Step 6: OK владельца на «Повторить» у 889b6423 — и повтор**

Либо владелец нажимает «Повторить» в админке сам, либо — с его OK — вызов на проде. Токен: refresh админа с node-3 через прод (вложенный ssh — с `-n`, иначе он съест остаток скрипта), обмен и вызов — на `localhost:3001`, токены наружу не выводятся. Без `from` и `note`: ролик продолжит с оживления.

```bash
ssh -o ConnectTimeout=15 dvolkov@212.113.106.202 'bash -s' <<'EOF'
REFRESH=$(ssh -n -o BatchMode=yes -o ConnectTimeout=10 dvolkov@5.45.115.22 'sudo cat /var/lib/synthetic/admin-state.json' | python3 -c 'import sys,json; print(json.load(sys.stdin)["refreshToken"])')
[ -n "$REFRESH" ] || { echo "нет refresh"; exit 1; }
ACCESS=$(curl -s -X POST http://localhost:3001/webhook/auth/refresh -H "Authorization: Bearer $REFRESH" | python3 -c 'import sys,json; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print(d.get("access-token") or d.get("accessToken") or "")')
[ -n "$ACCESS" ] || { echo "обмен refresh не удался"; exit 1; }
curl -s -X POST http://localhost:3001/webhook/admin/shorts -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  --data '{"action":"retry","id":"889b6423-53dd-4586-bb9f-c3f9cd5263a5"}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print({k: d.get(k) for k in ("id","status","failedFrom","lastError","message")})'
EOF
```

Ожидается: `'status': 'animate_queued'`.

- [ ] **Step 7: Проследить ролик до проверки**

В фоне (Bash `run_in_background`), psql на проде — только чтение:

```bash
for i in $(seq 1 30); do
  out=$(ssh -o ConnectTimeout=10 dvolkov@212.113.106.202 'PGOPTIONS="-c default_transaction_read_only=on" psql "$(sed -n "s/^DATABASE_URL=//p" ~/spirits_back/.env | tail -n 1)" -X -At -F" | " -f -' <<'SQL'
SELECT status, animation->>'omniSeconds', left(coalesce(last_error, ''), 200) FROM short_video WHERE id = '889b6423-53dd-4586-bb9f-c3f9cd5263a5';
SQL
)
  echo "$(date +%H:%M:%S) $out"
  case "$out" in pending_review*|failed*) break;; esac
  sleep 30
done
ssh -o ConnectTimeout=15 dvolkov@212.113.106.202 'grep -ah "889b6423\|принят клип из брака\|animate punchline" ~/.pm2/logs/linkeon-studio-out*.log | tail -8'
```

Ожидается: `animate punchline: принят клип из брака rejected-2026-10-31T16-29-00-469Z.mp4 — сверка v2, без Omni`, затем `render 889b6423-…: громкость … → -14.x LUFS`, статус `pending_review`, `omniSeconds` — 48, владельцу приходит ролик на проверку.

- [ ] **Step 8: Заметка памяти и рабочее состояние** — в `project_promo_shorts_studio.md` и списке `shorts-self-healing`: очередь 1 на проде (sha), ролик 889b6423 поднят без Omni; дальше — план очереди 2.
