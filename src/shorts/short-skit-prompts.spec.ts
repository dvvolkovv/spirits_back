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
    expect(p).toContain(`Exactly 2 characters — ${galina.who} and ${kesha.who} — each appears once.`);
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
    expect(() => buildKeyframePrompt(empty, { continuity: false })).toThrow(/2–3 героя/);
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
    expect(() => buildVideoPrompt(mute)).toThrow(/1–3 реплики/);
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
    expect(() => planSkits({ conflict: c, punchline: punchline() })).toThrow(/сценка conflict: пустая реплика 1 \(galina\)/);
    const one = conflict();
    one.cast = [one.cast[0]];
    one.lines = [one.lines[0]];
    expect(() => planSkits({ conflict: one, punchline: punchline() })).toThrow(/сценка conflict: в составе нужно 2–3 героя/);
    const four = conflict();
    four.cast = [...four.cast, { hero: 'boris', role: 'начальник' }, { hero: 'zhorik', role: 'продавец' }];
    expect(() => planSkits({ conflict: four, punchline: punchline() })).toThrow(/в составе нужно 2–3 героя/);
    const mute = conflict();
    mute.lines = [];
    expect(() => planSkits({ conflict: mute, punchline: punchline() })).toThrow(/нужно 1–3 реплики/);
    const roleless = conflict();
    roleless.cast[1].role = ' ';
    expect(() => planSkits({ conflict: roleless, punchline: punchline() })).toThrow(/у героя kesha нет роли/);
    const fox = punchline();
    fox.cast[0] = { hero: 'fox' as any, role: 'лиса' };
    expect(() => planSkits({ conflict: conflict(), punchline: fox })).toThrow(/сценка punchline: героя «fox» нет в труппе/);
  });

  it('место, первый кадр и действие — английские строки', () => {
    const ru = conflict();
    ru.opening = 'Гусыня в дверях, «Залог мой»';
    expect(() => planSkits({ conflict: ru, punchline: punchline() })).toThrow(/сценка conflict: поле opening — по-английски/);
    const obj = conflict();
    (obj as any).setting = { en: 'hallway' };
    expect(() => planSkits({ conflict: obj, punchline: punchline() })).toThrow(/поле setting — не строка/);
    expect(() => buildKeyframePrompt(ru, { continuity: false })).toThrow(/по-английски/);
    const sign = conflict();
    sign.setting = 'a hallway with a sign "FOR RENT"';
    expect(() => planSkits({ conflict: sign, punchline: punchline() })).toThrow(/поле setting — по-английски и без кавычек/);
  });

  it('правило 17: реплика до 12 слов, сценка до 25 — длиннее Omni не уложит в 8 с', () => {
    const long = conflict();
    long.lines[0].text = 'Раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать.';
    expect(() => planSkits({ conflict: long, punchline: punchline() })).toThrow(/сценка conflict: реплика 1 длиннее 12 слов/);
    const many = conflict();
    const nine = 'Раз два три четыре пять шесть семь восемь девять.';
    many.lines = [{ hero: 'galina', text: nine }, { hero: 'kesha', text: nine }, { hero: 'galina', text: nine }];
    expect(() => planSkits({ conflict: many, punchline: punchline() })).toThrow(/в репликах 27 слов, больше 25/);
    const dash = conflict();
    dash.lines[0].text = 'Раз — два — три — четыре — пять — шесть — семь — восемь — девять — десять — одиннадцать — двенадцать.';
    expect(() => planSkits({ conflict: dash, punchline: punchline() })).not.toThrow();
  });

  it('отпечаток кадра конфликта передаётся только развязке', () => {
    expect(() => planSkit(conflict(), 'conflict', 'abcdef0123456789')).toThrow(/только развязке/);
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
