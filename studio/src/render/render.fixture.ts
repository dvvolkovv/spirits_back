import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ttsKey } from '../tts';
import { renderRun } from './run-render';

/**
 * Сборка ролика из фикстуры без сети: картинки и «голос» (синус) делает
 * ffmpeg, озвучка берётся из кеша. Папка не удаляется — по ней смотрят кадры.
 */
test('рендер фикстуры: 1080×1920, 30–60 с, звук по всей длине', { timeout: 15 * 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fixture-'));
  console.log(`fixture: ${dir}`);
  const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ff('-f', 'lavfi', '-i', 'color=c=0xedfaed:s=1080x1920', '-frames:v', '1', path.join(dir, 'question.png'));
  ff('-f', 'lavfi', '-i', 'color=c=white:s=1080x5400', '-frames:v', '1', path.join(dir, 'answer.png'));

  const lines = [
    { id: 'h', scene: 'hook', text: 'Юрист нашёл три ловушки', ms: 2000 },
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист. Пришлите договор — проверю.', ms: 5000 },
    { id: 'a1', scene: 'answer', text: 'Первая ловушка — залог без срока возврата.', ms: 9000, box: 1 },
    { id: 'a2', scene: 'answer', text: 'Вторая — ремонт за ваш счёт.', ms: 9000, box: 2 },
    { id: 'a3', scene: 'answer', text: 'Третья — выселение без уведомления.', ms: 9000, box: 3 },
    { id: 'f', scene: 'final', text: 'Linkeon. Ссылка — в описании.', ms: 4000 },
  ] as const;
  fs.mkdirSync(path.join(dir, 'voice'));
  const manifest: Record<string, { key: string; durationMs: number }> = {};
  for (const l of lines) {
    ff('-f', 'lavfi', '-i', `sine=frequency=440:duration=${l.ms / 1000}`, '-ac', '1', '-ar', '44100', path.join(dir, 'voice', `${l.id}.mp3`));
    manifest[l.id] = { key: ttsKey({ text: l.text, voice: 'madirus', speed: 1 }), durationMs: l.ms };
  }
  fs.writeFileSync(path.join(dir, 'voice', 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(dir, 'capture.json'),
    JSON.stringify({
      scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Проверьте договор', followups: [] },
      cabinetUrl: 'fixture',
      capturedAt: new Date(0).toISOString(),
      questionShot: 'question.png',
      answerShot: 'answer.png',
      answerShotWidth: 1080,
      answerShotHeight: 5400,
      answerText: 'x'.repeat(500),
      turns: 1,
      assistantsCount: 18,
      boxes: [
        { n: 1, top: 900, height: 300, text: 'a' },
        { n: 2, top: 2400, height: 300, text: 'b' },
        { n: 3, top: 4200, height: 300, text: 'c' },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'script.json'),
    JSON.stringify({
      hook: 'Юрист нашёл три ловушки',
      voice: 'madirus',
      speed: 1,
      lines: lines.map((l) => ({ id: l.id, scene: l.scene, text: l.text, ...('box' in l ? { box: l.box } : {}) })),
      final: { disclaimer: 'Ответ ИИ, не заменяет специалиста' },
    }),
  );

  const r = await renderRun(dir, { skipTts: true });
  assert.deepEqual(r.problems, []);
  assert.ok(fs.statSync(r.cover).size > 10_000, 'обложка подозрительно мала');
});
