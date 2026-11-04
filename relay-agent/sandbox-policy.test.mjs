// node --test; без зависимостей. Номера в тестах выдуманные.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sandboxMode, isCanarySession, buildSandboxSettings, buildCliEnv,
  buildSandboxTools, baseToolsForTurn, buildTurnEnv, applySandboxPrompt,
  sandboxFailureFromToolResult, AGENT_MCP_DIR,
} from './sandbox-policy.mjs';

const FS_KEY = 'test_fs-key';
const EXPECTED_ALLOWED_DOMAINS = [
  'example.com',
  'pypi.org',
  'files.pythonhosted.org',
  'registry.npmjs.org',
  'nodejs.org',
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'image.pollinations.ai',
  'fonts.google.com',
  'fonts.gstatic.com',
];
const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'];

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
  const keysFile = path.join(dir, 'canary-keys');
  fs.writeFileSync(keysFile, '79030001111_14_ru\n79030001111_10_en\n');
  assert.equal(isCanarySession('79030001111_14_ru', 'canary', keysFile), true);
  assert.equal(isCanarySession('79990001122_1_ru', 'canary', keysFile), false);
  assert.equal(isCanarySession('79030001111_14_ru', 'on', keysFile), true);
  assert.equal(isCanarySession('79990001122_1_ru', 'on', keysFile), true);
  assert.equal(isCanarySession('79030001111_14_ru', 'off', keysFile), false);
  assert.equal(isCanarySession('79030001111_14_ru', 'canary', path.join(dir, 'missing')), false);
});

test('канарейка: пустые строки файла не включают пустой ключ сессии', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  const keysFile = path.join(dir, 'canary-keys');
  fs.writeFileSync(keysFile, '\n  \n');
  assert.equal(isCanarySession('', 'canary', keysFile), false);
});

