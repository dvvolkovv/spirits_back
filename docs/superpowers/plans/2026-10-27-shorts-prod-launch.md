# Ролики на проде, план 5: студия на прод-сервере и запуск — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ролики со сценками выходят на проде: студия работает процессом PM2 на прод-сервере, её ставит и перезапускает `deploy.sh`, первые ролики владелец одобряет вручную, потом включается расписание.

**Architecture:** Код роликов уже в `main` (планы 1–4, `6e25b129`) и на проде лежит инертно: без `SHORTS_ENABLED` крон ничего не делает. План добавляет только эксплуатацию — процесс `linkeon-studio` (`studio/ecosystem.config.cjs`) и блок студии в `scripts/deploy.sh` по образцу `voice-host` (сборка, рестарт, откат; признак настроенности — `studio/.env`), — затем настраивает стенд и прод и проводит первый ролик с владельцем.

**Tech Stack:** bash (`scripts/deploy.sh`), jest для тестов скрипта (`tests/scripts/*.test.js`), студия — Node ESM, `tsx --test`, PM2, Playwright 1.59.1, Remotion 4.0.530.

**Спека:** `docs/superpowers/specs/2026-10-24-promo-shorts-design.md` — «Среды и выкат», «Предусловия»; итоги планов 2 и 4 — разделы «Что уточнил план 2» и «Что уточнил конвейер (план 4)» спеки сценок.

**Решения владельца (27.10.2026):**
- студия — на прод-сервере `212.113.106.202`, как в спеке (8 ядер, 15 ГБ, нагрузка ≈ 0,1; на PM2 там только `linkeon-api` и `linkeon-voice-host`);
- первые ролики — вручную (`SHORTS_AUTO_TOPICS=false`), владелец одобряет в Telegram; расписание вт/чт/сб 18:00 — после них;
- вопросы юристу (ERID, реестр РКН) — параллельно, запуск их не ждёт.

**Что проверено до плана (только чтение):**
- прод на `b6c54ea3`: модуль роликов плана 2 есть, таблицы `short_video` и `short_settings` созданы, строк нет; миграция 002 приедет с выкатом;
- в `.env` бэкенда прода есть `GOOGLE_AI_API_KEY`, `YANDEX_SPEECHKIT_API_KEY`, `YANDEX_TTS_FOLDER_ID`, `DEBUG_SECRET`, `BLOG_APPROVER_TG_ID`, `MINIO_*`; переменных `SHORTS_*` нет;
- политика MinIO `smm-rw` прода уже даёт `s3:DeleteObject` и `s3:ListBucket` на `linkeon-smm-videos` — пункт «перед продом» из итогов плана 4 снят;
- Google Generative Language API с прода — напрямую (бэкенд так и ходит, сторож Nano Banana тоже); `cdn.playwright.dev`, `storage.googleapis.com`, `registry.npmjs.org` отвечают; `my.linkeon.io` с самого прода — 200;
- библиотеки Chromium (libnss3, libgbm, libatk и др.) и шрифты на проде есть, `sudo` есть, ffmpeg есть; Node — v20.20.2;
- номера `790300XXXXX` у бэкенда «чисто тестовые» (`auth.service.ts`, `PURE_TEST_PATTERN`): SMS не уходит, код — из debug-ручки; демо-аккаунта на проде ещё нет — заведётся первым входом студии;
- мониторинги «Затыки недели», монитор качества, воронка, админка, темы блога номера `790300XXXXX` уже исключают (`src/common/test-users.ts`); алерт роста стоимости и отчёты о сбоях ассистентов — нет (сбой ассистента на демо-аккаунте — полезный сигнал; алерт роста стоимости проверяется после первой съёмки, задача 7);
- канал блога прода — `-1003046204962` (@ainomira).

**Вне этого плана:** VK (кода публикации нет, нужен сообщество и приложение VK ID — шаг владельца), автопубликация в YouTube (набор для ручной выкладки на канал @Linkeons остаётся), админка «Ролики» в кабинете, мелочи из разделов «Открыто…» спек.

