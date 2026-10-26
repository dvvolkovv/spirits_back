/**
 * Контракт API и студии — строки short_video и ключи MinIO. Импортировать
 * типы студии нельзя (отдельный ESM-пакет вне сборки API), поэтому сторож
 * читает её исходники текстом: переименование поля в одной половине должно
 * ронять тест, а не съёмку на стенде.
 */
import * as fs from 'fs';
import * as path from 'path';
import { planSkits } from './short-skit-prompts';

const studio = (p: string): string => fs.readFileSync(path.join(__dirname, '..', '..', 'studio', 'src', p), 'utf8');

describe('контракт API и студии', () => {
  it('сцена, съёмка и сценарий студии — с полями, которые пишет и читает API', () => {
    const types = studio('types.ts');
    for (const field of [
      'assistantId', 'assistantName', 'followups', 'answerShotWidth', 'answerShotHeight', 'answerText', 'turns',
      'paragraphs', 'hookBox', 'badge', 'assistantsCount', 'disclaimer',
    ]) {
      expect(types).toMatch(new RegExp(`\\b${field}\\??:`));
    }
  });

  it('очередь студии — те же статусы и колонки', () => {
    const db = studio('worker/db.ts');
    for (const s of [
      "'capture_queued'", "'capturing'", "'render_queued'", "'rendering'", "status = 'writing'", "status = 'pending_review'",
      'writer_feedback', 'failed_from', 'failure_notified = false', 'questionShotKey', 'answerShotKey', 'review_message_id = NULL',
    ]) {
      expect(db).toContain(s);
    }
  });

  it('ключи видео и обложки — те, что API шлёт в Telegram', () => {
    const jobs = studio('worker/jobs.ts');
    expect(jobs).toContain('shorts/${id}/video.mp4');
    expect(jobs).toContain('shorts/${id}/cover.jpg');
  });

  it('сценки: студия знает те же поля, что пишет план сценок бэкенда, и в тех же типах', () => {
    const types = studio('types.ts');
    // Поле ищется внутри своего типа: skits и fingerprint есть и в соседних типах.
    const block = (name: string): string => {
      const m = types.match(new RegExp(`(?:interface ${name}(?: extends [^{]+)? |type ${name} = )\\{([\\s\\S]*?)\\n\\}`));
      if (!m) throw new Error(`studio/src/types.ts: нет типа ${name}`);
      return m[1];
    };
    const has = (name: string, field: string) => expect(block(name)).toMatch(new RegExp(`^\\s*${field}\\??:`, 'm'));
    has('Script', 'skits');
    const skit = {
      cast: [{ hero: 'galina' as const, role: 'хозяйка квартиры' }, { hero: 'kesha' as const, role: 'жилец' }],
      setting: 'hallway',
      opening: 'at the door',
      action: 'argue',
      lines: [{ hero: 'kesha' as const, text: 'Это износ.', box: 1 }],
    };
    const { punchline } = planSkits({ conflict: skit, punchline: skit });
    for (const f of Object.keys(punchline)) has('SkitPlan', f);
    for (const f of Object.keys(punchline.skit)) has('Skit', f);
    for (const f of Object.keys(punchline.skit.lines[0])) has('SkitLine', f);
    const kind = /export type SkitKind = ([^;]+);/;
    expect(types.match(kind)?.[1]).toBe(fs.readFileSync(path.join(__dirname, 'short-skit-prompts.ts'), 'utf8').match(kind)?.[1]);
  });
});
