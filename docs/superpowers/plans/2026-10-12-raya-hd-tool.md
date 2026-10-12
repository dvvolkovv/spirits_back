# Райя считает и рисует бодиграф инструментом — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Райя в чате считает карту Human Design модулем калькулятора linkeon.io и показывает бодиграф картинкой в переписке — через новый MCP-инструмент `calculate_human_design`.

**Architecture:** копия модуля `land_linkeon/src/lib/human-design/` и базы городов переносится в `spirits_back/src/human-design/` скриптом (тесты калькулятора, включая эталон Swiss Ephemeris, едут вместе и гоняются jest'ом бэкенда). Тонкий слой бэкенда: поиск города (`city-resolver.ts`), SVG→PNG (`bodygraph-png.ts`, sharp), сервис инструмента (`hd-tool.service.ts`), ветка в `ChatToolsService.executeTool` и запись в `CHAT_TOOLS` — точка `/mcp` подхватывает её сама. Дальше — список инструментов релея и инструкция Райи в боевой базе.

**Tech Stack:** NestJS 10 (CommonJS, Node 22), jest + ts-jest, sharp 0.35, astronomy-engine 2.1.19 (MIT, есть сборка CommonJS), MCP SDK (StreamableHTTP, stateless).

**Спека:** [docs/superpowers/specs/2026-10-12-raya-hd-tool-design.md](../specs/2026-10-12-raya-hd-tool-design.md)

---

## Что выяснено при подготовке плана (12.10.2026)

1. **Точка `/mcp`** (`src/mcp/mcp.controller.ts`) отдаёт `CHAT_TOOLS` из `src/chat/chat-tools.ts`, сама добавляя к каждой схеме обязательный `userId`, и зовёт `ChatToolsService.executeTool(userId, name, args)`; результат уходит модели JSON-текстом. Новый инструмент = запись в `CHAT_TOOLS` + ветка в `executeTool`; контроллер не меняется.
2. **`ChatToolsService`** предоставляет `ChatModule` (`src/chat/chat.module.ts`). Тесты собирают его руками позиционно (`new ChatToolsService({} as any, … 7 штук)`), поэтому новая зависимость добавляется **последним** параметром — старые тесты не ломаются.
3. **Картинки** `generate_image` грузятся `MiscService.uploadAssetImage(buffer, 'png')` в бакет `linkeon-assets` под случайным ключом `images/<ts>-<rnd>.png`, наружу — публичный URL. Модель вставляет `![](imageUrl)` (так велит промпт релея), кабинет показывает картинку в переписке.
4. **sharp** в бэкенде подключают через `require` (`src/chat/chat-files/thumbnails.ts:17`: `const sharp = require('sharp') as unknown as typeof import('sharp/lib/index');`) — `esModuleInterop` нет.
5. **Бэкенд — CommonJS**, `isolatedModules`, `strictNullChecks: false`, target ES2021; jest гоняет `**/src/**/*.spec.ts` через ts-jest **без проверки типов** (типы — отдельным `npx tsc -p tsconfig.build.json --noEmit`). `testPathIgnorePatterns` содержит `/.worktrees/` — в маковском воркдереве jest «не видит» тесты, гонять только на ноде (путь `~/ci/wt/...`).
6. **JSON в сборку не попадает:** `resolveJsonModule` нет, у `nest-cli.json` нет `assets`. База городов читается с диска (`__dirname/data/cities.ru.json`) и копируется в `dist` правилом `assets` в `nest-cli.json`.
7. **Модуль калькулятора** — чистый TS без браузерных API; тесты на vitest: импорт `from 'vitest'` и в `reference.test.ts` — `new URL('./__fixtures__/reference.json', import.meta.url)`. В бэкенде (jest, CommonJS) скрипт переноса убирает импорт vitest, меняет путь к эталону на `join(__dirname, …)` и переименовывает `*.test.ts` → `*.spec.ts`. `boundary.test.ts` (сторож границы лендинга, `import.meta` + `typescript`) не переносится. `expect(x, 'сообщение')` vitest'а jest 29 не принимает («Expect takes at most one argument» — выяснилось на первом прогоне 12.10): скрипт вставляет в начало каждого перенесённого теста обёртку `expect`, отбрасывающую сообщение.
8. **astronomy-engine 2.1.19:** `exports['.'].require = ./astronomy.js` — CommonJS-сборка есть; типы `astronomy.d.ts`.
9. **Схема** 360×548 (`layout.ts`, `VIEWBOX`), шрифт `Inter, system-ui, sans-serif` → на сервере падёт на системный sans-serif (librsvg/fontconfig). PNG рисуем с плотностью 144 → 720×1096. Читаются ли цифры ворот — проверяется глазами (Task 4) и на проде до включения Райи (Task 8).
10. **Telegram-бот** — отдельный конвейер с маркерами (`src/tg-bot/tg-bot.service.ts`, `OutgoingMarker`), инструментов MCP там нет. Райя в Telegram продолжит считать по-старому — это закрывает пункт инструкции «инструмент недоступен — прежний способ». Мобильное приложение ходит тем же `/webhook/soulmate/chat` → релей → MCP.
11. **Релей:** список разрешённых инструментов — строка `let allowedTools = "…,mcp__linkeon__read_calendar";` в `relay-agent/server.mjs:477`; на сервере `dv@5.101.115.184:/home/dv/file-agent` (свой git без remote), PM2 `file-agent`, порт 3033, `GET /health`. `deploy.sh` релей не катает. Живые ходы считает прод: `GET https://my.linkeon.io/webhook/chat/active-streams` → `{"active":N}`.
12. **Инструкция Райи** — только в боевой базе (`agents.system_prompt`, id 14); бэкенд читает её на каждый ход (кэша нет). Выгрузка — по образцу `land_linkeon/.superpowers/assistant-pages/dump-assistant-prompts.sh` (вне git): строка подключения из `~/spirits_back/.env` прода, `psql`.
13. **`deploy.sh`:** есть `BACK_ONLY=1` и `TEST_ONLY=1`. Тестовый API — на самой ноде, `localhost:3001`.

## Порядок и стоп-точки

```
Task 1 → 2 → 3 → 4 → 5 → 6 → 7 [СТОП 1] → 8 [СТОП 2 ×2] → 9 [СТОП 3] → 10 [СТОП 4] → 11 → 12
```

- **СТОП 1** (Task 7) — владелец видит PNG бодиграфа и итог проверок.
- **СТОП 2** — каждый запуск `deploy.sh` (Task 8): сначала `TEST_ONLY=1 BACK_ONLY=1`, потом `BACK_ONLY=1`.
- **СТОП 3** (Task 9) — правка и перезапуск релея.
- **СТОП 4** (Task 10) — владелец читает новый раздел инструкции Райи до записи в базу.

## Где работать

- Код — в воркдереве `~/Downloads/spirits_back/.worktrees/raya-hd` (ветка `feat/raya-hd-tool`). Основной чекаут `spirits_back` не трогать — там работают другие сессии.
- На маке нет `node_modules` бэкенда: jest, tsc, сборка — только на ноде `dv@85.192.61.231` в воркдереве `~/ci/wt/raya-hd`, через `node-run.sh` (Task 1). На ноду попадает только закоммиченное — красный тест коммитится отдельно (`test(hd-tool): … (красный)`).
- Скрипты, снимки инструкции и проверочные файлы — в `~/Downloads/land_linkeon/.superpowers/raya-hd/` (в `.gitignore` лендинга), не в репозитории бэкенда.
- Репозиторий публичный: ни секретов, ни номеров, ни рецептов входа, ни текста инструкций ассистентов — ни в коде, ни в коммитах, ни в этом плане.
- Коммиты по-русски, последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; в `git add` — только свои файлы поимённо. Без `\uXXXX` в исходниках (инструмент записи файлов их раскодирует).

## Файлы

| Файл | Ответственность | Что с ним |
|---|---|---|
| `scripts/sync-human-design.sh` | перенос модуля и базы городов из `land_linkeon` | создать |
| `src/human-design/lib/*` | копия модуля калькулятора с его тестами и эталоном | создать скриптом |
| `src/human-design/cities.ts`, `cities.spec.ts`, `data/cities.ru.json`, `data/README.md` | копия поиска городов и базы GeoNames (CC BY 4.0) | создать скриптом |
| `src/human-design/city-resolver.ts` + `.spec.ts` | город по словам человека: найден / варианты / нет | создать |
| `src/human-design/bodygraph-png.ts` + `.spec.ts` | SVG схемы → PNG | создать |
| `src/human-design/hd-tool.service.ts` + `.spec.ts` | сам инструмент: город → карта → картинка → ответ | создать |
| `src/human-design/human-design.module.ts` | модуль Nest | создать |
| `src/chat/chat-tools.ts` | запись `CHAT_TOOLS`, тип ответа, ветка `executeTool`, зависимость | изменить |
| `src/chat/chat-tools.hd.spec.ts` | инструмент в списке и делегирование | создать |
| `src/chat/chat.module.ts` | импорт `HumanDesignModule` | изменить |
| `nest-cli.json` | `assets` для базы городов | изменить |
| `package.json`, `package-lock.json` | `astronomy-engine` 2.1.19 | изменить |
| `relay-agent/server.mjs` | инструмент в списке разрешённых | изменить (Task 9) |

---

### Task 1: Рабочая копия и прогон на ноде

**Files:** только служебные — `~/Downloads/land_linkeon/.superpowers/raya-hd/`.

- [ ] **Step 1: Воркдерево**

Уже создано при записи спеки: `~/Downloads/spirits_back/.worktrees/raya-hd`, ветка `feat/raya-hd-tool` от `origin/main`, upstream снят. Проверить:

```bash
git -C ~/Downloads/spirits_back/.worktrees/raya-hd status -sb | head -2
git -C ~/Downloads/spirits_back/.worktrees/raya-hd fetch -q origin && git -C ~/Downloads/spirits_back/.worktrees/raya-hd rebase -q origin/main && git -C ~/Downloads/spirits_back/.worktrees/raya-hd log --oneline -1
```

- [ ] **Step 2: Скрипты для ноды**

`~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh`:

```bash
#!/usr/bin/env bash
# Прогон на тестовой ноде на ТЕКУЩЕМ коммите воркдерева бэкенда (raya-hd).
#   bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh 'npx jest src/human-design --maxWorkers=2'
# Код едет git push'ем прямо в CI-клон ноды (ветка tmp/raya-hd). Незакоммиченное
# на ноду не попадает. npm ci — только когда поменялся package-lock.json.
set -euo pipefail
WT=~/Downloads/spirits_back/.worktrees/raya-hd
NODE_WT=ci/wt/raya-hd
BRANCH=tmp/raya-hd
SSH_OPTS="-o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h"
GIT_SSH_COMMAND="ssh $SSH_OPTS" git -C "$WT" push -q -f "dv@85.192.61.231:ci/spirits_back" "HEAD:refs/heads/$BRANCH"
SHA=$(git -C "$WT" rev-parse HEAD)
ssh $SSH_OPTS dv@85.192.61.231 "set -e
  [ -d ~/$NODE_WT ] || git -C ~/ci/spirits_back worktree add -q --detach ~/$NODE_WT $SHA
  cd ~/$NODE_WT && git checkout -q --detach $SHA
  source ~/.nvm/nvm.sh
  H=\$(sha256sum package-lock.json | cut -c1-16)
  if [ \"\$(cat node_modules/.lockhash 2>/dev/null)\" != \"\$H\" ]; then
    npm ci > /tmp/raya-npmci.log 2>&1 || (tail -20 /tmp/raya-npmci.log; exit 1)
    echo \"\$H\" > node_modules/.lockhash
  fi
  echo \"== \$(git log --oneline -1)\"
  set +e
  $1"
```

`~/Downloads/land_linkeon/.superpowers/raya-hd/node-ssh.sh`:

```bash
#!/usr/bin/env bash
# Произвольная команда на ноде через то же мастер-соединение.
exec ssh -o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h dv@85.192.61.231 "$1"
```

Журнал — `~/Downloads/land_linkeon/.superpowers/raya-hd/progress.md`: строка на задачу «коммит, итог прогона».

- [ ] **Step 3: Точка отсчёта**

```bash
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh '(npx jest src/chat src/mcp --maxWorkers=2 > /tmp/raya-jest.log 2>&1 && echo JEST_OK || echo JEST_FAILED); grep -E "^Tests:|^Test Suites:" /tmp/raya-jest.log; (npx tsc -p tsconfig.build.json --noEmit > /tmp/raya-tsc.log 2>&1 && echo TSC_OK || (echo TSC_FAILED; grep -c "error TS" /tmp/raya-tsc.log)); (npm run build > /tmp/raya-build.log 2>&1 && echo BUILD_OK || echo BUILD_FAILED)'
```

Expected: числа тестов `src/chat src/mcp`, `TSC_OK` (или число старых ошибок — записать, дальше мерить дельтой), `BUILD_OK`. Записать в журнал.

---

### Task 2: Перенос модуля скриптом

**Files:**
- Create: `scripts/sync-human-design.sh`
- Create (скриптом): `src/human-design/lib/*`, `src/human-design/cities.ts`, `src/human-design/cities.spec.ts`, `src/human-design/data/cities.ru.json`, `src/human-design/data/README.md`, `src/human-design/lib/README.md`
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Скрипт переноса**

`scripts/sync-human-design.sh`:

```bash
#!/usr/bin/env bash
# Переносит модуль Human Design и базу городов из land_linkeon (калькулятор
# linkeon.io) в бэкенд — для инструмента calculate_human_design.
#
# Модуль правится ТОЛЬКО в land_linkeon (там его проверяет эталон Swiss
# Ephemeris на 300 рождений и 10 карт ручной сверки); сюда — этим скриптом.
# Тесты едут вместе: vitest → jest (импорт vitest убирается, *.test.ts →
# *.spec.ts, путь к эталону — через __dirname). Сторож границы лендинга
# (boundary.test.ts) не нужен бэкенду и не переносится.
#
# Запуск из корня spirits_back:
#   bash scripts/sync-human-design.sh [путь к land_linkeon]
set -euo pipefail
LAND="${1:-$HOME/Downloads/land_linkeon}"
SRC="$LAND/src/lib/human-design"
DST="src/human-design/lib"
[ -f "$SRC/index.ts" ] || { echo "нет $SRC/index.ts — укажите путь к land_linkeon" >&2; exit 1; }
[ -f package.json ] && grep -q '"name"' package.json || { echo "запускать из корня spirits_back" >&2; exit 1; }
if [ -n "$(git -C "$LAND" status --porcelain -- src/lib/human-design src/lib/cities.ts src/lib/cities.test.ts src/content/hd/cities.ru.json)" ]; then
  echo "в land_linkeon незакоммиченные правки модуля или базы городов — сначала коммит там" >&2
  exit 1
fi
SHA=$(git -C "$LAND" rev-parse --short HEAD)

rm -rf "$DST"
mkdir -p "$DST/__fixtures__" src/human-design/data

for f in "$SRC"/*.ts; do
  base=$(basename "$f")
  case "$base" in
    boundary.test.ts) continue ;;
    *.test.ts)
      out="$DST/${base%.test.ts}.spec.ts"
      sed -e "/^import .* from 'vitest';$/d" \
          -e "s#new URL('./__fixtures__/reference.json', import.meta.url)#join(__dirname, '__fixtures__', 'reference.json')#" \
          "$f" > "$out"
      if grep -q "join(__dirname" "$out"; then
        { echo "import { join } from 'node:path';"; cat "$out"; } > "$out.tmp" && mv "$out.tmp" "$out"
      fi
      ;;
    *) cp "$f" "$DST/$base" ;;
  esac
done
cp "$SRC/__fixtures__/reference.json" "$DST/__fixtures__/reference.json"

cp "$LAND/src/lib/cities.ts" src/human-design/cities.ts
sed -e "/^import .* from 'vitest';$/d" "$LAND/src/lib/cities.test.ts" > src/human-design/cities.spec.ts
cp "$LAND/src/content/hd/cities.ru.json" src/human-design/data/cities.ru.json

cat > "$DST/README.md" <<EOF
# Копия модуля Human Design

Источник — \`land_linkeon/src/lib/human-design/\` @ \`$SHA\` (калькулятор
linkeon.io/calculators/human-design/). **Здесь не править**: правка — в
land_linkeon, перенос — \`bash scripts/sync-human-design.sh\`. Тесты и эталон
Swiss Ephemeris перенесены вместе: если копия разошлась с калькулятором,
покраснеет \`reference.spec.ts\`.
EOF

cat > src/human-design/data/README.md <<EOF
# База городов

\`cities.ru.json\` — города GeoNames от 15 000 жителей с русскими названиями и
IANA-поясом; собирает \`land_linkeon/scripts/build-hd-cities.py\`, сюда —
\`scripts/sync-human-design.sh\` (land_linkeon @ \`$SHA\`).
Данные GeoNames (https://www.geonames.org/) — по лицензии CC BY 4.0.
EOF

if grep -rln "import.meta\|from 'vitest'" "$DST" src/human-design/cities.ts src/human-design/cities.spec.ts; then
  echo "остались следы vitest или ESM — скрипт надо поправить" >&2
  exit 1
fi
echo "перенесено из land_linkeon@$SHA"
```

- [ ] **Step 2: Перенести**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git -C ~/Downloads/land_linkeon pull -q --ff-only
bash scripts/sync-human-design.sh ~/Downloads/land_linkeon
find src/human-design -type f | sort
```

Expected: «перенесено из land_linkeon@<sha>»; файлы `lib/{bodygraph,chart,ephemeris,index,layout,rules,svg,time,wheel}.ts`, их `*.spec.ts` (`bodygraph, chart, ephemeris, layout, manual, reference, rules, svg, time, wheel`), `lib/__fixtures__/reference.json`, `lib/README.md`, `cities.ts`, `cities.spec.ts`, `data/cities.ru.json`, `data/README.md`. Без `boundary`.

- [ ] **Step 3: Зависимость astronomy-engine — на ноде, обратно файлами**

На маке `npm` для бэкенда не запускается. Ставим на ноде во временном каталоге и забираем два файла:

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git add scripts/sync-human-design.sh src/human-design
git commit -q -m "feat(hd-tool): копия модуля Human Design и базы городов из land_linkeon, скрипт переноса

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh 'npm install --save-exact astronomy-engine@2.1.19 > /tmp/raya-npmi.log 2>&1 && echo NPMI_OK || (echo NPMI_FAILED; tail -5 /tmp/raya-npmi.log); grep -n "astronomy-engine" package.json'
scp -o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h dv@85.192.61.231:ci/wt/raya-hd/package.json dv@85.192.61.231:ci/wt/raya-hd/package-lock.json .
git diff --stat package.json package-lock.json
```

Expected: `NPMI_OK`, в `package.json` строка `"astronomy-engine": "2.1.19"`; дифф — только эти два файла. Вернуть воркдерево ноды к чистому состоянию (иначе следующий `checkout --detach` откажет):

```bash
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-ssh.sh 'cd ~/ci/wt/raya-hd && git checkout -q -- package.json package-lock.json && git status --short | head -3'
```

- [ ] **Step 4: Копия зелёная в jest бэкенда**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git add package.json package-lock.json
git commit -q -m "feat(hd-tool): astronomy-engine 2.1.19 для копии модуля Human Design

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh '(npx jest src/human-design --maxWorkers=2 > /tmp/raya-jest.log 2>&1 && echo JEST_OK || echo JEST_FAILED); grep -E "^Tests:|^Test Suites:|✕" /tmp/raya-jest.log | head -20; (npx tsc -p tsconfig.build.json --noEmit > /tmp/raya-tsc.log 2>&1 && echo TSC_OK || (echo TSC_FAILED; grep "error TS" /tmp/raya-tsc.log | head))'
```

Expected: `JEST_OK` — все перенесённые файлы зелёные, включая `reference.spec.ts` (300 рождений) и `manual.spec.ts`; `TSC_OK` (или прежнее число ошибок из Task 1 — новых нет). Красное в копии — **не править копию**: разбираться, что мешает (CommonJS-импорт astronomy-engine, отличие vitest/jest), чинить скрипт переноса и переносить заново.

---

### Task 3: Город для инструмента

**Files:**
- Create: `src/human-design/city-resolver.ts`
- Test: `src/human-design/city-resolver.spec.ts`

- [ ] **Step 1: Тест**

`src/human-design/city-resolver.spec.ts`:

```ts
import { indexCities, type CityDb } from './cities';
import { MAX_CANDIDATES, resolveCity } from './city-resolver';

const DB: CityDb = {
  v: 1,
  zones: ['Europe/Moscow', 'Europe/Berlin'],
  countries: { RU: 'Россия', DE: 'Германия' },
  regions: ['Москва', 'Татарстан', 'Нижегородская область', 'Берлин', 'Мурманская область', 'Ленинградская область'],
  cities: [
    ['Москва', 'Moscow', 'RU', 0, 10381, 0],
    ['Нижний Новгород', 'Nizhniy Novgorod', 'RU', 0, 1259, 2],
    ['Казань', 'Kazan', 'RU', 0, 1244, 1],
    ['Берлин', 'Berlin', 'DE', 1, 3426, 3],
    ['Великий Новгород', 'Velikiy Novgorod', 'RU', 0, 218, -1],
    ['Кировск', 'Kirovsk', 'RU', 0, 27, 4],
    ['Кировск', 'Kirovsk', 'RU', 0, 26, 5],
  ],
};
const index = indexCities(DB);

describe('город для инструмента Райи', () => {
  it('точное совпадение названия — берём, без регистра и латиницей', () => {
    expect(resolveCity(index, 'Казань')).toEqual({
      kind: 'found',
      cityId: 2,
      city: { name: 'Казань', region: 'Татарстан', country: 'Россия', zone: 'Europe/Moscow' },
    });
    expect(resolveCity(index, '  казань ')).toMatchObject({ kind: 'found', cityId: 2 });
    expect(resolveCity(index, 'Kazan')).toMatchObject({ kind: 'found', cityId: 2 });
  });

  it('одноимённых несколько — варианты, крупные первыми', () => {
    const r = resolveCity(index, 'Кировск');
    expect(r.kind).toBe('choose');
    if (r.kind !== 'choose') return;
    expect(r.candidates.map((c) => [c.cityId, c.region])).toEqual([
      [5, 'Мурманская область'],
      [6, 'Ленинградская область'],
    ]);
  });

  it('регион или страна после запятой сужают', () => {
    expect(resolveCity(index, 'Кировск, Ленинградская')).toMatchObject({ kind: 'found', cityId: 6 });
    expect(resolveCity(index, 'Казань, Германия')).toEqual({ kind: 'not_found' });
  });

  it('без точного совпадения — только варианты, даже если вариант один: пояс угадывать нельзя', () => {
    const r = resolveCity(index, 'Новгород');
    expect(r.kind === 'choose' && r.candidates.map((c) => c.name)).toEqual(['Нижний Новгород', 'Великий Новгород']);
    expect(resolveCity(index, 'Каз')).toMatchObject({ kind: 'choose', candidates: [{ cityId: 2, name: 'Казань' }] });
  });

  it('не найден, пусто, одна буква', () => {
    for (const q of ['Атлантида', '', 'К']) expect(resolveCity(index, q)).toEqual({ kind: 'not_found' });
  });

  it('cityId из прошлого ответа — берётся напрямую; чужой — не найден', () => {
    expect(resolveCity(index, 'что угодно', 3)).toMatchObject({
      kind: 'found',
      cityId: 3,
      city: { name: 'Берлин', zone: 'Europe/Berlin' },
    });
    for (const id of [999, -1, 1.5]) expect(resolveCity(index, 'Казань', id)).toEqual({ kind: 'not_found' });
  });

  it(`вариантов не больше ${MAX_CANDIDATES}`, () => {
    const many: CityDb = {
      ...DB,
      cities: Array.from({ length: 8 }, (_, i) => ['Кировск', 'Kirovsk', 'RU', 0, 100 - i, -1] as CityDb['cities'][number]),
    };
    const r = resolveCity(indexCities(many), 'Кировск');
    expect(r.kind === 'choose' && r.candidates).toHaveLength(MAX_CANDIDATES);
  });
});
```

- [ ] **Step 2: Красный прогон**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git add src/human-design/city-resolver.spec.ts
git commit -q -m "test(hd-tool): город по словам человека — найден, варианты, не найден (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh 'npx jest src/human-design/city-resolver > /tmp/raya-t.log 2>&1; echo "exit $?"; grep -E "Cannot find module|^Tests:" /tmp/raya-t.log | head -3'
```

Expected: `exit 1`, `Cannot find module './city-resolver'`.

- [ ] **Step 3: Реализация**

`src/human-design/city-resolver.ts`:

```ts
import { normalize, type City, type CityIndex } from './cities';

export const MAX_CANDIDATES = 5;

/** Вариант для уточнения: cityId — номер записи в базе, им Райя отвечает при повторном вызове. */
export interface CityCandidate extends City {
  cityId: number;
}

export type CityResolution =
  | { kind: 'found'; cityId: number; city: City }
  | { kind: 'choose'; candidates: CityCandidate[] }
  | { kind: 'not_found' };

/**
 * Город по словам человека — для часового пояса рождения.
 *
 * Совпадение названия целиком (без регистра, ё/й, латиницей тоже): одно —
 * берём, несколько — варианты для уточнения. Без точного совпадения — города,
 * чьё название или слово в нём начинается с запроса, как подсказки
 * калькулятора, но только вариантами, даже если он один: от города зависит
 * пояс, угадывать нельзя. «Кировск, Мурманская» — части после запятой сужают
 * по региону и стране. cityId — номер записи из прошлого ответа: берётся
 * напрямую. База отсортирована по населению — крупные идут первыми.
 */
export function resolveCity(index: CityIndex, query: string, cityId?: number): CityResolution {
  if (cityId !== undefined && cityId !== null) {
    const entry = Number.isInteger(cityId) ? index[cityId] : undefined;
    return entry ? { kind: 'found', cityId, city: entry.city } : { kind: 'not_found' };
  }
  const [namePart, ...rest] = String(query ?? '').split(',');
  const q = normalize(namePart);
  if (q.length < 2) return { kind: 'not_found' };
  const hints = rest.map(normalize).filter(Boolean);
  const fits = (c: City) => hints.every((h) => normalize(`${c.region ?? ''} ${c.country}`).includes(h));

  const exact: CityCandidate[] = [];
  const partial: CityCandidate[] = [];
  index.forEach(({ city, keys }, id) => {
    if (!fits(city)) return;
    if (keys.includes(q)) exact.push({ ...city, cityId: id });
    else if (partial.length < MAX_CANDIDATES && keys.some((k) => k.startsWith(q) || k.includes(` ${q}`))) {
      partial.push({ ...city, cityId: id });
    }
  });

  if (exact.length === 1) {
    const { cityId: id, ...city } = exact[0];
    return { kind: 'found', cityId: id, city };
  }
  if (exact.length > 1) return { kind: 'choose', candidates: exact.slice(0, MAX_CANDIDATES) };
  if (partial.length > 0) return { kind: 'choose', candidates: partial };
  return { kind: 'not_found' };
}
```

- [ ] **Step 4: Зелёный прогон**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git add src/human-design/city-resolver.ts
git commit -q -m "feat(hd-tool): город для инструмента — точное совпадение, варианты для уточнения, регион через запятую

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh 'npx jest src/human-design/city-resolver > /tmp/raya-t.log 2>&1; echo "exit $?"; grep -E "^Tests:" /tmp/raya-t.log'
```

Expected: `exit 0`, `Tests: 7 passed`.

---

### Task 4: Бодиграф картинкой

**Files:**
- Create: `src/human-design/bodygraph-png.ts`
- Test: `src/human-design/bodygraph-png.spec.ts`

- [ ] **Step 1: Тест**

`src/human-design/bodygraph-png.spec.ts`:

```ts
import { chartFromUtc, renderBodygraphSvg } from './lib';
import { BODYGRAPH_PNG_DENSITY, bodygraphPng } from './bodygraph-png';

const sharp = require('sharp') as unknown as typeof import('sharp/lib/index');

describe('бодиграф картинкой', () => {
  it('PNG вдвое крупнее схемы 360×548', async () => {
    const png = await bodygraphPng(renderBodygraphSvg(chartFromUtc('1990-03-12T11:25:00Z')));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const meta = await sharp(png).metadata();
    expect(BODYGRAPH_PNG_DENSITY).toBe(144);
    expect([meta.width, meta.height]).toEqual([720, 1096]);
  });
});
```

- [ ] **Step 2: Красный прогон**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git add src/human-design/bodygraph-png.spec.ts
git commit -q -m "test(hd-tool): бодиграф картинкой PNG (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh 'npx jest src/human-design/bodygraph-png > /tmp/raya-t.log 2>&1; echo "exit $?"; grep -E "Cannot find module|^Tests:" /tmp/raya-t.log | head -3'
```

Expected: `exit 1`, `Cannot find module './bodygraph-png'`.

- [ ] **Step 3: Реализация**

`src/human-design/bodygraph-png.ts`:

```ts
// sharp — через require, как в chat-files/thumbnails.ts: esModuleInterop в
// бэкенде нет, default-импорт упал бы в рантайме.
const sharp = require('sharp') as unknown as typeof import('sharp/lib/index');

/** Плотность растеризации: SVG схемы задан в 72 dpi, 144 — вдвое крупнее (720×1096). */
export const BODYGRAPH_PNG_DENSITY = 144;

/**
 * SVG бодиграфа (renderBodygraphSvg модуля — та же схема, что на сайте) →
 * PNG. PNG, а не SVG: картинку показывают все клиенты чата, её можно
 * скачать и переслать. Цифры ворот — текст SVG: sharp рисует их системным
 * sans-serif (Inter на сервере нет).
 */
export async function bodygraphPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: BODYGRAPH_PNG_DENSITY }).png().toBuffer();
}
```

- [ ] **Step 4: Зелёный прогон и снимок глазами**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git add src/human-design/bodygraph-png.ts
git commit -q -m "feat(hd-tool): бодиграф картинкой — SVG схемы в PNG вдвое крупнее

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh 'npx jest src/human-design/bodygraph-png > /tmp/raya-t.log 2>&1; echo "exit $?"; grep -E "^Tests:" /tmp/raya-t.log; npx ts-node -T -e "require(\"./src/human-design/bodygraph-png\").bodygraphPng(require(\"./src/human-design/lib\").renderBodygraphSvg(require(\"./src/human-design/lib\").chartFromUtc(\"1990-03-12T11:25:00Z\"))).then((b) => require(\"fs\").writeFileSync(\"/tmp/raya-bodygraph.png\", b))" && ls -l /tmp/raya-bodygraph.png; fc-list | wc -l'
mkdir -p ~/Downloads/land_linkeon/.superpowers/raya-hd
scp -o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h dv@85.192.61.231:/tmp/raya-bodygraph.png ~/Downloads/land_linkeon/.superpowers/raya-hd/bodygraph-node.png
```

Expected: `exit 0`, `Tests: 1 passed`; файл PNG ~720×1096. Открыть `bodygraph-node.png` (Read): центры закрашены, каналы, **цифры ворот читаются**. Цифр нет — на ноде нет шрифтов для librsvg: записать в журнал, проверить `fc-list` на проде (Task 8) и переходить на запасной путь — отрисовка текста ворот через `@napi-rs/canvas` (отдельной задачей с правкой спеки).

---

### Task 5: Сервис инструмента

**Files:**
- Create: `src/human-design/hd-tool.service.ts`, `src/human-design/human-design.module.ts`
- Modify: `nest-cli.json`
- Test: `src/human-design/hd-tool.service.spec.ts`

- [ ] **Step 1: Тест**

`src/human-design/hd-tool.service.spec.ts`:

```ts
import { indexCities, type CityDb } from './cities';
import { HumanDesignToolService } from './hd-tool.service';

const IMAGE = 'https://media.example/linkeon-assets/images/1-abc.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function service() {
  const upload = jest.fn(async () => IMAGE);
  const svc = new HumanDesignToolService({ uploadAssetImage: upload } as any);
  return { svc, upload };
}

