import * as fs from 'fs';
import * as path from 'path';
import { SpeechService, LISTEN_MAX_CHARS, mapLimit } from './speech.service';

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

/**
 * Заглушки без сети и БД. Баланс — настоящее изменяемое состояние, UPDATE
 * ведёт себя как Postgres: условие `AND tokens >= $1` берётся ИЗ ТЕКСТА
 * запроса. INSERT уважает уникальность (user_id, cache_key) — как ON CONFLICT
 * DO NOTHING на боевом индексе.
 */
function makeService(overrides: any = {}) {
  const state = {
    balance: overrides.balance ?? 100000,
    profile: overrides.profile ?? { preferred_agent: 'Роман', profile_data: {} },
  };
  const rows: { listens: any[] } = { listens: [] };
  const deduct = jest.fn();
  const deleted = jest.fn();
  const touched = jest.fn();
  const ledger: any[] = [];
  const sqlLog: string[] = [];
  let seq = 0;

  const pg: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      sqlLog.push(sql);
      if (/UPDATE speech_listens SET last_used_at/.test(sql)) {
        touched(params[0]);
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE ai_profiles_consolidated SET tokens = tokens - \$1/.test(sql)) {
        const [amount, uid] = params;
        if (/tokens >= \$1/.test(sql) && state.balance < amount) return { rows: [] };
        state.balance -= amount;
        deduct(uid, amount);
        return { rows: [{ tokens: state.balance }] };
      }
      if (/DELETE FROM speech_listens/.test(sql)) {
        const [id, uid] = params;
        rows.listens = rows.listens.filter((r) => !(r.id === id && r.user_id === uid));
        deleted(id, uid);
        return { rows: [] };
      }
      if (/INSERT INTO speech_listens/.test(sql)) {
        // Колонки — ИЗ ТЕКСТА запроса: заглушка не знает схему заранее и
        // уронит тест, если сервис перестанет что-то писать.
        const cols = String(sql.match(/INSERT INTO speech_listens \(([^)]*)\)/)?.[1] ?? '')
          .split(',').map((c) => c.trim());
        const row: any = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        if (rows.listens.some((r) => r.user_id === row.user_id && r.cache_key === row.cache_key)) {
          return { rows: [] };
        }
        row.id = `listen-${++seq}`;
        row.parts = JSON.parse(row.parts); // jsonb pg отдаёт уже разобранным
        rows.listens.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/FROM speech_listens/.test(sql)) {
        const hit = rows.listens.find((r) => r.user_id === params[0] && r.cache_key === params[1]);
        return { rows: hit ? [hit] : [] };
      }
      if (/preferred_agent/.test(sql)) return { rows: [state.profile] };
      if (/SELECT tokens/.test(sql)) return { rows: [{ tokens: state.balance }] };
      return { rows: [] };
    }),
    async getClient() {
      return {
        query: async (sql: string, params: any[] = []) => {
          if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
          if (/INSERT INTO token_transactions/i.test(sql)) {
            ledger.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            return { rows: [] };
          }
          return pg.query(sql, params);
        },
        release: () => {},
      };
    },
  };

  const storage = { upload: jest.fn(async (input: any) => `https://minio.test/${input.bucket}/${input.key}`) };
  const language = { resolveUserLanguage: jest.fn(async () => overrides.lang ?? 'ru') };
  const redis = { incr: jest.fn(async () => 1), expire: jest.fn(async () => undefined) };
  const svc = new SpeechService(pg, storage as any, language as any, redis as any);
  // Сеть подменяем: тестируем оркестрацию. Байты куска = его текст — так видно,
  // какой кусок в какой файл ушёл.
  const synth = jest.fn(async (_provider: string, chunk: string, _voice: string) => Buffer.from(chunk));
  (svc as any).synthesizeWith = synth;
  return { svc, pg, storage, synth, deduct, deleted, touched, ledger, rows, state, redis, sqlLog };
}

const squash = (s: string) => s.replace(/\s+/g, '');

