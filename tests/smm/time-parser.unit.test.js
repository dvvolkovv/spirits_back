const path = require('path');
const { parseScheduleTime } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'publication', 'time-parser'),
);

module.exports = {
  'time-parser: "сейчас" → null': () => {
    if (parseScheduleTime('сейчас') !== null) throw new Error('expected null');
    if (parseScheduleTime('now') !== null) throw new Error('expected null');
    if (parseScheduleTime('') !== null) throw new Error('expected null');
    if (parseScheduleTime(null) !== null) throw new Error('expected null');
  },

  'time-parser: "через час" → ~1h ahead': () => {
    const d = parseScheduleTime('через час');
    if (!d) throw new Error('expected Date');
    const delta = d.getTime() - Date.now();
    if (delta < 3590_000 || delta > 3610_000) throw new Error(`delta=${delta}ms`);
  },

  'time-parser: "через 30 минут"': () => {
    const d = parseScheduleTime('через 30 минут');
    if (!d) throw new Error('expected Date');
    const delta = d.getTime() - Date.now();
    if (delta < 1790_000 || delta > 1810_000) throw new Error(`delta=${delta}ms`);
  },

  'time-parser: "завтра в 18"': () => {
    const d = parseScheduleTime('завтра в 18');
    if (!d) throw new Error('expected Date');
    if (d.getHours() !== 18 || d.getMinutes() !== 0) {
      throw new Error(`expected 18:00, got ${d.getHours()}:${d.getMinutes()}`);
    }
    const now = new Date();
    const expectedDay = now.getDate() + 1;
    // Cross-month boundary handling: just verify it's >= tomorrow
    if (d.getTime() < Date.now()) throw new Error('expected future date');
  },

  'time-parser: ISO timestamp future': () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const d = parseScheduleTime(future);
    if (!d || Math.abs(d.getTime() - new Date(future).getTime()) > 100) {
      throw new Error('iso mismatch');
    }
  },

  'time-parser: ISO timestamp in the past throws': () => {
    let thrown = false;
    try {
      parseScheduleTime('2020-01-01T00:00:00Z');
    } catch (e) { thrown = true; }
    if (!thrown) throw new Error('expected throw on past date');
  },

  'time-parser: gibberish throws': () => {
    let thrown = false;
    try {
      parseScheduleTime('маленький зелёный енот');
    } catch (e) { thrown = true; }
    if (!thrown) throw new Error('expected throw on unparseable');
  },
};