test('настройки: своя папка на запись, домашний каталог и mcp на запрет чтения', () => {
  const s = buildSandboxSettings(FS_KEY, { scratch: `/tmp/agent-scratch/${FS_KEY}/`, mcpDir: '/tmp/agent-mcp' });
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.ok(s.sandbox.filesystem.allowWrite.includes(`/tmp/agent-scratch/${FS_KEY}`));
  assert.ok(s.sandbox.filesystem.allowWrite.includes(`/tmp/agent-output/${FS_KEY}`));
  assert.ok(s.sandbox.filesystem.denyRead.includes('/home/dv'));
  assert.ok(s.sandbox.filesystem.denyRead.includes('/etc/sudoers'));
  assert.ok(s.sandbox.filesystem.denyRead.includes('/tmp/agent-mcp'));
  assert.ok(s.sandbox.filesystem.denyRead.includes('/tmp/agent-uploads/mcp'));
  assert.ok(s.permissions.deny.includes('Read(/tmp/agent-uploads/mcp/**)'));
  assert.ok(s.permissions.deny.includes('Edit(/tmp/agent-uploads/mcp/**)'));
  assert.ok(s.sandbox.filesystem.denyRead.includes('/proc'));
  assert.ok(s.permissions.deny.includes('Read(/proc/**)'));
  assert.ok(s.permissions.deny.includes('Edit(/proc/**)'));
  assert.equal(s.sandbox.filesystem.denyRead.includes('/tmp/agent-scratch'), false);
  assert.deepEqual(s.sandbox.network.allowedDomains, EXPECTED_ALLOWED_DOMAINS);
  assert.equal(s.sandbox.network.allowedDomains.includes('*'), false);
  assert.equal(s.sandbox.network.allowedDomains.some((d) => /^(?:localhost|127\.)/.test(d)), false);
  assert.ok(s.sandbox.excludedCommands.includes('sudo *'));
  assert.equal(typeof s.permissions.deny[0], 'string');
  for (const rule of s.permissions.deny) assert.match(rule, /^(Read|Edit)\(/);
  for (const d of s.sandbox.filesystem.denyRead) {
    assert.ok(s.permissions.deny.includes(`Read(${d}/**)`), `Read(${d}/**)`);
    assert.ok(s.permissions.deny.includes(`Edit(${d}/**)`), `Edit(${d}/**)`);
  }
  assert.equal(s.permissions.deny.some((rule) => /^(Glob|Grep|Write)\(/.test(rule)), false);
  assert.equal(s.permissions.deny.length, s.sandbox.filesystem.denyRead.length * 2);
});

test('настройки: trailing slash у mcpDir убирается', () => {
  const s = buildSandboxSettings(FS_KEY, { mcpDir: '/tmp/agent-mcp/' });
  assert.ok(s.sandbox.filesystem.denyRead.includes('/tmp/agent-mcp'));
  assert.ok(s.permissions.deny.includes('Read(/tmp/agent-mcp/**)'));
  for (const rule of s.permissions.deny) assert.equal(rule.includes('//**'), false, rule);
});

test('схема песочницы fail-closed: production принимает только A', () => {
  assert.deepEqual(buildSandboxSettings(FS_KEY, { schema: 'A' }).sandbox.network.allowedDomains, EXPECTED_ALLOWED_DOMAINS);
  for (const schema of ['B', '', 'a', 'unknown']) {
    assert.throws(() => buildSandboxSettings(FS_KEY, { schema }), (e) => e instanceof TypeError && /RELAY_SANDBOX_SCHEMA/.test(e.message));
  }
});

test('сетевой белый список: настройки возвращают копию, а не общую изменяемую константу', () => {
  const first = buildSandboxSettings(FS_KEY);
  first.sandbox.network.allowedDomains.push('mutated.invalid');
  const second = buildSandboxSettings(FS_KEY);
  assert.deepEqual(second.sandbox.network.allowedDomains, EXPECTED_ALLOWED_DOMAINS);
  assert.notEqual(first.sandbox.network.allowedDomains, second.sandbox.network.allowedDomains);
});

test('fsKey: только безопасный сегмент пути', () => {
  for (const fsKey of ['/', '..', '']) {
    assert.throws(() => buildSandboxSettings(fsKey), TypeError);
    assert.throws(() => buildCliEnv({ baseEnv: {}, providerEnv: {}, fsKey, scrub: false }), TypeError);
  }
});

test('cliEnv: белый список, без лишних ключей, scrub включён', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/dv', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    GEMINI_API_KEY: 'x', OPENROUTER_API_KEY: 'x', SSH_AUTH_SOCK: '/tmp/ssh', OLDPWD: '/x',
    PM2_USAGE: '1', MCP_TIMEOUT: '1', MCP_TOOL_TIMEOUT: '2',
    http_proxy: 'http://incoming.invalid', https_proxy: 'http://incoming.invalid',
    HTTP_PROXY: 'http://incoming.invalid', HTTPS_PROXY: 'http://incoming.invalid',
    no_proxy: 'incoming.invalid', NO_PROXY: 'incoming.invalid' };
  const env = buildCliEnv({
    baseEnv: base,
    providerEnv: {
      ANTHROPIC_BASE_URL: 'https://q',
      ANTHROPIC_AUTH_TOKEN: 't',
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
      CLAUDE_CODE_MAX_RETRIES: '2',
      CLAUDE_CODE_SUBAGENT_MODEL: 'm',
      API_TIMEOUT_MS: '300000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      LD_PRELOAD: '/tmp/bad.so',
      NODE_OPTIONS: '--require=/tmp/bad.cjs',
      UNRELATED: 'x',
    },
    fsKey: FS_KEY,
    scrub: true,
  });
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.OLDPWD, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.PM2_USAGE, undefined);
  assert.equal(env.MCP_TIMEOUT, '120000');
  assert.equal(env.MCP_TOOL_TIMEOUT, '600000');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://q');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 't');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'o');
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '2');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'm');
  assert.equal(env.API_TIMEOUT_MS, '300000');
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.UNRELATED, undefined);
  assert.equal(env.HOME, `/tmp/agent-scratch/${FS_KEY}`);
  assert.equal(env.TMPDIR, `/tmp/agent-scratch/${FS_KEY}`);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/dv/.claude');
  assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  assert.ok(env.PATH.startsWith('/opt/linkeon-agent/bin:'));
  for (const key of PROXY_ENV_KEYS) {
    assert.equal(Object.hasOwn(env, key), false, key + ' не должен попадать в spawn env');
  }

  const noScrub = buildCliEnv({ baseEnv: {}, providerEnv: {}, fsKey: FS_KEY, scrub: false });
  assert.equal(Object.hasOwn(noScrub, 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'), false);
});

