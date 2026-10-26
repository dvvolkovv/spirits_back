import { checkBotToken } from './bot-token-check';

const TOKEN = '1234567890:AAH9sdfjKJHkjh34kjh5kjh6KJHkjhKJHkj';
const res = (status: number, body: any) => ({ status, json: async () => body }) as any;

describe('проверка токена бота', () => {
  it('не похоже на токен — даже не идём в Telegram', async () => {
    const f = jest.fn();
    expect(await checkBotToken('nope', f as any)).toEqual({ ok: false, reason: 'bad_form' });
    expect(f).not.toHaveBeenCalled();
  });

  it('Telegram принял — id и имя бота', async () => {
    const f = jest.fn(async () => res(200, { ok: true, result: { id: 1234567890, username: 'shop_bot' } }));
    expect(await checkBotToken(` ${TOKEN} `, f as any)).toEqual({ ok: true, id: 1234567890, username: 'shop_bot' });
    expect((f.mock.calls[0] as any[])[0]).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it('401 — токен отозван или чужой', async () => {
    expect(await checkBotToken(TOKEN, (async () => res(401, { ok: false })) as any)).toEqual({ ok: false, reason: 'rejected' });
  });

  it('тело без ok: true — не успех (прокси, заглушка)', async () => {
    expect(await checkBotToken(TOKEN, (async () => res(200, {})) as any)).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('сетевая ошибка — unreachable, текст с токеном наружу не уходит', async () => {
    const r = await checkBotToken(TOKEN, (async () => { throw new Error(`fetch failed https://api.telegram.org/bot${TOKEN}`); }) as any);
    expect(r).toEqual({ ok: false, reason: 'unreachable' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
