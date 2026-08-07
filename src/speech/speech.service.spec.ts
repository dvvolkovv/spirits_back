import { tokenCostFor, cacheKeyFor, estimateDurationSec, maxCharsFor } from './speech.service';
import { SpeechService } from './speech.service';

describe('tokenCostFor', () => {
  it('округляет вверх до целых тысяч', () => {
    expect(tokenCostFor(1)).toBe(1000);
    expect(tokenCostFor(999)).toBe(1000);
    expect(tokenCostFor(1000)).toBe(1000);
    expect(tokenCostFor(1001)).toBe(2000);
    expect(tokenCostFor(5000)).toBe(5000);
  });
});

describe('cacheKeyFor', () => {
  it('одинаковые входы дают одинаковый ключ', () => {
    expect(cacheKeyFor('привет', 'zahar', 'ru')).toBe(cacheKeyFor('привет', 'zahar', 'ru'));
  });

  it('смена голоса даёт другой ключ', () => {
    expect(cacheKeyFor('привет', 'zahar', 'ru')).not.toBe(cacheKeyFor('привет', 'filipp', 'ru'));
  });

  it('смена языка даёт другой ключ', () => {
    expect(cacheKeyFor('hello', 'onyx', 'en')).not.toBe(cacheKeyFor('hello', 'onyx', 'de'));
  });

  it('смена текста даёт другой ключ', () => {
    expect(cacheKeyFor('привет', 'zahar', 'ru')).not.toBe(cacheKeyFor('пока', 'zahar', 'ru'));
  });
});

describe('estimateDurationSec', () => {
  it('оценивает по 15 символов в секунду', () => {
    expect(estimateDurationSec(150)).toBeCloseTo(10, 1);
  });
});

describe('maxCharsFor — потолок свой у каждого провайдера', () => {
  it('yandex — 2000 символов: 15 КБ лимит тела, кириллица раздувается в 6 раз', () => {
    expect(maxCharsFor('yandex')).toBe(2000);
  });

  it('openai — 4000 символов: у tts-1 лимит 4096 на input', () => {
    expect(maxCharsFor('openai')).toBe(4000);
  });

  it('потолок yandex реально влезает в 15 КБ тела на кириллице', () => {
    const params = new URLSearchParams();
    params.set('text', 'я'.repeat(maxCharsFor('yandex')));
    expect(Buffer.byteLength(params.toString())).toBeLessThan(15000);
  });

  it('вдвое больший текст в лимит уже НЕ влезает — проверка, что потолок не декоративный', () => {
    const params = new URLSearchParams();
    params.set('text', 'я'.repeat(maxCharsFor('yandex') * 2));
    expect(Buffer.byteLength(params.toString())).toBeGreaterThan(15000);
  });
});

/**
 * Минимальные заглушки зависимостей — без сети и БД.
 *
 * Баланс — настоящее изменяемое состояние, а UPDATE в заглушке ведёт себя как
 * Postgres: условие `AND tokens >= $1` берётся ИЗ ТЕКСТА запроса. Уберёшь
 * условие в сервисе — заглушка спишет безусловно и уведёт баланс в минус,
 * ровно как боевая БД. Иначе тест на гонку был бы декоративным.
 */
