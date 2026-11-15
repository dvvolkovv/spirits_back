import {
  DeletionCancelledError,
  DeletionRetryError,
} from '../account-deletion/account-deletion.safe';
import { AuthController } from './auth.controller';

/**
 * T19-M1 (ревью Task 19) — POST /webhook/auth/identities/merge против ошибок
 * deletion-pipeline.
 *
 * До фикса redis.del(merge-token) выполнялся ДО mergeAccounts и без try/catch:
 * DeletionRetryError (нештатный стоп/ядро у loser) всплывал наружу, глобальный
 * фильтр отдавал 500, а токен уже был потреблён — повторный merge становился
 * невозможен без нового конфликт-флоу (повторной привязки провайдера).
 *
 * Контракт после фикса:
 *  - DeletionRetryError → 503 {retryable:true}, mergeToken НЕ потреблён —
 *    повторный запрос с тем же токеном возможен и доводит merge до конца;
 *  - DeletionCancelledError → 409, токен потреблён (терминальный исход:
 *    loser реактивирован, путь — новый конфликт-флоу);
 *  - успех → 200, токен потреблён ровно один раз.
 *
 * Форма «не потреблять токен при retryable» выбрана вместо переиздания:
 * mergeToken живёт в redis с TTL 30 минут и привязан к паре
 * (targetUserId, conflictUserId) — пока merge не завершён, пара не устарела,
 * а mergeAccounts идемпотентен (поколение переиспользуется, баланс не
 * задваивается, выполненные стопы не переисполняются).
 */

const TARGET = 'u-target';
const CONFLICT = 'u-conflict';
const TOKEN = 'merge-token-unit';

function mockRes() {
  const res: any = {};
  res.set = jest.fn(() => res);
  res.status = jest.fn((code: number) => { res._status = code; return res; });
  res.json = jest.fn((body: any) => { res._body = body; return res; });
  return res;
}

/** Redis-фейк с состоянием: видно, потреблён токен или нет. */
function fakeRedis() {
  const store = new Map<string, string>();
  store.set(
    `merge-token-${TOKEN}`,
    JSON.stringify({ targetUserId: TARGET, conflictUserId: CONFLICT }),
  );
  return {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
    del: jest.fn(async (key: string) => { store.delete(key); }),
  };
}

