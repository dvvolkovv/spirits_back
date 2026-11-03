# План: изоляция Bash ассистентов на релее (часть В)

> **Для агентных исполнителей:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans. Шаги с чекбоксами (`- [ ]`).
> Тесты и сборки — на тестовой ноде (`ssh dv@85.192.61.231`, клоны `~/ci/wt/`), НЕ на маке. Системные правки на релее (`dv@5.101.115.184`) — только по чеклисту Task 4, с фиксацией результата каждого шага; любое отклонение от ожидаемого — стоп и доклад.

**Цель:** ассистент (модель через CLI в Bash) на релее не может: читать `~/file-agent/sessions.json`, `~/.claude`, pm2-журналы, `.env`/ключи (в т.ч. из окружения), `~/.ssh`; видеть чужие сессии; работать с сетью внутренних адресов; получить root. По спеке `docs/superpowers/specs/2026-11-03-relay-bash-sandbox-design.md`.

**Архитектура:** штатная песочница Claude Code (bubblewrap) для Bash + узкие `--allowedTools` и `permissions.deny` для файловых инструментов + чистое окружение процесса CLI по списку. Код релея — плоские файлы в `relay-agent/` (других путей `deploy-relay.sh` не пропускает). Бэкенд не трогаем.

**Стек:** Node 22 (релей), bubblewrap 0.9.0, AppArmor, Claude Code CLI 2.1.280.

---

## Структура файлов

- Create: `relay-agent/sandbox-policy.mjs` — режим из файла, сбор `--settings`, чистое окружение, пути
- Create: `relay-agent/sandbox-policy.test.mjs` — тесты модуля (нода, `node --test`)
- Modify: `relay-agent/paths.mjs` — константы `AGENT_SCRATCH_DIR`/`AGENT_MCP_DIR`, создание каталогов с правами
- Modify: `relay-agent/paths.test.mjs` — тесты новых констант
- Modify: `relay-agent/session-mcp-config.mjs` — конфиги MCP в `/tmp/agent-mcp`, 0600
- Modify: `relay-agent/server.mjs` — врезка политики в запуск CLI, журнал, алерт, промпт-пути
- Modify (система релея, Task 4): bubblewrap, `/etc/apparmor.d/bwrap`, `/opt/linkeon-agent`, права 0311, архив `~/linkeon-orphans-oldtmp`

Ключевые якоря в `relay-agent/server.mjs` (читать перед правкой): `BASE_TOOLS` (~347), сбор `allowedTools` (~599-667), `args` (~676-700, флаг `--mcp-config`), `spawn` (~868-880, `env:`), промпт-строки с `/home/dv/agent-env` (~80, ~92), `PATH` в подсказке (~872). В `relay-agent/llm-fallback.mjs`: `providerSpawnEnv` и `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0"` (~112-115).

---

## Task 0: Стенд-разведка на релее — подтвердить рабочие настройки песочницы

Всё — на релее `dv@5.101.115.184`. Это единственный блокер плана: точные JSON-ключи песочницы CLI 2.1.280, поведение scrub и sudo, схема сети проверяются опытом, а не документацией. Системные изменения этого таска (apt + AppArmor) уже одобрены владельцем 03.11 («Да, можно»).

- [ ] **Step 1: bubblewrap и профиль AppArmor**

```bash
ssh dv@5.101.115.184
sudo apt-get install -y bubblewrap
printf '%s\n' 'abi <abi/4.0>' 'include <tunables/global>' '' 'profile bwrap /usr/bin/bwrap {' '  include <abstractions/base>' '  userns,' '}' | sudo tee /etc/apparmor.d/bwrap >/dev/null
sudo apparmor_parser -r /etc/apparmor.d/bwrap
bwrap --bind / / --dev-bind /dev /dev true && echo 'bwrap ок'
```

Ожидается: `bwrap ок`. Иначе — стоп, доклад (профиль/ядро смотреть через `dmesg | tail` после попытки).

- [ ] **Step 2: минимальный ход в песочнице (белый список команд)**

Создать `/tmp/sbx-probe/settings.json`:

```json
{
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "excludedCommands": ["sudo *"],
    "filesystem": {
      "allowWrite": ["/tmp/sbx-probe/w"],
      "denyRead": ["/home/dv/file-agent"]
    }
  },
  "permissions": { "deny": ["Read(//home/dv/file-agent/**)"] }
}
```

`mkdir -p /tmp/sbx-probe/w`. Запуск (модель haiku, копеечный ход; токен — текущая учётка релея):

