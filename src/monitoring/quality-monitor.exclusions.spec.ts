/**
 * Метрика качества чат-ответов не должна считать мусорные учётки.
 *
 * 15.08.2026 прилетел алерт «всплеск англоязычных ответов — 4/37 (11%)».
 * Все срабатывания принадлежали двум аккаунтам, заведённым и удалённым в тот
 * же день при отладке удаления профиля. Исключение тестовых юзеров жило
 * только в воронке, метрика качества о нём не знала.
 *
 * Плюс метрика обязана читать lang_mismatch, а не старый english_leak: тот
 * вычислялся правилом «мало кириллицы — дефект», под которое попадал любой
 * корректный ответ не по-русски.
 */

jest.mock('../common/telegram-alert', () => ({
  sendTelegramPayload: jest.fn(async () => {}),
  sendTelegramAlert: jest.fn(async () => {}),
}));

import { QualityMonitorService } from './quality-monitor.service';

function makeService() {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      return { rows: [{}] };
    }),
  };
  return { svc: new QualityMonitorService(pg as any) as any, queries };
}

const chatQuery = (q: Array<{ sql: string; params: any[] }>) =>
  q.find((c) => /chat_quality/.test(c.sql));

beforeEach(() => jest.clearAllMocks());

describe('запрос chat_quality', () => {
  it('считает lang_mismatch, а не english_leak', async () => {
    const { svc, queries } = makeService();
    await svc.getOverview();

    const sql = chatQuery(queries)!.sql;
    expect(sql).toContain("'lang_mismatch'");
    // Старый проп нельзя подмешивать: он заведомо ложный для семи локалей.
    expect(sql).not.toContain("'english_leak'");
  });

  it('исключает удалённые аккаунты', async () => {
    const { svc, queries } = makeService();
    await svc.getOverview();

    const sql = chatQuery(queries)!.sql;
    expect(sql).toContain("u.state");
    expect(sql).toContain("'deleted'");
  });

  it('исключает тестовые учётки и передаёт их параметром', async () => {
    const { svc, queries } = makeService();
    await svc.getOverview();

    const call = chatQuery(queries)!;
    expect(call.sql).toMatch(/NOT \(e\.user_id = ANY/);
    const excluded = call.params.find((p) => Array.isArray(p)) as string[];
    expect(excluded).toContain('70000000000');
  });
});
