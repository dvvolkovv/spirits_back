// Регрессия 04.11.2026: при отсутствии дочерних процессов `ps --ppid`
// возвращает 1. Под `set -e` это останавливало deploy-relay до замены файлов,
// хотя пустой список детей — нормальное условие drain.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const source = fs.readFileSync(require.resolve('../../scripts/deploy-relay.sh'), 'utf8');

test('drain: пустой список дочерних процессов не является ошибкой', () => {
  assert.ok(source.includes('CHILDREN=$(ps --ppid "$PID" -o pid= || true)'));
  const bash = 'set -euo pipefail; PID=$1; CHILDREN=$(ps --ppid "$PID" -o pid= || true); [[ -z "$CHILDREN" ]]; echo drain-ok';
  assert.equal(execFileSync('bash', ['-c', bash, 'bash', '99999999'], { encoding: 'utf8' }).trim(), 'drain-ok');
});

test('health-wait: холодному восстановлению сессий даётся 120 секунд', () => {
  assert.ok(source.includes('health_and_release() {\n  for attempt in $(seq 1 120); do'));
});
