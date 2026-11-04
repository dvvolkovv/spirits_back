// Регрессия 04.11.2026: при отсутствии дочерних процессов `ps --ppid`
// возвращает 1. Под `set -e` это останавливало deploy-relay до замены файлов,
// хотя пустой список детей — нормальное условие drain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const source = fs.readFileSync(new URL('../../scripts/deploy-relay.sh', import.meta.url), 'utf8');

test('drain: пустой список дочерних процессов не является ошибкой', () => {
  assert.ok(source.includes('CHILDREN=$(ps --ppid "$PID" -o pid= || true)'));
  const bash = 'set -euo pipefail; PID=$1; CHILDREN=$(ps --ppid "$PID" -o pid= || true); [[ -z "$CHILDREN" ]]; echo drain-ok';
  assert.equal(execFileSync('bash', ['-c', bash, 'bash', '99999999'], { encoding: 'utf8' }).trim(), 'drain-ok');
});