function makeCtrl(mergeImpl: () => Promise<{ survivorUserId: string; loserUserId: string }>) {
  const identity = { mergeAccounts: jest.fn(mergeImpl) };
  const redis = fakeRedis();
  const jwt = {
    signAccess: jest.fn((id: string) => `access-${id}`),
    signRefresh: jest.fn((id: string) => `refresh-${id}`),
  };
  // Порядок аргументов конструктора: authService, email, identity, jwt, redis,
  // googleOAuth, yandexOAuth, appleOAuth, devices, pg (прецедент —
  // link-telegram.spec.ts). Незадействованные зависимости — пустышки.
  const ctrl = new AuthController(
    {} as any, {} as any, identity as any, jwt as any, redis as any,
    {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return { ctrl, identity, redis, jwt };
}

const success = async (survivorUserId: string = TARGET) => ({
  survivorUserId,
  loserUserId: survivorUserId === TARGET ? CONFLICT : TARGET,
});

describe('POST /webhook/auth/identities/merge — ошибки deletion-pipeline (T19-M1)', () => {
  const req = { user: { userId: TARGET } };

  it('DeletionRetryError → 503 {retryable:true}, токен НЕ потреблён', async () => {
    const { ctrl, redis, identity } = makeCtrl(async () => {
      throw new DeletionRetryError('db');
    });
    const res = mockRes();

    await ctrl.mergeAccounts({ mergeToken: TOKEN }, req, res);

    expect(res._status).toBe(503);
    expect(res._body).toMatchObject({ retryable: true });
    expect(identity.mergeAccounts).toHaveBeenCalledWith(CONFLICT, TARGET);
    // Главное: токен жив — повторный merge с тем же токеном возможен.
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.store.has(`merge-token-${TOKEN}`)).toBe(true);
  });

  it('повтор тем же токеном после retryable доводит merge до конца', async () => {
    let attempt = 0;
    const { ctrl, redis } = makeCtrl(async () => {
      attempt += 1;
      if (attempt === 1) throw new DeletionRetryError('timeout');
      return success();
    });

    const first = mockRes();
    await ctrl.mergeAccounts({ mergeToken: TOKEN }, req, first);
    expect(first._status).toBe(503);

    const second = mockRes();
    await ctrl.mergeAccounts({ mergeToken: TOKEN }, req, second);

    expect(second._status).toBe(200);
    expect(second._body).toEqual({ merged: true });
    // Успех потребляет токен ровно один раз.
    expect(redis.store.has(`merge-token-${TOKEN}`)).toBe(false);
  });

  it('DeletionCancelledError → 409, токен потреблён (терминальный исход)', async () => {
    const { ctrl, redis, jwt } = makeCtrl(async () => {
      throw new DeletionCancelledError();
    });
    const res = mockRes();

    await ctrl.mergeAccounts({ mergeToken: TOKEN }, req, res);

    expect(res._status).toBe(409);
    expect(res._body).toMatchObject({ error: expect.any(String) });
    expect(redis.store.has(`merge-token-${TOKEN}`)).toBe(false);
    // Токенов на удалённый/реактивированный аккаунт не выдаётся.
    expect(jwt.signAccess).not.toHaveBeenCalled();

    // Повтор тем же токеном — уже обычный expired/invalid.
    const again = mockRes();
    await ctrl.mergeAccounts({ mergeToken: TOKEN }, req, again);
    expect(again._status).toBe(400);
  });

  it('успешный merge потребляет токен и отдаёт merged:true', async () => {
    const { ctrl, redis } = makeCtrl(() => success());
    const res = mockRes();

    await ctrl.mergeAccounts({ mergeToken: TOKEN }, req, res);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ merged: true });
    expect(redis.store.has(`merge-token-${TOKEN}`)).toBe(false);
  });

  it('выжил не target — 200 со свежей парой JWT на survivor', async () => {
    const { ctrl, jwt } = makeCtrl(() => success(CONFLICT));
    const res = mockRes();

    await ctrl.mergeAccounts({ mergeToken: TOKEN }, req, res);

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({
      merged: true,
      'access-token': `access-${CONFLICT}`,
      'refresh-token': `refresh-${CONFLICT}`,
    });
    expect(jwt.signAccess).toHaveBeenCalledWith(CONFLICT);
  });

  /**
   * T20-M4 (ревью Task 20, characterization): произвольная НЕ-deletion ошибка
   * mergeAccounts всплывает как есть (глобальный фильтр Nest → 500), а
   * mergeToken НЕ потреблён. Инфраструктурный сбой (например, обрыв
   * соединения с БД) не должен маскироваться под deletion-исход и лишать
   * повторной попытки с тем же токеном: redis.del стоит после catch-блока и
   * выполняется только на успехе/терминальной отмене.
   */
  it('T20-M4: не-deletion ошибка всплывает (→500), токен НЕ потреблён', async () => {
    const { ctrl, redis, identity } = makeCtrl(async () => {
      throw new Error('connection terminated unexpectedly');
    });
    const res = mockRes();

    await expect(ctrl.mergeAccounts({ mergeToken: TOKEN }, req, res))
      .rejects.toThrow('connection terminated unexpectedly');

    expect(identity.mergeAccounts).toHaveBeenCalledWith(CONFLICT, TARGET);
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.store.has(`merge-token-${TOKEN}`)).toBe(true);
    // Ответ не отправлен: 500 сформирует глобальный exception-filter.
    expect(res.status).not.toHaveBeenCalled();
  });
});
