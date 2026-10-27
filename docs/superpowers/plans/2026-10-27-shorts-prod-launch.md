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

### Task 1: Процесс PM2 студии и остановка без брошенного задания

**Files:** Create `studio/ecosystem.config.cjs`, `studio/src/worker/stop.ts`, `studio/src/worker/ecosystem.test.ts`, `studio/src/worker/stop.test.ts`; Modify `studio/src/worker/worker.ts`, `studio/package.json` (список тестов: `src/worker/ecosystem.test.ts src/worker/stop.test.ts` после `src/worker/animate-money.test.ts`).

- [x] **Step 1: Тесты (красные: `831ee04`, после ревью — `f071bfc`)**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchStop } from './stop';

test('pm2 шлёт сообщение shutdown — остановка после текущего задания, одна строка в журнале', () => {
  const proc = new EventEmitter();
  const lines: string[] = [];
  const stopping = watchStop(proc, (l) => lines.push(l));
  assert.equal(stopping(), false);
  proc.emit('message', { type: 'other' });
  proc.emit('message', 'ping');
  assert.equal(stopping(), false);
  proc.emit('message', 'shutdown');
  proc.emit('message', 'shutdown');
  assert.equal(stopping(), true);
  assert.deepEqual(lines, ['worker: pm2 shutdown — закончу текущее задание и выйду']);
});

test('ручной запуск: SIGINT и SIGTERM — тоже остановка', () => {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const proc = new EventEmitter();
    const lines: string[] = [];
    const stopping = watchStop(proc, (l) => lines.push(l));
    proc.emit(sig);
    assert.equal(stopping(), true);
    assert.deepEqual(lines, [`worker: ${sig} — закончу текущее задание и выйду`]);
  }
});
```

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const apps = () => createRequire(import.meta.url)(path.join(STUDIO, 'ecosystem.config.cjs')).apps;

test('pm2: linkeon-studio — один рабочий процесс студии с низким приоритетом, циклом', () => {
  assert.equal(apps().length, 1);
  const a = apps()[0];
  assert.deepEqual([a.name, a.cwd, a.exec_mode, a.instances], ['linkeon-studio', STUDIO, 'fork', 1]);
  // nice 19: съёмка и сборка грузят процессор, а API и чат на том же сервере важнее.
  // node --import tsx, а не обёртка tsx: pm2 меряет и останавливает сам рабочий процесс.
  assert.deepEqual([a.script, a.interpreter], ['/usr/bin/nice', 'none']);
  assert.deepEqual(a.args, ['-n', '19', 'node', '--import', 'tsx', 'src/worker/worker.ts']);
  assert.ok(fs.existsSync(path.join(STUDIO, 'src/worker/worker.ts')));
});

test('pm2: остановка — сообщением shutdown и без рассылки сигналов Chromium и ffmpeg', () => {
  const a = apps()[0];
  // SIGINT ловят Playwright и Remotion: убивают браузер и выходят сами — задание брошено.
  assert.equal(a.shutdown_with_message, true);
  assert.equal(a.treekill, false);
  assert.ok(a.kill_timeout >= 600_000, `kill_timeout ${a.kill_timeout}`);
  // Падение на старте (нет ключа, нет базы) — не чаще раза в минуту, а не цикл перезапусков.
  assert.ok(a.restart_delay >= 60_000, `restart_delay ${a.restart_delay}`);
  // Сообщение shutdown разбирает watchStop (stop.ts, свой тест); рабочий процесс на нём и держит цикл.
  const worker = fs.readFileSync(path.join(STUDIO, 'src/worker/worker.ts'), 'utf8');
  assert.match(worker, /const stopping = watchStop\(process, log\);/);
  assert.match(worker, /while \(!stopping\(\)\)/);
});
```

- [x] **Step 2: Реализация (`8752153`, после ревью — `8eea65f`)**

`studio/src/worker/stop.ts`:

```ts
import type { EventEmitter } from 'node:events';

/**
 * Остановка рабочего процесса: дождаться текущего задания и выйти.
 *
 * Под PM2 — сообщением 'shutdown' (shutdown_with_message в ecosystem.config.cjs),
 * а не сигналом: SIGINT ловят Playwright и Remotion — убивают браузер и выходят
 * сами (process.exit(130)), и задание бросалось посреди съёмки или сборки
 * (проверено на ноде 27.10.2026). Сигналы — для ручных запусков.
 * @returns «пора выходить» — проверять между заданиями
 */
export function watchStop(proc: Pick<EventEmitter, 'on'>, log: (line: string) => void): () => boolean {
  let stopping = false;
  const stop = (why: string): void => {
    if (stopping) return;
    stopping = true;
    log(`worker: ${why} — закончу текущее задание и выйду`);
  };
  for (const sig of ['SIGTERM', 'SIGINT'] as const) proc.on(sig, () => stop(sig));
  proc.on('message', (m: unknown) => {
    if (m === 'shutdown') stop('pm2 shutdown');
  });
  return () => stopping;
}
```

