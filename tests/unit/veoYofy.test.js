/**
 * Unit-тест авто-ёфикации реплики Veo (video.service.yofy).
 * Фидбэк katya: Veo читает «е» вместо «ё» («взлет» вместо «взлёт»). Словарь —
 * безопасный список (только однозначные слова, без омографов полет/полёт).
 * Inline-копия парсера/логики (как остальные unit; данные — src/video/yo-safe.txt).
 */
const fs = require('fs');
const path = require('path');

function loadYoMap() {
  const map = new Map();
  const file = path.join(__dirname, '..', '..', 'src', 'video', 'yo-safe.txt');
  const txt = fs.readFileSync(file, 'utf8');
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^(]+)(?:\(([^)]*)\))?$/);
    if (!m) continue;
    const base = m[1];
    const forms = [base];
    if (m[2]) for (const e of m[2].split('|')) forms.push(base + e);
    for (const f of forms) {
      const key = f.replace(/ё/g, 'е').replace(/Ё/g, 'Е').toLowerCase();
      if (key !== f.toLowerCase()) map.set(key, f.toLowerCase());
    }
  }
  return map;
}
const map = loadYoMap();
const yofy = (text) => text.replace(/[а-яёА-ЯЁ]+/g, (w) => {
  const v = map.get(w.toLowerCase());
  if (!v) return w;
  return /^[А-ЯЁ]/.test(w) ? v.charAt(0).toUpperCase() + v.slice(1) : v;
});

describe('Veo yofy (ёфикация реплики)', () => {
  test('словарь загрузился', () => {
    expect(map.size).toBeGreaterThan(1000);
  });
  test('однозначные слова получают ё (главный кейс katya: взлёт)', () => {
    expect(yofy('Кормите при взлете и посадке')).toBe('Кормите при взлёте и посадке');
    expect(yofy('теплый прием')).toBe('тёплый приём');
  });
  test('сохраняется регистр первой буквы', () => {
    expect(yofy('Взлет')).toBe('Взлёт');
  });
  test('омографы вне safe-словаря НЕ трогаются (все/всё — неоднозначно)', () => {
    expect(yofy('все включено')).toBe('все включено');
  });
  test('пунктуация и не-русский текст не ломаются', () => {
    expect(yofy('Talking head: «взлете», 16s.')).toBe('Talking head: «взлёте», 16s.');
  });
  test('пустая строка', () => {
    expect(yofy('')).toBe('');
  });
});