```bash
cd /tmp/sbx-probe
claude --print --model claude-haiku-4-5 \
  --settings /tmp/sbx-probe/settings.json \
  --allowedTools 'Bash(echo *),Bash(cat *),Bash(ls *),Bash(env),Bash(sudo *)' \
  -p 'Выполни по порядку, каждой командой отдельно, и напиши только её вывод: 1) echo ok > w/a.txt 2) cat w/a.txt 3) cat /home/dv/file-agent/sessions.json 4) ls /home/dv/file-agent 5) sudo -n true; после каждой — строку RC=<код>'
```

Зафиксировать: (a) запись в `w` прошла; (b) чтение `sessions.json` из Bash отказано; (c) `Read` отказан; (d) `sudo` отказан (`excludedCommands` сработал ИЛИ bwrap его сломал — любой отказ засчитывается, НО если sudo прошёл — стоп и доклад, это блокер: мера «sudo нельзя» безработоспособна штатно).

- [ ] **Step 3: очистка окружения (scrub)**

```bash
GEMINI_API_KEY=probe-gemini OPENROUTER_API_KEY=probe-or claude --print --model claude-haiku-4-5 \
  --settings /tmp/sbx-probe/settings.json \
  --allowedTools 'Bash(env *)' \
  -p 'Запусти env и скажи, есть ли в выводе строки GEMINI_API_KEY или OPENROUTER_API_KEY: ответь одной строкой FOUND или CLEAN'
```

Повторить с `"envScrub": true` внутри `sandbox` блока, если CLEAN не получен. Также проверить флаг окружения: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` передать в env запуска и повторить. Зафиксировать рабочий способ. Если ни один способ не вычистил env — стоп и доклад (ветвление: ключи запасных провайдеров через файл конфигурации CLI вместо env).

- [ ] **Step 4: сеть «внешнее да, внутреннее нет»**

Применительно к схемам: `network.allowedDomains` (список), любые deny-ключи (`deniedDomains`, `network.deny` — если существуют, CLI не падает на неизвестных ключах). Пробы (первая подошедшая — фиксируется):
1. `"network": {"allowedDomains": ["example.com", "127.0.0.1:3033"]}` → curl внешний ОК, `curl -s -m 3 http://127.0.0.1:3033/` ОК — не подходит (внутреннее открыто);
2. `"network": {"allowedDomains": ["example.com"]}` → внешний ОК, внутренний отказ;
3. нет `network`-блока → оба ОК — не подходит;
Проверки: `curl -sI -m 8 https://example.com | head -1` и `curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3033/`. Если схема 2 работает — решаем уровень: `allowedDomains` со списком нужных доменов ассистентам (api оформления, википедия и т.п.) либо возврат к владельцу (спека допускает). Решение по факту — владельцу одной строкой.
Замерить также: `time` двух одинаковых ходов с песочницей и без (дельта > 30 с — отметить для владельца).

- [ ] **Step 5: учётка при чужом HOME**

```bash
mkdir -p /tmp/sbx-probe/home
HOME=/tmp/sbx-probe/home CLAUDE_CONFIG_DIR=/home/dv/.claude claude --print --model claude-haiku-4-5 \
  --settings /tmp/sbx-probe/settings.json -p 'ответь одним словом: ок'
```

Ожидается: ход проходит (учётка найдена). Отказ — стоп и доклад (гейт: без этого врезка в server.mjs невозможна).

- [ ] **Step 6: зафиксировать результаты**

Записать в Task 1 константу `SETTINGS_SCHEMA` фактически подтверждённые ключи и значения (выбор между заранее прописанными вариантами A/B ниже), а также: способ scrub, сетевую схему, дельту времени хода. Удалить `/tmp/sbx-probe` после фиксации (`rm -rf /tmp/sbx-probe`).

**Варианты SETTINGS_SCHEMA, зашитые в Task 1** (Task 0 выбирает, не изобретает):
- `A` — deny-чтение работает, sudo через `excludedCommands`, сеть через `allowedDomains`-список;
- `B` — то же, но сеть полностью открыта (внутреннее доступно; расхождение со спекой — владельцу);
- `C` — блокер (sudo/scrub/учётка не подтвердились) — план останавливается до решения.

---

## Task 1: `relay-agent/sandbox-policy.mjs` + тесты (TDD)

