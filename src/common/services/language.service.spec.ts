import { LanguageService, SUPPORTED_LANGUAGES, LANGUAGE_NAMES } from './language.service';

describe('LanguageService', () => {
  const makePg = (rows: any[]) => ({ query: jest.fn().mockResolvedValue({ rows }) }) as any;

  describe('normalize', () => {
    it('пропускает поддерживаемый код', () => {
      expect(LanguageService.normalize('es')).toBe('es');
    });

    it('схлопывает региональный вариант', () => {
      expect(LanguageService.normalize('es-MX')).toBe('es');
      expect(LanguageService.normalize('ZH_HANS')).toBe('zh');
    });

    it('падает в русский на неизвестном и пустом', () => {
      // Раньше примером неподдерживаемого языка служил 'pt'. Португальский с тех
      // пор добавили в SUPPORTED_LANGUAGES, и тест краснел, требуя от живого
      // языка отката в русский. Берём коды, которых в списке заведомо нет.
      expect(LanguageService.normalize('ja')).toBe('ru');
      expect(LanguageService.normalize('klingon')).toBe('ru');
      expect(LanguageService.normalize(undefined)).toBe('ru');
      expect(LanguageService.normalize(null)).toBe('ru');
    });

    it('каждый язык из списка нормализуется сам в себя', () => {
      // Страховка от повторения истории: язык, добавленный в SUPPORTED_LANGUAGES,
      // больше не может втихую откатываться в русский, а этот тест — устареть,
      // потому что он читает сам список, а не его копию.
      for (const code of SUPPORTED_LANGUAGES) {
        expect(LanguageService.normalize(code)).toBe(code);
      }
    });
  });

  describe('SUPPORTED_LANGUAGES', () => {
    it('у каждого языка есть человекочитаемое название для промпта', () => {
      for (const code of SUPPORTED_LANGUAGES) {
        expect(LANGUAGE_NAMES[code]).toBeTruthy();
      }
    });
  });

  describe('resolveUserLanguage', () => {
    it('возвращает язык из profile_data', async () => {
      const svc = new LanguageService(makePg([{ language: 'de' }]));
      await expect(svc.resolveUserLanguage('u1')).resolves.toBe('de');
    });

    it('нормализует региональный вариант из профиля', async () => {
      const svc = new LanguageService(makePg([{ language: 'fr-CA' }]));
      await expect(svc.resolveUserLanguage('u1')).resolves.toBe('fr');
    });

    it('падает в русский, если профиля нет', async () => {
      const svc = new LanguageService(makePg([]));
      await expect(svc.resolveUserLanguage('u1')).resolves.toBe('ru');
    });

    it('падает в русский, если запрос упал', async () => {
      const pg = { query: jest.fn().mockRejectedValue(new Error('boom')) } as any;
      const svc = new LanguageService(pg);
      await expect(svc.resolveUserLanguage('u1')).resolves.toBe('ru');
    });
  });

  describe('buildDirective', () => {
    it('называет язык и разрешает подстройку под пользователя', () => {
      const directive = LanguageService.buildDirective('es');
      expect(directive).toContain('Spanish');
      expect(directive).toContain('языке его последнего сообщения');
    });
  });
});

describe('директива и язык истории', () => {
  // Найдено на живом аккаунте: язык в профиле сменили на английский, а
  // ассистент продолжал отвечать по-русски. На пустом аккаунте тот же
  // английский работал сразу — разница была только в накопленной переписке.
  // Директива перечисляла, что игнорировать (системные сообщения, tool-
  // результаты, пути файлов), но историю не называла, и та перевешивала.
  it('прямо велит игнорировать язык прежней переписки', () => {
    const d = LanguageService.buildDirective('en');
    expect(d).toMatch(/ПРЕДЫДУЩЕЙ ПЕРЕПИСКИ НЕ ИМЕЕТ ЗНАЧЕНИЯ/);
    expect(d).toContain('английском');
  });

  it('правило про язык последнего сообщения осталось', () => {
    const d = LanguageService.buildDirective('de');
    expect(d).toMatch(/языке его последнего сообщения/);
  });
});

describe('директива против русского промпта', () => {
  // Весь системный промпт — по-русски: платформа, промпт ассистента, правила
  // ответа. Тысячи русских слов перевешивали одну русскую строчку «отвечай
  // по-английски», и Роман с его длинным промптом отвечал по-русски даже при
  // language=en в профиле.
  it('заканчивается требованием на самом целевом языке', () => {
    expect(LanguageService.buildDirective('en').trimEnd())
      .toMatch(/Reply in English\.$/);
    expect(LanguageService.buildDirective('de').trimEnd())
      .toMatch(/Antworte auf Deutsch\.$/);
    expect(LanguageService.buildDirective('zh').trimEnd())
      .toMatch(/请用简体中文回复。$/);
  });

  it('прямо снимает русский язык инструкций как образец', () => {
    expect(LanguageService.buildDirective('fr'))
      .toMatch(/НЕ.*указание отвечать по-русски/);
  });

  it('для русского строка тоже русская, без противоречия', () => {
    expect(LanguageService.buildDirective('ru').trimEnd())
      .toMatch(/Отвечай по-русски\.$/);
  });

  it('незнакомый язык не оставляет директиву без последней строки', () => {
    expect(LanguageService.buildDirective('xx').trimEnd())
      .toMatch(/Отвечай по-русски\.$/);
  });
});
