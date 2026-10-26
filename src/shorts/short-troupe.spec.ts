import * as fs from 'fs';
import * as path from 'path';
import { heroById, TROUPE, TROUPE_VERSION } from './short-troupe';

describe('труппа', () => {
  it('пятеро героев утверждённого листа, id без повторов', () => {
    expect(TROUPE.map((h) => h.id)).toEqual(['kesha', 'galina', 'boris', 'mikhalych', 'zhorik']);
    expect(TROUPE_VERSION).toBe('v1');
  });

  it('у каждого — облик и голос для промптов, роли и коронная фраза', () => {
    for (const h of TROUPE) {
      expect(h.look.length).toBeGreaterThan(20);
      expect(h.voice).toMatch(/voice$/);
      expect(h.who).toMatch(/^the [a-z]+$/);
      expect(h.roles.length).toBeGreaterThan(0);
      expect(h.catchphrases.length).toBeGreaterThan(0);
    }
  });

  it('heroById находит героя и не находит чужого', () => {
    expect(heroById('galina')?.name).toBe('Гусыня Галина Петровна');
    expect(heroById('fox')).toBeUndefined();
  });

  it('у каждого героя есть портрет в студии', () => {
    for (const h of TROUPE) {
      const f = path.join(__dirname, '..', '..', 'studio', 'assets', 'troupe', TROUPE_VERSION, `${h.id}.png`);
      expect(fs.existsSync(f)).toBe(true);
    }
  });
});
