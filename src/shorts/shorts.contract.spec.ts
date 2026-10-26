/**
 * Контракт API и студии — строки short_video и ключи MinIO. Импортировать
 * типы студии нельзя (отдельный ESM-пакет вне сборки API), поэтому сторож
 * читает её исходники текстом: переименование поля в одной половине должно
 * ронять тест, а не съёмку на стенде.
 */
import * as fs from 'fs';
import * as path from 'path';

const studio = (p: string): string => fs.readFileSync(path.join(__dirname, '..', '..', 'studio', 'src', p), 'utf8');

describe('контракт API и студии', () => {
  it('сцена, съёмка и сценарий студии — с полями, которые пишет и читает API', () => {
    const types = studio('types.ts');
    for (const field of [
      'assistantId', 'assistantName', 'followups', 'answerShotWidth', 'answerShotHeight', 'answerText', 'turns',
      'paragraphs', 'hookBox', 'badge', 'assistantsCount', 'disclaimer',
      'skits', 'troupeVersion', 'heroes', 'keyframePrompt', 'videoPrompt', 'fingerprint',
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
});
