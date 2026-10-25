import * as crypto from 'crypto';
import { TmaController } from './tma.controller';

const BOT_TOKEN = '123456:TEST-TOKEN-AAAA';

function signInitData(fields: Record<string, string>): string {
  const dataCheckString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const freshInitData = (tgId = 42) =>
  signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: tgId, first_name: 'Дмитрий', username: 'dv' }),
  });

function mockRes() {
  const res: any = {};
  res.set = jest.fn(() => res);
  res.status = jest.fn((code: number) => { res._status = code; return res; });
  res.json = jest.fn((body: any) => { res._body = body; return res; });
  return res;
}

describe('POST /webhook/tma/auth', () => {
  let pg: any, identity: any, jwt: any, ctrl: TmaController;

  beforeEach(() => {
    process.env.TG_BOT_TOKEN = BOT_TOKEN;
    pg = { query: jest.fn().mockResolvedValue({ rows: [] }), getClient: jest.fn() };
    identity = { resolveOrCreate: jest.fn(), touchIdentity: jest.fn(), isDeleted: jest.fn().mockResolvedValue(false) };
    jwt = { signAccess: jest.fn(() => 'ACC'), signRefresh: jest.fn(() => 'REF') };
    ctrl = new TmaController(pg, identity, jwt);
  });

  it('отвергает битую подпись с 401', async () => {
    const res = mockRes();
    await ctrl.auth({ initData: 'user=%7B%22id%22%3A1%7D&hash=deadbeef' }, res);
    expect(res._status).toBe(401);
    expect(identity.resolveOrCreate).not.toHaveBeenCalled();
  });

  it('незнакомому tg_user_id без intent отдаёт 404 needsChoice', async () => {
    const res = mockRes();
    await ctrl.auth({ initData: freshInitData() }, res);
    expect(res._status).toBe(404);
    expect(res._body).toEqual({ needsChoice: true });
    expect(identity.resolveOrCreate).not.toHaveBeenCalled();
  });

  it('с intent=signup заводит аккаунт и отдаёт пару токенов', async () => {
    identity.resolveOrCreate.mockResolvedValue({ status: 'ok', userId: 'u-new', isNew: true, mergedExisting: false });
    const res = mockRes();
    await ctrl.auth({ initData: freshInitData(), intent: 'signup' }, res);
    expect(identity.resolveOrCreate).toHaveBeenCalledWith('telegram', { sub: '42' });
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ 'access-token': 'ACC', 'refresh-token': 'REF' });
  });

  it('находит пользователя по user_identities и не заводит нового', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ user_id: 'u-known' }] });
    const res = mockRes();
    await ctrl.auth({ initData: freshInitData() }, res);
    expect(identity.resolveOrCreate).not.toHaveBeenCalled();
    expect(jwt.signAccess).toHaveBeenCalledWith('u-known');
    expect(res._status).toBe(200);
    expect(identity.touchIdentity).toHaveBeenCalledWith('telegram', '42');
  });

  it('находит старожила бота по tg_user_identities и дописывает строку в user_identities', async () => {
    pg.query
      .mockResolvedValueOnce({ rows: [] })                              // user_identities — пусто
      .mockResolvedValueOnce({ rows: [{ linkeon_user_id: 'u-bot' }] })  // tg_user_identities — есть
      .mockResolvedValueOnce({ rows: [] });                             // бэкфилл INSERT
    const res = mockRes();
    await ctrl.auth({ initData: freshInitData() }, res);
    expect(res._status).toBe(200);
    expect(jwt.signAccess).toHaveBeenCalledWith('u-bot');
    const backfill = pg.query.mock.calls[2][0];
    expect(backfill).toContain('INSERT INTO user_identities');
    expect(identity.touchIdentity).toHaveBeenCalledWith('telegram', '42');
  });

  /// Удалённый аккаунт не входит через мини-приложение ни по одной ветке.
  ///
  /// Связки, указывающие на удалённый аккаунт, — мусор: Telegram вёл себя как
  /// незнакомый (ветка 3), а получал токены удалённого аккаунта, и ветка
  /// «старожилов» вдобавок заново заводила ему связку входа.
  describe('удалённый аккаунт', () => {
    /** pg, отвечающий по тексту запроса: какие связки есть и что удалено. */
    function routedPg(opts: { known?: string; fromBot?: string }) {
      const calls: Array<{ sql: string; params: any[] }> = [];
      pg.query.mockImplementation(async (sql: string, params: any[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        calls.push({ sql: s, params });
        if (s.startsWith('SELECT user_id FROM user_identities')) {
          return { rows: opts.known ? [{ user_id: opts.known }] : [] };
        }
        if (s.startsWith('SELECT linkeon_user_id FROM tg_user_identities')) {
          return { rows: opts.fromBot ? [{ linkeon_user_id: opts.fromBot }] : [] };
        }
        return { rows: [], rowCount: 0 };
      });
      return calls;
    }

    beforeEach(() => {
      identity.isDeleted.mockImplementation(async (id: string) => id === 'u-deleted');
    });

    it('связка входа ведёт в удалённый аккаунт — токенов нет, 404 needsChoice', async () => {
      const calls = routedPg({ known: 'u-deleted' });
      const res = mockRes();
      await ctrl.auth({ initData: freshInitData() }, res);
      expect(jwt.signAccess).not.toHaveBeenCalled();
      expect(res._status).toBe(404);
      expect(res._body).toEqual({ needsChoice: true });
      // Связку удалённого аккаунта снимаем — ровно ту, что нашли.
      const release = calls.find((c) => c.sql.startsWith('DELETE FROM user_identities'));
      expect(release?.params).toEqual(['42', 'u-deleted']);
    });

    it('старожил бота с удалённым аккаунтом — токенов нет, связку входа заново не заводим', async () => {
      const calls = routedPg({ fromBot: 'u-deleted' });
      const res = mockRes();
      await ctrl.auth({ initData: freshInitData() }, res);
      expect(jwt.signAccess).not.toHaveBeenCalled();
      expect(res._status).toBe(404);
      expect(res._body).toEqual({ needsChoice: true });
      expect(calls.some((c) => c.sql.startsWith('INSERT INTO user_identities'))).toBe(false);
      const release = calls.find((c) => c.sql.startsWith('DELETE FROM tg_user_identities'));
      expect(release?.params).toEqual([42, 'u-deleted']);
    });

    it('с intent=signup заводит НОВЫЙ аккаунт и выдаёт токены ему, а не удалённому', async () => {
      const calls = routedPg({ known: 'u-deleted', fromBot: 'u-deleted' });
      identity.resolveOrCreate.mockResolvedValue({ status: 'ok', userId: 'u-new', isNew: true, mergedExisting: false });
      const res = mockRes();
      await ctrl.auth({ initData: freshInitData(), intent: 'signup' }, res);
      expect(res._status).toBe(200);
      expect(jwt.signAccess).toHaveBeenCalledWith('u-new');
      expect(jwt.signAccess).not.toHaveBeenCalledWith('u-deleted');
      // Обе связки удалённого аккаунта сняты ДО регистрации: иначе
      // resolveOrCreate нашёл бы старую связку входа, а вставка в
      // tg_user_identities упёрлась бы в UNIQUE на tg_user_id.
      const signupAt = identity.resolveOrCreate.mock.invocationCallOrder[0];
      const releases = calls
        .map((c, i) => ({ c, order: pg.query.mock.invocationCallOrder[i] }))
        .filter(({ c }) => c.sql.startsWith('DELETE FROM'));
      expect(releases).toHaveLength(2);
      for (const r of releases) expect(r.order).toBeLessThan(signupAt);
    });

    it('связка входа — в удалённый аккаунт, связка бота — в живой: токены живому, связка входа дописана ему', async () => {
      const calls = routedPg({ known: 'u-deleted', fromBot: 'u-bot' });
      const res = mockRes();
      await ctrl.auth({ initData: freshInitData() }, res);
      expect(res._status).toBe(200);
      expect(jwt.signAccess).toHaveBeenCalledWith('u-bot');
      expect(jwt.signAccess).not.toHaveBeenCalledWith('u-deleted');
      // Мёртвая связка снята ДО дозаписи: иначе ON CONFLICT DO NOTHING молча
      // оставил бы её, и следующий вход снова начинался бы с удалённого.
      const releaseAt = calls.findIndex((c) => c.sql.startsWith('DELETE FROM user_identities'));
      const backfillAt = calls.findIndex((c) => c.sql.startsWith('INSERT INTO user_identities'));
      expect(releaseAt).toBeGreaterThanOrEqual(0);
      expect(backfillAt).toBeGreaterThan(releaseAt);
      expect(calls[backfillAt].params).toEqual(['u-bot', '42']);
      expect(identity.touchIdentity).toHaveBeenCalledWith('telegram', '42');
    });

    it('живой аккаунт по-прежнему входит', async () => {
      routedPg({ known: 'u-known' });
      const res = mockRes();
      await ctrl.auth({ initData: freshInitData() }, res);
      expect(res._status).toBe(200);
      expect(jwt.signAccess).toHaveBeenCalledWith('u-known');
    });
  });

  describe('stage в логе называет упавшую операцию, а не предыдущую успешную', () => {
    it('падение touchIdentity в ветке user_identities логируется как touch:user_identities', async () => {
      pg.query.mockResolvedValueOnce({ rows: [{ user_id: 'u-known' }] });
      identity.touchIdentity.mockRejectedValueOnce(new Error('boom'));
      const errorSpy = jest.spyOn((ctrl as any).logger, 'error').mockImplementation(() => undefined);
      const res = mockRes();

      await expect(ctrl.auth({ initData: freshInitData() }, res)).rejects.toThrow('boom');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain('touch:user_identities');
    });

    it('падение touchIdentity в ветке tg_user_identities логируется как touch:tg_user_identities', async () => {
      pg.query
        .mockResolvedValueOnce({ rows: [] })                              // user_identities — пусто
        .mockResolvedValueOnce({ rows: [{ linkeon_user_id: 'u-bot' }] })  // tg_user_identities — есть
        .mockResolvedValueOnce({ rows: [] });                             // бэкфилл INSERT
      identity.touchIdentity.mockRejectedValueOnce(new Error('boom'));
      const errorSpy = jest.spyOn((ctrl as any).logger, 'error').mockImplementation(() => undefined);
      const res = mockRes();

      await expect(ctrl.auth({ initData: freshInitData() }, res)).rejects.toThrow('boom');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain('touch:tg_user_identities');
    });
  });

  describe('onModuleInit — сигнал об отсутствующем TG_BOT_TOKEN', () => {
    it('логирует ошибку один раз при старте без TG_BOT_TOKEN, и не логирует, когда переменная задана', () => {
      // beforeEach уже выставил TG_BOT_TOKEN; сохраняем его, чтобы гарантированно
      // вернуть на место — не полагаясь на то, что следующий beforeEach это сделает.
      const original = process.env.TG_BOT_TOKEN;
      try {
        delete process.env.TG_BOT_TOKEN;
        const localCtrl = new TmaController(pg, identity, jwt);
        const errorSpy = jest
          .spyOn((localCtrl as any).logger, 'error')
          .mockImplementation(() => undefined);

        localCtrl.onModuleInit();
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][0]).toContain('TG_BOT_TOKEN');

        errorSpy.mockClear();
        process.env.TG_BOT_TOKEN = BOT_TOKEN;
        localCtrl.onModuleInit();
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        if (original === undefined) delete process.env.TG_BOT_TOKEN;
        else process.env.TG_BOT_TOKEN = original;
      }
    });
  });
});
