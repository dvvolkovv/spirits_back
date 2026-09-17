import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import { SLEEPING_REFUSAL, TurnsService } from './turns.service';

function makeService(
  opts: {
    duplicate?: boolean;
    failWithCode?: string;
    productStatus?: string;
    balanceOk?: boolean;
  } = {},
) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT status FROM products')) {
        return { rows: [{ status: opts.productStatus ?? 'running' }] };
      }
      if (sql.includes('INSERT INTO product_turns') && opts.duplicate) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: 'product_turns_one_active',
        });
      }
      if (sql.includes('INSERT INTO product_turns') && opts.failWithCode) {
        throw Object.assign(new Error('boom'), { code: opts.failWithCode });
      }
      if (sql.includes('INSERT INTO product_turns')) {
        return { rows: [{ id: 't-1', status: 'queued' }] };
      }
      // Источник отката: revert() читает его, а потом идёт в тот же enqueue.
      if (sql.includes('SELECT id, sha_before FROM product_turns')) {
        return { rows: [{ id: 't-0', sha_before: 'deadbeef' }] };
      }
      return { rows: [] };
    }),
  };
  const misc = {
    deductTokens: jest.fn(),
    checkTokenBalance: jest.fn(async () => ({ ok: opts.balanceOk ?? true })),
  };
  return { svc: new TurnsService(pg as any, misc as any), calls, misc };
}

describe('TurnsService.enqueue', () => {
  it('создаёт ход в статусе queued', async () => {
    const { svc, calls } = makeService();

    await expect(
      svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'поправь футер' }),
    ).resolves.toMatchObject({ id: 't-1', status: 'queued' });

    // INSERT ищется по содержимому, а не по индексу: первым запросом идёт
    // проверка статуса продукта, и привязка к calls[0] сломается от любой
    // будущей вставки предусловия.
    const insert = calls.find((c) => c.sql.includes('INSERT INTO product_turns'))!;

    // Три утверждения о тексте нужны потому, что мок отдаёт захардкоженную
    // строку и ни на одну из этих подмен сам по себе не отреагирует. Каждая
    // подмена ломает тихо, без исключения и без строки в логе:
    //
    //   'queued' → 'running'     — claimNext ищет строго 'queued' и такой ход
    //                              не подберёт никогда, а замок будет считать
    //                              продукт занятым до сборщика через полчаса;
    //   перестановка колонок     — userId уезжает в product_id, ход повисает
    //   или плейсхолдеров          на несуществующем продукте, замок занимает
    //                              не тот продукт;
    //   усечение RETURNING       — наружу уходит объект без status, а его
    //                              отдают клиенту revert (Task 5) и chat
    //                              (Task 8).
    //
    // Колонки и плейсхолдеры охраняются раздельно: переставить можно любое из
    // двух, последствие одинаковое, а params при этом не меняется.
    expect(insert.sql).toContain('(product_id, user_id, channel, prompt, revert_to_sha, status)');
    expect(insert.sql).toContain('VALUES ($1, $2, $3, $4, $5');
    expect(insert.sql).toContain("'queued'");
    expect(insert.sql).toContain('RETURNING id, status');
    expect(insert.params).toEqual(['p-1', 'u-1', 'web', 'поправь футер', null]);

    // Владение проверяется в сервисе, а не только в контроллере: у ходов два
    // входа, и телеграм-вход унаследовал бы шлагбаум по балансу даром, а
    // проверку владения молча не получил.
    const guard = calls.find((c) => c.sql.includes('SELECT status FROM products'))!;
    expect(guard.sql).toContain('user_id = $2');
    expect(guard.sql).toContain('archived_at IS NULL');
    expect(guard.params).toEqual(['p-1', 'u-1']);
  });

  it('обычный ход не может притвориться откатом', async () => {
    // Признак отката несёт отдельная колонка, а не префикс в prompt. Иначе
    // POST /products/:id/chat с телом {"prompt": "__revert__:<sha>"} доехал бы
    // до раннера как команда отката мимо всех проверок revert(), а sha
    // пользователь знает — история сама отдаёт ему sha_before и sha_after.
    const { svc, calls } = makeService();

    await svc.enqueue({
      productId: 'p-1',
      userId: 'u-1',
      channel: 'web',
      prompt: '__revert__:deadbeef',
    });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO product_turns'))!;
    expect(insert.params[4]).toBeNull();
  });

  it('второй ход по тому же продукту отбивается 409, а не 500', async () => {
    const { svc } = makeService({ duplicate: true });

    await expect(
      svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'ещё раз' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('ошибка, не связанная с замком, пробрасывается как есть', async () => {
    // Без этого теста безусловный ConflictException в catch проходит незамеченным,
    // и тогда падение базы, таймаут пула или нарушение CHECK приезжают клиенту
    // как «агент уже работает» — на продукте, где никто не работает. В логе при
    // этом пусто: ConflictException штатный 4xx, а не 5xx, и диагностика уходит
    // искать зависший ход, которого нет.
    const { svc } = makeService({ failWithCode: '23514' });

    await expect(
      svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'go' }),
    ).rejects.not.toBeInstanceOf(ConflictException);
  });

  it('ход на неработающем продукте не создаётся', async () => {
    const { svc, calls } = makeService({ productStatus: 'stopped' });

    await expect(
      svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'go' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(calls.some((c) => c.sql.includes('INSERT INTO product_turns'))).toBe(false);
  });

  it('при нулевом балансе ход не создаётся', async () => {
    const { svc, calls } = makeService({ balanceOk: false });

    await expect(
      svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'go' }),
    ).rejects.toThrow();

    // Ход = реальный запуск claude -p на VM, то есть живые деньги. Вставка не
    // должна происходить вовсе, а не «происходить и не тарифицироваться».
    expect(calls.some((c) => c.sql.includes('INSERT INTO product_turns'))).toBe(false);
  });
});

