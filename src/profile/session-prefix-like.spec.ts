import { ProfileService } from './profile.service';
import { BusinessProfileService } from '../business-profile/business-profile.service';
import { ProfileCompactionService } from '../scheduler/profile-compaction.service';

/**
 * У custom_chat_history нет колонки user_id: переписку пользователя ищут по
 * session_id вида `{userId}_{assistantId}`. `_` в LIKE — любой символ, поэтому
 * без экранирования шаблон `7903016918_%` ловит и `79030169187_12` — переписку
 * другого человека, чей номер начинается так же. Тест не сверяет текст SQL, а
 * разбирает шаблон по правилам PostgreSQL и проверяет, что он ловит.
 */

const SHORT = '7903016918';
const LONG = '79030169187';

/** PostgreSQL LIKE → RegExp. Escape-символ — обратный слэш (он же по умолчанию). */
function likeToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '%') re += '[\\s\\S]*';
    else if (c === '_') re += '[\\s\\S]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Шаблон, который запрос применяет к session_id: `$N` или `$N || '<хвост>'`. */
function sessionPattern(sql: string, params: any[]): string {
  const m = sql.match(/session_id LIKE \(?\$(\d+)(?:\s*\|\|\s*'([^']*)')?/);
  if (!m) throw new Error(`нет LIKE по session_id в запросе: ${sql}`);
  return String(params[Number(m[1]) - 1]) + (m[2] ?? '');
}

function capturePg() {
  const calls: { sql: string; params: any[] }[] = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
  };
}

function expectOwnSessionsOnly(sql: string, params: any[]) {
  const re = likeToRegExp(sessionPattern(sql, params));
  expect(re.test(`${SHORT}_12`)).toBe(true);
  expect(re.test(`${SHORT}_12_fresh_1791471348193`)).toBe(true);
  expect(re.test(`${LONG}_12`)).toBe(false);
}

describe('переписка пользователя по префиксу session_id', () => {
  it('удаление аккаунта не стирает переписку номера, который начинается так же', async () => {
    const pg = capturePg();
    await new ProfileService(pg as any).deleteProfile(SHORT);
    const del = pg.calls.find((c) => /DELETE FROM custom_chat_history/.test(c.sql));
    expect(del).toBeDefined();
    expectOwnSessionsOnly(del!.sql, del!.params);
  });

  it('бизнес-история смотрит только свою переписку', async () => {
    const pg = capturePg();
    await new BusinessProfileService(pg as any).hasBusinessHistory(SHORT);
    const q = pg.calls.find((c) => /custom_chat_history/.test(c.sql));
    expect(q).toBeDefined();
    expectOwnSessionsOnly(q!.sql, q!.params);
  });

  it('проверка профиля ищет подтверждения только в своих репликах', async () => {
    const pg = capturePg();
    await (new ProfileCompactionService(pg as any) as any).findUserMatches(SHORT, 'кришна и личностный бог', []);
    const q = pg.calls.find((c) => /custom_chat_history/.test(c.sql));
    expect(q).toBeDefined();
    expectOwnSessionsOnly(q!.sql, q!.params);
  });

  it('разбор шаблона сам ловит неэкранированный `_` (проверка теста)', () => {
    expect(likeToRegExp(`${SHORT}_%`).test(`${LONG}_12`)).toBe(true);
    expect(likeToRegExp(`${SHORT}\\_%`).test(`${LONG}_12`)).toBe(false);
  });
});
