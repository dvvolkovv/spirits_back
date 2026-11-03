// node --test; без зависимостей. Номера в тестах выдуманные.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sandboxMode, isCanarySession, buildSandboxSettings, buildCliEnv,
} from './sandbox-policy.mjs';

const FS_KEY = 'test_fs-key';

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

test('настройки: своя папка на запись, домашний каталог и mcp на запрет чтения', () => {
  const s = buildSandboxSettings(FS_KEY, { scratch: `/tmp/agent-scratch/${FS_KEY}/`, mcpDir: '/tmp/agent-mcp' });
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.ok(s.sandbox.filesystem.allowWrite.includes(`/tmp/agent-scratch/${FS_KEY}`));
  assert.ok(s.sandbox.filesystem.allowWrite.includes(`/tmp/agent-output/${FS_KEY}`));
  assert.ok(s.sandbox.filesystem.denyRead.includes('/home/dv'));
  assert.ok(s.sandbox.filesystem.denyRead.includes('/etc/sudoers'));
  assert.ok(s.sandbox.filesystem.denyRead.includes('/tmp/agent-mcp'));
  assert.equal(s.sandbox.filesystem.denyRead.includes('/tmp/agent-scratch'), false);
  assert.deepEqual(s.sandbox.network.allowedDomains, ['127.0.0.1:8471']);
  assert.ok(s.sandbox.excludedCommands.includes('sudo *'));
  assert.equal(typeof s.permissions.deny[0], 'string');
  for (const d of s.permissions.deny) assert.match(d, /^(Read|Glob|Grep|Write|Edit)\(/);
});

test('настройки: trailing slash у mcpDir убирается', () => {
  const s = buildSandboxSettings(FS_KEY, { mcpDir: '/tmp/agent-mcp/' });
  assert.ok(s.sandbox.filesystem.denyRead.includes('/tmp/agent-mcp'));
  assert.ok(s.permissions.deny.includes('Read(/tmp/agent-mcp/**)'));
  for (const rule of s.permissions.deny) assert.equal(rule.includes('//**'), false, rule);
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
    PM2_USAGE: '1', MCP_TIMEOUT: '120000' };
  const env = buildCliEnv({
    baseEnv: base,
    providerEnv: {
      ANTHROPIC_BASE_URL: 'https://q',
      ANTHROPIC_AUTH_TOKEN: 't',
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
      CLAUDE_CODE_MAX_RETRIES: '2',
      CLAUDE_CODE_SUBAGENT_MODEL: 'm',
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
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://q');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 't');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'o');
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '2');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'm');
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.UNRELATED, undefined);
  assert.equal(env.HOME, `/tmp/agent-scratch/${FS_KEY}`);
  assert.equal(env.TMPDIR, `/tmp/agent-scratch/${FS_KEY}`);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/dv/.claude');
  assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  assert.ok(env.PATH.startsWith('/opt/linkeon-agent/bin:'));
  assert.equal(env.http_proxy, 'http://127.0.0.1:8471');
  assert.equal(env.https_proxy, env.http_proxy);
  assert.equal(env.no_proxy, undefined);

  const noScrub = buildCliEnv({ baseEnv: {}, providerEnv: {}, fsKey: FS_KEY, scrub: false });
  assert.equal(Object.hasOwn(noScrub, 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'), false);
});
