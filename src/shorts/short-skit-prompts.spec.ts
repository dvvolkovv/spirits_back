import { heroById, TROUPE_VERSION } from './short-troupe';
import {
  buildKeyframePrompt,
  buildVideoPrompt,
  planSkit,
  planSkits,
  Skit,
  SKIT_FORBIDDEN,
  SKIT_FRAMING,
  skitFingerprints,
} from './short-skit-prompts';

const conflict = (): Skit => ({
  cast: [
    { hero: 'galina', role: 'хозяйка квартиры' },
    { hero: 'kesha', role: 'жилец' },
  ],
  setting: 'shabby hallway of a rented flat',
  opening: 'The goose blocks the doorway, the capybara stands with a suitcase',
  action: 'The goose hisses and flaps her wings.',
  lines: [
    { hero: 'galina', text: 'Обои потёрли! Залог мой!' },
    { hero: 'kesha', text: 'Спокойно. Спрошу у юриста.' },
  ],
});

const punchline = (): Skit => ({
  ...conflict(),
  opening: 'The capybara holds up the phone',
  action: 'The goose lowers her wings.',
  lines: [
    { hero: 'kesha', text: 'Три года — нормальный износ.', box: 1 },
    { hero: 'galina', text: 'Га-га… ладно.' },
  ],
});

const galina = heroById('galina');
const kesha = heroById('kesha');

describe('промпт кадра', () => {
  it('облик героев из паспортов по порядку, место, первый кадр, рамка и запреты', () => {
    const p = buildKeyframePrompt(conflict(), { continuity: false });
    expect(p).toContain(`1) ${galina.look}; 2) ${kesha.look}.`);
    expect(p).toContain('Exactly 2 characters, each appears once.');
    expect(p).toContain('Setting: shabby hallway of a rented flat.');
    expect(p).toContain('The picture: The goose blocks the doorway, the capybara stands with a suitcase.');
    expect(p).toContain(SKIT_FRAMING);
    expect(p).toContain(SKIT_FORBIDDEN);
    expect(p).not.toContain('previous scene');
    expect(p).not.toContain('hisses');
  });

  it('без кириллицы и «ёлочек»: надписи генератор картинок рисует охотно', () => {
    expect(buildKeyframePrompt(conflict(), { continuity: false })).not.toMatch(/[а-яё«»]/i);
  });

  it('у развязки — опора на кадр конфликта', () => {
    expect(buildKeyframePrompt(conflict(), { continuity: true })).toContain('The last image is the previous scene');
  });

  it('точка в конце фразы не удваивается, лишние пробелы схлопываются', () => {
    const s = conflict();
    s.setting = '  hallway.  ';
    s.opening = 'Goose   at the door';
    const p = buildKeyframePrompt(s, { continuity: false });
    expect(p).toContain('Setting: hallway. The picture: Goose at the door.');
  });

  it('состав: чужой герой, повтор, пустой — ошибка', () => {
    const fox = conflict();
    fox.cast[0] = { hero: 'fox' as any, role: 'лиса' };
    expect(() => buildKeyframePrompt(fox, { continuity: false })).toThrow(/fox.*нет в труппе/);
    const twice = conflict();
    twice.cast[1] = { hero: 'galina', role: 'соседка' };
    expect(() => buildKeyframePrompt(twice, { continuity: false })).toThrow(/galina.*дважды/);
    const empty = conflict();
    empty.cast = [];
    expect(() => buildKeyframePrompt(empty, { continuity: false })).toThrow(/нет героев/);
  });
});

describe('промпт видео', () => {
  it('действие и реплики по порядку, слово в слово, с голосом говорящего', () => {
    const p = buildVideoPrompt(conflict());
    expect(p).toContain('The goose hisses and flaps her wings.');
    const first = p.indexOf('«Обои потёрли! Залог мой!»');
    const second = p.indexOf('«Спокойно. Спрошу у юриста.»');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(p).toContain(`1) ${galina.who} (${galina.voice}) says in Russian: «Обои`);
    expect(p).toContain('Only the speaker talks');
    expect(p).toContain(SKIT_FORBIDDEN);
  });

  it('реплика героя не из состава и сценка без реплик — ошибка', () => {
    const s = conflict();
    s.lines.push({ hero: 'boris', text: 'Не положено.' });
    expect(() => buildVideoPrompt(s)).toThrow(/boris.*не в составе/);
    const mute = conflict();
    mute.lines = [];
    expect(() => buildVideoPrompt(mute)).toThrow(/нет реплик/);
  });
});

