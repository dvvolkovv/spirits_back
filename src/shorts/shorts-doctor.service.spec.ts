import { ShortsDoctorService } from './shorts-doctor.service';
import { rowToShort } from './shorts.types';

const NOW = new Date('2030-01-01T10:00:00.000Z');
const failed = (over: Record<string, any> = {}) =>
  rowToShort({
    id: 'v1', rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't', status: 'failed', format: 'skit',
    failed_from: 'animating', failed_code: 'google_quota', last_error: 'оживление: лимит Google исчерпан', failure_notified: true,
    capture: { answerText: 'ответ', paragraphs: [] }, owner_note: null, recoveries: [], auto_recoveries: 0,
    // Сцена нужна «без сценок» (prescribe, задача 5, шаг 5): сценарист пишет текст по сцене и съёмке.
    scene: { kind: 'chat', assistantId: 1, assistantName: 'Алексей', question: 'Вопрос', followups: [] }, ...over,
  });

function setup(rowCount = 1) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' '), params });
      return { rows: [], rowCount };
    }),
  };
  return { svc: new ShortsDoctorService(pg as any), calls };
}

describe('ShortsDoctorService', () => {
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.SHORTS_AUTO_HEAL;
  });
  afterAll(() => {
    process.env = env;
  });

  it('«позже»: тот же этап в очередь с паузой 30 мин, попытки с нуля, запись в историю — по захваченному сбою', async () => {
    const { svc, calls } = setup();
    expect(await svc.treat(failed(), NOW)).toBe('took');
    expect(calls).toHaveLength(1);
    const [w] = calls;
    expect(w.sql).toMatch(/SET status = \$4, lease_until = now\(\) \+ make_interval\(mins => \$5\)/);
    expect(w.sql).toMatch(/attempts = 0, last_error = NULL, failed_from = NULL, failed_code = NULL, failure_notified = false/);
    expect(w.sql).toMatch(/auto_recoveries = auto_recoveries \+ 1, recoveries = recoveries \|\| \$3::jsonb/);
    expect(w.sql).toMatch(/WHERE id = \$1 AND status = 'failed' AND failed_from = \$2 AND failure_notified$/);
    expect(w.params.slice(0, 2)).toEqual(['v1', 'animating']);
    expect(JSON.parse(w.params[2])).toEqual([
      { at: NOW.toISOString(), from: 'animating', code: 'google_quota', action: 'later', delayMin: 30, reason: 'оживление: лимит Google исчерпан' },
    ]);
    expect(w.params.slice(3)).toEqual(['animate_queued', 30]);
  });

  it('«новая сцена»: режиссёр, строка «Сам: …» к замечаниям, отзывы и круги сценариста — с нуля, формат прежний', async () => {
    const { svc, calls } = setup();
    const v = failed({ failed_from: 'capturing', failed_code: 'answer_rejected', last_error: 'съёмка: ответ не годится', owner_note: 'Короче.' });
    expect(await svc.treat(v, NOW)).toBe('took');
    const [w] = calls;
    expect(w.sql).toMatch(/SET status = 'directing', lease_until = NULL, writer_rounds = 0, owner_note = \$4, writer_feedback = NULL, skit_feedback = NULL/);
    expect(w.sql).not.toMatch(/format/);
    expect(w.params[3]).toBe('Короче.\nСам: прошлая сцена не удалась — съёмка: ответ не годится');
    expect(JSON.parse(w.params[2])[0]).toMatchObject({ from: 'capturing', code: 'answer_rejected', action: 'new_scene' });
  });

  it('«без сценок»: сценарист в формате chat; оживление (счёт секунд Omni) не трогается', async () => {
    const { svc, calls } = setup();
    expect(await svc.treat(failed({ failed_code: 'omni_budget' }), NOW)).toBe('took');
    const [w] = calls;
    expect(w.sql).toMatch(/SET status = 'writing', format = 'chat', lease_until = NULL, writer_rounds = 0, writer_feedback = NULL, skit_feedback = NULL/);
    expect(w.sql).not.toMatch(/animation/);
    expect(JSON.parse(w.params[2])[0].action).toBe('no_skits');
  });

  it('запись ничего не нашла (владелец успел нажать кнопку) — gone', async () => {
    const { svc } = setup(0);
    expect(await svc.treat(failed(), NOW)).toBe('gone');
  });

  it('не лечится или ролик не упал — gave_up, в базу ничего', async () => {
    const { svc, calls } = setup();
    expect(await svc.treat(failed({ failed_from: 'directing', failed_code: 'no_assistant' }), NOW)).toBe('gave_up');
    expect(await svc.treat(failed({ failed_from: 'publishing', failed_code: null }), NOW)).toBe('gave_up');
    expect(await svc.treat(failed({ status: 'writing' }), NOW)).toBe('gave_up');
    expect(calls).toHaveLength(0);
  });

  it('SHORTS_AUTO_HEAL=false — выключен: gave_up без записи; любое другое значение и отсутствие — включён', async () => {
    process.env.SHORTS_AUTO_HEAL = ' FALSE ';
    const off = setup();
    expect(await off.svc.treat(failed(), NOW)).toBe('gave_up');
    expect(off.calls).toHaveLength(0);
    process.env.SHORTS_AUTO_HEAL = 'true';
    expect(await setup().svc.treat(failed(), NOW)).toBe('took');
    delete process.env.SHORTS_AUTO_HEAL;
    expect(await setup().svc.treat(failed(), NOW)).toBe('took');
  });
});