Файлы: Create `relay-agent/sandbox-policy.mjs`, Create `relay-agent/sandbox-policy.test.mjs`. Тесты — на ноде: `ssh dv@85.192.61.231 'cd ~/ci/wt/<клон> && git checkout <sha> && node --test relay-agent/sandbox-policy.test.mjs'`.

- [ ] **Step 1: красный тест.** Написать `relay-agent/sandbox-policy.test.mjs`:

```javascript
// node --test; без зависимостей. Номера в тестах выдуманные.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sandboxMode, isCanarySession, buildSandboxSettings, buildCliEnv, SANDBOX_SCHEMA,
} from './sandbox-policy.mjs';

const OWNER_PHONE = '7903' + '0169187'; // номер владельца НЕ хардкодим: канареечный список — файл на сервере (sandbox-canary.keys)
test('режим из файла: off/canary/on, битый файл = off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  const f = path.join(dir, 'mode');
  fs.writeFileSync(f, 'off\n');
  assert.equal(sandboxMode(f), 'off');
  fs.writeFileSync(f, 'on');
  assert.equal(sandboxMode(f), 'on');
  fs.writeFileSync(f, 'canary\n');
  assert.equal(sandboxMode(f), 'canary');
  fs.writeFileSync(f, 'бред');
  assert.equal(sandboxMode(f), 'off');
  assert.equal(sandboxMode(path.join(dir, 'нет')), 'off');
});

test('канарейка: только сессии из файла списка', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  const modeFile = path.join(dir, 'mode');
  const keysFile = path.join(dir, 'canary-keys');
  fs.writeFileSync(modeFile, 'canary\n');
  fs.writeFileSync(keysFile, '79030001111_14_ru\n79030001111_10_en\n');
  assert.equal(isCanarySession('79030001111_14_ru', 'canary', keysFile), true);
  assert.equal(isCanarySession('79990001122_1_ru', 'canary', keysFile), false);
  assert.equal(isCanarySession('79030001111_14_ru', 'on', keysFile), true);
  assert.equal(isCanarySession('79990001122_1_ru', 'on', keysFile), true);
  assert.equal(isCanarySession('79030001111_14_ru', 'off', keysFile), false);
});

test('настройки: своя папка на запись, домашний каталог и mcp на запрет чтения', () => {
  const s = buildSandboxSettings('<fs_key>', { scratch: '/tmp/agent-scratch/<fs_key>', mcpDir: '/tmp/agent-mcp', home: '/home/dv' });
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.ok(s.sandbox.filesystem.allowWrite.includes('/tmp/agent-scratch/<fs_key>'));
  assert.ok(s.sandbox.filesystem.allowWrite.includes('/tmp/agent-output/<fs_key>'));
  assert.ok(s.sandbox.filesystem.denyRead.includes('/home/dv'));
  assert.ok(s.sandbox.filesystem.denyRead.includes('/tmp/agent-mcp'));
  assert.ok(s.sandbox.excludedCommands.includes('sudo *'));
  assert.equal(typeof s.permissions.deny[0], 'string');
  for (const d of s.permissions.deny) assert.match(d, /^(Read|Glob|Grep|Write|Edit)\(/);
});

test('cliEnv: белый список, без лишних ключей, scrub включён', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/dv', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    GEMINI_API_KEY: 'x', OPENROUTER_API_KEY: 'x', SSH_AUTH_SOCK: '/tmp/ssh', OLDPWD: '/x',
    PM2_USAGE: '1', MCP_TIMEOUT: '120000' };
  const env = buildCliEnv({ baseEnv: base, providerEnv: { ANTHROPIC_BASE_URL: 'https://q', ANTHROPIC_AUTH_TOKEN: 't' }, fsKey: '<fs_key>', scrub: true });
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.OLDPWD, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.PM2_USAGE, undefined);
  assert.equal(env.MCP_TIMEOUT, '120000');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://q');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 't');
  assert.equal(env.HOME, '/tmp/agent-scratch/<fs_key>');
  assert.equal(env.TMPDIR, '/tmp/agent-scratch/<fs_key>');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/dv/.claude');
  assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  assert.ok(env.PATH.startsWith('/opt/linkeon-agent/bin:'));
  assert.equal(env.http_proxy, 'http://127.0.0.1:8471');
  assert.equal(env.https_proxy, env.http_proxy);
  assert.equal(env.no_proxy, undefined);
});
```

Запустить на ноде: `node --test relay-agent/sandbox-policy.test.mjs` — ожидается падение (модуля нет).

- [ ] **Step 2: зелёный модуль.** `relay-agent/sandbox-policy.mjs`:

