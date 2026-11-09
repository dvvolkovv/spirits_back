const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEPLOY = path.join(__dirname, '..', '..', 'scripts', 'deploy.sh');
const HEX64 = /^[0-9a-f]{64}$/;

function withBack(content, fn) {
  const back = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-retention-secret-'));
  const file = path.join(back, '.env');
  if (content !== null) fs.writeFileSync(file, content);
  try {
    return fn({ back, file });
  } finally {
    fs.rmSync(back, { recursive: true, force: true });
  }
}

function runProbe(back, {
  readonly = false,
  prelude = '',
  path: probePath = process.env.PATH,
} = {}) {
  const extracted = spawnSync(
    'sed',
    ['-n', '/^retention_unsubscribe_secret_probe()/,/^}/p', DEPLOY],
    { encoding: 'utf8' },
  );
  assert.equal(extracted.status, 0, extracted.stderr);
  const env = {
    PATH: probePath,
    BACK: back,
    RS_READONLY: readonly ? '1' : '',
  };
  const generated = spawnSync('bash', ['-s'], {
    input: `${extracted.stdout}\nretention_unsubscribe_secret_probe\n`,
    encoding: 'utf8',
    env,
  });
  if (generated.error) throw generated.error;
  assert.equal(generated.status, 0, generated.stderr);
  const result = spawnSync('bash', ['-s'], {
    input: `${prelude}\n${generated.stdout}`,
    encoding: 'utf8',
    env,
  });
  if (result.error) throw result.error;
  return result;
}

function outputLines(result) {
  return result.stdout.split('\n').filter(Boolean);
}

function statusLine(result, status) {
  return outputLines(result).find((line) => (
    line === status || line.startsWith(`${status} `) || line.startsWith(`${status}=`)
  ));
}

function returnedValue(result) {
  const line = outputLines(result).find((item) => item.startsWith('RS_VALUE='));
  return line ? line.slice('RS_VALUE='.length) : null;
}

function variableLines(content) {
  return content.split('\n').filter((line) => /^RETENTION_UNSUBSCRIBE_SECRET=/.test(line));
}

test('missing variable is generated once and the second probe reuses it', () => {
  withBack('ALPHA=one\nexport BETA="two"\n', ({ back, file }) => {
    const before = fs.readFileSync(file, 'utf8');
    const beforeStat = fs.statSync(file);

    const first = runProbe(back);
    assert.ok(statusLine(first, 'RS_ADDED'), first.stderr || first.stdout);
    const value = returnedValue(first);
    assert.match(value || '', HEX64);
    assert.deepEqual(outputLines(first), ['RS_ADDED', `RS_VALUE=${value}`]);

    const afterFirst = fs.readFileSync(file, 'utf8');
    assert.equal(afterFirst, `${before}RETENTION_UNSUBSCRIBE_SECRET=${value}\n`);
    assert.equal(variableLines(afterFirst).length, 1);
    const afterStat = fs.statSync(file);
    assert.equal(afterStat.mode, beforeStat.mode);
    assert.equal(afterStat.uid, beforeStat.uid);
    assert.equal(afterStat.gid, beforeStat.gid);

    const second = runProbe(back);
    assert.equal(returnedValue(second), value);
    assert.equal(statusLine(second, 'RS_ADDED'), undefined);
    assert.deepEqual(outputLines(second), [`RS_VALUE=${value}`]);
    assert.equal(fs.readFileSync(file, 'utf8'), afterFirst);
    assert.equal(variableLines(fs.readFileSync(file, 'utf8')).length, 1);
  });
});

test('an existing valid 64-hex value is returned without changing the file', () => {
  const value = 'a'.repeat(64);
  const content = `OTHER=keep\nexport RETENTION_UNSUBSCRIBE_SECRET="${value}"\r\n`;
  withBack(content, ({ back, file }) => {
    const result = runProbe(back);
    assert.equal(returnedValue(result), value, result.stderr || result.stdout);
    assert.deepEqual(outputLines(result), [`RS_VALUE=${value}`]);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  });
});

test('short, non-hex, and whitespace-containing values are rejected unchanged', () => {
  const cases = [
    { name: 'short', value: 'a'.repeat(63), status: 'RS_SHORT' },
    { name: 'non-hex', value: 'g'.repeat(64), status: 'RS_BAD' },
    { name: 'whitespace inside', value: `${'a'.repeat(32)} ${'b'.repeat(31)}`, status: 'RS_BAD' },
  ];
  for (const item of cases) {
    const content = `OTHER=keep\nRETENTION_UNSUBSCRIBE_SECRET="${item.value}"\n`;
    withBack(content, ({ back, file }) => {
      const result = runProbe(back);
      assert.ok(statusLine(result, item.status), `${item.name}: ${result.stderr || result.stdout}`);
      assert.equal(returnedValue(result), null, item.name);
      assert.equal(statusLine(result, 'RS_ADDED'), undefined, item.name);
      assert.equal(fs.readFileSync(file, 'utf8'), content, item.name);
    });
  }
});

