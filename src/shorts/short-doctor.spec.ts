import { DOCTOR_NOTE_PREFIX, LATER_DELAYS_MIN, MAX_AUTO_RECOVERIES, currentCircle, newSceneNote, prescribe, recoveryEntry, recoveryWords } from './short-doctor';
import type { ShortRecovery, ShortStatus } from './shorts.types';

const rec = (action: ShortRecovery['action'], over: Partial<ShortRecovery> = {}): ShortRecovery => ({
  at: '2030-01-01T10:00:00.000Z', from: 'animating', code: 'google_quota', action, reason: 'r', ...over,
});
const v = (over: Record<string, unknown> = {}) => ({
  failedFrom: 'animating' as ShortStatus | null, failedCode: 'google_quota' as string | null, format: 'skit' as const,
  capture: { answerText: 'ответ' } as any, scene: { kind: 'chat' } as any, recoveries: [] as ShortRecovery[], autoRecoveries: 0, lastError: 'оживление: лимит Google исчерпан',
  ...over,
});

describe('prescribe — таблица «этап + код → самопочинка»', () => {
  it.each([
    ['directing', 'relay', 'later'], ['directing', 'lease', 'later'], ['directing', 'rules', 'new_scene'], ['directing', 'no_assistant', 'never'],
    ['writing', 'relay', 'later'], ['writing', 'lease', 'later'], ['writing', 'rules', 'new_scene'], ['writing', 'recapture', 'new_scene'],
    ['writing', 'no_scene', 'new_scene'], ['writing', 'no_conflict', 'new_scene'], ['writing', 'too_long', 'new_scene'],
    ['writing', 'too_short', 'new_scene'], ['writing', 'line_too_short', 'new_scene'], ['writing', 'script_invalid', 'new_scene'],
    ['writing', 'speech_mismatch', 'no_skits'], ['writing', 'omni_rejected', 'no_skits'],
    ['capturing', 'login', 'later'], ['capturing', 'blocked', 'later'], ['capturing', 'idle_timeout', 'later'], ['capturing', 'unknown', 'later'],
    ['capturing', 'lease', 'later'], ['capturing', 'wrong_assistant', 'new_scene'], ['capturing', 'question_hidden', 'new_scene'],
    ['capturing', 'answer_rejected', 'new_scene'], ['capturing', 'no_paragraphs', 'new_scene'],
    ['animating', 'omni_failed', 'later'], ['animating', 'omni_timeout', 'later'], ['animating', 'google_quota', 'later'],
    ['animating', 'keyframe', 'later'], ['animating', 'clip_invalid', 'later'], ['animating', 'stt', 'later'], ['animating', 'lease', 'later'],
    ['animating', 'omni_budget', 'no_skits'], ['animating', 'model_gone', 'no_skits'], ['animating', 'google_auth', 'no_skits'],
    ['animating', 'omni_bad_request', 'no_skits'], ['animating', 'speech_mismatch', 'no_skits'], ['animating', 'omni_rejected', 'no_skits'],
    ['animating', 'keyframe_blocked', 'new_scene'], ['animating', 'script_invalid', 'new_scene'],
    ['rendering', 'tts', 'later'], ['rendering', 'video_invalid', 'later'], ['rendering', 'lease', 'later'], ['rendering', 'frame_size', 'new_scene'],
    ['capturing', 'answer_timeout', 'later'], ['capturing', 'empty_frame', 'later'],
    ['animating', 'omni_unreadable', 'later'], ['animating', 'unknown', 'later'], ['rendering', 'unknown', 'later'],
    ['capturing', 'no_input', 'never'], ['animating', 'no_input', 'never'], ['rendering', 'no_input', 'never'],
    ['publishing', 'telegram', 'never'], ['publishing', null, 'never'],
    ['capturing', 'код-из-будущего', 'later'], ['animating', null, 'later'],
  ])('%s + %s → %s', (from, code, action) => {
    expect(prescribe(v({ failedFrom: from, failedCode: code })).action).toBe(action);
  });

  it('без этапа падения — никак', () => {
    expect(prescribe(v({ failedFrom: null })).action).toBe('never');
  });
});

