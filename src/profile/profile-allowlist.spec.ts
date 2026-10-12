import { ProfileService } from './profile.service';
import { sanitizeProfilePatch } from './profile-patch';

/**
 * POST /webhook/profile-update вливал в profile_data любой ключ, а это поле
 * читают и сам человек, и другие:
 *   • в ответе GET /profile ключи profile_data перекрывали вычисленные поля —
 *     `isadmin`, `tokens`, `email` можно было «переписать» себе;
 *   • GET /user-profile отдавал любому вошедшему весь profile_data другого
 *     человека — бизнес-карточку, дату рождения, служебные пометки;
 *   • `avatar_url`, `business`, `contactVisible` писались в обход своих ручек.
 */

describe('sanitizeProfilePatch', () => {
  it('пропускает поля, которые пишут клиенты', () => {
    const { patch, dropped } = sanitizeProfilePatch({
      name: 'Анна', family_name: 'Иванова', user_nickname: 'anna', birthday: '1990-05-01', language: 'en',
    });
    expect(patch).toEqual({ name: 'Анна', family_name: 'Иванова', user_nickname: 'anna', birthday: '1990-05-01', language: 'en' });
    expect(dropped).toEqual([]);
  });

  it.each([
    'isadmin', 'tokens', 'email', 'phone', 'onboarded', 'preferred_agent', 'user_id',
    'avatar_url', 'business', 'contactVisible', 'low_balance_warned', 'smm_sdk_session_id', 'profile', 'что-то-новое',
  ])('отбрасывает %s', (key) => {
    const { patch, dropped } = sanitizeProfilePatch({ [key]: 'x', name: 'Анна' });
    expect(patch).toEqual({ name: 'Анна' });
    expect(dropped).toEqual([key]);
  });

  it('обрезает пробелы и слишком длинный текст', () => {
    const { patch } = sanitizeProfilePatch({ name: `  ${'я'.repeat(500)}  ` });
    expect(patch.name).toBe('я'.repeat(100));
  });

  it('null очищает поле, не-строку отбрасывает', () => {
    const { patch, dropped } = sanitizeProfilePatch({ family_name: null, name: { $gt: '' } });
    expect(patch).toEqual({ family_name: null });
    expect(dropped).toEqual(['name']);
  });

  it('язык сводит к поддерживаемому корню, незнакомый отбрасывает (не подменяет русским)', () => {
    expect(sanitizeProfilePatch({ language: 'pt-PT' }).patch).toEqual({ language: 'pt' });
    expect(sanitizeProfilePatch({ language: 'xx' })).toEqual({ patch: {}, dropped: ['language'] });
    expect(sanitizeProfilePatch({ language: null })).toEqual({ patch: {}, dropped: ['language'] });
  });

  it('голоса ассистентов проходят свою чистку', () => {
    const { patch } = sanitizeProfilePatch({ assistant_voices: 'не объект' });
    expect(patch).toEqual({ assistant_voices: {} });
  });

  it('портрет (values и др.) в profile_data не пишет — его забирает Neo4j', () => {
    const { patch, dropped } = sanitizeProfilePatch({ values: ['честность'], intentions: ['x'], skills: [] });
    expect(patch).toEqual({});
    expect(dropped).toEqual([]);
  });
});

function pgReturning(rows: any[][]) {
  const calls: { sql: string; params: any[] }[] = [];
  let i = 0;
  return {
    calls,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows: rows[i++] ?? [] };
    }),
  };
}

describe('ProfileService.updateProfile', () => {
  it('пишет в базу только разрешённое', async () => {
    const pg = pgReturning([]);
    await new ProfileService(pg as any).updateProfile('u-1', { name: 'Анна', isadmin: true, tokens: 10 ** 9 });
    expect(pg.calls).toHaveLength(1);
    expect(JSON.parse(pg.calls[0].params[0])).toEqual({ name: 'Анна' });
  });

  it('нечего писать — в базу не ходит', async () => {
    const pg = pgReturning([]);
    await new ProfileService(pg as any).updateProfile('u-1', { isadmin: true });
    expect(pg.calls).toHaveLength(0);
  });
});

describe('GET /profile: ключи profile_data не перекрывают вычисленные поля', () => {
  it('isadmin, tokens, email, phone и прочее — из колонок, а не из profile_data', async () => {
    const spoof = {
      isadmin: true, tokens: 999999999, email: 'spoof@example.com', phone: '70000000001', onboarded: true,
      preferred_agent: 'чужой', user_id: 'чужой', id: -1, signup_method: 'чужой', name: 'Анна', language: 'en',
    };
    const pg = pgReturning([
      [{ id: 7, user_id: 'u-1', preferred_agent: 'Роман', tokens: 25000, email: 'real@example.com', isadmin: false, onboarded: false, profile_data: spoof }],
      [{ primary_phone: '79990000000', primary_email: null, signup_method: 'phone' }],
    ]);
    const [{ profileJson: p }] = (await new ProfileService(pg as any).getProfile('u-1')) as any;
    expect(p).toMatchObject({
      id: 7, user_id: 'u-1', preferred_agent: 'Роман', tokens: 25000, email: 'real@example.com',
      phone: '79990000000', signup_method: 'phone', isadmin: false, onboarded: false,
    });
    // Свои настоящие ключи profile_data по-прежнему доходят.
    expect(p.name).toBe('Анна');
    expect(p.language).toBe('en');
  });
});

describe('GET /user-profile: о другом человеке — только публичное', () => {
  it('без бизнес-карточки, даты рождения и служебных ключей', async () => {
    const pd = {
      name: 'Анна', family_name: 'Иванова', user_nickname: 'anna', avatar_url: 'https://my.linkeon.io/smm-media/linkeon-assets/avatars/users/u-2.jpg',
      business: { revenue: 'секрет' }, birthday: '1990-05-01', language: 'en', low_balance_warned: { at: 1 },
      smm_sdk_session_id: 'секрет', assistant_voices: { 'Роман': 'alena' }, contactVisible: 'private',
    };
    const pg = pgReturning([[{ user_id: 'u-2', profile_data: pd }]]);
    const r: any = await new ProfileService(pg as any).getUserProfile('u-2');
    expect(Object.keys(r.profile_data).sort()).toEqual(
      ['avatar_url', 'beliefs', 'desires', 'family_name', 'intents', 'interests', 'name', 'skills', 'user_nickname', 'values'],
    );
    expect(JSON.stringify(r)).not.toContain('секрет');
    expect(r.name).toBe('Анна');
  });
});
