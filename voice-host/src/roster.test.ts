import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Roster } from './roster.js';

/**
 * Кто был на встрече — для записи после неё.
 *
 * Presence держит ТЕКУЩИЙ состав и забывает вышедших; здесь, наоборот,
 * не забывается никто. Владелец 03.11.2026: «на встречах записывать список
 * участников».
 */
describe('Roster', () => {
  test('пустой при создании', () => {
    assert.deepEqual(new Roster().list, []);
  });

  test('каждый записан с временем первого появления', () => {
    const r = new Roster();
    r.seen('Аня', 1000);
    r.seen('Борис', 2000);
    assert.deepEqual(r.list, [
      { name: 'Аня', joinedAt: 1000 },
      { name: 'Борис', joinedAt: 2000 },
    ]);
  });

  test('повторное появление не дублирует и время не сдвигает', () => {
    // Перезаход во встречу, повтор вебхука, речь после входа — всё это тот же
    // человек. Свой бот к тому же выдаёт uuid по порядку в списке, поэтому
    // ключ — имя, а не uuid.
    const r = new Roster();
    r.seen('Аня', 1000);
    r.seen('Аня', 5000);
    r.seen('  аня ', 6000);
    assert.deepEqual(r.list, [{ name: 'Аня', joinedAt: 1000 }]);
  });

  test('сам бот в список не попадает', () => {
    const r = new Roster('Роман · ассистент Дмитрия');
    r.seen('Роман · ассистент Дмитрия', 1000);
    r.seen('роман  ·  ассистент дмитрия', 1500);
    r.seen('Дмитрий', 2000);
    assert.deepEqual(r.list.map((e) => e.name), ['Дмитрий']);
  });

  test('пустое имя не записывается', () => {
    const r = new Roster();
    r.seen('', 1000);
    r.seen('   ', 1000);
    assert.deepEqual(r.list, []);
  });

  test('имя записывается без лишних пробелов', () => {
    const r = new Roster();
    r.seen('  Вера Петрова ', 1000);
    assert.deepEqual(r.list, [{ name: 'Вера Петрова', joinedAt: 1000 }]);
  });

  test('список — копия: снаружи его не испортить', () => {
    const r = new Roster();
    r.seen('Аня', 1000);
    r.list.pop();
    assert.equal(r.list.length, 1);
  });
});
