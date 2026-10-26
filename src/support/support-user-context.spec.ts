import { SupportService } from './support.service';

/// get_user_context уходит модели ИИ-поддержки. Идентификатор аккаунта (у
/// телефонных пользователей — номер) ей не нужен и не передаётся (спека
/// 2026-10-26-mcp-turn-token-design.md); имя, почта, баланс и язык остаются.
describe('ИИ-поддержка: get_user_context без идентификатора аккаунта', () => {
  const ROW = {
    user_id: '79030169187',
    tokens: '1200',
    email: 'user@example.com',
    preferred_agent: '12',
    profile_data: { name: 'Дмитрий', family_name: 'В.', language: 'en' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: null,
    isadmin: false,
  };

  it('имя, почта, баланс и язык — есть; user_id и номера — нет', async () => {
    const svc = new SupportService({ query: jest.fn(async () => ({ rows: [ROW] })) } as any);
    const out = await (svc as any).executeTool('t-1', '79030169187', 'get_user_context', {});
    expect(out).not.toHaveProperty('user_id');
    expect(JSON.stringify(out)).not.toContain('79030169187');
    expect(out).toMatchObject({ tokens: 1200, email: 'user@example.com', name: 'Дмитрий', language: 'en' });
  });
});
