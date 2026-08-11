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