---

## Как работать

- **Воркдерево на маке:** `/Users/dmitry/Downloads/spirits_back/.worktrees/shorts-prod`, ветка `feat/shorts-prod` от `origin/main` (`6e25b12`). Ниже `W` — этот путь. Git — через `git -C "$W"`.
- **Всё тяжёлое — на тестовой ноде.** `"$W"/studio/scripts/node-run.sh "<команда>"` пушит ветку и ставит `~/ci/wt/promo-shorts` на точный коммит (с `NODE_RUN_DIR=.` — корень бэкенда). Пуш в GitHub с мака — через ноду: `export GIT_SSH_COMMAND="ssh -o 'ProxyCommand=ssh -o ControlMaster=auto -o ControlPath=$HOME/.ssh/cm-%%C -o ControlPersist=30m dv@85.192.61.231 -W %h:%p'"`.
- **Слияние в main, выкат, правки `.env` и настроек на стенде и проде — только с явного OK владельца** (задачи 5–8, шаги с пометкой «OK»). Выкат — только `scripts/deploy.sh`, отвязанно, из свежих клонов на ноде (рецепт — задача 5).
- **Секреты и номера** в репозиторий и в вывод не попадают: значения из `.env` копируются на сервере, печатаются только имена переменных. Демо-номер и номер админа ниже — `<демо-номер>` (шаблон `790300XXXXX`) и `<номер админа>` (таблица «Тестовые аккаунты» в `CLAUDE.md`).
- **Коммиты** — по-русски, последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Файлы

| Файл | Задача | За что отвечает |
|---|---|---|
| `studio/ecosystem.config.cjs` | 1 | Процесс PM2 `linkeon-studio`: `nice -n 19`, `kill_timeout` 10 мин, `restart_delay` 60 с |
| `studio/src/worker/ecosystem.test.ts`, `studio/package.json` | 1 | Сторож конфига PM2 |
| `scripts/deploy.sh` | 2 | Студия в сборке бэкенда, в шаге рестарта и в откате прода |
| `tests/scripts/deploy-studio.test.js`, `tests/scripts/deploy-restart-gate.test.js` | 2 | Блок студии по-настоящему в bash, на заглушках |
| `studio/README.md` | 3 | Раздел «Под PM2: стенд и прод» |

---

### Task 1: Процесс PM2 студии

**Files:** Create `studio/ecosystem.config.cjs`, `studio/src/worker/ecosystem.test.ts`; Modify `studio/package.json` (список тестов: `src/worker/ecosystem.test.ts` после `src/worker/animate-money.test.ts`).

- [x] **Step 1: Тест (красный, коммит `831ee04` вместе с тестами задачи 2)**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = () => createRequire(import.meta.url)(path.join(STUDIO, 'ecosystem.config.cjs')).apps[0];

test('pm2: linkeon-studio — один рабочий процесс студии с низким приоритетом, циклом', () => {
  const apps = createRequire(import.meta.url)(path.join(STUDIO, 'ecosystem.config.cjs')).apps;
  assert.equal(apps.length, 1);
  const a = app();
  assert.deepEqual([a.name, a.cwd, a.exec_mode, a.instances], ['linkeon-studio', STUDIO, 'fork', 1]);
  // nice 19: съёмка и сборка грузят процессор, а API и чат на том же сервере важнее.
  assert.deepEqual([a.script, a.interpreter], ['/usr/bin/nice', 'none']);
  assert.deepEqual(a.args, ['-n', '19', 'node_modules/.bin/tsx', 'src/worker/worker.ts']);
  assert.ok(fs.existsSync(path.join(STUDIO, 'src/worker/worker.ts')));
});

