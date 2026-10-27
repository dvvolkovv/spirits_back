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
