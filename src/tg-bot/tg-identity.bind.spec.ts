import { TgIdentityService, TgIdentityConflictError } from './tg-identity.service';
import { TgBotService } from './tg-bot.service';

/**
 * Привязка Telegram к аккаунту Linkeon.
 *
 * Жалоба владельца 22.08.2026: при привязке @nomira_ai ко второму аккаунту
 * пришло «Не получилось привязать: duplicate key ... tg_user_identities_
 * tg_user_id_key. Сгенерируй новую ссылку (TTL 15 минут)». Совет бесполезен:
 * Telegram занят другим аккаунтом с 10 июня, и новая ссылка упрётся туда же.
 *
 * Хуже того, токен гасился ДО вставки — то есть ссылка действительно сгорала
 * при каждой неудачной попытке, и совет выглядел правдоподобно.
 */

function makeClient(insertFails: boolean) {
  const calls: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      calls.push(sql.trim().split('\n')[0].trim());
      if (sql.startsWith('SELECT owner_user_id')) return { rows: [{ owner_user_id: '79169403771' }] };
      if (sql.includes('INSERT INTO tg_user_identities') && insertFails) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: 'tg_user_identities_tg_user_id_key',
        });
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  return { client, calls };
}

function makeService(insertFails: boolean) {
  const { client, calls } = makeClient(insertFails);
  const pg = { getClient: jest.fn(async () => client) };
  return { svc: new TgIdentityService(pg as any), calls, client };
}

describe('TgIdentityService.consumeAuthToken', () => {
  it('успешная привязка коммитится', async () => {
    const { svc, calls } = makeService(false);

    await expect(svc.consumeAuthToken('tok', 7643480198, 'nomira_ai', 'Nomira')).resolves.toBe('79169403771');

    expect(calls).toContain('COMMIT');
    expect(calls).not.toContain('ROLLBACK');
  });

  it('занятый Telegram — понятная ошибка, а не сырой duplicate key', async () => {
    const { svc } = makeService(true);

    await expect(svc.consumeAuthToken('tok', 7643480198, 'nomira_ai', 'Nomira'))
      .rejects.toBeInstanceOf(TgIdentityConflictError);
  });

  it('провал откатывает транзакцию — токен не сгорает', async () => {
    // Это и есть суть фикса: гашение токена и вставка теперь атомарны.
    const { svc, calls } = makeService(true);

    await svc.consumeAuthToken('tok', 7643480198, 'nomira_ai', 'Nomira').catch(() => {});

    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  it('клиент возвращается в пул в любом случае', async () => {
    const { svc, client } = makeService(true);

    await svc.consumeAuthToken('tok', 1, null, null).catch(() => {});

    expect(client.release).toHaveBeenCalled();
  });
});

describe('TgBotService.bindFailureMessage', () => {
  it('занятый Telegram: не советует новую ссылку и называет аккаунт', () => {
    const msg = TgBotService.bindFailureMessage(
      new TgIdentityConflictError(7643480198, 'nomira_ai'),
      { id: 7643480198, username: 'nomira_ai' },
    );

    expect(msg).toContain('@nomira_ai');
    expect(msg).toContain('уже привязан к другому аккаунту');
    expect(msg).not.toContain('TTL 15 минут');
  });

  it('без username называет числовой id — чтобы было видно, какой Telegram пришёл', () => {
    const msg = TgBotService.bindFailureMessage(
      new TgIdentityConflictError(37948399, null),
      { id: 37948399, username: null },
    );

    expect(msg).toContain('37948399');
  });

  it('настоящий протухший токен по-прежнему советует новую ссылку', () => {
    // Проверка в обратную сторону: чиня один диагноз, нельзя потерять другой.
    const msg = TgBotService.bindFailureMessage(new Error('invalid or expired auth token'), { id: 1 });

    expect(msg).toContain('TTL 15 минут');
  });
});