const LEGACY_TOOLS = 'Bash(*),Read(*),Write(*),Edit(*),Glob(*),Grep(*),WebSearch(*),WebFetch(*)';

test('mcp-каталог песочницы вынесен из загрузок пользователя', () => {
  assert.equal(AGENT_MCP_DIR, '/tmp/agent-mcp');
  assert.equal(AGENT_MCP_DIR.startsWith('/tmp/agent-uploads/'), false);
});

test('инструменты: off возвращает прежний BASE_TOOLS дословно', () => {
  assert.equal(baseToolsForTurn(FS_KEY, false, LEGACY_TOOLS), LEGACY_TOOLS);
});

test('инструменты: on ограничивает Read/Glob/Grep и Write/Edit, но оставляет свои uploads', () => {
  const tools = buildSandboxTools(FS_KEY);
  const rules = tools.split(',');
  assert.equal(baseToolsForTurn(FS_KEY, true, LEGACY_TOOLS), tools);
  for (const name of ['Read', 'Write', 'Edit', 'Glob', 'Grep']) {
    assert.equal(rules.includes(`${name}(*)`), false, name);
  }
  for (const name of ['Read', 'Glob', 'Grep']) {
    for (const root of [
      `/tmp/agent-output/${FS_KEY}/**`,
      `/tmp/agent-scratch/${FS_KEY}/**`,
      `/tmp/agent-uploads/${FS_KEY}_*`,
      '/opt/linkeon-agent/**', '/usr/**', '/etc/**',
    ]) assert.ok(rules.includes(`${name}(${root})`), `${name}(${root})`);
    assert.equal(rules.includes(`${name}(/opt/**)`), false, `${name}(/opt/**)`);
  }
  for (const name of ['Write', 'Edit']) {
    assert.deepEqual(rules.filter((r) => r.startsWith(`${name}(`)).sort(), [
      `${name}(/tmp/agent-output/${FS_KEY}/**)`,
      `${name}(/tmp/agent-scratch/${FS_KEY}/**)`,
    ].sort());
  }
  for (const name of ['Bash(*)', 'WebSearch(*)']) assert.ok(rules.includes(name));
  assert.equal(rules.includes('WebFetch(*)'), false);
});

test('инструменты: повторный базовый список после ошибки MCP не снимает ограничения', () => {
  const baseAllowedTools = () => baseToolsForTurn(FS_KEY, true, LEGACY_TOOLS);
  let allowedTools = baseAllowedTools() + ',mcp__linkeon__tool';
  assert.ok(allowedTools.includes('mcp__linkeon__tool'));
  allowedTools = baseAllowedTools();
  assert.equal(allowedTools, buildSandboxTools(FS_KEY));
  assert.equal(allowedTools.includes('Read(*)'), false);
});

test('окружение процесса: off возвращает прежний объект без каких-либо изменений', () => {
  const legacyEnv = {
    PATH: '/usr/bin:/home/dv/agent-env/bin:/home/dv/.bun/bin:/home/dv/file-agent/bin',
    HOME: '/home/dv', MCP_TIMEOUT: '120000', MCP_TOOL_TIMEOUT: '600000', OMP_THREAD_LIMIT: '1',
  };
  assert.equal(buildTurnEnv({ sandboxOn: false, legacyEnv }), legacyEnv);
  assert.deepEqual(legacyEnv, {
    PATH: '/usr/bin:/home/dv/agent-env/bin:/home/dv/.bun/bin:/home/dv/file-agent/bin',
    HOME: '/home/dv', MCP_TIMEOUT: '120000', MCP_TOOL_TIMEOUT: '600000', OMP_THREAD_LIMIT: '1',
  });
});

