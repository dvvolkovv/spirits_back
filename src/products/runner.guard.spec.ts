import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { RunnerGuard } from './runner.guard';

const TOKEN = 'runner-secret-token';
const HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');

function makeContext(header?: string) {
  const req: any = { headers: header ? { authorization: header } : {} };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    __req: req,
  } as any;
}

function makeGuard(rows: any[]) {
  // Параметры объявлены явно, хотя тело их не использует: без этого
  // TypeScript выводит для mock.calls пустой кортеж, и обращения к
  // calls[0][0] / calls[0][1] в утверждениях ниже становятся ошибкой типа.
  // Jest их не ловит, а `tsc --noEmit -p tsconfig.json` — предписанная
  // планом проверка перед выкатом — краснеет.
  const pg = { query: jest.fn(async (_sql: string, _params?: any[]) => ({ rows })) };
  return { guard: new RunnerGuard(pg as any), pg };
}

describe('RunnerGuard', () => {
  it('пропускает раннера с валидным токеном и кладёт продукт в запрос', async () => {
    const { guard } = makeGuard([{ id: 'p-1', checkout_path: '/home/dv/selyanska' }]);
    const ctx = makeContext(`Bearer ${TOKEN}`);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(ctx.__req.product).toMatchObject({ id: 'p-1' });
  });

  it('ищет по хешу, а не по самому токену', async () => {
    const { guard, pg } = makeGuard([{ id: 'p-1' }]);

    await guard.canActivate(makeContext(`Bearer ${TOKEN}`));

    // Оба утверждения нужны. Мок отдаёт rows независимо от sql, поэтому одна
    // проверка параметров зафиксировала бы лишь форму вызова: запрос без
    // `WHERE runner_token_hash = $1` прошёл бы тест насквозь.
    expect(pg.query.mock.calls[0][0]).toContain('runner_token_hash = $1');
    // Раннер архивного продукта должен терять доступ вместе с архивацией,
    // иначе он продолжит забирать задания и править чекаут выведенного из
    // эксплуатации продукта.
    expect(pg.query.mock.calls[0][0]).toContain('archived_at IS NULL');
    expect(pg.query.mock.calls[0][1]).toEqual([HASH]);
  });

  it('без заголовка — 401', async () => {
    // Мок отдаёт НЕпустые rows намеренно. С пустыми тест носил бы имя одной
    // защиты, а держался на другой: пустой токен дошёл бы до запроса, ничего
    // не нашёл, и сработал бы второй страж `if (!r.rows[0])`. Исключение
    // вылетело бы всё равно — и снятие ранней проверки `!token` осталось бы
    // незамеченным. С непустыми rows такая мутация даёт resolves(true), то
    // есть тест ловит ровно ту защиту, которую называет.
    const { guard } = makeGuard([{ id: 'p-1' }]);

    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('заголовок без префикса Bearer не принимается', async () => {
    // Утверждение явное, потому что иначе эта мутация ловится случайно: без
    // разбора префикса в хеш уходит вся строка целиком, значение расходится с
    // константой HASH, и тест краснеет по совпадению, а не по замыслу.
    //
    // Разбор регистрозависимый. RFC 7235 объявляет схему авторизации
    // регистронезависимой, то есть мы строже стандарта — это осознанно:
    // раннера пишем мы сами, и заголовок формирует наш же код.
    const { guard } = makeGuard([{ id: 'p-1' }]);

    await expect(guard.canActivate(makeContext(TOKEN))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('неизвестный токен — 401', async () => {
    const { guard } = makeGuard([]);

    await expect(guard.canActivate(makeContext('Bearer wrong'))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
