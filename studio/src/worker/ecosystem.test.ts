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