describe('prescribe — пределы на круг', () => {
  it('«позже»: первый через 30 мин, второй через 2 ч, третьего нет — у съёмки дальше никак', () => {
    expect(prescribe(v({ failedFrom: 'capturing', failedCode: 'login' }))).toEqual({ action: 'later', delayMin: LATER_DELAYS_MIN[0] });
    const once = [rec('later', { from: 'capturing', code: 'login', delayMin: 30 })];
    expect(prescribe(v({ failedFrom: 'capturing', failedCode: 'login', recoveries: once, autoRecoveries: 1 }))).toEqual({ action: 'later', delayMin: LATER_DELAYS_MIN[1] });
    const twice = [...once, rec('later', { from: 'capturing', code: 'login', delayMin: 120 })];
    expect(prescribe(v({ failedFrom: 'capturing', failedCode: 'login', recoveries: twice, autoRecoveries: 2 })).action).toBe('never');
  });

  it('оживление: «позже» исчерпано — без сценок; без сценок уже было — никак', () => {
    const twice = [rec('later', { delayMin: 30 }), rec('later', { delayMin: 120 })];
    expect(prescribe(v({ recoveries: twice, autoRecoveries: 2 })).action).toBe('no_skits');
    const done = [rec('later', { delayMin: 30 }), rec('no_skits')];
    expect(prescribe(v({ failedCode: 'omni_budget', recoveries: done, autoRecoveries: 2 })).action).toBe('never');
  });

  it(`всего на круг — ${MAX_AUTO_RECOVERIES}`, () => {
    const three = [rec('later', { delayMin: 30 }), rec('new_scene', { from: 'capturing', code: 'answer_rejected' }), rec('later', { delayMin: 120 })];
    expect(prescribe(v({ failedCode: 'omni_budget', recoveries: three, autoRecoveries: 3 })).action).toBe('never');
  });

  it('новая сцена — одна на круг', () => {
    const once = [rec('new_scene', { from: 'capturing', code: 'answer_rejected' })];
    expect(prescribe(v({ failedFrom: 'capturing', failedCode: 'answer_rejected', recoveries: once, autoRecoveries: 1 })).action).toBe('never');
  });

  it('без сценок нельзя: ролик уже только чат или без съёмки — никак', () => {
    expect(prescribe(v({ failedCode: 'omni_budget', format: 'chat' })).action).toBe('never');
    expect(prescribe(v({ failedCode: 'omni_budget', capture: null })).action).toBe('never');
  });

  it('круг — последние autoRecoveries записей: история прошлых кругов не мешает', () => {
    const old = [rec('later', { delayMin: 30 }), rec('later', { delayMin: 120 }), rec('no_skits')];
    expect(currentCircle({ recoveries: old, autoRecoveries: 0 })).toEqual([]);
    expect(currentCircle({ recoveries: old, autoRecoveries: 1 })).toEqual([old[2]]);
    expect(prescribe(v({ recoveries: old, autoRecoveries: 0 }))).toEqual({ action: 'later', delayMin: 30 });
  });

  it('«позже» считается на весь круг: после паузы на съёмке первый повтор оживления — уже через 2 ч', () => {
    const once = [rec('later', { from: 'capturing', code: 'login', delayMin: 30 })];
    expect(prescribe(v({ recoveries: once, autoRecoveries: 1 }))).toEqual({ action: 'later', delayMin: LATER_DELAYS_MIN[1] });
  });

  it('оживление, последнее действие круга — без сценок, а не «позже»: ролик выйдет наверняка', () => {
    const two = [rec('new_scene', { from: 'capturing', code: 'answer_rejected' }), rec('later', { delayMin: 30 })];
    expect(prescribe(v({ recoveries: two, autoRecoveries: 2 })).action).toBe('no_skits');
    // У других этапов «без сценок» не лечит — там последнее действие прежнее.
    expect(prescribe(v({ failedFrom: 'capturing', failedCode: 'login', recoveries: two, autoRecoveries: 2 }))).toEqual({ action: 'later', delayMin: LATER_DELAYS_MIN[1] });
  });

  it('оживление: новая сцена круга израсходована — без сценок; у сценариста — никак', () => {
    const once = [rec('new_scene', { code: 'keyframe_blocked' })];
    expect(prescribe(v({ failedCode: 'keyframe_blocked', recoveries: once, autoRecoveries: 1 })).action).toBe('no_skits');
    expect(prescribe(v({ failedFrom: 'writing', failedCode: 'rules', recoveries: once, autoRecoveries: 1 }))).toEqual({ action: 'never' });
  });

  it('счётчик — источник правды о круге: история короче счётчика или с мусором не ломает предел', () => {
    expect(prescribe(v({ recoveries: [], autoRecoveries: MAX_AUTO_RECOVERIES })).action).toBe('never');
    const junk = [null, rec('later', { delayMin: 30 }), 'x'] as unknown as ShortRecovery[];
    expect(currentCircle({ recoveries: junk, autoRecoveries: 3 })).toEqual([junk[1]]);
    expect(() => recoveryWords(currentCircle({ recoveries: junk, autoRecoveries: 3 }))).not.toThrow();
  });

  it('без сцены «без сценок» нельзя: сценарист пишет текст по сцене и съёмке', () => {
    expect(prescribe(v({ failedCode: 'omni_budget', scene: null })).action).toBe('never');
  });
});