/**
 * СПЯЩИЙ ПРОДУКТ. Общее условие `status !== 'running'` его и так не пропускает,
 * поэтому первые два теста ниже — не про «отказ есть», а про то, ЧЕМ он
 * отличается от отказа всем прочим неработающим. Разница не косметическая: сон
 * снимается только пополнением баланса, и отказ, не назвавший этого, оставляет
 * владельца пробовать снова до бесконечности.
 *
 * Чего эти тесты НЕ доказывают: что текст доезжает до экрана. На 17.09.2026 не
 * доезжает — `apiClient.fetchStream` отдаёт null на любом не-2xx, теряя и код,
 * и тело, а ProductChat подставляет вместо них свой `products.chat.busy`
 * («Агент уже работает над предыдущим запросом»). Это относится и к
 * существующему 402 «Недостаточно токенов». Чинится на фронте (задача 11).
 */
describe('TurnsService.enqueue — спящий продукт', () => {
  const refusal = async (productStatus: string) => {
    const { svc, calls, misc } = makeService({ productStatus });
    const err = await svc
      .enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'правь' })
      .then(
        () => null,
        (e: any) => e,
      );
    expect(err).not.toBeNull();
    return { err: err as HttpException, calls, misc };
  };

  it('спящему продукту правка не ставится', async () => {
    // Молчаливая беда, ради которой проверка стоит ЯВНО. Ход, уехавший в
    // очередь по погашенному контейнеру, не заберёт никто: claimNext требует
    // p.status = 'running', а reapStuck хоронит только 'running'. Правка
    // остаётся в 'queued' навсегда, держит замок product_turns_one_active — и
    // владелец не получает ни ошибки, ни результата, ни следующей попытки.
    const { err, calls } = await refusal('sleeping');

    expect(err).toBeInstanceOf(HttpException);
    expect(calls.some((c) => c.sql.includes('INSERT INTO product_turns'))).toBe(false);
  });

  it('текст отказа зовёт пополнить баланс, а не «попробуйте позже»', async () => {
    const { err } = await refusal('sleeping');

    expect(err.message).toMatch(/пополн/i);
    // «Позже» здесь — прямая неправда: само оно не пройдёт никогда.
    expect(err.message).not.toMatch(/позже|подожд/i);
    // И про сам сон сказано, иначе владелец не поймёт, почему сайт не отвечает.
    expect(err.message).toMatch(/спит/i);
  });

  it('отказ спящему — 402, тот же код, что у нулевого баланса', async () => {
    // Кабинету нужен ОДИН признак «зови пополнение». 409 у него занят замком
    // одного хода («агент занят») — самым частым источником 409 на этом
    // маршруте, — и спящий продукт в этой ветке получил бы чужой текст.
    const { err } = await refusal('sleeping');

    expect(err.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(err).not.toBeInstanceOf(ConflictException);
  });

  it('отказ спящему отличается от отказа заведомо нерабочему', async () => {
    // `stopped` снял владелец, и снимается он кнопкой рядом; сон снимается
    // только деньгами. Один текст на оба состояния врал бы в обе стороны.
    const sleeping = await refusal('sleeping');
    const stopped = await refusal('stopped');

    expect(stopped.err).toBeInstanceOf(ConflictException);
    expect(stopped.err.getStatus()).not.toBe(sleeping.err.getStatus());
    expect(stopped.err.message).not.toBe(sleeping.err.message);
    expect(stopped.err.message).not.toMatch(/пополн/i);
  });

  it('спящий отбивается ДО проверки баланса', async () => {
    // У спящего владельца баланса нет почти наверняка — он потому и спит.
    // Обратный порядок выдал бы ему общее «Недостаточно токенов» вместо
    // объяснения, что именно спит и что произойдёт после пополнения.
    const { err, misc } = await refusal('sleeping');

    expect(misc.checkTokenBalance).not.toHaveBeenCalled();
    expect(err.message).toBe(SLEEPING_REFUSAL);
  });

  it('откат на спящем продукте тоже не ставится', async () => {
    // Второй вход в enqueue. Откат — это тот же запуск агента в контейнере,
    // которого нет; отдельной проверки у него не будет и не должно быть, но
    // без этого теста она может уехать в контроллер и потерять revert молча.
    const { svc, calls } = makeService({ productStatus: 'sleeping' });

    await expect(
      svc.revert({ productId: 'p-1', turnId: 't-0', userId: 'u-1' }),
    ).rejects.toMatchObject({ message: SLEEPING_REFUSAL });

    expect(calls.some((c) => c.sql.includes('INSERT INTO product_turns'))).toBe(false);
  });
});