function makeService(overrides: any = {}) {
  const rows: { clips: any[] } = { clips: [] };
  const state = { balance: overrides.balance ?? 100000 };
  /** Каждое фактическое списание: (userId, amount). */
  const deduct = jest.fn();
  /** Каждый откат неоплаченного клипа: (clipId, userId). */
  const deleted = jest.fn();
  /** Каждая отметка «клип выдан сейчас» на кэш-хите: (clipId). */
  const touched = jest.fn();
  let clipSeq = 0;

  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      // Строго до общей ветки `FROM speech_clips` — это UPDATE, а не SELECT.
      if (/UPDATE speech_clips SET last_used_at/.test(sql)) {
        const [id] = params;
        const row = rows.clips.find((c) => c.id === id);
        if (row) row.last_used_at = Date.now();
        touched(id);
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (/UPDATE ai_profiles_consolidated SET tokens = tokens - \$1/.test(sql)) {
        const [amount, uid] = params;
        const guarded = /tokens >= \$1/.test(sql);
        if (guarded && state.balance < amount) return { rows: [] };
        state.balance -= amount;
        deduct(uid, amount);
        return { rows: [{ tokens: state.balance }] };
      }
      if (/DELETE FROM speech_clips/.test(sql)) {
        const [id, uid] = params;
        const before = rows.clips.length;
        rows.clips = rows.clips.filter((c) => !(c.id === id && c.user_id === uid));
        deleted(id, uid);
        return { rows: [], rowCount: before - rows.clips.length };
      }
      if (/FROM speech_clips/.test(sql)) {
        const hit = rows.clips.find((c) => c.user_id === params[0] && c.cache_key === params[1]);
        return { rows: hit ? [hit] : [] };
      }
      if (/INSERT INTO speech_clips/.test(sql)) {
        // Колонки читаем ИЗ ТЕКСТА запроса и сопоставляем с params по позиции:
        // так заглушка не «знает» схему заранее и уронит тест, если сервис
        // перестанет писать tokens_spent.
        const cols = String(sql.match(/INSERT INTO speech_clips \(([^)]*)\)/)?.[1] ?? '')
          .split(',').map((c) => c.trim());
        const row: any = { id: `clip-${++clipSeq}`, tokens_spent: 0, last_used_at: Date.now() };
        cols.forEach((c, i) => { row[c] = params[i]; });
        rows.clips.push(row);
        return { rows: [row] };
      }
      if (/preferred_agent/.test(sql)) return { rows: [{ preferred_agent: 'Роман', profile_data: {} }] };
      if (/SELECT tokens/.test(sql)) return { rows: [{ tokens: state.balance }] };
      return { rows: [] };
    }),
  };

  const storage = { upload: jest.fn(async () => 'https://minio.test/linkeon-assets/audio/x.mp3') };
  const language = { resolveUserLanguage: jest.fn(async () => overrides.lang ?? 'ru') };
  const redis = { incr: jest.fn(async () => 1), expire: jest.fn(async () => undefined) };

  const svc = new SpeechService(pg as any, storage as any, language as any, redis as any);
  // Подменяем сетевые вызовы — тестируем оркестрацию, не HTTP.
  (svc as any).synthesizeWith = jest.fn(async () => Buffer.from('fake-mp3-bytes'));
  return { svc, pg, storage, deduct, deleted, touched, rows, state, language, redis };
}