`studio/src/worker/worker.ts` — вместо своего цикла сигналов `const stopping = watchStop(process, log);` и `while (!stopping()) {`, импорт `import { watchStop } from './stop';`.

`studio/ecosystem.config.cjs`:

```js
// studio/ecosystem.config.cjs — PM2: рабочий процесс студии роликов (linkeon-studio).
// Расширение .cjs обязательно: в studio/package.json стоит "type":"module",
// и .js здесь читался бы как ESM без module.exports (как у voice-host).
// Ставит и перезапускает deploy.sh, только если рядом есть studio/.env.
module.exports = {
  apps: [
    {
      name: 'linkeon-studio',
      cwd: __dirname,
      // nice 19: съёмка (Chromium) и сборка (Remotion, ffmpeg) грузят процессор,
      // а API и чат на том же сервере важнее. node --import tsx, а не обёртка
      // tsx: pm2 видит сам рабочий процесс — его память и его выход.
      script: '/usr/bin/nice',
      args: ['-n', '19', 'node', '--import', 'tsx', 'src/worker/worker.ts'],
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Падение на старте (нет ключа Google, база недоступна) — не чаще раза в минуту.
      restart_delay: 60000,
      max_memory_restart: '2G',
      // Остановка — сообщением 'shutdown' (stop.ts): SIGINT ловят Playwright и
      // Remotion, убивают браузер и выходят сами — задание бросалось бы. Сигналы
      // детям (Chromium, ffmpeg, esbuild) тоже не рассылаются: они доводят работу.
      shutdown_with_message: true,
      treekill: false,
      // Задание — обычно 1–5 минут; дольше pm2 добьёт процесс, задание вернётся в
      // очередь по истечении аренды, оплаченное не потеряется (animation в базе).
      kill_timeout: 600000,
    },
  ],
};
```

---

### Task 2: Студия в `deploy.sh`

**Files:** Modify `scripts/deploy.sh` (новые `studio_build_cmds` и `studio_restart_cmds`; `back_build_cmds` зовёт первую; сборка в `deploy_backend` запоминает работающий коммит `STUDIO_SAME_AS`; шаг `[back 3.5/3]` после health-wait; `rollback_backend` — обе функции после API); Create `tests/scripts/deploy-studio.test.js`; Modify `tests/scripts/deploy-restart-gate.test.js`.

- [x] **Step 1: Тесты (красные: `831ee04`, после ревью — `f071bfc`, `8f7b87d`)** — блоки студии выполняются по-настоящему в bash на заглушках npm/node/git/pm2/playwright, откат — настоящей `rollback_backend`:

```js
/**
 * deploy.sh: студия роликов (studio/) — свой package.json, без сборки (tsx),
 * браузеры съёмки (Playwright) и сборки (Remotion), процесс pm2 linkeon-studio.
 *
 * Команды выполняются по-настоящему — в каталоге, похожем на сервер, а npm,
 * node, git, pm2 и локальный playwright подменены заглушками, которые пишут
 * журнал вызовов с каталогом, где их позвали. Логи шагов — в $TMPDIR теста.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEPLOY = path.join(__dirname, '..', '..', 'scripts', 'deploy.sh');
const SHA = 'a'.repeat(40);

/** Тело функции скрипта: от `имя() {` до первой `}` в начале строки. */
function scriptFunction(name) {
  const lines = fs.readFileSync(DEPLOY, 'utf8').split('\n');
  const start = lines.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`в deploy.sh нет функции ${name}`);
  const end = lines.indexOf('}', start);
  return lines.slice(start, end + 1).join('\n');
}

// FAIL_ON — подстрока вызова вместе с каталогом: «npm(studio) ci» роняет только npm ci студии.
const STUB = (name) => `#!/usr/bin/env bash
echo "${name}($(basename "$PWD")) $*" >> "$WORK/log"
if [ -n "$FAIL_ON" ]; then
  case "${name}($(basename "$PWD")) $*" in *"$FAIL_ON"*) exit 1 ;; esac
fi
exit 0
`;

/**
 * «Сервер»: корень бэкенда back/ со studio/. studio: 'env' — с .env; config —
 * есть ecosystem.config.cjs; deps — уже стоят node_modules/.bin/{tsx,playwright}.
 * npm ci студии ставит их (как настоящий). git diff --quiet — «без изменений» при LOCK_SAME=1.
 */
function server({ studio = 'env', config = true, deps = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-studio-'));
  const root = path.join(work, 'back');
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(work, 'tmp'));
  fs.mkdirSync(root);
  const st = path.join(root, 'studio');
  if (studio) fs.mkdirSync(st);
  if (studio === 'env') fs.writeFileSync(path.join(st, '.env'), 'X=1\n');
  if (studio && config) fs.writeFileSync(path.join(st, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  const localBins = () => {
    fs.mkdirSync(path.join(st, 'node_modules', '.bin'), { recursive: true });
    for (const b of ['tsx', 'playwright']) fs.writeFileSync(path.join(st, 'node_modules', '.bin', b), STUB(b), { mode: 0o755 });
  };
  if (studio && deps) localBins();
  for (const name of ['node', 'pm2', 'npx']) fs.writeFileSync(path.join(bin, name), STUB(name), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), `${STUB('npm').replace(/exit 0\n$/, '')}
