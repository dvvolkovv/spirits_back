import { AuthController } from './auth.controller';

/**
 * Форму ответа этого маршрута читают уже выложенные веб-клиент и мобильные
 * приложения. Лишнее поле в теле — сломанный разбор у всех, кто не обновился.
 *
 * Сторож появился вместе с записью устройств: чтобы достать userId для неё,
 * refreshTokens стал возвращать его вместе с токенами, и единственное, что
 * удерживает его от утечки наружу, — деструктуризация в контроллере. Без
 * этого теста её можно убрать одной правкой и ничего не заметить.
 */

function fakeRes() {
  const out: any = {};
  return {
    out,
    set() { return this; },
    status(code: number) { out.code = code; return this; },
    json(body: any) { out.body = body; return this; },
  };
}

const req = (headers: Record<string, string>) => ({ headers }) as any;

// AuthController принимает 9 параметров (authService, email, identity, jwt,
// redis, googleOAuth, yandexOAuth, appleOAuth, devices) — refresh() трогает
// только authService и devices, остальные подставные объекты не используются
// этим маршрутом и передаются пустыми заглушками, чтобы сохранить порядок
// аргументов конструктора.
const unused = {} as any;

function makeController(authService: any, devices: any) {
  return new AuthController(
    authService,
    unused, // email
    unused, // identity
    unused, // jwt
    unused, // redis
    unused, // googleOAuth
    unused, // yandexOAuth
    unused, // appleOAuth
    devices,
  );
}

describe('форма ответа auth/refresh', () => {
  const authService = {
    async refreshTokens() {
      return { 'access-token': 'A', 'refresh-token': 'R', userId: 'u1' };
    },
  };

  it('в теле ровно два поля — токены, и никакого userId', async () => {
    const res = fakeRes();
    const devices = { record: async () => {} };
    await makeController(authService, devices).refresh(
      req({ authorization: 'Bearer x', 'user-agent': 'Dart/3.10' }),
      res as any,
    );

    expect(res.out.code).toBe(200);
    expect(Object.keys(res.out.body).sort()).toEqual(['access-token', 'refresh-token']);
    expect(res.out.body).not.toHaveProperty('userId');
  });

  it('устройство записывается с userId и заголовком запроса', async () => {
    const seen: any[] = [];
    const devices = { record: async (u: string, ua: string) => { seen.push([u, ua]); } };
    const res = fakeRes();
    await makeController(authService, devices).refresh(
      req({ authorization: 'Bearer x', 'user-agent': 'Dart/3.10' }),
      res as any,
    );

    expect(seen).toEqual([['u1', 'Dart/3.10']]);
  });

  // Запись не ждут намеренно. Если она когда-нибудь станет медленной или
  // начнёт бросать, авторизация не должна это почувствовать.
  it('ответ не ждёт записи устройства', async () => {
    let released: (() => void) | null = null;
    const devices = { record: () => new Promise<void>((r) => { released = r; }) };
    const res = fakeRes();

    await makeController(authService, devices).refresh(
      req({ authorization: 'Bearer x' }),
      res as any,
    );

    // Ответ уже отдан, хотя запись всё ещё висит.
    expect(res.out.code).toBe(200);
    expect(released).not.toBeNull();
    released!();
  });
});