```javascript
// Политика песочницы для ходов релея (спека 2026-11-03-relay-bash-sandbox-design.md).
// Чистая логика — без зависимостей от server.mjs; читаемое извне: режим из файла,
// канареечный список, сбор --settings, чистое окружение CLI.
import fs from 'node:fs';

export const AGENT_OPT_DIR = '/opt/linkeon-agent';
export const AGENT_SCRATCH_ROOT = '/tmp/agent-scratch';
export const AGENT_MCP_DIR = '/tmp/agent-mcp';
export const SANDBOX_SCHEMA = process.env.RELAY_SANDBOX_SCHEMA || 'A'; // Task 0 выбирает A|B; C — стоп плана

// Режим из файла на сервере (~/file-agent/sandbox-mode). Битый/отсутствующий — off.
export function sandboxMode(modeFile) {
  try {
    const v = fs.readFileSync(modeFile, 'utf8').trim();
    return v === 'on' || v === 'canary' ? v : 'off';
  } catch {
    return 'off';
  }
}

// Канарейка: только сессии, чьи ключи есть в файле списка (по строке).
export function isCanarySession(sessionKey, mode, keysFile) {
  if (mode === 'on') return true;
  if (mode !== 'canary') return false;
  try {
    return fs.readFileSync(keysFile, 'utf8').split('\n').map((s) => s.trim()).includes(sessionKey);
  } catch {
    return false;
  }
}

// Настройки для --settings <файл>. Пути без fs_key — с подставленным ключом.
export function buildSandboxSettings(fsKey, { scratch, mcpDir } = {}) {
  const scratchDir = scratch || `${AGENT_SCRATCH_ROOT}/${fsKey}`;
  const myOutput = `/tmp/agent-output/${fsKey}`;
  const deny = ['/home/dv', '/etc/sudoers', '/etc/sudoers.d', mcpDir || AGENT_MCP_DIR];
  const PROXY = process.env.RELAY_SANDBOX_PROXY || '127.0.0.1:8471';
  const net = SANDBOX_SCHEMA === 'A'
    ? { network: { allowedDomains: [PROXY] } }
    : {};
  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      excludedCommands: ['sudo *'],
      filesystem: {
        allowWrite: [scratchDir, myOutput],
        denyRead: deny,
      },
      ...net,
    },
    permissions: {
      deny: [
        ...deny.map((d) => `Read(${d}/**)`),
        ...deny.map((d) => `Glob(${d}/**)`),
        ...deny.map((d) => `Grep(${d}/**)`),
        ...deny.map((d) => `Write(${d}/**)`),
        ...deny.map((d) => `Edit(${d}/**)`),
      ],
    },
  };
}

// Окружение CLI: белый список + переменные выбранного провайдера + scrub.
// GEMINI_API_KEY/OPENROUTER_API_KEY не пробрасываются (ни релею, ни ассистентам не нужны).
const ENV_PASS = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT', 'RUN_ENV']);

export function buildCliEnv({ baseEnv, providerEnv, fsKey, scrub }) {
  const env = {};
  for (const k of ENV_PASS) if (baseEnv[k] !== undefined) env[k] = baseEnv[k];
  Object.assign(env, providerEnv || {}); // ANTHROPIC_* выбранного провайдера
  const scratchDir = `${AGENT_SCRATCH_ROOT}/${fsKey}`;
  env.HOME = scratchDir;
  env.TMPDIR = scratchDir;
  env.CLAUDE_CONFIG_DIR = '/home/dv/.claude';
  if (scrub) env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  env.PATH = `${AGENT_OPT_DIR}/bin:/usr/local/bin:/usr/bin:/bin`;
  // Сеть — только через локальный прокси (squid на релее режет внутренние
  // назначения). no_proxy НЕ задаём: он дал бы обход резки через localhost.
  env.http_proxy = `http://${PROXY}`;
  env.https_proxy = `http://${PROXY}`;
  env.HTTP_PROXY = env.http_proxy;
  env.HTTPS_PROXY = env.https_proxy;
  return env;
}
```

Запустить тесты на ноде — зелёные. **Step 3: коммит** `feat(relay-agent): политика песочницы — режим, настройки, чистое окружение (Т)` + push.

**Уточнение после quality-ревью (400594ac):** корень `AGENT_SCRATCH_ROOT` в `denyRead` НЕ включается — иначе собственный scratch/HOME хода оказался бы под запретом; чужие scratch закрыты правами 0311 и непредсказуемыми fs_key. Оба билдера валидируют `fsKey` (`/^[A-Za-z0-9._-]+$/`, не `.`/`..`, иначе TypeError), `scratch`/`mcpDir` нормализуются без trailing slash, `PATH` удалён из `ENV_PASS`, а `providerEnv` пропускает только `ANTHROPIC_*` и `CLAUDE_CODE_OAUTH_TOKEN`/`CLAUDE_CODE_MAX_RETRIES`/`CLAUDE_CODE_SUBAGENT_MODEL`. Тесты дополнены этими случаями и отсутствующим canary-файлом.

---

## Task 2: `relay-agent/paths.mjs` — каталоги scratch/mcp и права (TDD)

- [ ] **Step 1: красный тест** — добавить в `relay-agent/paths.test.mjs`:

```javascript
// (внутри существующего describe файла, стиль как у соседних тестов)
assert.equal(AGENT_SCRATCH_ROOT, '/tmp/agent-scratch');
assert.equal(AGENT_MCP_DIR, '/tmp/agent-mcp');
// ensureSessionDirs(fsKey) создаёт /tmp/agent-scratch/<fsKey> и /tmp/agent-output/<fsKey> (0700) и возвращает scratch
// ensureListingGuard() делает chmod 0311 на /tmp/agent-output, /tmp/agent-uploads и /tmp/agent-scratch (idempotent, не падает, если нет)
```

(Импортировать новые константы/функции из `./paths.mjs`.) Прогон на ноде — красный.

- [ ] **Step 2: зелень** — в `relay-agent/paths.mjs` добавить:

```javascript
import { AGENT_SCRATCH_ROOT, AGENT_MCP_DIR } from './sandbox-policy.mjs';
export { AGENT_SCRATCH_ROOT, AGENT_MCP_DIR };

export async function ensureSessionDirs(fsKey, { scratchRoot = AGENT_SCRATCH_ROOT, outputs = '/tmp/agent-output' } = {}) {
  const scratch = path.join(scratchRoot, fsKey);
  await fsp.mkdir(scratch, { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.join(outputs, fsKey), { recursive: true, mode: 0o700 });
  await fsp.chmod(scratch, 0o700);
  await fsp.chmod(path.join(outputs, fsKey), 0o700);
  return scratch;
}

// 0311: по имени папки можно зайти, перечислить чужие нельзя. Релей списком не читает.
// scratch включён обязательно: все ходы под одним uid, поэтому 0700 на корне
// не закрыло бы ассистенту листинг чужих scratch-каталогов.
export async function ensureListingGuard({ outputs = '/tmp/agent-output', uploads = '/tmp/agent-uploads', scratchRoot = AGENT_SCRATCH_ROOT } = {}) {
  for (const d of [outputs, uploads, scratchRoot]) {
    await fsp.mkdir(d, { recursive: true });
    await fsp.chmod(d, 0o311);
  }
}
```

(`fsp`/`path` уже импортированы в файле; если имена иные — по месту.) Тесты на ноде — зелёные. **Step 3: коммит** + push.

---

## Task 3: `session-mcp-config.mjs` и `server.mjs` — врезка политики

- [ ] **Step 1: конфиги MCP в `/tmp/agent-mcp` (TDD).** В `relay-agent/session-mcp-config.mjs` найти функцию, возвращающую путь временного конфига (сейчас — общий `/tmp`), и перенести каталог на `AGENT_MCP_DIR` с именем `<fsKey>-<случайное>.json` и `mode 0o600`. Тест в `session-mcp-config.test.mjs`: путь начинается с `/tmp/agent-mcp/`, права 0600 (проверить `fs.statSync(...).mode & 0o777`), после `cleanup()` файла нет. Прогон на ноде. Коммит.

- [ ] **Step 2: server.mjs — запуск с политикой.** Точки (см. якоря в шапке плана). Правки:

1. Импорт: `import { sandboxMode, isCanarySession, buildSandboxSettings, buildCliEnv, AGENT_MCP_DIR, SANDBOX_SCHEMA } from './sandbox-policy.mjs';` и `ensureSessionDirs, ensureListingGuard` из `paths.mjs`.
2. Константы путей файлов режима: `const SANDBOX_MODE_FILE = path.join(HOME_AGENT, 'sandbox-mode'); const SANDBOX_CANARY_KEYS = path.join(HOME_AGENT, 'sandbox-canary.keys');` (рядом с `SESSION_STORE_PATH`).
3. В обработчике хода до spawn: `const sbxMode = sandboxMode(SANDBOX_MODE_FILE); const sbxOn = isCanarySession(sessionId, sbxMode, SANDBOX_CANARY_KEYS);` — строка в журнал: `console.log('sandbox: ' + (sbxOn ? sbxMode : 'off') + ' для ' + sessionId.replace(/[0-9]{7}$/, '*******'));` (маска номера в журнале: первые 4 цифры + звёздочки).
4. Если `sbxOn`: `await ensureSessionDirs(fsKey); await ensureListingGuard();` — `fsKey` взять из того же источника, что и `mcpConfigPath`/turnFsKey (уже есть в ветке части Б).
5. `spawn(...)`: `env` при `sbxOn` — `const cliEnv = buildCliEnv({ baseEnv: process.env, providerEnv: runProvider === 'claude' ? {} : llm.providerSpawnEnv(process.env, llmCfgs[runProvider]), fsKey, scrub: true }); cliEnv[RUN_ENV] = tag; cliEnv.OMP_THREAD_LIMIT = '1';` и в `spawn` передать `env: cliEnv`. При `sbxOn === false` — прежняя строка env без изменений (полный `process.env`/`providerSpawnEnv` + `MCP_TIMEOUT`/`OMP_THREAD_LIMIT`/`[RUN_ENV]` как сейчас). `MCP_TIMEOUT='120000'` и `MCP_TOOL_TIMEOUT='600000'` в `cliEnv` задаются всегда (как legacy, даже при пустом baseEnv); provider allowlist дополнительно пропускает `API_TIMEOUT_MS` и `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
6. `args`: после `--mcp-config` добавить `...sbxOn ? ['--settings', settingsPath] : []`, где `settingsPath = path.join(AGENT_MCP_DIR, `${fsKey}-${Date.now()}.settings.json`)`, записан через `writeFileSync(settingsPath, JSON.stringify(buildSandboxSettings(fsKey, {})))` с `chmod 600`, удаляется в `finally` рядом с удалением `mcpConfigPath`.
7. `allowedTools` при `sbxOn`: вместо `Read(*),Glob(*),Grep(*)` — `Read(/tmp/agent-output/${fsKey}/**),Read(/tmp/agent-scratch/${fsKey}/**),Read(/tmp/agent-uploads/${fsKey}_*),Read(${AGENT_OPT_DIR}/**),Read(/usr/**),Read(/etc/**)`; `Write/Edit` — только `/tmp/agent-output/${fsKey}/**` и `/tmp/agent-scratch/${fsKey}/**`. Синтаксис правил — как в существующем коде (проверить по `BASE_TOOLS`); `Bash(*)` и `WebSearch(*)` остаются. **`WebFetch` при on/canary запрещён через `--disallowedTools`**: он выполняется CLI вне bwrap и обходит сетевую границу; `WebFetch(*)` остаётся только в off. `/opt/**` целиком не разрешать.
8. Промпт: заменить `/home/dv/agent-env` → `/opt/linkeon-agent` (venv: `/opt/linkeon-agent/venv/bin/activate`), `~/file-agent/bin` и `~/.bun/bin` в PATH-подсказке → `/opt/linkeon-agent/bin`.
9. Детект отказа: в парсере tool-результатов (где сейчас ловятся ошибки инструментов) добавить: если текст результата Bash содержит `sandbox` (регистронезависимо) — `console.error('SANDBOX-FAIL ' + tag)` и счётчик `sandboxFails++`; раз в 5 минут, если `sandboxFails > 0`, — одна строка `sandbox-fail count=N` в журнал (грепается мониторингом; внешних алертов у релея нет, не добавляем).
10. Автоочистки scratch в этом этапе НЕТ: directory mtime не отражает запись во вложенные файлы, а удаление до preempt живого хода даёт гонку и TOCTOU. Не делать ни периодический `readdir` 0311-корня, ни удаление по возрасту в `ensureSessionDirs`; отдельная поздняя задача — с учётом живых ходов. `ensureListingGuard` вызывается ДО `ensureSessionDirs`, корни создаются сразу с `mode: 0o311`.

- [ ] **Step 3: server-level тесты** — настоящий Express handler с DI spawn и изолированными mkdtemp-каталогами, не только чистые помощники: off → прежний env, нет `--settings`, `WebFetch(*)` разрешён; on/canary → точные argv/env, `WebFetch` в `--disallowedTools`, `HOME` = scratch, settings один на retry/fallback и удаляется после хода; partial MCP/settings write и spawn error → оба файла удалены; parallel/preempt не удаляет чужие временные файлы; signal/stale sweeper обрабатывает оба suffix; неизвестная схема → отказ до spawn. Прогон всех `relay-agent/*.test.mjs` на ноде — всё зелёное.
- [ ] **Step 4: коммит** `feat(relay-agent): ходы в песочнице — настройки на запуск, чистое окружение, mcp в /tmp/agent-mcp (Т)` + push.

---

## Task 4: Системные правки релея (чеклист, каждый шаг с проверкой вывода)

На релее, sudo. Последовательно; любой шаг не по плану — стоп.

- [ ] 1. `sudo apt-get install -y bubblewrap` → `bwrap --version` выводит версию.
- [ ] 2. Профиль AppArmor (как в Task 0 Step 1) → `sudo apparmor_parser -r /etc/apparmor.d/bwrap` → `bwrap --bind / / true && echo ок`.
- [ ] 3. `sudo mkdir -p /opt/linkeon-agent && sudo cp -a ~/agent-env /opt/linkeon-agent/venv && sudo cp -a ~/file-agent/bin/. /opt/linkeon-agent/bin/ 2>/dev/null || true && sudo cp -a ~/file-agent/scripts/. /opt/linkeon-agent/bin/ 2>/dev/null || true` → `sudo chmod -R a+rX /opt/linkeon-agent` → `ls /opt/linkeon-agent/bin | head` показывает скрипты, `test -x /opt/linkeon-agent/venv/bin/python3`.
- [ ] 3a. Прокси (решение владельца «В», спека п.5): `ss -ltn | grep 8471` — порт свободен; `sudo apt-get install -y squid`; `/etc/squid/squid.conf` — минимальный:

```
http_port 127.0.0.1:8471
via off
forwarded_for off
acl localnet dst 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 ::1/128 fc00::/7 fe80::/10
http_access deny localnet
acl localhost src 127.0.0.1/32 ::1/128
http_access allow localhost
http_access deny all
```

`sudo systemctl restart squid && sudo systemctl enable squid`. Проверки: `curl -x http://127.0.0.1:8471 -sI -m 8 https://example.com | head -1` → 200; `curl -x http://127.0.0.1:8471 -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3033/` → 403 (squid access denied); то же для `http://169.254.169.254/` → 403.
- [ ] 4. Права: `sudo mkdir -p /tmp/agent-mcp /tmp/agent-scratch && sudo chown dv:dv /tmp/agent-mcp /tmp/agent-scratch && chmod 0311 /tmp/agent-output /tmp/agent-uploads /tmp/agent-scratch && chmod 0700 /tmp/agent-mcp` → проверка: `ls /tmp/agent-output` от пользователя `nobody`? (нельзя удобно) — проверка через `sudo -u nobody ls /tmp/agent-output 2>&1 | head -1` ожидает «Permission denied».
- [ ] 5. Уборка корня `/tmp` (старое рабочее): НЕ трогая `agent-output`, `agent-uploads`, `agent-mcp`, `agent-scratch`, `systemd-private*`, `ssh-*`, `node-compile-cache`, `.org.chromium.Chromium.*`: собрать кандидатов `find /tmp -maxdepth 1 -mindepth 1 -mtime +3`, показать владельцу список-маску (без номеров), после его «да» — `tar -czf ~/linkeon-orphans-oldtmp-$(date +%Y%m%d).tar.gz -C /tmp <список>` (umask 077), сверить число записей, удалить исходники.
- [ ] 6. Файлы режима: `printf 'off\n' > ~/file-agent/sandbox-mode && chmod 600 ~/file-agent/sandbox-mode && cp ~/relay-scrub-canary.keys ~/file-agent/sandbox-canary.keys && chmod 600 ~/file-agent/sandbox-canary.keys` (список = 92 ключа владельца из канарейки чистки).
- [ ] 7. Фиксация: вывод каждого шага — в журнал выполнения; фото-снимок не нужен, достаточно текстовой фиксации здесь.

---

## Task 5: Стенд-прогон

- [ ] 1. Стенд: копия `~/file-agent` → `~/file-agent-sandbox` (исключить `sessions.json`, `sandbox-*`, `node_modules` нет), порты 3036/3037 (по аналогии с прежним стендом; порт — env/аргумент server.mjs), `sandbox-mode` = `on`. Запуск: `cd ~/file-agent-sandbox && pm2 start ...` или `node server.mjs` под nohup; проверка `curl -s 127.0.0.1:3036/health` (или аналогичный лёгкий эндпоинт — смотреть в коде).
- [ ] 2. Прогоны из чеклиста спеки (каждый — Bash-команда в ходе ассистента стенда): `env | grep -cE 'GEMINI_API_KEY|OPENROUTER_API_KEY'` = 0; `tr '\0' '\n' < /proc/$PPID/environ | grep -cE 'ANTHROPIC|API_KEY|AUTH_TOKEN'` = 0 либо `/proc` недоступен; `cat /tmp/agent-uploads/mcp/<любой-старого-шаблона>` — отказ/недоступность; WebFetch в on/canary отклонён самим CLI; `sudo -n true` ≠ 0; `cat /home/dv/file-agent/sessions.json` ≠ 0; `ls /tmp/agent-output` — без имён чужих папок; `ls /tmp/agent-scratch` — permission denied; свой `/tmp/agent-scratch/<fs_key>/f` читается и пишется; чужой scratch по полному пути — недоступен/не должен использоваться (остаточный риск угадываемого legacy-ключа фиксируем); `curl -sI -m 8 https://example.com` — ок; `curl -s -m 3 http://127.0.0.1:3033/` — по схеме Task 0 (A: отказ); `pip install --quiet sampleproject` — ок; прокси: `curl -sI -m 8 https://example.com` (без -x, через env) — ок; `curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3033/` → не 200; `curl -s -m 5 -o /dev/null -w '%{http_code}' http://169.254.169.254/` → не 200; `echo x > /tmp/agent-scratch/<fs_key>/f` — ок; `/files/<fs_key>/…` отдаётся (через nginx прод-релея, папку не путать со стендом).
- [ ] 3. Три живых хода на Claude (простой вопрос, ход с файлом, ход со скачиванием картинки по внешней ссылке) — без ошибок, ответы осмысленные.
- [ ] 4. Те же три хода на Qwen и на Kimi (переключатель провайдера стенда) — без ошибок; в выводе `env` нет токенов.
- [ ] 5. Замер: средняя длительность хода со песочницей vs без (по журналу, ≥5 ходов) — дельта записывается; > 30 с — отметка для владельца.
- [ ] 6. `--resume`: ход, потом второй ход той же сессии — контекст помнит (транскрипт на месте).

## Task 6: Выкат (каждый шаг — с OK владельца, отдельно)

- [ ] 1. `bash scripts/deploy-relay.sh 35d87c61 <TARGET>` из свежего клона spirits_back на ноде (TARGET — голова ветки с Task 1-3). Дождаться drain, проверить `pm2 logs file-agent` — старт без ошибок, режим `off`: ходы идут по-старому. **После drain/остановки старого процесса** — одноразовая очистка `/tmp/agent-uploads/mcp`: `find ... -maxdepth 1 -type f -name '*-session-mcp.json' | wc -l`, подтвердить `ps`, что старый процесс не пишет, удалить только файлы этого шаблона и пустой каталог; прочие uploads не трогать. До очистки старый путь закрыт `denyRead`.
- [ ] 2. `printf 'canary\n' > ~/file-agent/sandbox-mode`; живой ход владельца (вы сами, после его «давай») — «норм».
- [ ] 3. `printf 'on\n' > ~/file-agent/sandbox-mode`; наблюдение 2 дня: `grep -c 'sandbox-fail' ~/.pm2/logs/file-agent-out.log` = 0, длительности ходов в норме, жалоб нет. Итог — владельцу.

## Откат

- Режим: `printf 'off\n' > ~/file-agent/sandbox-mode` — следующий ход по-старой схеме (Task 3 п.5 сохранил прежний env при `sbxOn=false`; `/opt/linkeon-agent` — копия, старые пути живы).
- Код: `deploy-relay.sh <TARGET> 35d87c61` (обратный синхронизирующий выкат; файлы удаления — только добавленные этим планом).
- Система: профиль `rm /etc/apparmor.d/bwrap && sudo apparmor_parser -r` (или `-R`), `apt-get remove bubblewrap`, права каталогов вернуть 0755 — по факту решения владельца.

## Не входит (напоминание исполнителю)

Чужие проекты на коробке, чистка `~`, `~/.ssh` (ключ выкатывает владелец), `.env.bak*` на проде, удаление архива `~/relay-orphans-20261103.tar.gz` (≥10.11, с OK). Повтор архиватора сирот (6 свежих) — отдельная задача владельца, не этот план.
