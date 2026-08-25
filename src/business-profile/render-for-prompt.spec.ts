import { BusinessProfileService } from './business-profile.service';
import { BusinessProfile, renderBusinessBlock } from './business-profile.types';

const FULL: BusinessProfile = {
  what:       { value: 'студия маникюра, 2 точки в Казани', source: 'user', updated_at: 'x' },
  legal_form: { value: 'ip', source: 'user', updated_at: 'x' },
  tax_mode:   { value: 'usn_d', source: 'user', updated_at: 'x' },
  stage:      { value: 'stable', source: 'assistant', updated_at: 'x' },
  revenue:    { value: '1m_3m', source: 'assistant', updated_at: 'x' },
  team:       { value: '4 мастера + администратор', source: 'assistant', updated_at: 'x' },
  customers:  { value: 'B2C, женщины 25-45', source: 'assistant', updated_at: 'x' },
};

/**
 * Рендер — чистая функция, поэтому основная батарея тестов идёт без мока
 * Postgres вовсе. `svcWith` нужен только последнему тесту, который проверяет
 * саму обёртку сервиса: что она читает карточку и делегирует, а не рендерит
 * во второй раз по-своему.
 */
function svcWith(profile: BusinessProfile) {
  const pg = {
    query: jest.fn(async () => ({ rows: [{ profile_data: { business: profile } }] })),
  } as any;
  return new BusinessProfileService(pg);
}

describe('renderBusinessBlock', () => {
  it('для business отдаёт полный блок с человекочитаемыми enum', () => {
    const out = renderBusinessBlock(FULL, 'business');

    expect(out).toContain('Business profile:');
    expect(out).toContain('студия маникюра, 2 точки в Казани');
    expect(out).toContain('ИП');            // не 'ip'
    expect(out).toContain('УСН Доходы');    // не 'usn_d'
    expect(out).toContain('1–3 млн ₽/мес'); // не '1m_3m'
  });

  it('для business перечисляет незаполненное', () => {
    const out = renderBusinessBlock(FULL, 'business');
    expect(out).toContain('Not filled in');
    expect(out).toContain('Current focus');
  });

  it('когда заполнено всё, строки про незаполненное нет', () => {
    const out = renderBusinessBlock({
      ...FULL,
      focus: { value: 'кассовый разрыв', source: 'user', updated_at: 'x' },
    }, 'business');
    expect(out).not.toContain('Not filled in');
  });

  it('для personal отдаёт одну строку без цифр', () => {
    const out = renderBusinessBlock(FULL, 'personal');

    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out).toContain('студия маникюра');
    expect(out).not.toContain('УСН');
    expect(out).not.toContain('млн');
    expect(out).not.toContain('1m_3m');
  });

  it('для assistant и для кастомных ассистентов — тоже строка', () => {
    for (const cat of ['assistant', 'custom', null, undefined] as any[]) {
      const out = renderBusinessBlock(FULL, cat);
      expect(out.trim().split('\n')).toHaveLength(1);
      expect(out).not.toContain('УСН');
    }
  });

  it('пустая карточка не даёт ничего ни в одном режиме', () => {
    expect(renderBusinessBlock({}, 'business')).toBe('');
    expect(renderBusinessBlock({}, 'personal')).toBe('');
  });

  it('карточка без what не даёт строку-резюме — резюмировать нечего', () => {
    expect(renderBusinessBlock({
      tax_mode: { value: 'usn_d', source: 'user', updated_at: 'x' },
    }, 'personal')).toBe('');
  });
});

describe('BusinessProfileService.renderForPrompt', () => {
  it('читает карточку пользователя и отдаёт тот же блок, что и чистая функция', async () => {
    const out = await svcWith(FULL).renderForPrompt('u1', 'business');
    expect(out).toBe(renderBusinessBlock(FULL, 'business'));
  });

  it('без подключения к базе не падает, а отдаёт пусто', async () => {
    const svc = new BusinessProfileService(undefined);
    expect(await svc.renderForPrompt('u1', 'business')).toBe('');
    expect(await svc.read('u1')).toEqual({});
    expect(await svc.merge('u1', { what: 'студия' }, 'user')).toEqual({});
  });
});
