import * as fs from 'fs';
import * as path from 'path';
import { SLOT_INDEX, SLOT_HOLDING_STATUSES, isSlotConflict } from './blog-slot-claim';

/**
 * Индекс живёт в .sql, а код, который выбирает свободный слот и узнаёт гонку,
 * — в TypeScript. Разойдись они молча — и код считал бы слот свободным там,
 * где база его не пустит (ретрай до исчерпания попыток), или ретрай не узнал
 * бы 23505 своего индекса и отдал бы владельцу 500. Сама работа индекса
 * проверяется на живом Postgres в blog-approval.integration.spec.ts; здесь —
 * что оба места говорят об одном и том же.
 */
describe('004_one_post_per_slot.sql и код говорят об одном и том же', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '004_one_post_per_slot.sql'), 'utf8')
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ');

  it('индекс уникальный, по slot_at и с тем именем, по которому ретрай узнаёт гонку', () => {
    expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${SLOT_INDEX} ON blog_post (slot_at)`);
  });

  it('слот держат ровно те статусы, которые код считает занятыми', () => {
    const m = sql.match(/WHERE status IN \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const statuses = m![1].split(',').map((x) => x.trim().replace(/'/g, ''));
    expect([...statuses].sort()).toEqual([...SLOT_HOLDING_STATUSES].sort());
  });
});

describe('isSlotConflict', () => {
  it('23505 по индексу слота — гонка за слот', () => {
    expect(isSlotConflict({ code: '23505', constraint: SLOT_INDEX })).toBe(true);
  });

  /** Иначе ретрай крутился бы вхолостую на конфликте, который новый слот не лечит. */
  it('23505 по другому ограничению — не гонка за слот', () => {
    expect(isSlotConflict({ code: '23505', constraint: 'blog_post_pkey' })).toBe(false);
  });

  it('прочие ошибки — не гонка за слот', () => {
    expect(isSlotConflict(new Error('connection reset'))).toBe(false);
    expect(isSlotConflict(null)).toBe(false);
  });
});
