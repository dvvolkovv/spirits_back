import { buildKeyframePrompt, buildVideoPrompt, planSkit, Skit, SKIT_FORBIDDEN, skitFingerprint } from './short-skit-prompts';

const conflict = (): Skit => ({
  cast: [
    { hero: 'galina', role: 'хозяйка квартиры' },
    { hero: 'kesha', role: 'жилец' },
  ],
  setting: 'shabby hallway of a rented flat',
  action: 'The goose blocks the doorway and hisses.',
  lines: [
    { hero: 'galina', text: 'Обои потёрли! Залог мой!' },
    { hero: 'kesha', text: 'Спокойно. Спрошу у юриста.' },
  ],
});

describe('промпт кадра', () => {
  it('облик героев из паспортов, роли, место, начало действия и постоянные запреты', () => {
    const p = buildKeyframePrompt(conflict(), { continuity: false });
    expect(p).toContain('a white goose');
    expect(p).toContain('a brown capybara');
    expect(p).toContain('«хозяйка квартиры»');
    expect(p).toContain('shabby hallway of a rented flat');
    expect(p).toContain('The goose blocks the doorway and hisses.');
    expect(p).toContain('Exactly 2 characters');
    expect(p).toContain(SKIT_FORBIDDEN);
    expect(p).not.toContain('previous scene');
  });

  it('у развязки — опора на кадр конфликта', () => {
    expect(buildKeyframePrompt(conflict(), { continuity: true })).toContain('previous scene');
  });

  it('герой не из труппы — ошибка', () => {
    const s = conflict();
    s.cast[0] = { hero: 'fox' as any, role: 'лиса' };
    expect(() => buildKeyframePrompt(s, { continuity: false })).toThrow(/fox.*нет в труппе/);
  });
});

describe('промпт видео', () => {
  it('реплики по порядку, слово в слово, с голосом говорящего', () => {
    const p = buildVideoPrompt(conflict());
    const first = p.indexOf('«Обои потёрли! Залог мой!»');
    const second = p.indexOf('«Спокойно. Спрошу у юриста.»');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(p).toContain('the goose, shrill, loud, grumpy elderly female voice: «Обои');
    expect(p).toContain('in Russian');
    expect(p).toContain(SKIT_FORBIDDEN);
  });

  it('реплика героя не из состава сценки — ошибка', () => {
    const s = conflict();
    s.lines.push({ hero: 'boris', text: 'Не положено.' });
    expect(() => buildVideoPrompt(s)).toThrow(/boris.*не в составе/);
  });
});

describe('отпечаток и план', () => {
  it('та же сценка — тот же отпечаток; другая реплика — другой', () => {
    const a = planSkit(conflict(), 'conflict');
    expect(planSkit(conflict(), 'conflict').fingerprint).toBe(a.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const s = conflict();
    s.lines[1].text = 'Спокойно.';
    expect(planSkit(s, 'conflict').fingerprint).not.toBe(a.fingerprint);
  });

  it('отпечаток зависит от версии труппы', () => {
    const p = planSkit(conflict(), 'conflict');
    expect(skitFingerprint({ ...p, troupeVersion: 'v2' })).not.toBe(p.fingerprint);
  });

  it('развязка отличается опорой на кадр; герои — без повторов, в порядке состава', () => {
    const c = planSkit(conflict(), 'conflict');
    expect(planSkit(conflict(), 'punchline').fingerprint).not.toBe(c.fingerprint);
    expect(c.heroes).toEqual(['galina', 'kesha']);
    expect(c.troupeVersion).toBe('v1');
    expect(c.skit).toEqual(conflict());
  });
});