if [ "$(basename "$PWD")" = studio ] && [ "$1" = ci ]; then
  mkdir -p node_modules/.bin
  for b in tsx playwright; do cp "$WORK/bin/.stub-$b" "node_modules/.bin/$b"; chmod +x "node_modules/.bin/$b"; done
fi
exit 0
`, { mode: 0o755 });
  for (const b of ['tsx', 'playwright']) fs.writeFileSync(path.join(bin, `.stub-${b}`), STUB(b), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
echo "git($(basename "$PWD")) $*" >> "$WORK/log"
[ "$1" = rev-parse ] && { echo ${SHA}; exit 0; }
[ "$1" = diff ] && [ "$LOCK_SAME" = 1 ] && exit 0
[ "$1" = diff ] && exit 1
exit 0
`, { mode: 0o755 });
  return { work, root, bin };
}

function run(srv, body, env = {}) {
  const harness = path.join(srv.work, 'harness.sh');
  fs.writeFileSync(harness, body);
  const res = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: { PATH: `${srv.bin}:${process.env.PATH}`, WORK: srv.work, TMPDIR: path.join(srv.work, 'tmp'), FAIL_ON: '', LOCK_SAME: '', ...env },
  });
  const log = fs.existsSync(path.join(srv.work, 'log')) ? fs.readFileSync(path.join(srv.work, 'log'), 'utf8').split('\n').filter(Boolean) : [];
  const tmpUsed = fs.readdirSync(path.join(srv.work, 'tmp'));
  fs.rmSync(srv.work, { recursive: true, force: true });
  return { status: res.status, out: `${res.stdout}${res.stderr}`, log, tmpUsed };
}

/** Команды функции-генератора (back_build_cmds, studio_restart_cmds) — как их выполнит сервер. */
function runCmds(fn, opts = {}, env = {}) {
  const srv = server(opts);
  const fns = ['studio_build_cmds', 'studio_restart_cmds', 'back_build_cmds'].map(scriptFunction).join('\n');
  const r = run(srv, [
    fns,
    `cmds=$(${fn})`,
    'printf "%s" "$cmds" > "$WORK/cmds.sh"',
    'bash -n "$WORK/cmds.sh" || { echo SYNTAX_ERROR; exit 99; }',
    `cd ${JSON.stringify(srv.root)}`,
    'set -eo pipefail',
    'eval "$cmds"',
  ].join('\n'), env);
  return r;
}

const inStudio = (log) => log.filter((l) => /^\w+\(studio\) /.test(l));
const PLAYWRIGHT = 'playwright(studio) install --only-shell chromium';
const ENSURE = /^node\(studio\) --input-type=module -e .*ensureBrowser/;