describe('SpeechService.listen — свежий синтез', () => {
  it('короткий ответ: один кусок голосом ассистента, списание по тарифу', async () => {
    const { svc, synth, deduct, storage } = makeService();
    const r: any = await svc.listen('u1', { text: 'Привет! Это ответ ассистента.', assistant: 'Роман' });
    expect(r).toMatchObject({ ok: true, voice: 'zahar', provider: 'yandex', tokensSpent: 1000, cached: false, chars: 29 });
    expect(r.parts).toHaveLength(1);
    expect(synth).toHaveBeenCalledTimes(1);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(deduct).toHaveBeenCalledWith('u1', 1000);
  });

  it('длинный русский ответ режется по 2000, а списание одно — за всю длину', async () => {
    const { svc, synth, deduct, ledger, state } = makeService({ balance: 10000 });
    const text = 'Это предложение для проверки. '.repeat(150).trim(); // 4499 знаков
    const r: any = await svc.listen('u1', { text });
    expect(r.ok).toBe(true);
    expect(synth.mock.calls.length).toBe(3);
    for (const [, chunk] of synth.mock.calls) expect(chunk.length).toBeLessThanOrEqual(2000);
    expect(r.parts).toHaveLength(3);
    expect(deduct).toHaveBeenCalledTimes(1);
    expect(deduct).toHaveBeenCalledWith('u1', 5000);
    expect(ledger).toHaveLength(1);
    expect(state.balance).toBe(5000);
  });

  it('куски лежат в хранилище по порядку чтения, даже если синтез завершился вразнобой', async () => {
    const { svc, synth, storage } = makeService();
    synth.mockImplementation(async (_p: string, chunk: string) => {
      // Первые куски отвечают дольше последних.
      await new Promise((res) => setTimeout(res, chunk.startsWith('Раз') ? 15 : 1));
      return Buffer.from(chunk);
    });
    const text = ['Раз. '.repeat(390), 'Два. '.repeat(390), 'Три. '.repeat(390)].join('\n').trim();
    const r: any = await svc.listen('u1', { text });
    const bodies = storage.upload.mock.calls.map((c: any[]) => String(c[0].body));
    expect(bodies).toHaveLength(3);
    expect(squash(bodies.join(' '))).toBe(squash(text));
    const keys = storage.upload.mock.calls.map((c: any[]) => c[0].key);
    keys.forEach((k: string, i: number) => expect(k).toMatch(new RegExp(`^audio/listen/[0-9a-f]{64}-${i}\\.mp3$`)));
    expect(r.parts).toEqual(keys.map((k: string) => `https://minio.test/linkeon-assets/${k}`));
  });

  it('не больше трёх запросов к провайдеру одновременно', async () => {
    const { svc, synth } = makeService();
    let inFlight = 0;
    let peak = 0;
    synth.mockImplementation(async (_p: string, chunk: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight--;
      return Buffer.from(chunk);
    });
    await svc.listen('u1', { text: 'Предложение номер один. '.repeat(400).trim() }); // 9599 знаков
    expect(synth.mock.calls.length).toBe(5);
    expect(peak).toBe(3);
  });

  it('пишет в реестр «Озвучка ответа» с остатком и подробностями', async () => {
    const { svc, ledger } = makeService({ balance: 5000 });
    await svc.listen('u1', { text: 'Привет' });
    expect(ledger).toHaveLength(1);
    const [userId, amount, balanceAfter, description, metadata] = ledger[0].params;
    expect(ledger[0].sql).toMatch(/'consumed'/);
    expect(userId).toBe('u1');
    expect(amount).toBe(-1000);
    expect(balanceAfter).toBe(4000);
    expect(description).toBe('Озвучка ответа');
    expect(JSON.parse(metadata)).toMatchObject({ chars: 6, parts: 1, voice: 'zahar', provider: 'yandex' });
  });

  it('в speech_clips не пишет и не читает — чат не подхватит прослушивание', async () => {
    const { svc, sqlLog } = makeService();
    await svc.listen('u1', { text: 'Привет' });
    await svc.listen('u1', { text: 'Привет' });
    expect(sqlLog.length).toBeGreaterThan(0);
    expect(sqlLog.some((s) => /speech_clips/.test(s))).toBe(false);
  });
});

