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
