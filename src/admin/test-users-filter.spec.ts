/**
 * Предикат «не тестовый пользователь» — один на всю админку.
 *
 * Раздел «Сайты и боты» живёт в своём сервисе, а фильтр тестовых аккаунтов ему
 * нужен тот же, что разделам AdminService. Своя копия списка номеров в новом
 * сервисе разошлась бы с common/test-users.ts молча, при первой же правке:
 * админка прятала бы прогоны владельца в одном разделе и показывала в
 * соседнем. Поэтому предикат вынесен наружу, а статические методы
 * AdminService строят ровно его.
 */
import { AdminService, excludeTestUsersSql, testUsersFilterSql } from './admin.service';
import { TEST_USERS, TEST_USER_PATTERN } from '../common/test-users';

describe('предикат тестовых аккаунтов', () => {
  it('исключает каждый номер общего списка и маску синтетических номеров', () => {
    const sql = excludeTestUsersSql('p.user_id');
    expect(sql).toMatch(/^p\.user_id <> ALL\(ARRAY\[/);
    for (const u of TEST_USERS) expect(sql).toContain(`'${u}'`);
    expect(sql).toContain(`p.user_id !~ '${TEST_USER_PATTERN}'`);
  });

  it('includeTest снимает фильтр целиком, по умолчанию он стоит', () => {
    expect(testUsersFilterSql('p.user_id', true)).toBe('true');
    expect(testUsersFilterSql('p.user_id', false)).toBe(excludeTestUsersSql('p.user_id'));
    expect(testUsersFilterSql('p.user_id')).toBe(excludeTestUsersSql('p.user_id'));
  });

  it('AdminService строит тот же самый предикат — второй копии нет', () => {
    const svc = AdminService as any;
    expect(svc.excludeTest('c.user_id')).toBe(excludeTestUsersSql('c.user_id'));
    expect(svc.testFilter('c.user_id', false)).toBe(testUsersFilterSql('c.user_id', false));
    expect(svc.testFilter('c.user_id', true)).toBe('true');
  });
});
