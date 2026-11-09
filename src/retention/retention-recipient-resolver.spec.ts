import { RetentionRecipientResolver } from './retention-recipient-resolver';

const UUID = '11111111-1111-4111-8111-111111111111';

function fakePg(rows: {
  profiles?: any[]; accounts?: any[]; identities?: any[]; suppressed?: string[];
}) {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM ai_profiles_consolidated')) return { rows: rows.profiles || [] };
      if (sql.includes('FROM user_identities')) return { rows: rows.identities || [] };
      if (sql.includes('FROM user_id')) return { rows: rows.accounts || [] };
      if (sql.includes('retention_email_unsubscribes')) {
        return { rows: (rows.suppressed || []).map((email_normalized) => ({ email_normalized })) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
}

describe('RetentionRecipientResolver', () => {
  const language = { resolveUserLanguage: jest.fn(async () => 'en') };

  it('пропускает невалидный profile email и выбирает primary_email', async () => {
    const pg = fakePg({
      profiles: [{ user_id: UUID, email: 'bad' }],
      accounts: [{ user_id: UUID, primary_email: ' Primary@Example.com ' }],
    });
    const result = await new RetentionRecipientResolver(pg as any, language as any).resolve([UUID]);
    expect(result.get(UUID)).toMatchObject({ email: 'primary@example.com', language: 'en', unsubscribed: false });
  });

  it('отписанный profile email пропускается в пользу другого активного адреса', async () => {
    const pg = fakePg({
      profiles: [{ user_id: UUID, email: 'old@example.com' }],
      identities: [{ user_id: UUID, provider: 'email', provider_sub: 'new@example.com', email: 'new@example.com', email_verified: true }],
      suppressed: ['old@example.com'],
    });
    const result = await new RetentionRecipientResolver(pg as any, language as any).resolve([UUID]);
    expect(result.get(UUID)).toMatchObject({ email: 'new@example.com', unsubscribed: false });
  });

  it('если все известные адреса отписаны, SMS не разрешён', async () => {
    const pg = fakePg({
      profiles: [{ user_id: UUID, email: 'old@example.com' }],
      identities: [{ user_id: UUID, provider: 'phone', provider_sub: '+79001112233', email_verified: false }],
      suppressed: ['old@example.com'],
    });
    const result = await new RetentionRecipientResolver(pg as any, language as any).resolve([UUID]);
    expect(result.get(UUID)).toMatchObject({ email: null, phone: '79001112233', unsubscribed: true });
  });

  it('UUID без email получает телефон из phone-identity', async () => {
    const pg = fakePg({
      identities: [{ user_id: UUID, provider: 'phone', provider_sub: '+79001112233', email_verified: false }],
    });
    const result = await new RetentionRecipientResolver(pg as any, language as any).resolve([UUID]);
    expect(result.get(UUID)).toMatchObject({ email: null, phone: '79001112233', unsubscribed: false });
  });

  it('phone identity выбирается по recency независимо от email_verified', async () => {
    const pg = fakePg({
      identities: [
        {
          user_id: UUID,
          provider: 'phone',
          provider_sub: '+79001112233',
          email_verified: true,
          last_used_at: '2026-01-01T00:00:00.000Z',
          created_at: '2025-01-01T00:00:00.000Z',
        },
        {
          user_id: UUID,
          provider: 'phone',
          provider_sub: '+79009998877',
          email_verified: false,
          last_used_at: '2026-02-01T00:00:00.000Z',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const result = await new RetentionRecipientResolver(pg as any, language as any).resolve([UUID]);
    expect(result.get(UUID)?.phone).toBe('79009998877');
  });

  it('один отписанный адрес блокирует оба аккаунта с этим email', async () => {
    const second = '44444444-4444-4444-8444-444444444444';
    const pg = fakePg({
      profiles: [{ user_id: UUID, email: 'same@example.com' }, { user_id: second, email: 'same@example.com' }],
      suppressed: ['same@example.com'],
    });
    const result = await new RetentionRecipientResolver(pg as any, language as any).resolve([UUID, second]);
    expect(result.get(UUID)?.unsubscribed).toBe(true);
    expect(result.get(second)?.unsubscribed).toBe(true);
  });
});
