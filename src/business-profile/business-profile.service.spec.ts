import { BusinessProfileService } from './business-profile.service';
import { BusinessProfile } from './business-profile.types';

function makePg(profile: BusinessProfile = {}) {
  const state = { business: profile };
  return {
    query: jest.fn(async (sql: string, params: any[]) => {
      if (/SELECT/i.test(sql)) {
        return { rows: [{ profile_data: { name: 'Дмитрий', business: state.business } }] };
      }
      // UPDATE ... SET profile_data = jsonb_set(...)
      // merge шлёт JSON.stringify — мок обязан распарсить, иначе в state
      // окажется строка и обращения вида state.business.what.value упадут.
      state.business = JSON.parse(params[0]);
      // Строка профиля есть — UPDATE её реально задел.
      return { rows: [], rowCount: 1 };
    }),
    _state: state,
  } as any;
}

/** Для userId, которому в ai_profiles_consolidated нет строки: SELECT ничего
 *  не находит, UPDATE не задевает ни одной строки (WHERE user_id = $2 мимо). */
function makePgWithoutRow() {
  return {
    query: jest.fn(async (sql: string) => {
      if (/SELECT/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as any;
}

describe('BusinessProfileService.merge', () => {
  it('записывает новое поле, пришедшее от ассистента', async () => {
    const pg = makePg({});
    const svc = new BusinessProfileService(pg);

    await svc.merge('u1', { what: 'студия маникюра' }, 'assistant');

    expect(pg._state.business.what.value).toBe('студия маникюра');
    expect(pg._state.business.what.source).toBe('assistant');
  });

  it('НЕ перезаписывает поле, которое правил пользователь', async () => {
    const pg = makePg({
      tax_mode: { value: 'usn_d', source: 'user', updated_at: '2026-08-01T00:00:00Z' },
    });
    const svc = new BusinessProfileService(pg);

    await svc.merge('u1', { tax_mode: 'osno' }, 'assistant');

    expect(pg._state.business.tax_mode.value).toBe('usn_d');
    expect(pg._state.business.tax_mode.source).toBe('user');
  });

  it('перезаписывает собственную прошлую догадку ассистента', async () => {
    const pg = makePg({
      tax_mode: { value: 'osno', source: 'assistant', updated_at: '2026-08-01T00:00:00Z' },
    });
    const svc = new BusinessProfileService(pg);

    await svc.merge('u1', { tax_mode: 'usn_d' }, 'assistant');

    expect(pg._state.business.tax_mode.value).toBe('usn_d');
  });

  it('правка пользователем перебивает значение ассистента и меняет source', async () => {
    const pg = makePg({
      tax_mode: { value: 'osno', source: 'assistant', updated_at: '2026-08-01T00:00:00Z' },
    });
    const svc = new BusinessProfileService(pg);

    await svc.merge('u1', { tax_mode: 'usn_d' }, 'user');

    expect(pg._state.business.tax_mode.value).toBe('usn_d');
    expect(pg._state.business.tax_mode.source).toBe('user');
  });

  it('игнорирует неизвестные ключи и пустые значения', async () => {
    const pg = makePg({});
    const svc = new BusinessProfileService(pg);

    await svc.merge('u1', { nonsense: 'x', what: '   ' } as any, 'assistant');

    expect(pg._state.business).toEqual({});
  });

  it('отбрасывает значение вне enum-словаря', async () => {
    const pg = makePg({});
    const svc = new BusinessProfileService(pg);

    await svc.merge('u1', { tax_mode: 'выдуманный_режим' }, 'assistant');

    expect(pg._state.business.tax_mode).toBeUndefined();
  });

  it('missingFields перечисляет незаполненное', async () => {
    const pg = makePg({
      what: { value: 'студия', source: 'user', updated_at: 'x' },
    });
    const svc = new BusinessProfileService(pg);

    const missing = await svc.missingFields('u1');

    expect(missing).not.toContain('what');
    expect(missing).toContain('revenue');
    expect(missing).toHaveLength(7);
  });

  it('не сообщает об успехе, если строки профиля в базе нет', async () => {
    const pg = makePgWithoutRow();
    const svc = new BusinessProfileService(pg);

    const result = await svc.merge('u-missing', { what: 'студия' }, 'user');

    expect(result).toEqual({});
  });

  it('сохраняет и возвращает новое состояние, когда строка есть', async () => {
    const pg = makePg({});
    const svc = new BusinessProfileService(pg);

    const result = await svc.merge('u1', { what: 'студия' }, 'user');

    expect(result.what?.value).toBe('студия');
  });
});