describe('отпечатки', () => {
  const pair = () => planSkits({ conflict: conflict(), punchline: punchline() });

  it('та же пара — те же отпечатки; порядок полей не важен', () => {
    const a = pair();
    expect(a.conflict.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(a.conflict.keyframeFingerprint).toMatch(/^[0-9a-f]{16}$/);
    const reordered = Object.fromEntries(Object.entries(conflict()).reverse()) as unknown as Skit;
    const b = planSkits({ conflict: reordered, punchline: punchline() });
    expect(b.conflict.fingerprint).toBe(a.conflict.fingerprint);
    expect(b.punchline.fingerprint).toBe(a.punchline.fingerprint);
  });

  it('правка реплики конфликта — новый клип конфликта с прежнего кадра, развязка та же', () => {
    const a = pair();
    const s = conflict();
    s.lines[1].text = 'Спокойно.';
    const b = planSkits({ conflict: s, punchline: punchline() });
    expect(b.conflict.keyframeFingerprint).toBe(a.conflict.keyframeFingerprint);
    expect(b.conflict.fingerprint).not.toBe(a.conflict.fingerprint);
    expect(b.punchline).toEqual(a.punchline);
  });

  it('новое место конфликта перерисовывает и развязку', () => {
    const a = pair();
    const s = conflict();
    s.setting = 'stairwell of an old block of flats';
    const b = planSkits({ conflict: s, punchline: punchline() });
    expect(b.conflict.keyframeFingerprint).not.toBe(a.conflict.keyframeFingerprint);
    expect(b.punchline.keyframeFingerprint).not.toBe(a.punchline.keyframeFingerprint);
    expect(b.punchline.fingerprint).not.toBe(a.punchline.fingerprint);
  });

  it('роль и опора на абзац отпечатки не меняют', () => {
    const a = pair();
    const c = conflict();
    c.cast[0].role = 'соседка';
    const p = punchline();
    p.lines[0].box = 5;
    const b = planSkits({ conflict: c, punchline: p });
    expect(b.conflict.fingerprint).toBe(a.conflict.fingerprint);
    expect(b.punchline.fingerprint).toBe(a.punchline.fingerprint);
  });

  it('версия труппы входит в оба отпечатка', () => {
    const base = { kind: 'conflict' as const, keyframePrompt: 'k', videoPrompt: 'v' };
    const v1 = skitFingerprints({ ...base, troupeVersion: 'v1' });
    const v2 = skitFingerprints({ ...base, troupeVersion: 'v2' });
    expect(v2.keyframeFingerprint).not.toBe(v1.keyframeFingerprint);
    expect(v2.fingerprint).not.toBe(v1.fingerprint);
  });

  it('пустые поля, состав и реплики ловятся до промптов — с именем сценки', () => {
    const p = punchline();
    delete (p as any).setting;
    expect(() => planSkits({ conflict: conflict(), punchline: p })).toThrow(/сценка punchline: пустое поле setting/);
    const c = conflict();
    c.lines[0].text = '  ';
    expect(() => planSkits({ conflict: c, punchline: punchline() })).toThrow(/сценка conflict: пустая реплика героя galina/);
    const one = conflict();
    one.cast = [one.cast[0]];
    one.lines = [one.lines[0]];
    expect(() => planSkits({ conflict: one, punchline: punchline() })).toThrow(/сценка conflict: в составе нужно 2–3 героя/);
    const fox = punchline();
    fox.cast[0] = { hero: 'fox' as any, role: 'лиса' };
    expect(() => planSkits({ conflict: conflict(), punchline: fox })).toThrow(/сценка punchline: героя «fox» нет в труппе/);
  });

  it('развязку без кадра конфликта не планируем', () => {
    expect(() => planSkit(punchline(), 'punchline')).toThrow(/planSkits/);
  });

  it('план несёт сценку, версию труппы и героев в порядке состава', () => {
    const c = pair().conflict;
    expect(c.skit).toEqual(conflict());
    expect(c.troupeVersion).toBe(TROUPE_VERSION);
    expect(c.heroes).toEqual(['galina', 'kesha']);
  });
});
