import { VOICE_CATALOG, resolveVoice, providerForLang } from './voices';

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
