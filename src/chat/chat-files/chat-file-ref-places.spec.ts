import { DOC_PLACES } from '../../voice-call/voice-document-migration';
import { CHAT_FILE_REF_PLACES } from './chat-file-account-deletion.adapter';

/**
 * Drift-guard (Task 11): перечень мест, где chat-file purge ищет ссылки перед
 * удалением объекта, обязан покрывать DOC_PLACES — канонический список мест,
 * куда модель и код пишут адреса документов и звонков
 * (voice-document-migration.ts). Новая площадка в DOC_PLACES без пары в
 * ref-check — и объект удалится при живой ссылке в чужих данных.
 *
 * Плюс контракт фейковых БД в unit-спеках: own-предикат ссылается на $1
 * (userId), а FROM начинается с имени таблицы — /FROM (\w+)/ в FakeChatDb
 * берёт ПЕРВОЕ вхождение FROM, поэтому у LEFT JOIN-площадок главная таблица
 * должна стоять первой.
 */

describe('chat-file ref-check места ⊇ DOC_PLACES', () => {
  it('каждая таблица+колонка DOC_PLACES покрыта (jsonb — через ::text)', () => {
    const misses: string[] = [];
    for (const place of DOC_PLACES) {
      const covers = CHAT_FILE_REF_PLACES.filter((p) => p.table === place.table);
      if (covers.length === 0) {
        misses.push(`${place.table}.${place.column}: таблицы нет в ref-check`);
        continue;
      }
      const col = covers.flatMap((p) => p.columns).find((c) => c.column === place.column);
      if (!col) {
        misses.push(`${place.table}.${place.column}: колонки нет в ref-check`);
        continue;
      }
      if (place.jsonb && !col.sql.includes('::text')) {
        misses.push(`${place.table}.${place.column}: jsonb без ::text`);
      }
    }
    expect(misses).toEqual([]);
  });

  it('у каждой площадки own-предикат с $1 и FROM начинается с её таблицы', () => {
    const misses: string[] = [];
    for (const p of CHAT_FILE_REF_PLACES) {
      if (!p.own.includes('$1')) misses.push(`${p.table}: own без $1`);
      if (!new RegExp(`^${p.table}(\\s|$)`).test(p.from)) {
        misses.push(`${p.table}: FROM «${p.from}» начинается не с таблицы`);
      }
      for (const c of p.columns) {
        if (!c.sql.includes(c.column)) misses.push(`${p.table}.${c.column}: sql не содержит колонку`);
      }
    }
    expect(misses).toEqual([]);
  });
});