test('readonly mode with a missing variable returns RS_ERR without generating or writing', () => {
  const content = 'OTHER=keep\n';
  withBack(content, ({ back, file }) => {
    const result = runProbe(back, { readonly: true });
    assert.ok(statusLine(result, 'RS_ERR'), result.stderr || result.stdout);
    assert.equal(returnedValue(result), null);
    assert.equal(statusLine(result, 'RS_ADDED'), undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  });
});

test('a missing .env returns RS_ERR and is not created', () => {
  withBack(null, ({ back, file }) => {
    const result = runProbe(back);
    assert.ok(statusLine(result, 'RS_ERR'), result.stderr || result.stdout);
    assert.equal(returnedValue(result), null);
    assert.equal(fs.existsSync(file), false);
  });
});

test('a file without a trailing newline gets a newline before the appended variable', () => {
  const content = 'OTHER=keep';
  withBack(content, ({ back, file }) => {
    const result = runProbe(back);
    assert.ok(statusLine(result, 'RS_ADDED'), result.stderr || result.stdout);
    const value = returnedValue(result);
    assert.match(value || '', HEX64);
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      `OTHER=keep\nRETENTION_UNSUBSCRIBE_SECRET=${value}\n`,
    );
  });
});

test('missing flock returns RS_ERR before reading or writing .env', () => {
  const content = 'OTHER=keep\n';
  withBack(content, ({ back, file }) => {
    const prelude = [
      'command() {',
      '  if [ "${1:-}" = "-v" ] && [ "${2:-}" = "flock" ]; then return 1; fi',
      '  builtin command "$@"',
      '}',
    ].join('\n');
    const result = runProbe(back, { prelude });
    assert.ok(statusLine(result, 'RS_ERR'), result.stderr || result.stdout);
    assert.equal(statusLine(result, 'RS_ADDED'), undefined);
    assert.equal(returnedValue(result), null);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  });
});

test('an unreadable .env returns RS_ERR and is restored without any append', () => {
  const content = 'OTHER=keep\n';
  withBack(content, ({ back, file }) => {
    let result;
    fs.chmodSync(file, 0);
    try {
      result = runProbe(back);
    } finally {
      fs.chmodSync(file, 0o600);
    }
    assert.ok(statusLine(result, 'RS_ERR'), result.stderr || result.stdout);
    assert.equal(statusLine(result, 'RS_ADDED'), undefined);
    assert.equal(returnedValue(result), null);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  });
});

test('tail -c1 failure returns RS_ERR and leaves .env byte-identical', () => {
  const content = 'OTHER=keep';
  withBack(content, ({ back, file }) => {
    const bin = path.join(back, 'mock-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'tail'), [
      '#!/usr/bin/env bash',
      'if [ "${1:-}" = "-c1" ]; then exit 42; fi',
      'exec /usr/bin/tail "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
    const result = runProbe(back, { path: `${bin}:${process.env.PATH}` });
    assert.ok(statusLine(result, 'RS_ERR'), result.stderr || result.stdout);
    assert.equal(statusLine(result, 'RS_ADDED'), undefined);
    assert.equal(returnedValue(result), null);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  });
});

test('newline printf failure returns RS_ERR and leaves .env byte-identical', () => {
  const content = 'OTHER=keep';
  withBack(content, ({ back, file }) => {
    const bin = path.join(back, 'mock-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'printf'), [
      '#!/usr/bin/env bash',
      'if [ "${1:-}" = "\\n" ]; then exit 43; fi',
      'exec /usr/bin/printf "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
    const result = runProbe(back, {
      path: `${bin}:${process.env.PATH}`,
      prelude: 'enable -n printf',
    });
    assert.ok(statusLine(result, 'RS_ERR'), result.stderr || result.stdout);
    assert.equal(statusLine(result, 'RS_ADDED'), undefined);
    assert.equal(returnedValue(result), null);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  });
});

test('run_phase checks the retention secret immediately after DEBUG_SECRET', () => {
  const script = fs.readFileSync(DEPLOY, 'utf8');
  const runPhase = script.match(/^run_phase\(\) \{[\s\S]*?^\}/m);
  assert.ok(runPhase, 'run_phase function is present');
  assert.match(
    runPhase[0],
    /^  ensure_debug_secret \|\| return 1\n  ensure_retention_unsubscribe_secret \|\| return 1$/m,
  );
});

test('deploy.sh passes bash syntax checking', () => {
  const result = spawnSync('bash', ['-n', DEPLOY], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