test('pm2: остановка ждёт текущее задание — рабочий процесс доводит его по SIGINT', () => {
  const a = app();
  assert.ok(a.kill_timeout >= 600_000, `kill_timeout ${a.kill_timeout}`);
  // Падение на старте (нет ключа, нет базы) — не чаще раза в минуту, а не цикл перезапусков.
  assert.ok(a.restart_delay >= 60_000, `restart_delay ${a.restart_delay}`);
  assert.match(fs.readFileSync(path.join(STUDIO, 'src/worker/worker.ts'), 'utf8'), /\['SIGTERM', 'SIGINT'\] as const/);
});
```

- [x] **Step 2: Конфиг PM2 (коммит `8752153`)**

```js
// studio/ecosystem.config.cjs — PM2: рабочий процесс студии роликов (linkeon-studio).
// Расширение .cjs обязательно: в studio/package.json стоит "type":"module",
// и .js здесь читался бы как ESM без module.exports (как у voice-host).
// Запускает deploy.sh (pm2 startOrReload), только если рядом есть studio/.env.
module.exports = {
  apps: [
    {
      name: 'linkeon-studio',
      cwd: __dirname,
      // nice 19: съёмка (Chromium) и сборка (Remotion, ffmpeg) грузят процессор,
      // а API и чат на том же сервере важнее. Команда — та же, что npm run worker.
      script: '/usr/bin/nice',
      args: ['-n', '19', 'node_modules/.bin/tsx', 'src/worker/worker.ts'],
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Падение на старте (нет ключа Google, база недоступна) — не чаще раза в минуту.
      restart_delay: 60000,
      max_memory_restart: '2G',
      // SIGINT — рабочий процесс доводит текущее задание и выходит (worker.ts);
      // задание — обычно 1–5 минут. Дольше — pm2 добьёт, задание вернётся в
      // очередь по истечении аренды, оплаченное не потеряется (animation в базе).
      kill_timeout: 600000,
    },
  ],
};
```

Рабочий процесс (`studio/src/worker/worker.ts`) по SIGTERM/SIGINT уже доводит текущее задание и выходит; брошенное задание возвращается в очередь по истечении аренды, оплаченное не теряется (`animation` в базе).

---

### Task 2: Студия в `deploy.sh`

**Files:** Modify `scripts/deploy.sh` (`back_build_cmds`, шаг рестарта в `deploy_backend`, `rollback_backend`); Create `tests/scripts/deploy-studio.test.js`; Modify `tests/scripts/deploy-restart-gate.test.js`.

- [x] **Step 1: Тесты (красный, `831ee04`)**

```js
/**
 * deploy.sh: студия роликов (studio/) — свой package.json, без сборки (tsx),
 * браузеры съёмки (Playwright) и сборки (Remotion), процесс pm2 linkeon-studio.
 *
 * Команды сборки бэкенда (back_build_cmds) выполняются здесь по-настоящему —
 * в каталоге, похожем на сервер, а npm, npx, node и git подменены заглушками,
 * которые пишут журнал вызовов с каталогом, где их позвали.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEPLOY = path.join(__dirname, '..', '..', 'scripts', 'deploy.sh');

/** Тело функции скрипта: от `имя() {` до первой `}` в начале строки. */
function scriptFunction(name) {
  const lines = fs.readFileSync(DEPLOY, 'utf8').split('\n');
  const start = lines.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`в deploy.sh нет функции ${name}`);
  const end = lines.indexOf('}', start);
  return lines.slice(start, end + 1).join('\n');
}

const STUB = (name) => `#!/usr/bin/env bash
echo "${name}($(basename "$PWD")) $*" >> "$WORK/log"
# FAIL_ON — подстрока вызова вместе с каталогом: «npm(studio) ci» роняет только npm ci студии.
if [ -n "$FAIL_ON" ]; then
  case "${name}($(basename "$PWD")) $*" in *"$FAIL_ON"*) exit 1 ;; esac
fi
exit 0
`;

/**
 * Каталог «сервера»: корень бэкенда со studio/ (и .env, если studio=env).
 * git diff --quiet отвечает «без изменений», если LOCK_SAME=1.
 */