describe('SpeechService.synthesize', () => {
  it('успешный синтез списывает токены и возвращает клип', async () => {
    const { svc, deduct, storage } = makeService();
    const r = await svc.synthesize('u1', { text: 'Привет, это тест' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.voice).toBe('zahar');
    expect(r.tokensSpent).toBe(1000);
    expect(r.cached).toBe(false);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(deduct).toHaveBeenCalledWith('u1', 1000);
  });

  it('повтор того же текста берётся из кэша и не стоит токенов', async () => {
    const { svc, deduct, storage } = makeService();
    await svc.synthesize('u1', { text: 'Привет' });
    const second = await svc.synthesize('u1', { text: 'Привет' });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cached).toBe(true);
    expect(second.tokensSpent).toBe(0);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(deduct).toHaveBeenCalledTimes(1);
  });

  it('смена голоса обходит кэш', async () => {
    const { svc, storage } = makeService();
    await svc.synthesize('u1', { text: 'Привет' });
    await svc.synthesize('u1', { text: 'Привет', voice: 'filipp' });
    expect(storage.upload).toHaveBeenCalledTimes(2);
  });

  it('при нехватке баланса не синтезирует и не списывает', async () => {
    const { svc, deduct, storage } = makeService({ balance: 500 });
    const r = await svc.synthesize('u1', { text: 'Привет' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // В tsconfig проекта strictNullChecks:false, поэтому truthiness-сужение
    // не выкидывает ok:true-ветку из union — поля ошибки читаем через any.
    const err = r as any;
    expect(err.error).toBe('insufficient_tokens');
    expect(err.required).toBe(1000);
    expect(err.balance).toBe(500);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(deduct).not.toHaveBeenCalled();
  });

  it('на русском потолок 2000 символов — 2001 отклоняется без синтеза', async () => {
    const { svc, storage } = makeService();
    const r = await svc.synthesize('u1', { text: 'я'.repeat(2001) });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    const err = r as any;
    expect(err.error).toBe('text_too_long');
    expect(err.maxChars).toBe(2000);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('на английском тот же текст проходит — потолок там 4000', async () => {
    const { svc } = makeService({ lang: 'en' });
    const r = await svc.synthesize('u1', { text: 'a'.repeat(2001) });
    expect(r.ok).toBe(true);
  });

  it('на английском 4001 символ отклоняется', async () => {
    const { svc } = makeService({ lang: 'en' });
    const r = await svc.synthesize('u1', { text: 'a'.repeat(4001) });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    const err = r as any;
    expect(err.error).toBe('text_too_long');
    expect(err.maxChars).toBe(4000);
  });

  it('пустой текст отклоняется', async () => {
    const { svc } = makeService();
    const r = await svc.synthesize('u1', { text: '   ' });
    expect(r.ok).toBe(false);
  });

  it('за упавший синтез токены не списываются', async () => {
    const { svc, deduct } = makeService();
    (svc as any).synthesizeWith = jest.fn(async () => { throw new Error('Yandex TTS 503'); });

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(false);
    expect(deduct).not.toHaveBeenCalled();
  });

  it('английский язык уводит на openai-голос', async () => {
    const { svc } = makeService({ lang: 'en' });
    const r = await svc.synthesize('u1', { text: 'Hello there' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider).toBe('openai');
    expect(r.voice).toBe('onyx');
  });

  it('гонку выиграл параллельный вызов — отдаём его клип и не списываем повторно', async () => {
    const { svc, pg, deduct } = makeService();
    // INSERT ... ON CONFLICT DO NOTHING вернул ноль строк: параллельный вызов
    // успел вставить ту же пару (user_id, cache_key) и уже оплатил синтез.
    let insertSeen = false;
    (pg.query as jest.Mock).mockImplementation(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO speech_clips/.test(sql)) { insertSeen = true; return { rows: [] }; }
      if (/FROM speech_clips/.test(sql)) {
        return insertSeen
          ? { rows: [{ id: 'clip-parallel', url: 'https://minio.test/a.mp3', duration_sec: 2, chars: 6 }] }
          : { rows: [] };
      }
      if (/preferred_agent/.test(sql)) return { rows: [{ preferred_agent: 'Роман', profile_data: {} }] };
      if (/SELECT tokens/.test(sql)) return { rows: [{ tokens: 100000 }] };
      return { rows: [] };
    });

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clipId).toBe('clip-parallel');
    expect(r.cached).toBe(true);
    expect(r.tokensSpent).toBe(0);
    expect(deduct).not.toHaveBeenCalled();
  });
});

/**
 * Гонка баланса. Проверка баланса и списание — два разных запроса, а описание
 * инструмента прямо поощряет пачку синтезов подряд («сценка по ролям»). При
 * безусловном `tokens = tokens - $1` все параллельные вызовы читают один и тот
 * же достаточный баланс и списывают каждый: 1000 на счету и пять вызовов по
 * 1000 давали −4000.
 *
 * Лечится условным UPDATE `... AND tokens >= $1 RETURNING tokens` — проверка и
 * списание становятся одной атомарной операцией. Ноль строк = денег не хватило.
 */
describe('SpeechService — гонка баланса при параллельных синтезах', () => {
  it('пять параллельных вызовов при балансе на один: платит один, баланс не уходит в минус', async () => {
    const { svc, state, deduct } = makeService({ balance: 1000 });

    // Разные тексты — чтобы кэш не схлопнул вызовы в один и гонка была настоящей.
    const results = await Promise.all(
      ['раз', 'два', 'три', 'четыре', 'пять'].map((t) => svc.synthesize('u1', { text: t })),
    );

    expect(state.balance).toBe(0);
    expect(state.balance).toBeGreaterThanOrEqual(0);
    expect(deduct).toHaveBeenCalledTimes(1);

    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(1);

    const failed = results.filter((r) => !r.ok) as any[];
    expect(failed).toHaveLength(4);
    for (const f of failed) {
      expect(f.error).toBe('insufficient_tokens');
      expect(f.required).toBe(1000);
      expect(f.balance).toBe(0);
    }
  });

  it('неоплаченный клип откатывается из БД — иначе он попал бы в кэш бесплатно', async () => {
    const { svc, state, deduct, deleted, rows } = makeService({ balance: 1000 });

    const [winner, loser] = await Promise.all([
      svc.synthesize('u1', { text: 'раз' }),
      svc.synthesize('u1', { text: 'два' }),
    ]);
    const paidOk = [winner, loser].filter((r) => r.ok);
    expect(paidOk).toHaveLength(1);
    expect(state.balance).toBe(0);
    expect(deduct).toHaveBeenCalledTimes(1);

    // В БД остаётся ровно один клип — оплаченный. Строка проигравшего снесена
    // компенсацией сразу после провалившегося списания.
    expect(rows.clips).toHaveLength(1);
    expect(deleted).toHaveBeenCalledTimes(1);

    // Повтор текста, за который не заплатили, обязан снова упереться в баланс,
    // а не отдаться бесплатно из кэша.
    const failedText = (winner as any).ok ? 'два' : 'раз';
    const retry: any = await svc.synthesize('u1', { text: failedText });
    expect(retry.ok).toBe(false);
    expect(retry.error).toBe('insufficient_tokens');
    expect(deduct).toHaveBeenCalledTimes(1);
    expect(state.balance).toBe(0);

    // Оплаченный клип, наоборот, из кэша отдаётся и при нулевом балансе.
    const paidText = (winner as any).ok ? 'раз' : 'два';
    const cachedRetry: any = await svc.synthesize('u1', { text: paidText });
    expect(cachedRetry.ok).toBe(true);
    expect(cachedRetry.cached).toBe(true);
    expect(cachedRetry.tokensSpent).toBe(0);
  });

  it('списание идёт условным UPDATE, а не безусловным deductTokens', async () => {
    const { svc, pg } = makeService();
    await svc.synthesize('u1', { text: 'Привет' });

    const upd = (pg.query as jest.Mock).mock.calls
      .map((c: any[]) => String(c[0]))
      .find((sql: string) => /UPDATE ai_profiles_consolidated SET tokens/.test(sql));

    expect(upd).toBeDefined();
    expect(upd).toMatch(/tokens >= \$1/);
    expect(upd).toMatch(/RETURNING tokens/);
  });
});

/**
 * Дефект 1. Кэш-хит отдавал старую строку и ничего в ней не трогал, а маркер
 * `{{audio:id=...}}` дописывается в chat.service.ts по клипам «за время
 * стрима». created_at у кэш-хита старый — маркер не подставлялся: инструмент
 * вернул ok, модель написала «готово», плеера у пользователя нет. Причём это
 * заявленная фича («повтор того же текста бесплатно»), а не редкий угол.
 */
describe('SpeechService — кэш-хит помечается как выданный сейчас (дефект 1)', () => {
  it('повтор двигает last_used_at у найденного клипа', async () => {
    const { svc, touched, rows } = makeService();
    const first: any = await svc.synthesize('u1', { text: 'Привет' });
    expect(touched).not.toHaveBeenCalled(); // первый синтез — вставка, не хит

    const second: any = await svc.synthesize('u1', { text: 'Привет' });
    expect(second.cached).toBe(true);
    // Отметили ровно тот клип, который отдали, — не «какой-нибудь».
    expect(touched).toHaveBeenCalledTimes(1);
    expect(touched).toHaveBeenCalledWith(rows.clips[0].id);
    expect(second.clipId).toBe(first.clipId);
  });

  it('клип, доставшийся от параллельного вызова, тоже свежий по времени — отдельная отметка не нужна', async () => {
    // Строку вставил параллельный вызов ЗА ЭТОТ ЖЕ стрим, её created_at уже
    // внутри окна. Проверяем, что выдача не падает и денег не берёт.
    const { svc, pg, deduct } = makeService();
    let insertSeen = false;
    (pg.query as jest.Mock).mockImplementation(async (sql: string) => {
      if (/INSERT INTO speech_clips/.test(sql)) { insertSeen = true; return { rows: [] }; }
      if (/FROM speech_clips/.test(sql)) {
        return insertSeen
          ? { rows: [{ id: 'clip-parallel', url: 'https://minio.test/a.mp3', duration_sec: 2, chars: 6 }] }
          : { rows: [] };
      }
      if (/preferred_agent/.test(sql)) return { rows: [{ preferred_agent: 'Роман', profile_data: {} }] };
      if (/SELECT tokens/.test(sql)) return { rows: [{ tokens: 100000 }] };
      return { rows: [] };
    });

    const r: any = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(true);
    expect(r.tokensSpent).toBe(0);
    expect(deduct).not.toHaveBeenCalled();
  });

  it('падение UPDATE last_used_at не ломает выдачу готового клипа', async () => {
    const { svc, pg } = makeService();
    await svc.synthesize('u1', { text: 'Привет' });

    const orig = (pg.query as jest.Mock).getMockImplementation()!;
    (pg.query as jest.Mock).mockImplementation(async (sql: string, params: any[] = []) => {
      if (/UPDATE speech_clips SET last_used_at/.test(sql)) throw new Error('deadlock detected');
      return orig(sql, params);
    });

    const r: any = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(true);
    expect(r.cached).toBe(true);
  });
});

/**
 * Дефект 2. У speech_clips не было колонки tokens_spent, и озвучка не попадала
 * в индикатор «X токенов» под сообщением: сценка из десяти реплик уводила
 * баланс на 10 000 молча. Сумму собирает chat.service.ts запросом
 * SUM(tokens_spent) по created_at за время стрима — значит платa обязана
 * лежать в самой строке клипа.
 */
describe('SpeechService — фактическая плата пишется в строку клипа (дефект 2)', () => {
  it('INSERT кладёт в tokens_spent ровно списанную сумму', async () => {
    const { svc, deduct, rows } = makeService();
    // 1500 символов → две начатые тысячи → 2000 токенов.
    await svc.synthesize('u1', { text: 'я'.repeat(1500) });

    expect(deduct).toHaveBeenCalledWith('u1', 2000);
    expect(rows.clips).toHaveLength(1);
    expect(Number(rows.clips[0].tokens_spent)).toBe(2000);
  });

  it('короткий текст — 1000, и в строке ровно 1000, а не длина текста', async () => {
    const { svc, rows } = makeService();
    await svc.synthesize('u1', { text: 'Привет' });
    expect(Number(rows.clips[0].tokens_spent)).toBe(1000);
  });

  it('неоплаченный клип не остаётся в таблице со своей суммой', async () => {
    // Иначе SUM(tokens_spent) показал бы пользователю плату, которую не взяли.
    const { svc, rows } = makeService({ balance: 1000 });
    await Promise.all([
      svc.synthesize('u1', { text: 'раз' }),
      svc.synthesize('u1', { text: 'два' }),
    ]);
    expect(rows.clips).toHaveLength(1);
    expect(rows.clips.reduce((s: number, c: any) => s + Number(c.tokens_spent), 0)).toBe(1000);
  });

  it('кэш-хит новой строки не создаёт — значит и в сумму стрима ничего не добавит', async () => {
    const { svc, rows } = makeService();
    await svc.synthesize('u1', { text: 'Привет' });
    await svc.synthesize('u1', { text: 'Привет' });
    expect(rows.clips).toHaveLength(1);
  });
});

describe('SpeechService — rate limit', () => {
  it('21-й вызов за минуту отклоняется', async () => {
    const { svc, redis, storage } = makeService();
    (redis.incr as jest.Mock).mockResolvedValue(21);

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const err = r as any;
    expect(err.error).toBe('rate_limited');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('20-й вызов ещё проходит — сценка по ролям не должна упираться в потолок', async () => {
    const { svc, redis } = makeService();
    (redis.incr as jest.Mock).mockResolvedValue(20);

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(true);
  });

  it('TTL ставится только на первом вызове окна', async () => {
    const { svc, redis } = makeService();
    (redis.incr as jest.Mock).mockResolvedValue(1);
    await svc.synthesize('u1', { text: 'Привет' });
    expect(redis.expire).toHaveBeenCalledWith(expect.stringContaining('u1'), 60);

    (redis.expire as jest.Mock).mockClear();
    (redis.incr as jest.Mock).mockResolvedValue(2);
    await svc.synthesize('u1', { text: 'Другой текст' });
    expect(redis.expire).not.toHaveBeenCalled();
  });
});

describe('SpeechService — ретрай провайдера', () => {
  it('одна неудача ретраится и вызов завершается успешно', async () => {
    const { svc, deduct } = makeService();
    const inner = jest.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(Buffer.from('fake-mp3-bytes'));
    // makeService глушит synthesizeWith целиком — но ретрай живёт именно в нём,
    // поэтому здесь заглушку снимаем (возвращая настоящий метод с прототипа)
    // и подменяем уровнем ниже, на callProvider.
    delete (svc as any).synthesizeWith;
    (svc as any).callProvider = inner;

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(true);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(deduct).toHaveBeenCalledTimes(1);
  });

  it('две неудачи подряд — отказ, ретраев ровно два вызова', async () => {
    const { svc, deduct } = makeService();
    const inner = jest.fn().mockRejectedValue(new Error('Yandex TTS 503'));
    // makeService глушит synthesizeWith целиком — но ретрай живёт именно в нём,
    // поэтому здесь заглушку снимаем (возвращая настоящий метод с прототипа)
    // и подменяем уровнем ниже, на callProvider.
    delete (svc as any).synthesizeWith;
    (svc as any).callProvider = inner;

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(false);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(deduct).not.toHaveBeenCalled();
  });
});