describe('слова и записи', () => {
  it('recoveryWords: «повтор через 30 мин (google_quota), повтор через 2 ч (…), новая сцена (…), без сценок (…)»', () => {
    expect(recoveryWords([
      rec('later', { delayMin: 30 }), rec('later', { delayMin: 120 }),
      rec('new_scene', { code: 'answer_rejected' }), rec('no_skits', { code: null }),
    ])).toBe('повтор через 30 мин (google_quota), повтор через 2 ч (google_quota), новая сцена (answer_rejected), без сценок (без кода)');
  });

  it('recoveryEntry: этап, код, действие; пауза — только у «позже»; причина — до 300 знаков', () => {
    const now = new Date('2030-01-01T10:00:00.000Z');
    expect(recoveryEntry(v(), { action: 'later', delayMin: 30 }, now)).toEqual({
      at: '2030-01-01T10:00:00.000Z', from: 'animating', code: 'google_quota', action: 'later', delayMin: 30, reason: 'оживление: лимит Google исчерпан',
    });
    const long = recoveryEntry(v({ lastError: 'я'.repeat(400) }), { action: 'no_skits' }, now);
    expect(long).not.toHaveProperty('delayMin');
    expect(Array.from(long.reason).length).toBeLessThanOrEqual(300);
  });

  it('newSceneNote: «Сам: прошлая сцена не удалась — <причина>»; без причины — код; переводы строк склеены', () => {
    expect(newSceneNote(v({ lastError: 'съёмка: ответ не годится' }))).toBe('Сам: прошлая сцена не удалась — съёмка: ответ не годится');
    expect(newSceneNote(v({ lastError: null, failedCode: 'answer_rejected' }))).toBe('Сам: прошлая сцена не удалась — answer_rejected');
    // Замечания — построчные (appendOwnerNote): многострочная ошибка студии разорвала бы строку «Сам: …».
    expect(newSceneNote(v({ lastError: 'сборка: сценарий не прошёл\n- строка 1\n- строка 2' }))).toBe('Сам: прошлая сцена не удалась — сборка: сценарий не прошёл - строка 1 - строка 2');
    expect(recoveryEntry(v({ lastError: 'a\n  b' }), { action: 'no_skits' }, new Date(0)).reason).toBe('a b');
  });

  it('паузы словами: «1 ч 30 мин», без паузы — «позже»; незнакомое действие — как есть', () => {
    expect(recoveryWords([rec('later', { delayMin: 90 }), rec('later', { delayMin: undefined })])).toBe('повтор через 1 ч 30 мин (google_quota), повтор позже (google_quota)');
    expect(recoveryWords([rec('teleport' as any)])).toBe('teleport (google_quota)');
  });

  it('recoveryEntry без ошибки — пустая причина; строка доктора — с общим префиксом', () => {
    expect(recoveryEntry(v({ lastError: null }), { action: 'no_skits' }, new Date(0)).reason).toBe('');
    expect(newSceneNote(v()).startsWith(`${DOCTOR_NOTE_PREFIX} `)).toBe(true);
  });
});
