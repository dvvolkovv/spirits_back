import { ProfileService, sanitizeAssistantVoices } from './profile.service';

describe('sanitizeAssistantVoices', () => {
  it('пропускает валидные пары', () => {
    expect(sanitizeAssistantVoices({ 'Роман': 'filipp', 'Оля': 'nova' }))
      .toEqual({ 'Роман': 'filipp', 'Оля': 'nova' });
  });

  it('выбрасывает несуществующие голоса', () => {
    expect(sanitizeAssistantVoices({ 'Роман': 'megatron-9000' })).toEqual({});
  });

  it('null очищает переопределение', () => {
    expect(sanitizeAssistantVoices({ 'Роман': null })).toEqual({});
  });

  it('не-объект превращается в пустой объект', () => {
    expect(sanitizeAssistantVoices('строка' as any)).toEqual({});
    expect(sanitizeAssistantVoices(null as any)).toEqual({});
  });

  it('ограничивает число ключей', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 200; i++) many[`Агент${i}`] = 'zahar';
    expect(Object.keys(sanitizeAssistantVoices(many)).length).toBeLessThanOrEqual(50);
  });
});

/**
 * Санитайзер бесполезен, если его перестанут вызывать. Эти тесты держат сам
 * вызов в updateProfile: проверяют, что в jsonb-патч уезжает уже очищенный
 * объект, а не сырое тело запроса.
 */
describe('ProfileService.updateProfile — assistant_voices', () => {
  function makeService() {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const pg: any = {
      query: async (sql: string, params: any[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };
    return { service: new ProfileService(pg), calls };
  }

  function patchOf(calls: Array<{ sql: string; params: any[] }>) {
    const update = calls.find((c) => c.sql.includes('profile_data'));
    if (!update) throw new Error('UPDATE profile_data не выполнился');
    return JSON.parse(update.params[0]);
  }

  it('прогоняет assistant_voices через санитайзер перед мержем', async () => {
    const { service, calls } = makeService();
    await service.updateProfile('u1', {
      name: 'Дима',
      assistant_voices: { 'Роман': 'megatron-9000', 'Оля': 'alena', 'Миша': null },
    });
    const patch = patchOf(calls);
    expect(patch.assistant_voices).toEqual({ 'Оля': 'alena' });
    expect(patch.name).toBe('Дима');
  });

  it('не-объект в assistant_voices не уезжает в базу как есть', async () => {
    const { service, calls } = makeService();
    await service.updateProfile('u1', { assistant_voices: 'дай-мне-всё' as any });
    expect(patchOf(calls).assistant_voices).toEqual({});
  });

  it('не подставляет assistant_voices, если поля не было в теле запроса', async () => {
    const { service, calls } = makeService();
    await service.updateProfile('u1', { name: 'Дима' });
    expect('assistant_voices' in patchOf(calls)).toBe(false);
  });
});