describe('deploy.sh: студия роликов в сборке бэкенда', () => {
  it('studio/.env и конфиг pm2 есть, зависимостей нет — npm ci студии, затем браузеры локальным playwright', () => {
    const r = runCmds('back_build_cmds');
    expect(r.status).toBe(0);
    expect(inStudio(r.log)).toEqual(['npm(studio) ci --no-audit --no-fund', PLAYWRIGHT, expect.stringMatching(ENSURE)]);
    // npx не зовётся: без локального пакета он молча поставил бы последнюю версию playwright.
    expect(r.log.some((l) => l.startsWith('npx('))).toBe(false);
    // Логи шагов — в $TMPDIR, не в общий /tmp сервера.
    expect(r.tmpUsed).toEqual(expect.arrayContaining(['studio-install.log', 'studio-browsers.log']));
  });

  it('studio/.env нет — студия не настроена: ни npm ci, ни браузеров, сообщение', () => {
    const r = runCmds('back_build_cmds', { studio: 'dir' });
    expect(r.status).toBe(0);
    expect(inStudio(r.log)).toEqual([]);
    expect(r.out).toMatch(/studio: \.env отсутствует — студия не настроена, рабочий процесс пропущен/);
  });

  it('каталога studio/ нет (старый коммит) — молча мимо', () => {
    const r = runCmds('back_build_cmds', { studio: null });
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/studio/);
  });

  it('studio/.env есть, а конфига pm2 в коммите нет (план 2) — ни npm ci, ни браузеров, сообщение', () => {
    const r = runCmds('back_build_cmds', { config: false });
    expect(r.status).toBe(0);
    expect(inStudio(r.log)).toEqual([]);
    expect(r.out).toMatch(/studio: в этом коммите нет studio\/ecosystem\.config\.cjs/);
  });

  it('lock-файл студии тот же, что у работающего коммита, и зависимости стоят — npm ci пропущен, браузеры проверяются', () => {
    for (const env of [{ STUDIO_SAME_AS: SHA }, { CI_SAME_AS: SHA }]) {
      const r = runCmds('back_build_cmds', { deps: true }, { LOCK_SAME: '1', ...env });
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/studio: npm ci пропущен: package-lock\.json тот же/);
      expect(inStudio(r.log)).toEqual([expect.stringMatching(/^git\(studio\) diff --quiet a+ HEAD -- package-lock\.json$/), PLAYWRIGHT, expect.stringMatching(ENSURE)]);
    }
  });

  it('lock-файл тот же, но зависимостей нет (первый выкат на сервер) — npm ci всё равно', () => {
    const r = runCmds('back_build_cmds', { deps: false }, { LOCK_SAME: '1', STUDIO_SAME_AS: SHA });
    expect(r.status).toBe(0);
    expect(inStudio(r.log)).toContain('npm(studio) ci --no-audit --no-fund');
  });

  it('lock-файл изменился — npm ci', () => {
    const r = runCmds('back_build_cmds', { deps: true }, { STUDIO_SAME_AS: SHA });
    expect(inStudio(r.log)).toContain('npm(studio) ci --no-audit --no-fund');
  });

  it('npm ci студии упал — сборка падает с понятной строкой, браузеры не ставятся', () => {
    const r = runCmds('back_build_cmds', {}, { FAIL_ON: 'npm(studio) ci' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/studio: npm ci FAILED/);
    expect(inStudio(r.log).some((l) => /playwright/.test(l))).toBe(false);
  });

  it('браузеры не встали — сборка падает: иначе первая же съёмка упала бы на проде', () => {
    for (const fail of ['playwright(studio) install', 'node(studio) --input-type=module']) {
      const r = runCmds('back_build_cmds', {}, { FAIL_ON: fail });
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/studio: браузеры не установились/);
    }
  });
});

describe('deploy.sh: перезапуск рабочего процесса студии', () => {
  it('конфиг есть — pm2 startOrReload из studio/', () => {
    const r = runCmds('studio_restart_cmds');
    expect(r.status).toBe(0);
    expect(r.log.filter((l) => l.startsWith('pm2('))).toEqual(['pm2(studio) startOrReload ecosystem.config.cjs']);
  });

  it('конфига в коммите нет — процесс останавливается и удаляется: не крутить новый код поверх старого дерева', () => {
    const r = runCmds('studio_restart_cmds', { config: false });
    expect(r.status).toBe(0);
    expect(r.log.filter((l) => l.startsWith('pm2('))).toEqual(['pm2(back) delete linkeon-studio']);
    expect(r.out).toMatch(/studio: в этом коммите нет studio\/ecosystem\.config\.cjs — рабочий процесс остановлен/);
  });

  it('студия не настроена — pm2 не трогается', () => {
    for (const opts of [{ studio: 'dir' }, { studio: null }]) {
      expect(runCmds('studio_restart_cmds', opts).log.filter((l) => l.startsWith('pm2('))).toEqual([]);
    }
  });

  it('startOrReload упал — выход не ноль с понятной строкой', () => {
    const r = runCmds('studio_restart_cmds', {}, { FAIL_ON: 'pm2(studio) startOrReload' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/studio: pm2 startOrReload FAILED/);
  });
});

describe('deploy.sh: студия в откате прода', () => {
  /** Настоящая rollback_backend; ssh_remote выполняет строку здесь же, в «сервере». */
  function rollback(opts, env = {}) {
    const srv = server(opts);
    const fns = ['studio_build_cmds', 'studio_restart_cmds', 'rollback_backend'].map(scriptFunction).join('\n');
    return run(srv, [
      'red() { echo "RED: $1"; }; green() { echo "GREEN: $1"; }',
      'ssh_remote() { bash -c "$*"; }',
      fns,
      `BACK_PATH=${JSON.stringify(srv.root)}; PRE_BACK_SHA=${SHA}; ENV_NAME=prod`,
      'rollback_backend',
    ].join('\n'), env);
  }

  it('откат на коммит с конфигом — npm ci студии по lock-файлу, браузеры и startOrReload после API', () => {
    const r = rollback({ deps: true }, { LOCK_SAME: '1' });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/GREEN: .*backend rolled back/);
    expect(r.out).toMatch(/studio: npm ci пропущен/);
    const pm2 = r.log.filter((l) => l.startsWith('pm2('));
    expect(pm2[0]).toMatch(/^pm2\(back\) restart linkeon-api/);
    expect(pm2[pm2.length - 1]).toBe('pm2(studio) startOrReload ecosystem.config.cjs');
    expect(inStudio(r.log)).toContain(PLAYWRIGHT);
  });

  it('откат на коммит без конфига (прод сейчас на таком) — студия остановлена, откат API не объявлен проваленным', () => {
    const r = rollback({ config: false });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/GREEN: .*backend rolled back/);
    expect(r.out).not.toMatch(/ROLLBACK BACKEND FAILED/);
    expect(r.log).toContain('pm2(back) delete linkeon-studio');
    expect(inStudio(r.log)).toEqual([]);
  });
});
```

В `tests/scripts/deploy-restart-gate.test.js`:

```diff
diff --git a/tests/scripts/deploy-restart-gate.test.js b/tests/scripts/deploy-restart-gate.test.js
index 5f7643a..bff5bab 100644
--- a/tests/scripts/deploy-restart-gate.test.js
+++ b/tests/scripts/deploy-restart-gate.test.js
@@ -69,6 +69,7 @@ ssh_remote() {
     *"seq 1"*) echo "OK 1" ;;
     *"git reset --hard origin/"*) [ -n "$BUILD_FAILS" ] && return 1 ;;
     *"git cat-file -e origin/"*"src/chat/relay-auth.ts"*) [ -n "$NO_RELAY_AUTH" ] && return 1 ;;
