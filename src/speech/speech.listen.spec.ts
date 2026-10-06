import * as fs from 'fs';
import * as path from 'path';
import { SpeechService } from './speech.service';

/**
 * Таблицы модуля создаются при старте API: `npm run migrate` на проде
 * застревает на base/001 и до speech/ не доходит.
 */
describe('SpeechService.onModuleInit — таблицы модуля при старте', () => {
  const firstLine = (sql: string) => sql.trim().split('\n')[0];

  function makeInit(failOn?: RegExp) {
    const calls: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        calls.push(firstLine(sql));
        if (failOn && failOn.test(sql)) throw new Error('lock timeout');
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pg: any = { query: jest.fn(), getClient: jest.fn(async () => client) };
    const svc = new SpeechService(pg, {} as any, {} as any, {} as any);
    return { svc, calls, client, pg };
  }

  it('применяет миграции модуля по порядку, каждую своей транзакцией с lock_timeout', async () => {
    const { svc, calls, client } = makeInit();
    await svc.onModuleInit();
    expect(calls).toEqual([
      'BEGIN', "SET LOCAL lock_timeout = '3s'", '-- 001_speech_clips.sql', 'COMMIT',
      'BEGIN', "SET LOCAL lock_timeout = '3s'", '-- 002_speech_listens.sql', 'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledTimes(2);
  });

  it('сбой одной миграции не роняет старт и не мешает следующей', async () => {
    const { svc, calls, client } = makeInit(/ALTER TABLE speech_clips/);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(calls).toContain('ROLLBACK');
    expect(calls).toContain('-- 002_speech_listens.sql');
    expect(client.release).toHaveBeenCalledTimes(2);
  });

  it('нет соединения с базой — старт не падает', async () => {
    const pg: any = { query: jest.fn(), getClient: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) };
    const svc = new SpeechService(pg, {} as any, {} as any, {} as any);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  it('002 создаёт speech_listens: user_id text, parts jsonb, уникальный ключ кэша', () => {
    const sql = fs.readFileSync(path.join(__dirname, 'migrations', '002_speech_listens.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS speech_listens/);
    expect(sql).toMatch(/user_id\s+text NOT NULL/);
    expect(sql).toMatch(/parts\s+jsonb NOT NULL/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS speech_listens_user_key\s+ON speech_listens \(user_id, cache_key\)/);
  });
});