/** База из двух одноимённых городов — для ветки уточнения (настоящая база может измениться). */
const TWINS: CityDb = {
  v: 1,
  zones: ['Europe/Moscow'],
  countries: { RU: 'Россия' },
  regions: ['Мурманская область', 'Ленинградская область'],
  cities: [
    ['Кировск', 'Kirovsk', 'RU', 0, 27, 0],
    ['Кировск', 'Kirovsk', 'RU', 0, 26, 1],
  ],
};

describe('инструмент calculate_human_design', () => {
  it('Казань, 12.03.1990, 14:25 — Манифестор 5/2, эмоциональный, картинка PNG', async () => {
    const { svc, upload } = service();
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Казань' });
    expect(r).toMatchObject({
      ok: true,
      kind: 'chart',
      city: { name: 'Казань', zone: 'Europe/Moscow' },
      offset: 'UTC+3',
      type: 'manifestor',
      profile: '5/2',
      authority: 'emotional',
      imageUrl: IMAGE,
    });
    if (!(r.ok && r.kind === 'chart')) throw new Error('ожидалась карта');
    expect(r.personality).toHaveLength(13);
    expect(r.design).toHaveLength(13);
    expect(r.personality[0]).toEqual({ body: 'sun', gate: expect.any(Number), line: expect.any(Number) });
    expect(upload).toHaveBeenCalledTimes(1);
    const [buf, ext] = upload.mock.calls[0] as unknown as [Buffer, string];
    expect(ext).toBe('png');
    expect(buf.subarray(0, 4)).toEqual(PNG);
  });

  it('одноимённые города — варианты, без расчёта и картинки; cityId из вариантов — карта', async () => {
    const { svc, upload } = service();
    svc['index'] = indexCities(TWINS);
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Кировск' });
    expect(r).toEqual({
      ok: true,
      kind: 'choose_city',
      candidates: [
        { cityId: 0, name: 'Кировск', region: 'Мурманская область', country: 'Россия', zone: 'Europe/Moscow' },
        { cityId: 1, name: 'Кировск', region: 'Ленинградская область', country: 'Россия', zone: 'Europe/Moscow' },
      ],
    });
    expect(upload).not.toHaveBeenCalled();
    const again = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Кировск', cityId: 1 });
    expect(again).toMatchObject({ ok: true, kind: 'chart', city: { region: 'Ленинградская область' } });
  });

  it('час перевода стрелок — вопрос «до или после»; с ответом — карта', async () => {
    const { svc } = service();
    const r = await svc.calculate({ date: '2014-10-26', time: '01:30', city: 'Москва, Россия' });
    expect(r).toEqual({ ok: true, kind: 'choose_dst', transition: 'ambiguous', before: 'UTC+4', after: 'UTC+3' });
    const after = await svc.calculate({ date: '2014-10-26', time: '01:30', city: 'Москва, Россия', dst: 'after' });
    expect(after).toMatchObject({ ok: true, kind: 'chart', offset: 'UTC+3' });
  });

  it('ошибки — понятным текстом и без картинки', async () => {
    const { svc, upload } = service();
    const cases = [
      { input: { date: '1990-03-12', time: '14:25', city: 'Атлантидаград' }, error: /не найден/ },
      { input: { date: '1990-02-30', time: '14:25', city: 'Казань' }, error: /дат/ },
      { input: { date: '1990-03-12', time: '25:00', city: 'Казань' }, error: /врем|дат/ },
      { input: { date: '2999-01-01', time: '12:00', city: 'Казань' }, error: /будущ/ },
      { input: { date: '1990-03-12', time: '14:25' }, error: /город/i },
    ];
    for (const { input, error } of cases) {
      const r = await svc.calculate(input);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(error);
    }
    expect(upload).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Красный прогон**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git add src/human-design/hd-tool.service.spec.ts
git commit -q -m "test(hd-tool): сервис инструмента — карта, уточнение города и стрелок, ошибки (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh 'npx jest src/human-design/hd-tool > /tmp/raya-t.log 2>&1; echo "exit $?"; grep -E "Cannot find module|^Tests:" /tmp/raya-t.log | head -3'
```

Expected: `exit 1`, `Cannot find module './hd-tool.service'`.

- [ ] **Step 3: Реализация**

`src/human-design/hd-tool.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MiscService } from '../misc/misc.service';
import { indexCities, type City, type CityDb, type CityIndex } from './cities';
import { resolveCity, type CityCandidate } from './city-resolver';
import { bodygraphPng } from './bodygraph-png';
import { calculateChart, formatOffset, renderBodygraphSvg, type Activation, type HdChart } from './lib';

/** Рядом с собранным файлом: nest-cli.json копирует data/*.json в dist (assets). */
export const CITIES_PATH = join(__dirname, 'data', 'cities.ru.json');

type ShortActivation = Pick<Activation, 'body' | 'gate' | 'line'>;

export type HdToolResult =
  | {
      ok: true;
      kind: 'chart';
      city: City;
      offset: string;
      birthUtc: string;
      type: HdChart['type'];
      strategy: HdChart['strategy'];
      authority: HdChart['authority'];
      profile: string;
      definition: HdChart['definition'];
      definedCenters: HdChart['definedCenters'];
      openCenters: HdChart['openCenters'];
      channels: string[];
      personality: ShortActivation[];
      design: ShortActivation[];
      imageUrl: string;
    }
  | { ok: true; kind: 'choose_city'; candidates: CityCandidate[] }
  | { ok: true; kind: 'choose_dst'; transition: 'gap' | 'ambiguous'; before: string; after: string }
  | { ok: false; error: string };

/**
 * Инструмент Райи calculate_human_design: город → пояс → карта модулем
 * калькулятора linkeon.io → бодиграф картинкой. Бесплатный: токены не
 * списываются. Описаний не отдаёт — толкует Райя; коды (manifestor, 5/2)
 * те же, что у калькулятора.
 */
@Injectable()
export class HumanDesignToolService {
  private index: CityIndex | null = null;

  constructor(private readonly misc: MiscService) {}

  /** База городов (1,5 МБ) читается один раз — при первом вызове, не при старте API. */
  private cityIndex(): CityIndex {
    if (!this.index) this.index = indexCities(JSON.parse(readFileSync(CITIES_PATH, 'utf8')) as CityDb);
    return this.index;
  }

  async calculate(input: any): Promise<HdToolResult> {
    const date = String(input?.date ?? '').trim();
    const time = String(input?.time ?? '').trim();
    const city = String(input?.city ?? '').trim();
    const rawId = input?.cityId;
    const cityId = rawId === undefined || rawId === null || rawId === '' ? undefined : Number(rawId);
    const dst = input?.dst === 'before' || input?.dst === 'after' ? input.dst : undefined;
    if (!city && cityId === undefined) return { ok: false, error: 'Нужен город рождения.' };

    const place = resolveCity(this.cityIndex(), city, cityId);
    if (place.kind === 'not_found') {
      return {
        ok: false,
        error: `Город «${city}» не найден в базе. Спросите ближайший крупный город в том же часовом поясе.`,
      };
    }
    if (place.kind === 'choose') return { ok: true, kind: 'choose_city', candidates: place.candidates };

    let result: ReturnType<typeof calculateChart>;
    try {
      result = calculateChart({ date, time, zone: place.city.zone, dst });
    } catch (e: any) {
      return { ok: false, error: `Проверьте дату и время рождения: ${e?.message ?? e}` };
    }
    if (result.kind === 'needsDstChoice') {
      return {
        ok: true,
        kind: 'choose_dst',
        transition: result.transition,
        before: formatOffset(result.beforeOffsetSeconds),
        after: formatOffset(result.afterOffsetSeconds),
      };
    }
    const { chart } = result;
    if (new Date(chart.birthUtc).getTime() > Date.now()) {
      return { ok: false, error: 'Дата рождения в будущем — проверьте год.' };
    }

    const imageUrl = await this.misc.uploadAssetImage(await bodygraphPng(renderBodygraphSvg(chart)), 'png');
    const short = (a: Activation): ShortActivation => ({ body: a.body, gate: a.gate, line: a.line });
    return {
      ok: true,
      kind: 'chart',
      city: place.city,
      offset: formatOffset(result.offsetSeconds),
      birthUtc: chart.birthUtc,
      type: chart.type,
      strategy: chart.strategy,
      authority: chart.authority,
      profile: chart.profile,
      definition: chart.definition,
      definedCenters: chart.definedCenters,
      openCenters: chart.openCenters,
      channels: chart.channels,
      personality: chart.personality.map(short),
      design: chart.design.map(short),
      imageUrl,
    };
  }
}
```

`src/human-design/human-design.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { MiscModule } from '../misc/misc.module';
import { HumanDesignToolService } from './hd-tool.service';

/** Инструмент Райи calculate_human_design (копия модуля калькулятора — в ./lib). */
@Module({
  imports: [MiscModule],
  providers: [HumanDesignToolService],
  exports: [HumanDesignToolService],
})
export class HumanDesignModule {}
```

`nest-cli.json` — целиком:

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": [{ "include": "human-design/data/*.json", "outDir": "dist" }]
  }
}
```

- [ ] **Step 4: Зелёный прогон и база в сборке**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git add src/human-design/hd-tool.service.ts src/human-design/human-design.module.ts nest-cli.json
git commit -q -m "feat(hd-tool): сервис инструмента calculate_human_design — город, карта, бодиграф картинкой; база городов в dist

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh 'npx jest src/human-design > /tmp/raya-t.log 2>&1; echo "exit $?"; grep -E "^Tests:|✕" /tmp/raya-t.log | head; (npm run build > /tmp/raya-build.log 2>&1 && echo BUILD_OK || (echo BUILD_FAILED; tail -15 /tmp/raya-build.log)); ls -l dist/human-design/data/cities.ru.json dist/human-design/hd-tool.service.js'
```

Expected: `exit 0` (все тесты `src/human-design`), `BUILD_OK`, оба файла в `dist/human-design/` — путь `CITIES_PATH` в сборке указывает на существующий файл.

---

### Task 6: Инструмент в списке и в executeTool

**Files:**
- Modify: `src/chat/chat-tools.ts` (импорт, запись в `CHAT_TOOLS` после `generate_speech`, тип `ToolResult`, конструктор, ветка `executeTool`)
- Modify: `src/chat/chat.module.ts`
- Test: `src/chat/chat-tools.hd.spec.ts`

- [ ] **Step 1: Тест**

`src/chat/chat-tools.hd.spec.ts`:

```ts
import { CHAT_TOOLS, ChatToolsService } from './chat-tools';

describe('инструмент calculate_human_design в чате', () => {
  it('в списке инструментов — с понятной схемой и правилом про картинку', () => {
    const tool = CHAT_TOOLS.find((t) => t.name === 'calculate_human_design');
    expect(tool).toBeDefined();
    const schema = tool!.input_schema as any;
    expect(schema.required).toEqual(['date', 'time', 'city']);
    expect(Object.keys(schema.properties).sort()).toEqual(['city', 'cityId', 'date', 'dst', 'time']);
    expect(schema.properties.dst.enum).toEqual(['before', 'after']);
    expect(tool!.description).toContain('![](imageUrl)');
    expect(tool!.description).toMatch(/choose_city/);
    expect(tool!.description).toMatch(/choose_dst/);
  });

  it('executeTool отдаёт вызов сервису как есть — без списания токенов', async () => {
    const result = { ok: true, kind: 'choose_city', candidates: [] };
    const humanDesign = { calculate: jest.fn(async () => result) };
    const pg = { query: jest.fn() };
    const svc = new ChatToolsService(
      {} as any, {} as any, pg as any, {} as any, {} as any, {} as any, {} as any, humanDesign as any,
    );
    const input = { date: '1990-03-12', time: '14:25', city: 'Казань' };
    await expect(svc.executeTool('70000000000', 'calculate_human_design', input)).resolves.toBe(result);
    expect(humanDesign.calculate).toHaveBeenCalledWith(input);
    expect(pg.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Красный прогон**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git add src/chat/chat-tools.hd.spec.ts
git commit -q -m "test(hd-tool): calculate_human_design в списке инструментов и в executeTool (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh 'npx jest src/chat/chat-tools.hd > /tmp/raya-t.log 2>&1; echo "exit $?"; grep -E "^Tests:|●" /tmp/raya-t.log | head -4'
```

Expected: `exit 1`, `Tests: 2 failed` (инструмента нет в списке; `unknown tool`).

- [ ] **Step 3: Реализация**

`src/chat/chat-tools.ts`:

1. Импорт — под строкой `import { TOP_UP_URL } from '../tokens/balance-context.service';`:

```ts
import { HumanDesignToolService, type HdToolResult } from '../human-design/hd-tool.service';
```

2. В `CHAT_TOOLS` — последним элементом, после объекта `generate_speech`:

```ts
  {
    name: 'calculate_human_design',
    description:
      'Рассчитать карту Human Design (дизайн человека) и нарисовать бодиграф — тем же модулем, что калькулятор ' +
      'на linkeon.io/calculators/human-design/: карта в чате и на сайте совпадает. Вход: дата, местное время и ' +
      'город рождения. Ответ kind="chart" — тип, стратегия, авторитет, профиль, определённость, определённые и ' +
      'открытые центры, каналы, 26 активаций (ворота и линия) и imageUrl картинки бодиграфа: вставь её в ответ ' +
      'отдельной строкой ![](imageUrl). kind="choose_city" — подходящих городов несколько: спроси человека, какой ' +
      '(регион, страна), и вызови снова с cityId выбранного варианта. kind="choose_dst" — время попало в час ' +
      'перевода стрелок: спроси, по часам до перевода или после, и вызови снова с dst. Ошибка «город не найден» — ' +
      'спроси ближайший крупный город в том же часовом поясе. Бесплатно.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Дата рождения, YYYY-MM-DD.' },
        time: { type: 'string', description: 'Местное время рождения, HH:MM (24 часа).' },
        city: {
          type: 'string',
          description: 'Город рождения, как назвал человек; можно с регионом через запятую: «Кировск, Мурманская область».',
        },
        cityId: { type: 'integer', description: 'Номер города из вариантов прошлого ответа choose_city.' },
        dst: {
          type: 'string',
          enum: ['before', 'after'],
          description: 'Ответ на вопрос о переводе стрелок: по часам до перевода или после.',
        },
      },
      required: ['date', 'time', 'city'],
    },
  },
```

3. Тип ответа — первой строкой объединения `export type ToolResult =`:

```ts
export type ToolResult =
  | HdToolResult
  | { ok: true; kind: 'image'; imageUrl: string; tokensSpent: number }
```

(остальные варианты — без изменений).

4. Конструктор — последним параметром:

```ts
    private readonly speech: SpeechService,
    private readonly humanDesign: HumanDesignToolService,
  ) {}
```

5. В `executeTool` — первой веткой внутри `try {`, перед `if (name === 'manage_routine') {`:

```ts
      if (name === 'calculate_human_design') {
        // Бесплатный расчёт: токены не списываются, userId нужен только
        // контроллеру /mcp для журнала вызовов.
        return await this.humanDesign.calculate(input);
      }
```

`src/chat/chat.module.ts`: импорт `import { HumanDesignModule } from '../human-design/human-design.module';` и `HumanDesignModule` в конец массива `imports`.

- [ ] **Step 4: Зелёный прогон, типы, сборка**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git add src/chat/chat-tools.ts src/chat/chat.module.ts
git commit -q -m "feat(hd-tool): calculate_human_design в инструментах чата и точке /mcp

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh '(npx jest src/chat src/mcp src/human-design --maxWorkers=2 > /tmp/raya-jest.log 2>&1 && echo JEST_OK || echo JEST_FAILED); grep -E "^Tests:|^Test Suites:|✕" /tmp/raya-jest.log | head; (npx tsc -p tsconfig.build.json --noEmit > /tmp/raya-tsc.log 2>&1 && echo TSC_OK || (echo TSC_FAILED; grep "error TS" /tmp/raya-tsc.log | head)); (npm run build > /tmp/raya-build.log 2>&1 && echo BUILD_OK || echo BUILD_FAILED)'
```

Expected: `JEST_OK` — прежние тесты `src/chat src/mcp` из Task 1 плюс новые; `TSC_OK` (или прежнее число из Task 1); `BUILD_OK`.

---

### Task 7: Проверка перед выкатом (СТОП 1)

- [ ] **Step 1: Ветка догнала main, полный прогон**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git fetch -q origin && git rebase -q origin/main && git log --oneline -3
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh '(npx jest src --maxWorkers=2 > /tmp/raya-jest-all.log 2>&1 && echo JEST_OK || echo JEST_FAILED); grep -E "^Tests:|^Test Suites:" /tmp/raya-jest-all.log; grep -E "✕|FAIL " /tmp/raya-jest-all.log | head; (npx tsc -p tsconfig.build.json --noEmit > /tmp/raya-tsc.log 2>&1 && echo TSC_OK || echo TSC_FAILED); (npm run build > /tmp/raya-build.log 2>&1 && echo BUILD_OK || echo BUILD_FAILED)'
```

Expected: `JEST_OK` по всему `src` (если на `main` и так есть красные — сравнить с прогоном `main` той же командой: новых падений нет), `TSC_OK`, `BUILD_OK`.

- [ ] **Step 2: СТОП 1 — владельцу**

Показать: `~/Downloads/land_linkeon/.superpowers/raya-hd/bodygraph-node.png` (схема с ноды), итог прогона, что дальше по шагам выката. Без «да» — не катить.

---

### Task 8: Выкат бэкенда и проверка инструмента (СТОП 2)

- [ ] **Step 1: Слить в main**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git fetch -q origin && git rebase -q origin/main
git checkout -q --detach origin/main && git merge -q --no-ff feat/raya-hd-tool -m "Merge feat/raya-hd-tool: Райя считает и рисует бодиграф инструментом calculate_human_design

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-run.sh '(npx jest src/chat src/mcp src/human-design --maxWorkers=2 > /tmp/raya-jest.log 2>&1 && echo JEST_OK || echo JEST_FAILED); (npm run build > /tmp/raya-build.log 2>&1 && echo BUILD_OK || echo BUILD_FAILED)'
git push origin HEAD:main > /tmp/raya-push.log 2>&1; echo "push exit $?"; git rev-parse --short HEAD
```

Expected: `JEST_OK`, `BUILD_OK`, `push exit 0`.

- [ ] **Step 2: СТОП 2 — test**

С OK владельца, с ноды, со свежих клонов, отвязанно:

```bash
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-ssh.sh 'pgrep -fa "^bash scripts/deploy.sh" || echo "чужих выкатов нет"'
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-ssh.sh 'set -e
NAME=raya-hd-test-$(date +%m%d-%H%M)
mkdir -p ~/deploy-clones/$NAME ~/deploy-logs
git clone -q --branch main git@github.com:dvvolkovv/spirits_back.git ~/deploy-clones/$NAME/spirits_back
git clone -q --branch main git@github.com:dvvolkovv/spirits.git ~/deploy-clones/$NAME/spirits_front
git -C ~/deploy-clones/$NAME/spirits_back log --oneline -1
source ~/.nvm/nvm.sh
cd ~/deploy-clones/$NAME/spirits_back
TEST_ONLY=1 BACK_ONLY=1 LOCAL_BACK_DIR=$PWD LOCAL_FRONT_DIR=~/deploy-clones/$NAME/spirits_front setsid -f bash -c "echo \$\$ > ~/deploy-logs/$NAME.pid; exec bash scripts/deploy.sh" > ~/deploy-logs/$NAME.log 2>&1 < /dev/null
echo $NAME'
```

Expected: в клоне — SHA слияния из Step 1. Ждать конца (`kill -0 $(cat ~/deploy-logs/<NAME>.pid)`), итог лога — `ALL PHASES GREEN` (только PHASE 1).

- [ ] **Step 3: Инструмент на test**

Скрипт вызова — `~/Downloads/land_linkeon/.superpowers/raya-hd/mcp-call.mjs` (вне git):

```js
// Вызов calculate_human_design через точку /mcp — проверка после выката.
//   MCP_SECRET=… node raya-mcp-call.mjs <адрес /mcp> <куда сохранить PNG>
// Секрет приходит из окружения и в вывод не попадает.
import { writeFileSync } from 'node:fs';

const [url, out] = process.argv.slice(2);
const secret = process.env.MCP_SECRET;
if (!url || !out || !secret) {
  console.error('нужны адрес /mcp, путь для PNG и MCP_SECRET');
  process.exit(2);
}
async function rpc(id, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text);
}
const list = await rpc(1, 'tools/list', {});
console.log('в списке:', list.result.tools.some((t) => t.name === 'calculate_human_design'));
const call = await rpc(2, 'tools/call', {
  name: 'calculate_human_design',
  arguments: { userId: '70000000000', date: '1990-03-12', time: '14:25', city: 'Казань' },
});
const r = JSON.parse(call.result.content[0].text);
console.log(JSON.stringify({ ok: r.ok, kind: r.kind, type: r.type, profile: r.profile, authority: r.authority, offset: r.offset, city: r.city?.name }));
const img = await fetch(r.imageUrl);
const buf = Buffer.from(await img.arrayBuffer());
writeFileSync(out, buf);
console.log('картинка:', img.status, img.headers.get('content-type'), buf.length);
```

Тестовый API — на самой ноде, `localhost:3001`. Секрет `/mcp` — из `.env` живого стенда, только чтение и не в вывод:

```bash
D=~/Downloads/land_linkeon/.superpowers/raya-hd
scp -o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h $D/mcp-call.mjs dv@85.192.61.231:/tmp/raya-mcp-call.mjs
bash $D/node-ssh.sh 'source ~/.nvm/nvm.sh >/dev/null; S=$(grep -E "^MCP_SECRET=" ~/spirits_back/.env | cut -d= -f2- | tr -d "\"'"'"'"); MCP_SECRET="$S" node /tmp/raya-mcp-call.mjs http://localhost:3001/mcp /tmp/raya-bodygraph-test.png'
scp -o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h dv@85.192.61.231:/tmp/raya-bodygraph-test.png $D/bodygraph-test.png
```

Expected: `в списке: true`; `{"ok":true,"kind":"chart","type":"manifestor","profile":"5/2","authority":"emotional","offset":"UTC+3","city":"Казань"}`; `картинка: 200 image/png <размер>`. Открыть `bodygraph-test.png` — схема и цифры ворот на месте.

- [ ] **Step 4: СТОП 2 — прод**

С OK владельца — тот же запуск, но `BACK_ONLY=1` (без `TEST_ONLY`; `NAME=raya-hd-prod-…`): test → smoke → прод → smoke. Итог — `ALL PHASES GREEN`.

- [ ] **Step 5: Инструмент на проде и шрифты**

С ноды (с мака прод недоступен). Секрет `/mcp` прода — из `.env` прода по ssh, не в вывод:

```bash
D=~/Downloads/land_linkeon/.superpowers/raya-hd
bash $D/node-ssh.sh 'source ~/.nvm/nvm.sh >/dev/null; S=$(ssh -o BatchMode=yes dvolkov@212.113.106.202 "grep -E \"^MCP_SECRET=\" ~/spirits_back/.env | cut -d= -f2-" | tr -d "\"'"'"'"); MCP_SECRET="$S" node /tmp/raya-mcp-call.mjs https://my.linkeon.io/mcp /tmp/raya-bodygraph-prod.png; ssh -o BatchMode=yes dvolkov@212.113.106.202 "fc-list | wc -l"'
scp -o ControlMaster=auto -o ControlPath=~/.ssh/cm-lnode -o ControlPersist=2h dv@85.192.61.231:/tmp/raya-bodygraph-prod.png $D/bodygraph-prod.png
```

Expected: то же, что на test (`kind: chart`, `manifestor`, `5/2`, `картинка: 200 image/png`); на проде есть шрифты (`fc-list` > 0). Открыть `bodygraph-prod.png` — цифры ворот читаются. Нет цифр — до Task 9 не идти: запасной путь (`@napi-rs/canvas`) отдельной задачей.

---

### Task 9: Инструмент в списке релея (СТОП 3)

**Files:**
- Modify: на сервере релея `/home/dv/file-agent/server.mjs`; в репозитории `relay-agent/server.mjs`

- [ ] **Step 1: Посмотреть строку на сервере**

```bash
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-ssh.sh 'ssh -o BatchMode=yes dv@5.101.115.184 "cd ~/file-agent && git status --short | head -5; git log --oneline -1; grep -c \"mcp__linkeon__read_calendar\\\";\" server.mjs; grep -c calculate_human_design server.mjs"'
```

Expected: рабочее дерево релея чистое (иначе — сначала понять, чьи там правки, и не трогать чужое), строка `…mcp__linkeon__read_calendar";` ровно одна, `calculate_human_design` — 0.

- [ ] **Step 2: СТОП 3 — согласие владельца на правку и перезапуск релея**

- [ ] **Step 3: Правка, проверка синтаксиса, коммит в git релея**

```bash
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-ssh.sh 'ssh -o BatchMode=yes dv@5.101.115.184 "cd ~/file-agent && sed -i \"s/mcp__linkeon__read_calendar\\\";/mcp__linkeon__read_calendar,mcp__linkeon__calculate_human_design\\\";/\" server.mjs && node --check server.mjs && git diff --stat && git commit -qam \"calculate_human_design — в список разрешённых инструментов\" && git log --oneline -1"'
```

Expected: `node --check` без ошибок, в диффе одна строка, коммит в git релея.

- [ ] **Step 4: Перезапуск, когда нет живых ходов**

```bash
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-ssh.sh 'for i in $(seq 1 120); do n=$(curl -s --max-time 10 https://my.linkeon.io/webhook/chat/active-streams | sed -n "s/.*\"active\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p"); [ "$n" = "0" ] && break; echo "живых ходов: ${n:-?} — жду"; sleep 15; done; echo "active=$n"; [ "$n" = "0" ] && ssh -o BatchMode=yes dv@5.101.115.184 "pm2 restart file-agent > /dev/null && sleep 3 && pm2 describe file-agent | grep -E \"status|restarts\" && curl -s localhost:3033/health"'
```

Expected: `active=0`, `status │ online`, `{"status":"ok",…}`. Если за 30 минут ходы не кончились — не перезапускать, спросить владельца.

- [ ] **Step 5: Та же правка в копии репозитория**

```bash
cd ~/Downloads/spirits_back/.worktrees/raya-hd
git fetch -q origin && git checkout -q --detach origin/main
sed -i '' 's/mcp__linkeon__read_calendar";/mcp__linkeon__read_calendar,mcp__linkeon__calculate_human_design";/' relay-agent/server.mjs
git diff --stat
git commit -qam "relay: calculate_human_design в списке разрешённых инструментов (перенесено с сервера релея)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push origin HEAD:main > /tmp/raya-push.log 2>&1; echo "push exit $?"
```

Expected: одна строка в диффе, `push exit 0`. (Релей в `deploy.sh` не катается — коммит только синхронизирует копию.)

---

### Task 10: Инструкция Райи (СТОП 4)

Текст инструкции в репозиторий и в этот план не попадает: снимки и черновик — в `~/Downloads/land_linkeon/.superpowers/raya-hd/` (вне git).

- [ ] **Step 1: Снимок нынешней инструкции**

```bash
D=~/Downloads/land_linkeon/.superpowers/raya-hd
ssh -o ConnectTimeout=10 dvolkov@212.113.106.202 'bash -s' > $D/raya-prompt-before.txt <<'REMOTE'
set -euo pipefail
url=$(grep -E '^DATABASE_URL=' ~/spirits_back/.env | cut -d= -f2- | tr -d "\"'")
psql "$url" -At -c "select system_prompt from agents where id = 14"
REMOTE
wc -c $D/raya-prompt-before.txt; sha256sum $D/raya-prompt-before.txt 2>/dev/null || shasum -a 256 $D/raya-prompt-before.txt
```

(Если с мака прод недоступен — тот же heredoc через `node-ssh.sh` и `scp` обратно.)

Expected: непустой файл, записать хэш в журнал.

- [ ] **Step 2: Черновик нового раздела о расчёте**

В копии `raya-prompt-after.txt` заменить раздел о расчёте (где Райя считает через Swiss Ephemeris) так, чтобы он требовал:
1. считать только инструментом `calculate_human_design` (дата, время, город; при уточнении — `cityId` или `dst`);
2. картинку бодиграфа из `imageUrl` вставлять в ответ отдельной строкой `![](imageUrl)`, сразу после первой фразы о том, что карта посчитана;
3. на `choose_city` — показать варианты (город, регион, страна) и спросить; на `choose_dst` — спросить, по часам до перевода стрелок или после; затем вызвать инструмент ещё раз;
4. если человек пришёл с калькулятора linkeon.io с готовыми данными (дата, время, город в первом сообщении) — сразу вызвать инструмент с ними;
5. если инструмент недоступен или вернул ошибку, кроме «город не найден», — посчитать прежним способом (Swiss Ephemeris, прежние правила) и сказать, что схемы сейчас не будет.

Остальной текст инструкции — без изменений. Показать дифф (`diff -u raya-prompt-before.txt raya-prompt-after.txt`).

- [ ] **Step 3: СТОП 4 — владелец читает раздел**

Показать владельцу только изменённый раздел (из диффа). Правки — в `raya-prompt-after.txt`.

- [ ] **Step 4: Запись в базу — только если инструкция не менялась с момента снимка**

```bash
D=~/Downloads/land_linkeon/.superpowers/raya-hd
scp -o ConnectTimeout=10 $D/raya-prompt-before.txt $D/raya-prompt-after.txt dvolkov@212.113.106.202:/tmp/
ssh -o ConnectTimeout=10 dvolkov@212.113.106.202 'bash -s' <<'REMOTE'
set -euo pipefail
url=$(grep -E '^DATABASE_URL=' ~/spirits_back/.env | cut -d= -f2- | tr -d "\"'")
now=$(psql "$url" -At -c "select system_prompt from agents where id = 14" | md5sum | cut -d' ' -f1)
snap=$(md5sum < /tmp/raya-prompt-before.txt | cut -d' ' -f1)
if [ "$now" != "$snap" ]; then
  echo "инструкция в базе изменилась после снимка — запись отменена"
  rm -f /tmp/raya-prompt-before.txt /tmp/raya-prompt-after.txt
  exit 1
fi
psql "$url" -v ON_ERROR_STOP=1 -v body="$(cat /tmp/raya-prompt-after.txt)" \
  -c "update agents set system_prompt = :'body' where id = 14 returning id, length(system_prompt)"
rm -f /tmp/raya-prompt-before.txt /tmp/raya-prompt-after.txt
REMOTE
```

Снимок из Step 1 сделан тем же `psql -At`, поэтому байты совпадают и `md5` сравнивается честно. «Изменилась после снимка» — снять снимок заново, переложить правку, снова СТОП 4.

Expected: строка `14 | <новая длина>` и `UPDATE 1`. Откат — тот же запуск с `raya-prompt-before.txt` в роли «после» (и снимком текущей версии в роли «до»).

---

### Task 11: Живая проверка в чате

- [ ] **Step 1: Разговор с Райей на проде**

С ноды, скриптом Playwright по образцу `~/Downloads/land_linkeon/.superpowers/values-test/prod-live.cjs` (вне git; вход — служебным тестовым аккаунтом по разделу «Тестовые аккаунты» CLAUDE.md кабинета, способ входа в репозиторий и в этот план не записывать): открыть `https://my.linkeon.io/chat?assistant=14`, отправить «Посчитай мой дизайн человека: 12.03.1990, 14:25, Казань», дождаться конца ответа.

Проверить и записать в журнал:
- в ответе есть картинка (`img` с адресом `…/linkeon-assets/images/…png`), она загрузилась (`naturalWidth > 0`);
- в тексте — Манифестор, профиль 5/2, эмоциональный авторитет — как у калькулятора на сайте;
- снимок экрана с картинкой — в `.superpowers/raya-hd/raya-prod-chat.png`.

Второй прогон — уточнение: «12.03.1990, 14:25, Кировск» → Райя спрашивает, какой Кировск; ответ «Ленинградская область» → карта и картинка.

- [ ] **Step 2: Итог владельцу**

Снимок экрана, что Райя сказала, что совпало с калькулятором.

---

### Task 12: После выката

- [ ] **Step 1: Заметки в память**

Новая заметка `project_raya_hd_tool`: инструмент `calculate_human_design` (точка `/mcp`, `src/human-design/`), копия модуля калькулятора — `scripts/sync-human-design.sh` (править только в `land_linkeon`), PNG через sharp в `linkeon-assets`, город — база GeoNames с уточнением, релей — `allowedTools` правится руками на сервере (git релея), инструкция Райи — снимки в `land_linkeon/.superpowers/raya-hd/`, Telegram — по-старому. В заметке калькулятора (`project_hd_calculator`) — «второй этап сделан». Строки в `MEMORY.md`.

- [ ] **Step 2: Уборка**

```bash
git -C ~/Downloads/spirits_back worktree remove .worktrees/raya-hd
bash ~/Downloads/land_linkeon/.superpowers/raya-hd/node-ssh.sh 'git -C ~/ci/spirits_back worktree remove --force ~/ci/wt/raya-hd; git -C ~/ci/spirits_back branch -D tmp/raya-hd; rm -rf ~/deploy-clones/raya-hd-*; rm -f /tmp/raya-*'
```

Ветку `feat/raya-hd-tool` удалить после «ок» владельца.