test('окружение процесса: on строится белым списком, включает scrub и метку хода', () => {
  const env = buildTurnEnv({
    sandboxOn: true,
    baseEnv: { PATH: '/home/dv/bin', HOME: '/home/dv', LANG: 'C.UTF-8', SECRET: 'x', HTTPS_PROXY: 'http://incoming.invalid' },
    providerEnv: { ANTHROPIC_AUTH_TOKEN: 'token', UNRELATED: 'x' },
    fsKey: FS_KEY, tag: 'run-tag', runEnvName: 'RELAY_RUN_TAG', legacyEnv: {},
  });
  assert.equal(env.HOME, `/tmp/agent-scratch/${FS_KEY}`);
  assert.equal(env.PATH.includes('/home/dv'), false);
  assert.equal(env.SECRET, undefined);
  assert.equal(env.UNRELATED, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'token');
  assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  assert.equal(env.RELAY_RUN_TAG, 'run-tag');
  assert.equal(env.OMP_THREAD_LIMIT, '1');
  for (const key of PROXY_ENV_KEYS) assert.equal(Object.hasOwn(env, key), false, key);
});

const PROMPT_PART = `Full sudo access (no password). Install anything you need.
Python 3.12 venv: source /home/dv/agent-env/bin/activate
INSTALL ANYTHING MISSING: apt, pip, npm, wget — whatever it takes.
fallback: /home/dv/agent-env/bin/generate_image.sh "english prompt" /path/to/output.png
KEEP THIS TEXT`;

test('промпт: off остаётся дословно прежним', () => {
  assert.equal(applySandboxPrompt(PROMPT_PART, false), PROMPT_PART);
});

test('промпт: on не обещает sudo/apt и использует только /opt/linkeon-agent', () => {
  const prompt = applySandboxPrompt(PROMPT_PART, true);
  assert.equal(prompt.includes('Full sudo access'), false);
  assert.equal(prompt.includes('INSTALL ANYTHING MISSING'), false);
  assert.equal(prompt.includes('/home/dv/agent-env'), false);
  assert.match(prompt, /Bash runs in a sandbox/);
  assert.match(prompt, /sudo is unavailable/);
  assert.match(prompt, /Write only to the output directory and your scratch directory/);
  assert.match(prompt, /pip\/npm locally/);
  assert.match(prompt, /allowed domains through the network sandbox/);
  assert.equal(prompt.includes('configured proxy'), false);
  assert.equal(prompt.includes('127.0.0.1:8471'), false);
  assert.ok(prompt.includes('/opt/linkeon-agent/venv/bin/activate'));
  assert.ok(prompt.includes('/opt/linkeon-agent/bin/generate_image.sh'));
  assert.ok(prompt.endsWith('KEEP THIS TEXT'));
});

test('детект сбоя песочницы: только tool_result известного Bash tool_use', () => {
  const bashIds = new Set(['bash-1']);
  const event = (id, content) => ({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
  assert.equal(sandboxFailureFromToolResult(event('bash-1', 'bwrap: failed'), bashIds), true);
  assert.equal(sandboxFailureFromToolResult(event('bash-1', 'No New Privileges error'), bashIds), true);
  assert.equal(sandboxFailureFromToolResult(event('bash-1', [{ type: 'text', text: 'SANDBOX denied' }]), bashIds), true);
  assert.equal(sandboxFailureFromToolResult(event('other-tool', 'bwrap: failed'), bashIds), false);
  assert.equal(sandboxFailureFromToolResult(event('bash-1', 'command completed'), bashIds), false);
  assert.equal(sandboxFailureFromToolResult({ type: 'assistant', message: { content: [] } }, bashIds), false);
});