describe('SpeechService.listen — кэш', () => {
  it('повтор того же текста бесплатен и не зовёт провайдера', async () => {
    const { svc, synth, deduct, touched } = makeService();
    const first: any = await svc.listen('u1', { text: 'Привет' });
    const second: any = await svc.listen('u1', { text: 'Привет' });
    expect(second).toMatchObject({ ok: true, cached: true, tokensSpent: 0 });
    expect(second.parts).toEqual(first.parts);
    expect(synth).toHaveBeenCalledTimes(1);
    expect(deduct).toHaveBeenCalledTimes(1);
    expect(touched).toHaveBeenCalledTimes(1);
  });

  it('оплаченное прослушивание отдаётся и при нулевом балансе', async () => {
    const { svc, state } = makeService({ balance: 1000 });
    await svc.listen('u1', { text: 'Привет' });
    expect(state.balance).toBe(0);
    const again: any = await svc.listen('u1', { text: 'Привет' });
    expect(again).toMatchObject({ ok: true, cached: true, tokensSpent: 0 });
  });

  it('другой ассистент — другой голос — новый синтез', async () => {
    const { svc, synth } = makeService();
    await svc.listen('u1', { text: 'Привет', assistant: 'Роман' });
    const r: any = await svc.listen('u1', { text: 'Привет', assistant: 'Маша' });
    expect(r).toMatchObject({ ok: true, voice: 'jane', cached: false });
    expect(synth).toHaveBeenCalledTimes(2);
  });

  it('кэш у каждого пользователя свой', async () => {
    const { svc, deduct } = makeService();
    await svc.listen('u1', { text: 'Привет' });
    const r: any = await svc.listen('u2', { text: 'Привет' });
    expect(r.cached).toBe(false);
    expect(deduct).toHaveBeenCalledTimes(2);
  });

  it('гонку вставки выиграл параллельный запрос — второй не платит', async () => {
    const { svc, deduct } = makeService();
    const [a, b]: any[] = await Promise.all([
      svc.listen('u1', { text: 'Привет' }),
      svc.listen('u1', { text: 'Привет' }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(deduct).toHaveBeenCalledTimes(1);
    expect([a.tokensSpent, b.tokensSpent].sort((x: number, y: number) => x - y)).toEqual([0, 1000]);
  });
});

describe('SpeechService.listen — голос', () => {
  it('без assistant берётся preferred_agent', async () => {
    const { svc } = makeService({ profile: { preferred_agent: 'Маша', profile_data: {} } });
    const r: any = await svc.listen('u1', { text: 'Привет' });
    expect(r.voice).toBe('jane');
  });

  it('выбор пользователя в настройках побеждает дефолт ассистента', async () => {
    const { svc } = makeService({
      profile: { preferred_agent: 'Роман', profile_data: { assistant_voices: { 'Маша': 'marina' } } },
    });
    const r: any = await svc.listen('u1', { text: 'Привет', assistant: 'Маша' });
    expect(r.voice).toBe('marina');
  });

  it('английский — OpenAI-голос ассистента и куски до 4000', async () => {
    const { svc, synth } = makeService({ lang: 'en' });
    const r: any = await svc.listen('u1', { text: 'This is a sentence for the test. '.repeat(150).trim(), assistant: 'Маша' });
    expect(r).toMatchObject({ ok: true, provider: 'openai', voice: 'shimmer' });
    expect(synth.mock.calls.length).toBe(2);
    for (const [, chunk] of synth.mock.calls) expect(chunk.length).toBeLessThanOrEqual(4000);
  });
});

describe('SpeechService.listen — отказы', () => {
  it('пустой текст', async () => {
    const { svc, synth } = makeService();
    const r: any = await svc.listen('u1', { text: '  \n ' });
    expect(r).toEqual({ ok: false, error: 'empty_text' });
    expect(synth).not.toHaveBeenCalled();
  });

  it('длиннее потолка — отказ без синтеза и без списания', async () => {
    const { svc, synth, deduct } = makeService();
    const r: any = await svc.listen('u1', { text: 'я'.repeat(LISTEN_MAX_CHARS + 1) });
    expect(r).toEqual({ ok: false, error: 'text_too_long', maxChars: 10000 });
    expect(synth).not.toHaveBeenCalled();
    expect(deduct).not.toHaveBeenCalled();
  });

  it('ровно потолок проходит', async () => {
    const { svc } = makeService();
    const r: any = await svc.listen('u1', { text: 'я'.repeat(LISTEN_MAX_CHARS) });
    expect(r).toMatchObject({ ok: true, tokensSpent: 10000 });
  });

  it('нехватка баланса — отказ до провайдера', async () => {
    const { svc, synth, deduct } = makeService({ balance: 1500 });
    const r: any = await svc.listen('u1', { text: 'я'.repeat(1500) });
    expect(r).toEqual({ ok: false, error: 'insufficient_tokens', balance: 1500, required: 2000 });
    expect(synth).not.toHaveBeenCalled();
    expect(deduct).not.toHaveBeenCalled();
  });

  it('отказ провайдера на любом куске — ничего не залито, не сохранено и не списано', async () => {
    const { svc, synth, deduct, rows, storage } = makeService();
    synth.mockImplementation(async (_p: string, chunk: string) => {
      if (synth.mock.calls.length === 2) throw new Error('Yandex TTS 503');
      return Buffer.from(chunk);
    });
    const r: any = await svc.listen('u1', { text: 'Предложение номер один. '.repeat(200).trim() });
    expect(r).toEqual({ ok: false, error: 'tts_failed' });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(rows.listens).toHaveLength(0);
    expect(deduct).not.toHaveBeenCalled();
  });

  it('сбой заливки в хранилище — отказ без списания', async () => {
    const { svc, storage, deduct, rows } = makeService();
    storage.upload.mockRejectedValueOnce(new Error('MinIO 503'));
    const r: any = await svc.listen('u1', { text: 'Привет' });
    expect(r).toEqual({ ok: false, error: 'tts_failed' });
    expect(rows.listens).toHaveLength(0);
    expect(deduct).not.toHaveBeenCalled();
  });

  it('лимит частоты общий с инструментом', async () => {
    const { svc, redis, synth } = makeService();
    redis.incr.mockResolvedValue(21);
    const r: any = await svc.listen('u1', { text: 'Привет' });
    expect(r).toEqual({ ok: false, error: 'rate_limited', retryAfterSec: 60 });
    expect(redis.incr).toHaveBeenCalledWith('speech:rl:u1');
    expect(synth).not.toHaveBeenCalled();
  });

  it('баланс ушёл за время синтеза — строка снята, денег не взято, повтор не бесплатен', async () => {
    const { svc, state, synth, deduct, deleted, rows } = makeService({ balance: 1000 });
    synth.mockImplementation(async (_p: string, chunk: string) => {
      state.balance = 0; // параллельная трата, пока шёл синтез
      return Buffer.from(chunk);
    });
    const r: any = await svc.listen('u1', { text: 'Привет' });
    expect(r).toEqual({ ok: false, error: 'insufficient_tokens', balance: 0, required: 1000 });
    expect(deduct).not.toHaveBeenCalled();
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(rows.listens).toHaveLength(0);

    const retry: any = await svc.listen('u1', { text: 'Привет' });
    expect(retry.ok).toBe(false);
  });
});

describe('mapLimit', () => {
  it('порядок результатов — порядок входа, а не завершения', async () => {
    const out = await mapLimit([30, 10, 20, 0], 2, async (ms, i) => {
      await new Promise((res) => setTimeout(res, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it('после первой ошибки новые вызовы не начинаются', async () => {
    const started: number[] = [];
    await expect(mapLimit([0, 1, 2, 3, 4], 2, async (x) => {
      started.push(x);
      if (x === 0) await new Promise((res) => setTimeout(res, 20));
      if (x === 1) throw new Error('boom');
      return x;
    })).rejects.toThrow('boom');
    // Даём долгому вызову доработать: без флага его исполнитель, освободившись,
    // взял бы следующие куски и сходил бы за них к провайдеру.
    await new Promise((res) => setTimeout(res, 50));
    expect(started).toEqual([0, 1]);
  });

  it('пустой вход — пустой результат', async () => {
    await expect(mapLimit([], 3, async (x) => x)).resolves.toEqual([]);
  });
});