+    *"cd studio"*"startOrReload"*) [ -n "$STUDIO_FAILS" ] && return 1 ;;
   esac
   return 0
 }
@@ -103,6 +104,7 @@ function runDeployBackend(streams, env = {}) {
       NO_SHA: '',
       BUILD_FAILS: '',
       NO_RELAY_AUTH: '',
+      STUDIO_FAILS: '',
       ...env,
     },
   });
@@ -189,6 +191,37 @@ describe('deploy.sh: живые ходы проверяются прямо пе
     expect(polls.some((l) => /^CALLS: /.test(l))).toBe(true);
   });
 
+  it('рабочий процесс студии — отдельным вызовом после проверки здоровья API: не в рестарте и не в сборке', () => {
+    // В одном вызове с рестартом API ожидание задания студии (до 10 минут) держало бы
+    // health-wait и smoke, а повтор ssh после обрыва перезапустил бы API второй раз.
+    const { status, log } = runDeployBackend(['0']);
+    expect(status).toBe(0);
+    const restart = indexOf(log, RESTART);
+    const health = indexOf(log, /^SSH: .*seq 1/, restart);
+    const studio = indexOf(log, /^SSH: .*cd studio\s+pm2 startOrReload ecosystem\.config\.cjs/);
+    expect(log[restart]).not.toMatch(/studio/);
+    expect(health).toBeGreaterThan(restart);
+    expect(studio).toBeGreaterThan(health);
+    expect(log[studio]).not.toMatch(/linkeon-api/);
+    expect(log[indexOf(log, BUILD)]).not.toMatch(/startOrReload/);
+  });
+
+  it('студия не перезапустилась: на стенде — выход 1 (прод не трогается), на проде — предупреждение, выкат идёт дальше', () => {
+    const test = runDeployBackend(['0'], { STUDIO_FAILS: '1', ENV_NAME: 'test' });
+    expect(test.status).toBe(1);
+    expect(test.log.join('\n')).toMatch(/студии не перезапустился — прод не трогаю/);
+    const prod = runDeployBackend(['0'], { STUDIO_FAILS: '1' });
+    expect(prod.status).toBe(0);
+    expect(prod.log.join('\n')).toMatch(/студии не перезапустился — API выкачен, студию смотреть руками/);
+  });
+
+  it('сборка запоминает работающий коммит до git reset — по нему студия решает, нужен ли npm ci', () => {
+    const { log } = runDeployBackend(['0']);
+    const build = log[indexOf(log, BUILD)];
+    expect(build).toMatch(/STUDIO_SAME_AS=\$\(git rev-parse HEAD\)/);
+    expect(build.indexOf('STUDIO_SAME_AS=')).toBeLessThan(build.indexOf('git reset --hard origin/'));
+  });
+
   it('голосовой воркер перезапускается в шаге рестарта, а не в сборке', () => {
     const { log } = runDeployBackend(['0']);
     expect(log[indexOf(log, RESTART)]).toMatch(/pm2 startOrReload ecosystem\.config\.cjs/);
```

- [x] **Step 2: Красный на ноде** — `f071bfc`: jest `tests/scripts` 17 failed, студия `# fail 3`; `8f7b87d`: 18 failed.

- [x] **Step 3: Реализация (`8752153`, после ревью — `8eea65f`)**

```diff
diff --git a/scripts/deploy.sh b/scripts/deploy.sh
index a6500ef..0799bec 100755
--- a/scripts/deploy.sh
+++ b/scripts/deploy.sh
@@ -300,6 +300,7 @@ rollback_backend() {
   ssh_remote "
     set -eo pipefail
     cd $BACK_PATH
+    STUDIO_SAME_AS=\$(git rev-parse HEAD)
     git reset --hard $PRE_BACK_SHA
     npm ci --no-audit --no-fund 2>&1 | tail -3
     npm run build 2>&1 | tail -3
@@ -324,6 +325,9 @@ rollback_backend() {
         || { tail -20 /tmp/vh-pm2.log; echo 'voice-host: pm2 startOrReload FAILED'; exit 1; }
       cd ..
     fi
+    # Студия роликов — последней, после API: прежний код, его зависимости и браузеры, процесс.
+    $(studio_build_cmds)
+    $(studio_restart_cmds)
   " && green "  ↩ backend rolled back ($ENV_NAME)" \
     || { red "  ✗ ROLLBACK BACKEND FAILED — $ENV_NAME needs manual intervention"; return 1; }
 }
@@ -664,6 +668,64 @@ back_build_cmds() {
     elif [ -d voice-host ]; then
       echo 'voice-host: .env отсутствует — LiveKit не настроен, воркер пропущен'
     fi
+CMDS
+  studio_build_cmds
+}
+
+# Студия роликов (studio/): свой package.json, сборки нет (tsx), но нужны браузеры —
+# съёмки (Playwright) и сборки ролика (Remotion). Ставим в сборке, а не при первом
+# ролике: недоехавший браузер должен ронять выкат, а не съёмку на проде. Признак
+# настроенности — studio/.env (кладут руками вместе с ключами); коммит без
+# studio/ecosystem.config.cjs (план 2) студию не ставит — её процесс остановит
+# studio_restart_cmds. Зовётся из back_build_cmds (выкат и возврат сборки) и из отката.
+#
+# STUDIO_SAME_AS (или CI_SAME_AS возврата) — работающий коммит: npm ci сносит
+# node_modules под работающим процессом вместе с браузером Remotion
+# (node_modules/.remotion), поэтому он идёт, только если lock-файл студии сменился
+# или зависимостей ещё нет (первый выкат на сервер).
+studio_build_cmds() {
+  cat <<'CMDS'
+    if [ -d studio ] && [ -f studio/.env ] && [ -f studio/ecosystem.config.cjs ]; then
+      cd studio
+      studio_same="${STUDIO_SAME_AS:-${CI_SAME_AS:-}}"
+      if [ -n "$studio_same" ] && git diff --quiet "$studio_same" HEAD -- package-lock.json && [ -x node_modules/.bin/tsx ]; then
+        echo 'studio: npm ci пропущен: package-lock.json тот же'
+      else
+        npm ci --no-audit --no-fund > "${TMPDIR:-/tmp}/studio-install.log" 2>&1 \
+          || { tail -20 "${TMPDIR:-/tmp}/studio-install.log"; echo 'studio: npm ci FAILED'; exit 1; }
+      fi
+      # Только headless shell: его и запускает съёмка, полный Chrome (≈370 МБ) не нужен.
+      # Локальный playwright, а не npx: без пакета npx молча поставил бы последнюю версию.
+      { node_modules/.bin/playwright install --only-shell chromium \
+          && node --input-type=module -e 'import { ensureBrowser } from "@remotion/renderer"; await ensureBrowser();'; } > "${TMPDIR:-/tmp}/studio-browsers.log" 2>&1 \
+        || { tail -20 "${TMPDIR:-/tmp}/studio-browsers.log"; echo 'studio: браузеры не установились'; exit 1; }
+      cd ..
+    elif [ -d studio ] && [ -f studio/.env ]; then
+      echo 'studio: в этом коммите нет studio/ecosystem.config.cjs — студия пропущена'
+    elif [ -d studio ]; then
+      echo 'studio: .env отсутствует — студия не настроена, рабочий процесс пропущен'
+    fi
+CMDS
+}
+
+# Перезапуск рабочего процесса студии. Остановка — сообщением shutdown
+# (ecosystem.config.cjs): процесс доводит текущее задание (до kill_timeout,
+# 10 минут) и выходит, поэтому вызов может ждать — его зовут отдельно от рестарта API.
+studio_restart_cmds() {
+  cat <<'CMDS'
+    if [ -d studio ] && [ -f studio/.env ]; then
+      if [ -f studio/ecosystem.config.cjs ]; then
+        cd studio
+        pm2 startOrReload ecosystem.config.cjs > "${TMPDIR:-/tmp}/studio-pm2.log" 2>&1 \
+          || { tail -20 "${TMPDIR:-/tmp}/studio-pm2.log"; echo 'studio: pm2 startOrReload FAILED'; exit 1; }
+        cd ..
+      else
+        # Коммит старше процесса PM2 (откат на план 2): новый код в памяти поверх
+        # старого дерева собирал бы ролики на чужих композициях — останавливаем.
+        pm2 delete linkeon-studio > /dev/null 2>&1 || true
+        echo 'studio: в этом коммите нет studio/ecosystem.config.cjs — рабочий процесс остановлен'
+      fi
+    fi
 CMDS
 }
 
@@ -735,6 +797,7 @@ deploy_backend() {
   if ! ssh_remote "
     set -eo pipefail
     cd $BACK_PATH
+    STUDIO_SAME_AS=\$(git rev-parse HEAD)
     git fetch origin
     git reset --hard origin/$BRANCH
     $(back_build_cmds)
@@ -801,6 +864,24 @@ deploy_backend() {
   ext=$(curl -s -m 12 ${BASIC_AUTH:+-u "$BASIC_AUTH"} -o /dev/null -w "%{http_code}" "${BASE_URL}/webhook/agents" 2>/dev/null) || ext="${ext:-000}"
   if [[ "$ext" == "200" ]]; then green "  ✓ снаружи ${BASE_URL} = 200"
   else yellow "  ⚠ снаружи ${BASE_URL} = $ext при живом бэкенде — маршрут/edge с этой машины"; fi
+
+  # Студия — отдельным вызовом и после проверки здоровья API: ожидание её задания
+  # (до 10 минут) не держит health-wait и smoke, а повтор ssh после обрыва
+  # (ssh_remote) не перезапускает API второй раз. Сбой на стенде останавливает
+  # выкат до прода; на проде API уже выкачен — только предупреждение.
+  bold "[back 3.5/3] рабочий процесс студии ($ENV_NAME)"
+  if ! ssh_remote "
+    set -e
+    cd $BACK_PATH
+    $(studio_restart_cmds)
+  "; then
+    if [[ "$ENV_NAME" == prod ]]; then
+      red "  ✗ prod: рабочий процесс студии не перезапустился — API выкачен, студию смотреть руками (pm2 logs linkeon-studio)"
+    else
+      red "  ✗ $ENV_NAME: рабочий процесс студии не перезапустился — прод не трогаю"
+      exit 1
+    fi
+  fi
 }
 
 deploy_frontend() {
```

- [x] **Step 4: Зелёный на ноде** — `8eea65f`: jest `tests/scripts` 34 passed; студия 226 pass, `TSC_OK`.

---

### Task 3: README студии

- [x] Раздел «Под PM2: стенд и прод» в `studio/README.md` (`995c49d`, после ревью — `8eea65f`): процесс и его остановка, что делает выкат, состав `studio/.env` сервера, `pm2 save`, Node 20.

- [x] **Проверка под Node 20** (прод — v20.20.2), до плана, на ноде: `export PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH` → `npm test` 222/222, `typecheck`, живая очередь `test:db` 15/15, обе фикстуры сборки — pass.

---

### Task 4: Ревью ветки

- [x] **Step 1:** Субагент `superpowers:code-reviewer` (opus) на `6e25b12..bc4f6cb`. Итог — одобрено с правками, Critical нет. Опыты на ноде (свой демон pm2 6.0.14, как на проде, Node 20.20.2) показали:
  - **I1** по SIGINT задание не доводилось: Playwright и Remotion ловят SIGINT, убивают браузер и делают `process.exit(130)`, `startOrReload` возвращался за 0,3 с; `treekill` слал сигнал ffmpeg и esbuild; `max_memory_restart` мерил обёртку tsx (42 МБ при дереве 530 МБ). Правка — `node --import tsx`, `shutdown_with_message`, `treekill: false`, `watchStop` (проверено ревьюером: задание доведено, `startOrReload` ждал ровно его длину);
  - **I2** перезапуск студии в одном ssh с `pm2 restart linkeon-api`: ожидание задания держало бы health-wait и smoke, а повтор ssh после обрыва (код 255) перезапустил бы API второй раз — студия вынесена в шаг `[back 3.5/3]` после health-wait;
  - **I3** откат на коммит без `ecosystem.config.cjs` (прод сейчас на таком, `b6c54ea3`) падал бы «ROLLBACK BACKEND FAILED», а процесс крутил бы новый код поверх старого дерева — теперь процесс удаляется;
  - **I4** `npm ci` студии на каждом выкате сносил `node_modules` под работающим процессом вместе с браузером Remotion (92 МБ заново) — теперь по lock-файлу и наличию `node_modules/.bin/tsx`;
  - **I5, I6** — в задачах 5 и 7 ниже (перезапуск во время задания; пополнение демо-аккаунта);
  - Minor: только headless shell (`--only-shell`, минус 369 МБ), локальный `node_modules/.bin/playwright` вместо `npx`, браузер Remotion и в откате, логи в `TMPDIR`, тесты отката и рестарта — настоящим bash, проверки `restart_time`, `DATABASE_URL` без исполнения `.env`, пробная съёмка — всё взято.

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

Expected: `online`, `restart_time` 0 и `unstable restarts` 0 (цикл падений `online` не ловит), `nice` 19, в логе `worker: старт`.

- [ ] **Step 5: Ролик через процесс PM2 и перезапуск во время задания** — формат «Только чат» на время прогона (без трат Google): `update_settings format=chat` → `order` → `start_now`. Когда процесс возьмёт съёмку или сборку (`status` `capturing` или `rendering`), — `pm2 restart linkeon-studio`. Expected: в логе `worker: pm2 shutdown — закончу текущее задание и выйду`, задание доведено, ролик доходит до `pending_review` без паузы на аренду, `attempts` не растёт, затем новый `worker: старт`. Формат обратно `skit`. Ручной `worker --once` из `~/ci/wt` на стенде больше не нужен.

---

### Task 6 (OK): Прод — окружение, настройки, выкат

- [ ] **Step 1: `studio/.env` прода** — на сервере, значения из `~/spirits_back/.env` прода, без вывода:

```bash
ssh dvolkov@212.113.106.202 'set -e; f=~/spirits_back/studio/.env; test ! -f $f; umask 077; { grep -E "^(DATABASE_URL|MINIO_ENDPOINT|MINIO_ACCESS_KEY|MINIO_SECRET_KEY|MINIO_BUCKET_VIDEOS|YANDEX_SPEECHKIT_API_KEY|YANDEX_TTS_FOLDER_ID|GOOGLE_AI_API_KEY|DEBUG_SECRET)=" ~/spirits_back/.env; echo CABINET_URL=https://my.linkeon.io; echo API_URL=https://my.linkeon.io; echo DEMO_PHONE=<демо-номер>; echo ADMIN_PHONE=<номер админа>; } > $f; grep -oE "^[A-Z_]+=" $f | sort | tr "\n" " "'
```

- [ ] **Step 2: Канал** — до включения модуля, как велит спека:

```bash
ssh dvolkov@212.113.106.202 'psql "$(grep -m1 "^DATABASE_URL=" ~/spirits_back/.env | cut -d= -f2-)" -Atc "UPDATE short_settings SET tg_channel_chat_id = '"'"'-1003046204962'"'"', updated_at = now() WHERE id = 1 RETURNING tg_channel_chat_id, platforms"'
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

Expected: коммит слияния, `002_skits.sql applied`, `linkeon-studio` `online` без перезапусков, `worker: старт`.

- [ ] **Step 6: Пробная съёмка и демо-аккаунт** — до первого ролика, без хода ассистента: `cd ~/spirits_back/studio && npx tsx src/capture/run-capture.ts scenes/sample-lawyer-lease.json --probe` (на проде). Первый вход заводит демо-аккаунт; проба показывает, что у нового аккаунта кабинет доходит до чата и нужного ассистента. Затем баланс демо-аккаунта — с запасом на месяцы (съёмка ≈ 2 000 токенов, стартовых 25 000 хватит примерно на 12): `curl -s -X POST -H "X-Debug-Secret: <из .env>" http://127.0.0.1:3001/webhook/debug/add-tokens/<демо-номер>/200000` (ручка работает только для тестовых номеров). Нехватка токенов потом видна сама: съёмка браком уйдёт в `failed`, владельцу придёт сообщение.

- [ ] **Step 7: Предел на первый ролик** — `cd ~/spirits_back/studio && npx tsx scripts/stand-admin.ts update_settings settings:='{"maxOmniSeconds":16}'` (на проде, API на 127.0.0.1:3001). Expected: `format: skit`, `maxOmniSeconds: 16`, `tgChannelChatId: -1003046204962`.

---

### Task 7 (OK): Первый ролик на проде — с владельцем

- [ ] **Step 1:** Тему выбирает владелец (или берётся из каталога). `order` → `start_now` через `stand-admin.ts` на проде. Ролик идёт сам: режиссёр и сценарист — API, съёмка, оживление и сборка — `linkeon-studio`. Следить за `status`, `last_error`, `animation` (psql по `short_video`).
- [ ] **Step 2:** Владелец получает ролик в личку (без пометки «СТЕНД»), одобряет. `publish_now` → пост в @ainomira, набор для YouTube владельцу; ссылку на ролик канала @Linkeons владелец отдаёт кнопкой.
- [ ] **Step 3:** Алерт роста стоимости на демо-аккаунт не сработал; баланс демо-аккаунта уменьшился на одну съёмку; предел Omni — обратно 48.

---

### Task 8 (OK): Расписание

- [ ] После 1–2 одобренных роликов — `SHORTS_AUTO_TOPICS=true` в `.env` прода и рестарт API без обрыва живых ходов (`/webhook/chat/active-streams` = 0, затем `pm2 restart linkeon-api --update-env`) или ближайшим выкатом. Темы набираются в воскресенье, ролики готовятся к слотам вт/чт/сб 18:00 МСК, владелец одобряет кнопками.

---

### Task 9: Итоги

- [ ] Раздел «Что уточнил выкат (план 5)» в спеке роликов, заметка памяти `project_promo_shorts_studio.md`, рабочее состояние `promo-shorts`.