function runBuildCmds({ studio = 'env', env = {} } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-studio-'));
  const root = path.join(work, 'back');
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(root);
  if (studio) fs.mkdirSync(path.join(root, 'studio'));
  if (studio === 'env') fs.writeFileSync(path.join(root, 'studio', '.env'), 'X=1\n');
  for (const name of ['npm', 'npx', 'node']) {
    fs.writeFileSync(path.join(bin, name), STUB(name), { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
echo "git($(basename "$PWD")) $*" >> "$WORK/log"
[ "$1" = diff ] && [ "$LOCK_SAME" = 1 ] && exit 0
[ "$1" = diff ] && exit 1
exit 0
`, { mode: 0o755 });
  const harness = path.join(work, 'harness.sh');
  fs.writeFileSync(harness, [
    scriptFunction('back_build_cmds'),
    'cmds=$(back_build_cmds)',
    'printf "%s" "$cmds" > "$WORK/cmds.sh"',
    `cd ${JSON.stringify(root)}`,
    'set -eo pipefail',
    'eval "$cmds"',
  ].join('\n'));
  const res = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, WORK: work, FAIL_ON: '', LOCK_SAME: '', ...env },
  });
  const log = fs.existsSync(path.join(work, 'log')) ? fs.readFileSync(path.join(work, 'log'), 'utf8').split('\n').filter(Boolean) : [];
  const syntax = spawnSync('bash', ['-n', path.join(work, 'cmds.sh')], { encoding: 'utf8' });
  fs.rmSync(work, { recursive: true, force: true });
  return { status: res.status, out: `${res.stdout}${res.stderr}`, log, syntaxOk: syntax.status === 0 };
}

const inStudio = (log) => log.filter((l) => /^\w+\(studio\) /.test(l));

describe('deploy.sh: студия роликов в сборке бэкенда', () => {
  it('studio/.env есть — npm ci студии, браузеры Playwright и Remotion, по порядку', () => {
    const r = runBuildCmds();
    expect(r.status).toBe(0);
    expect(r.syntaxOk).toBe(true);
    expect(inStudio(r.log)).toEqual([
      'npm(studio) ci --no-audit --no-fund',
      'npx(studio) playwright install chromium',
      expect.stringMatching(/^node\(studio\) --input-type=module -e .*ensureBrowser/),
    ]);
  });

  it('studio/.env нет — студия не настроена: ни npm ci, ни браузеров, сообщение', () => {
    const r = runBuildCmds({ studio: 'dir' });
    expect(r.status).toBe(0);
    expect(inStudio(r.log)).toEqual([]);
    expect(r.out).toMatch(/studio: \.env отсутствует — студия не настроена, рабочий процесс пропущен/);
  });

  it('каталога studio/ нет (старый коммит) — молча мимо', () => {
    const r = runBuildCmds({ studio: null });
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/studio/);
  });

  it('тот же package-lock.json (возврат сборки) — npm ci студии пропущен, браузеры — всё равно', () => {
    const r = runBuildCmds({ env: { LOCK_SAME: '1', CI_SAME_AS: 'abc' } });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/studio: npm ci пропущен: package-lock\.json тот же/);
    expect(inStudio(r.log).some((l) => / ci /.test(`${l} `))).toBe(false);
    expect(inStudio(r.log).some((l) => /playwright install chromium/.test(l))).toBe(true);
  });

  it('npm ci студии упал — сборка падает с понятной строкой, браузеры не ставятся', () => {
    const r = runBuildCmds({ env: { FAIL_ON: 'npm(studio) ci' } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/studio: npm ci FAILED/);
    expect(inStudio(r.log).some((l) => /playwright/.test(l))).toBe(false);
  });

  it('браузеры не встали — сборка падает: иначе первая же съёмка упала бы на проде', () => {
    for (const fail of ['npx(studio) playwright install', 'node(studio) --input-type=module']) {
      const r = runBuildCmds({ env: { FAIL_ON: fail } });
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/studio: браузеры не установились/);
    }
  });
});

describe('deploy.sh: рабочий процесс студии в откате прода', () => {
  it('откат бэкенда возвращает и студию: npm ci, браузеры и pm2 startOrReload — только при studio/.env', () => {
    const fn = scriptFunction('rollback_backend');
    const block = fn.slice(fn.indexOf('[ -f studio/.env ]'));
    expect(block).toMatch(/cd studio/);
    expect(block).toMatch(/npm ci --no-audit --no-fund > \/tmp\/studio-install\.log/);
    expect(block).toMatch(/npx playwright install chromium/);
    expect(block).toMatch(/pm2 startOrReload ecosystem\.config\.cjs > \/tmp\/studio-pm2\.log/);
    const n = spawnSync('bash', ['-n'], { input: fn, encoding: 'utf8' });
    expect(n.status).toBe(0);
  });
});
```

В `tests/scripts/deploy-restart-gate.test.js` — случай для шага рестарта:

```diff
diff --git a/tests/scripts/deploy-restart-gate.test.js b/tests/scripts/deploy-restart-gate.test.js
index 5f7643a..e107195 100644
--- a/tests/scripts/deploy-restart-gate.test.js
+++ b/tests/scripts/deploy-restart-gate.test.js
@@ -189,6 +189,14 @@ describe('deploy.sh: живые ходы проверяются прямо пе
     expect(polls.some((l) => /^CALLS: /.test(l))).toBe(true);
   });
 
+  it('рабочий процесс студии перезапускается в шаге рестарта, после API, а не в сборке', () => {
+    const { log } = runDeployBackend(['0']);
+    const restart = log[indexOf(log, RESTART)];
+    expect(restart).toMatch(/\[ -f studio\/\.env \].*cd studio\s+pm2 startOrReload ecosystem\.config\.cjs > \/tmp\/studio-pm2\.log/);
+    expect(restart.indexOf('pm2 restart linkeon-api')).toBeLessThan(restart.indexOf('cd studio'));
+    expect(log[indexOf(log, BUILD)]).not.toMatch(/studio-pm2/);
+  });
+
   it('голосовой воркер перезапускается в шаге рестарта, а не в сборке', () => {
     const { log } = runDeployBackend(['0']);
     expect(log[indexOf(log, RESTART)]).toMatch(/pm2 startOrReload ecosystem\.config\.cjs/);
```

- [x] **Step 2: Красный на ноде**

Run (нода, CI-воркдерево на `831ee04`): `npx jest tests/scripts` и `cd studio && npx tsx --test src/worker/ecosystem.test.ts`
Получено: jest — 7 failed, 17 passed; студия — `# fail 2`.

- [x] **Step 3: Реализация (`8752153`)**

```diff
diff --git a/scripts/deploy.sh b/scripts/deploy.sh
index a6500ef..664cb6f 100755
--- a/scripts/deploy.sh
+++ b/scripts/deploy.sh
@@ -324,6 +324,17 @@ rollback_backend() {
         || { tail -20 /tmp/vh-pm2.log; echo 'voice-host: pm2 startOrReload FAILED'; exit 1; }
       cd ..
     fi
+    # Студия роликов — как в back_build_cmds и шаге рестарта: прежний код, его браузеры, процесс.
+    if [ -d studio ] && [ -f studio/.env ]; then
+      cd studio
+      npm ci --no-audit --no-fund > /tmp/studio-install.log 2>&1 \
+        || { tail -20 /tmp/studio-install.log; echo 'studio: npm ci FAILED'; exit 1; }
+      npx playwright install chromium > /tmp/studio-browsers.log 2>&1 \
+        || { tail -20 /tmp/studio-browsers.log; echo 'studio: браузеры не установились'; exit 1; }
+      pm2 startOrReload ecosystem.config.cjs > /tmp/studio-pm2.log 2>&1 \
+        || { tail -20 /tmp/studio-pm2.log; echo 'studio: pm2 startOrReload FAILED'; exit 1; }
+      cd ..
+    fi
   " && green "  ↩ backend rolled back ($ENV_NAME)" \
     || { red "  ✗ ROLLBACK BACKEND FAILED — $ENV_NAME needs manual intervention"; return 1; }
 }
@@ -664,6 +675,25 @@ back_build_cmds() {
     elif [ -d voice-host ]; then
       echo 'voice-host: .env отсутствует — LiveKit не настроен, воркер пропущен'
     fi
+    # Студия роликов: свой package.json, сборки нет (tsx), но нужны браузеры —
+    # съёмки (Playwright) и сборки ролика (Remotion). Ставим здесь, а не при первом
+    # ролике: недоехавший браузер должен ронять выкат, а не съёмку на проде.
+    # Признак настроенности — studio/.env: его кладут руками вместе с ключами.
+    if [ -d studio ] && [ -f studio/.env ]; then
+      cd studio
+      if [ -n "${CI_SAME_AS:-}" ] && git diff --quiet "$CI_SAME_AS" HEAD -- package-lock.json; then
+        echo 'studio: npm ci пропущен: package-lock.json тот же'
+      else
+        npm ci --no-audit --no-fund > /tmp/studio-install.log 2>&1 \
+          || { tail -20 /tmp/studio-install.log; echo 'studio: npm ci FAILED'; exit 1; }
+      fi
+      { npx playwright install chromium \
+          && node --input-type=module -e 'import { ensureBrowser } from "@remotion/renderer"; await ensureBrowser();'; } > /tmp/studio-browsers.log 2>&1 \
+        || { tail -20 /tmp/studio-browsers.log; echo 'studio: браузеры не установились'; exit 1; }
+      cd ..
+    elif [ -d studio ]; then
+      echo 'studio: .env отсутствует — студия не настроена, рабочий процесс пропущен'
+    fi
 CMDS
 }
 
@@ -774,6 +804,14 @@ deploy_backend() {
         || { tail -20 /tmp/vh-pm2.log; echo 'voice-host: pm2 startOrReload FAILED'; exit 1; }
       cd ..
     fi
+    # Студия: SIGINT — рабочий процесс доводит текущее задание (до kill_timeout,
+    # 10 минут), чат не трогает. Съёмку как живой ход уже дождался wait_for_streams_drain.
+    if [ -d studio ] && [ -f studio/.env ]; then
+      cd studio
+      pm2 startOrReload ecosystem.config.cjs > /tmp/studio-pm2.log 2>&1 \
+        || { tail -20 /tmp/studio-pm2.log; echo 'studio: pm2 startOrReload FAILED'; exit 1; }
+      cd ..
+    fi
   " || { red "  backend restart failed ($ENV_NAME)"; exit 1; }
 
   bold "[back 3/3] health-wait"
```

- [x] **Step 4: Зелёный на ноде**

Получено на `8752153`: jest `tests/scripts` — 24 passed; `ecosystem.test.ts` — 2 pass; студия целиком — 224 pass, `TSC_OK`.

---

### Task 3: README студии

- [x] Раздел «Под PM2: стенд и прод» в `studio/README.md` (`995c49d`): процесс, условия выката, состав `studio/.env` сервера, `pm2 save`, Node 20.

- [x] **Проверка под Node 20** (прод — v20.20.2), до плана, на ноде: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH` → `npm test` 222/222, `typecheck`, живая очередь `test:db` 15/15, обе фикстуры сборки — pass.

---

### Task 4: Ревью ветки

- [ ] **Step 1:** Субагент `superpowers:code-reviewer` (opus) на `6e25b12..HEAD` ветки `feat/shorts-prod`. Главный вопрос: может ли выкат с этим блоком уронить API или прод (падение сборки студии, зависание `pm2 startOrReload`, откат), и запустится ли `linkeon-studio` на сервере (пути, `nice`, cwd, `.env`). Critical и Important — тест → правка → прогон → коммит.

---

### Task 5 (OK): Слияние в main и студия на стенде

- [ ] **Step 1: Слияние** — в свежем клоне (как задача 17 плана 4): `git clone --branch main`, `git merge --no-ff origin/feat/shorts-prod`, прогон итога на ноде (`npx jest tests/scripts src/shorts`, гейт типов, `npm run build`, студия `npm test`), перемотка `main` только при `merge-base --is-ancestor origin/main HEAD`.

- [ ] **Step 2: `studio/.env` стенда** — копия окружения студии из CI-воркдерева (значения стенда те же), права 600:

```bash
ssh dv@85.192.61.231 'test -f ~/spirits_back/studio/.env || install -m 600 ~/ci/wt/promo-shorts/studio/.env ~/spirits_back/studio/.env; grep -oE "^[A-Z_]+=" ~/spirits_back/studio/.env | sort | tr "\n" " "'
```

Expected: имена `ADMIN_PHONE API_URL CABINET_BASIC_AUTH CABINET_URL DATABASE_URL DEBUG_SECRET DEMO_PHONE GOOGLE_AI_API_KEY MINIO_* YANDEX_*`.

- [ ] **Step 3: Выкат на стенд** — `TEST_ONLY=1 BACK_ONLY=1` из свежих клонов на ноде (`~/deploy-clones/<имя>/{spirits_back,spirits_front}`, `test-server.env.local` и `tests/node_modules` из `~/dev/spirits_back`, `source ~/.nvm/nvm.sh`, `setsid -f` с pid-файлом, лог в `~/deploy-logs/`). Expected: в логе `studio:` без `FAILED`, `ALL PHASES GREEN`.

- [ ] **Step 4: Процесс на стенде**

```bash
ssh dv@85.192.61.231 'source ~/.nvm/nvm.sh >/dev/null; pm2 describe linkeon-studio | grep -E "status|script path|exec cwd"; ps -o ni=,args= -C node | grep worker.ts; pm2 logs linkeon-studio --lines 5 --nostream; pm2 save'
```

Expected: `online`, `nice` 19, в логе `worker: старт`.

- [ ] **Step 5: Ролик через процесс PM2** — формат «Только чат» на время прогона (без трат Google): `update_settings format=chat` → `order` → `start_now` → без ручного `worker --once` ролик доходит до `pending_review` → формат обратно `skit`. Затем `pm2 restart linkeon-studio` в простое — в логе `worker: SIGINT — закончу текущее задание и выйду` и новый `worker: старт`. Ручной `worker --once` из `~/ci/wt` на стенде больше не нужен.

---

### Task 6 (OK): Прод — окружение, настройки, выкат

- [ ] **Step 1: `studio/.env` прода** — на сервере, значения из `~/spirits_back/.env` прода, без вывода:

```bash
ssh dvolkov@212.113.106.202 'set -e; f=~/spirits_back/studio/.env; test ! -f $f; umask 077; { grep -E "^(DATABASE_URL|MINIO_ENDPOINT|MINIO_ACCESS_KEY|MINIO_SECRET_KEY|MINIO_BUCKET_VIDEOS|YANDEX_SPEECHKIT_API_KEY|YANDEX_TTS_FOLDER_ID|GOOGLE_AI_API_KEY|DEBUG_SECRET)=" ~/spirits_back/.env; echo CABINET_URL=https://my.linkeon.io; echo API_URL=https://my.linkeon.io; echo DEMO_PHONE=<демо-номер>; echo ADMIN_PHONE=<номер админа>; } > $f; grep -oE "^[A-Z_]+=" $f | sort | tr "\n" " "'
```

- [ ] **Step 2: Канал** — до включения модуля, как велит спека:

```bash
ssh dvolkov@212.113.106.202 'set -a; . ~/spirits_back/.env >/dev/null 2>&1; set +a; psql "$DATABASE_URL" -Atc "UPDATE short_settings SET tg_channel_chat_id = '"'"'-1003046204962'"'"', updated_at = now() WHERE id = 1 RETURNING tg_channel_chat_id, platforms"'
```

- [ ] **Step 3: Переменные модуля** — копия `.env` вне каталога приложения, строки дописываются, только если их нет:

```bash
ssh dvolkov@212.113.106.202 'set -e; cp ~/spirits_back/.env ~/env-spirits_back.bak-$(date +%Y%m%d%H%M); grep -q "^SHORTS_ENABLED=" ~/spirits_back/.env || printf "\nSHORTS_ENABLED=true\nSHORTS_AUTO_TOPICS=false\n" >> ~/spirits_back/.env; grep -E "^SHORTS_" ~/spirits_back/.env'
```

API прочтёт их при рестарте, который сделает выкат.

- [ ] **Step 4: Выкат** — `deploy.sh` из свежих клонов на ноде, `BACK_ONLY=1 SKIP_BOTS=1` (меняется только бэкенд; машина ботов с ноды не катится), отвязанно, с логом. Перед ним — `git log --oneline origin/main..origin/b2b` (ожидаемо три коммита «штурмана») и нет ли чужих выкатов (`pgrep -f '^bash scripts/deploy.sh'`). Expected: обе фазы зелёные.

- [ ] **Step 5: Проверка прода**

```bash
ssh dvolkov@212.113.106.202 'export PATH=$HOME/.npm-global/bin:$PATH; git -C ~/spirits_back log --oneline -1; grep -h "shorts migration" ~/.pm2/logs/linkeon-api-out*.log | tail -2; pm2 describe linkeon-studio | grep -E "status|exec cwd"; pm2 logs linkeon-studio --lines 5 --nostream; pm2 save'
```

Expected: коммит слияния, `002_skits.sql applied`, `linkeon-studio` `online`, `worker: старт`.

- [ ] **Step 6: Предел на первый ролик** — `cd ~/spirits_back/studio && npx tsx scripts/stand-admin.ts update_settings settings:='{"maxOmniSeconds":16}'` (на проде, API на 127.0.0.1:3001). Expected: `format: skit`, `maxOmniSeconds: 16`, `tgChannelChatId: -1003046204962`.

---

### Task 7 (OK): Первый ролик на проде — с владельцем

- [ ] **Step 1:** Тему выбирает владелец (или берётся из каталога). `order` → `start_now` через `stand-admin.ts` на проде. Ролик идёт сам: режиссёр и сценарист — API, съёмка, оживление и сборка — `linkeon-studio`. Следить за `status`, `last_error`, `animation` (psql по `short_video`).
- [ ] **Step 2:** Владелец получает ролик в личку (без пометки «СТЕНД»), одобряет. `publish_now` → пост в @ainomira, набор для YouTube владельцу; ссылку на ролик канала @Linkeons владелец отдаёт кнопкой.
- [ ] **Step 3:** Демо-аккаунт: создан первым входом, баланс (стартовые 25 000 токенов, съёмка ≈ 2 000); алерт роста стоимости на него не сработал; предел Omni — обратно 48.

---

### Task 8 (OK): Расписание

- [ ] После 1–2 одобренных роликов — `SHORTS_AUTO_TOPICS=true` в `.env` прода и рестарт API без обрыва живых ходов (`/webhook/chat/active-streams` = 0, затем `pm2 restart linkeon-api --update-env`) или ближайшим выкатом. Темы набираются в воскресенье, ролики готовятся к слотам вт/чт/сб 18:00 МСК, владелец одобряет кнопками.

---

### Task 9: Итоги

- [ ] Раздел «Что уточнил выкат (план 5)» в спеке роликов, заметка памяти `project_promo_shorts_studio.md`, рабочее состояние `promo-shorts`.
