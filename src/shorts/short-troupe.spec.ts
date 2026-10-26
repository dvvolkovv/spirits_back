import * as fs from 'fs';
import * as path from 'path';
import { heroById, TROUPE, TROUPE_VERSION } from './short-troupe';

describe('труппа', () => {
  it('пятеро героев утверждённого листа', () => {
    expect(TROUPE.map((h) => h.id)).toEqual(['kesha', 'galina', 'boris', 'mikhalych', 'zhorik']);
  });

  it('промпт Omni однозначно называет говорящего, генераторам уходит только английский', () => {
    const who = TROUPE.map((h) => h.who);
    expect(new Set(who).size).toBe(who.length);
    for (const h of TROUPE) {
      expect(h.who).toMatch(/^the [a-z]+( [a-z]+)*$/);
      expect(h.look).toContain(h.who.replace(/^the /, ''));
      // Каждая часть облика — про зверя («a pompous cat boss», а не «a pompous boss»): иначе генератор дорисует человека.
      for (const part of h.look.split(/, (?=an? )/)) expect(part).toContain(h.who.replace(/^the /, ''));
      expect(h.voice).toMatch(/voice$/);
      expect(`${h.who} ${h.look} ${h.voice}`).not.toMatch(/[а-яё]/i);
    }
  });

  it('у каждого — роли и коронная фраза для режиссёра и сценариста', () => {
    for (const h of TROUPE) {
      expect(h.roles.length).toBeGreaterThan(0);
      expect(h.catchphrases.length).toBeGreaterThan(0);
    }
  });

  it('heroById находит героя по id и не находит чужого', () => {
    for (const h of TROUPE) expect(heroById(h.id)).toBe(h);
    expect(heroById('fox')).toBeUndefined();
  });

  it('у каждого героя есть портрет в студии', () => {
    for (const h of TROUPE) {
      const f = path.join(__dirname, '..', '..', 'studio', 'assets', 'troupe', TROUPE_VERSION, `${h.id}.png`);
      expect(fs.existsSync(f)).toBe(true);
    }
  });
});
