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

/** Минимальные заглушки зависимостей — без сети и БД. */
function makeService(overrides: any = {}) {
  const rows: Record<string, any[]> = { clips: [] };

  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM speech_clips/.test(sql)) {
        const hit = rows.clips.find((c) => c.user_id === params[0] && c.cache_key === params[1]);
        return { rows: hit ? [hit] : [] };
      }
      if (/INSERT INTO speech_clips/.test(sql)) {
        const row = {
          id: 'clip-1', user_id: params[0], assistant_id: params[1], cache_key: params[2],
          url: params[3], duration_sec: params[4], chars: params[5],
          provider: params[6], voice: params[7], lang: params[8],
        };
        rows.clips.push(row);
        return { rows: [row] };
      }
      if (/preferred_agent/.test(sql)) return { rows: [{ preferred_agent: 'Роман', profile_data: {} }] };
      if (/SELECT tokens/.test(sql)) return { rows: [{ tokens: overrides.balance ?? 100000 }] };
      return { rows: [] };
    }),
  };

  const storage = { upload: jest.fn(async () => 'https://minio.test/linkeon-assets/audio/x.mp3') };
  const misc = { deductTokens: jest.fn(async () => undefined) };
  const language = { resolveUserLanguage: jest.fn(async () => overrides.lang ?? 'ru') };
  const redis = { incr: jest.fn(async () => 1), expire: jest.fn(async () => undefined) };

  const svc = new SpeechService(pg as any, storage as any, misc as any, language as any, redis as any);
  // Подменяем сетевые вызовы — тестируем оркестрацию, не HTTP.
  (svc as any).synthesizeWith = jest.fn(async () => Buffer.from('fake-mp3-bytes'));
  return { svc, pg, storage, misc, language, redis };
}

describe('SpeechService.synthesize', () => {
  it('успешный синтез списывает токены и возвращает клип', async () => {
    const { svc, misc, storage } = makeService();
    const r = await svc.synthesize('u1', { text: 'Привет, это тест' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.voice).toBe('zahar');
    expect(r.tokensSpent).toBe(1000);
    expect(r.cached).toBe(false);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(misc.deductTokens).toHaveBeenCalledWith('u1', 1000);
  });

  it('повтор того же текста берётся из кэша и не стоит токенов', async () => {
    const { svc, misc, storage } = makeService();
    await svc.synthesize('u1', { text: 'Привет' });
    const second = await svc.synthesize('u1', { text: 'Привет' });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cached).toBe(true);
    expect(second.tokensSpent).toBe(0);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(misc.deductTokens).toHaveBeenCalledTimes(1);
  });

  it('смена голоса обходит кэш', async () => {
    const { svc, storage } = makeService();
    await svc.synthesize('u1', { text: 'Привет' });
    await svc.synthesize('u1', { text: 'Привет', voice: 'filipp' });
    expect(storage.upload).toHaveBeenCalledTimes(2);
  });

  it('при нехватке баланса не синтезирует и не списывает', async () => {
    const { svc, misc, storage } = makeService({ balance: 500 });
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
    expect(misc.deductTokens).not.toHaveBeenCalled();
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
    const { svc, misc } = makeService();
    (svc as any).synthesizeWith = jest.fn(async () => { throw new Error('Yandex TTS 503'); });

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(false);
    expect(misc.deductTokens).not.toHaveBeenCalled();
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
    const { svc, pg, misc } = makeService();
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
    expect(misc.deductTokens).not.toHaveBeenCalled();
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
    const { svc, misc } = makeService();
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
    expect(misc.deductTokens).toHaveBeenCalledTimes(1);
  });

  it('две неудачи подряд — отказ, ретраев ровно два вызова', async () => {
    const { svc, misc } = makeService();
    const inner = jest.fn().mockRejectedValue(new Error('Yandex TTS 503'));
    // makeService глушит synthesizeWith целиком — но ретрай живёт именно в нём,
    // поэтому здесь заглушку снимаем (возвращая настоящий метод с прототипа)
    // и подменяем уровнем ниже, на callProvider.
    delete (svc as any).synthesizeWith;
    (svc as any).callProvider = inner;

    const r = await svc.synthesize('u1', { text: 'Привет' });
    expect(r.ok).toBe(false);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(misc.deductTokens).not.toHaveBeenCalled();
  });
});
