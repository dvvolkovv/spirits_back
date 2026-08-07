import { VOICE_CATALOG, ASSISTANT_DEFAULTS, GENDER_DEFAULT, resolveVoice, providerForLang, isValidVoice } from './voices';

describe('providerForLang', () => {
  it('ru → yandex, всё остальное → openai', () => {
    expect(providerForLang('ru')).toBe('yandex');
    expect(providerForLang('en')).toBe('openai');
    expect(providerForLang('zh')).toBe('openai');
  });
});

describe('VOICE_CATALOG', () => {
  it('у каждого голоса заполнены обязательные поля', () => {
    for (const v of VOICE_CATALOG) {
      expect(v.id).toBeTruthy();
      expect(['yandex', 'openai']).toContain(v.provider);
      expect(['m', 'f']).toContain(v.gender);
      expect(v.title).toBeTruthy();
      expect(v.description).toBeTruthy();
    }
  });

  it('id уникальны в пределах провайдера', () => {
    const keys = VOICE_CATALOG.map((v) => `${v.provider}:${v.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('resolveVoice — приоритеты', () => {
  it('1: явный voice перебивает всё', () => {
    const r = resolveVoice({ lang: 'ru', assistantName: 'Оля', userChoice: 'jane', requested: 'zahar' });
    expect(r.voice).toBe('zahar');
    expect(r.source).toBe('requested');
  });

  it('2: выбор пользователя перебивает дефолт ассистента', () => {
    const r = resolveVoice({ lang: 'ru', assistantName: 'Оля', userChoice: 'jane' });
    expect(r.voice).toBe('jane');
    expect(r.source).toBe('user');
  });

  it('3: дефолт ассистента, когда выбора нет', () => {
    const r = resolveVoice({ lang: 'ru', assistantName: 'Роман' });
    expect(r.voice).toBe('zahar');
    expect(r.source).toBe('assistant');
  });

  it('4: неизвестный ассистент → женский дефолт', () => {
    const r = resolveVoice({ lang: 'ru', assistantName: 'Незнакомец' });
    expect(r.voice).toBe('alena');
    expect(r.source).toBe('gender-default');
  });

  it('4b: неизвестный ассистент, английский язык → женский дефолт openai', () => {
    const r = resolveVoice({ lang: 'en', assistantName: 'Незнакомец' });
    expect(r.voice).toBe('nova');
    expect(r.source).toBe('gender-default');
  });
});

describe('resolveVoice — откаты при невалидном голосе', () => {
  it('выдуманный моделью id откатывается на следующий уровень', () => {
    const r = resolveVoice({ lang: 'ru', assistantName: 'Роман', requested: 'megatron-9000' });
    expect(r.voice).toBe('zahar');
    expect(r.source).toBe('assistant');
  });

  it('yandex-голос при английском языке откатывается, а не роняет вызов', () => {
    const r = resolveVoice({ lang: 'en', assistantName: 'Роман', requested: 'zahar' });
    expect(r.voice).toBe('onyx');
    expect(r.source).toBe('assistant');
  });

  it('невалидный пользовательский выбор откатывается на дефолт ассистента', () => {
    const r = resolveVoice({ lang: 'ru', assistantName: 'Роман', userChoice: 'nova' });
    expect(r.voice).toBe('zahar');
    expect(r.source).toBe('assistant');
  });

  it('всегда возвращает голос выбранного провайдера', () => {
    for (const lang of ['ru', 'en', 'de', 'fr', 'es', 'zh']) {
      const r = resolveVoice({ lang, assistantName: 'Оля' });
      const entry = VOICE_CATALOG.find((v) => v.id === r.voice && v.provider === providerForLang(lang));
      expect(entry).toBeDefined();
    }
  });
});

describe('консистентность ASSISTANT_DEFAULTS и GENDER_DEFAULT против VOICE_CATALOG', () => {
  it('у каждого ассистента дефолтные голоса валидны для своего провайдера', () => {
    for (const def of Object.values(ASSISTANT_DEFAULTS)) {
      expect(isValidVoice(def.yandex, 'yandex')).toBe(true);
      expect(isValidVoice(def.openai, 'openai')).toBe(true);
    }
  });

  it('у каждого ассистента gender совпадает с gender обоих его дефолтных голосов в каталоге', () => {
    for (const def of Object.values(ASSISTANT_DEFAULTS)) {
      const yandexEntry = VOICE_CATALOG.find((v) => v.id === def.yandex && v.provider === 'yandex');
      const openaiEntry = VOICE_CATALOG.find((v) => v.id === def.openai && v.provider === 'openai');
      expect(yandexEntry?.gender).toBe(def.gender);
      expect(openaiEntry?.gender).toBe(def.gender);
    }
  });

  it('каждая комбинация GENDER_DEFAULT[gender][provider] есть в каталоге с тем же gender и provider', () => {
    for (const gender of ['m', 'f'] as const) {
      for (const provider of ['yandex', 'openai'] as const) {
        const voiceId = GENDER_DEFAULT[gender][provider];
        const entry = VOICE_CATALOG.find((v) => v.id === voiceId && v.provider === provider && v.gender === gender);
        expect(entry).toBeDefined();
      }
    }
  });
});
