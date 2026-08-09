import { LanguageService } from '../common/services/language.service';

describe('языковая директива в промпте', () => {
  it('для испанского называет испанский, а не русский', () => {
    const d = LanguageService.buildDirective('es');
    expect(d).toContain('español');
    expect(d).not.toContain('Язык интерфейса пользователя — русском');
  });

  it('для русского профиля остаётся русской', () => {
    expect(LanguageService.buildDirective('ru')).toContain('русском');
  });

  it('неизвестный код деградирует в русский, а не в пустоту', () => {
    const d = LanguageService.buildDirective('xx');
    expect(d).toContain('русском');
  });

  it('всегда разрешает подстройку под язык реплики', () => {
    for (const lang of ['ru', 'en', 'es', 'de', 'fr', 'zh']) {
      expect(LanguageService.buildDirective(lang)).toContain('языке его последнего сообщения');
    }
  });
});

describe('resolveUserLanguage — приоритет профиля и подсказки из запроса', () => {
  const svcWith = (language: string | null) =>
    new LanguageService({ query: async () => ({ rows: [{ language }] }) } as any);

  it('язык профиля побеждает подсказку из запроса', async () => {
    // Профиль — явный выбор пользователя, синхронный между устройствами и
    // мобильным приложением. Запрос не должен его перебивать.
    expect(await svcWith('es').resolveUserLanguage('u1', 'de')).toBe('es');
  });

  it('пустой профиль закрывается подсказкой из запроса', async () => {
    // Ровно случай новорега: AuthContext пишет язык в профиль без await, и
    // первое сообщение успевает уйти раньше записи.
    expect(await svcWith(null).resolveUserLanguage('u2', 'de')).toBe('de');
  });

  it('подсказка схлопывается до корня и проверяется по списку', async () => {
    expect(await svcWith(null).resolveUserLanguage('u3', 'es-MX')).toBe('es');
    expect(await svcWith(null).resolveUserLanguage('u4', 'pt-BR')).toBe('ru');
  });

  it('нет ни профиля, ни подсказки — русский', async () => {
    expect(await svcWith(null).resolveUserLanguage('u5')).toBe('ru');
  });

  it('падение базы не роняет ответ', async () => {
    const svc = new LanguageService({
      query: async () => { throw new Error('db down'); },
    } as any);
    expect(await svc.resolveUserLanguage('u6', 'de')).toBe('ru');
  });
});
