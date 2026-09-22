import { NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';

const ROW = {
  id: 'p-1',
  user_id: '79030169187',
  name: 'selyanska',
  slug: 'selyanska',
  status: 'running',
  checkout_path: '/home/dv/selyanska',
};

function makeService(rows: any[]) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows };
    }),
  };
  return { svc: new ProductsService(pg as any), calls };
}

describe('ProductsService.list', () => {
  it('фильтрует по владельцу и не отдаёт архивные', async () => {
    const { svc, calls } = makeService([ROW]);

    await svc.list('79030169187');

    expect(calls[0].params).toEqual(['79030169187']);
    // Оба условия WHERE проверяются отдельно. Утверждение только про архивные
    // оставляет фильтр владельца без сторожа, а этот метод отдаёт коллекцию:
    // снятый предикат вернёт клиенту чужие продукты списком, вместе с их
    // checkout_path, domain и host_ip.
    expect(calls[0].sql).toContain('user_id = $1');
    expect(calls[0].sql).toContain('archived_at IS NULL');
  });
});

describe('колонки клиентской выдачи', () => {
  it('не отдают ни хеш токена раннера, ни секреты продукта', async () => {
    const { svc, calls } = makeService([ROW]);

    await svc.list('79030169187');
    await svc.getOwned('p-1', '79030169187');

    expect(calls).toHaveLength(2);
    for (const { sql } of calls) {
      // Перечисление колонок, а не звёздочка. Проверка одних только
      // not.toContain зеленела бы на SELECT *: имён секретных колонок в тексте
      // запроса нет, а в ответ они уезжают.
      expect(sql).toMatch(/SELECT\s+id,\s*user_id/);
      expect(sql).not.toContain('*');
      expect(sql).not.toContain('runner_token_hash');
      expect(sql).not.toContain('secrets_encrypted');
    }
  });

  it('не отдают внутреннюю топологию машины продуктов', async () => {
    // Не секреты — и потому уехали бы обратно в перечисление под предлогом
    // «пусть будет, вдруг пригодится». Это адрес хоста, путь чекаута, команды
    // сборки и перезапуска, адрес health и id сессии Claude: ими живут агент
    // хоста и раннер внутри контейнера, каждый своим запросом (runner.guard.ts
    // перечисляет их для себя отдельно). В браузере им делать нечего — через
    // кабинет они утекают в консоль, в расширения и в снимок вкладки.
    const { svc, calls } = makeService([ROW]);

    await svc.list('79030169187');
    await svc.getOwned('p-1', '79030169187');

    expect(calls).toHaveLength(2);
    for (const { sql } of calls) {
      for (const column of [
        'host_ip',
        'checkout_path',
        'build_cmd',
        'restart_cmd',
        'health_url',
        'repo_url',
        'claude_session_id',
        // port не отдавался и раньше: это порт на петле хоста.
        'port',
      ]) {
        expect(sql).not.toContain(column);
      }
    }
  });

  it('отдают ровно то, что читает кабинет', async () => {
    // Список собран ПО ФРОНТУ: `interface Product` в
    // spirits_front/src/services/productsApi.ts. Пропавшая отсюда колонка не
    // ломает ни одного серверного теста — она молча превращается в пустое
    // место на карточке (так уже было с provision_error и kind, см.
    // комментарий над COLUMNS).
    const { svc, calls } = makeService([ROW]);

    await svc.list('79030169187');

    for (const column of [
      'id',
      'name',
      'slug',
      'status',
      'kind',
      'domain',
      'runner_seen_at',
      'provision_error',
      // Аренда (миграция 004). Пропуск ровно так же не ломает ни одного
      // серверного теста: карточка просто не покажет, до какого числа
      // оплачено и почему продукт спит, — владелец увидит «остановлен» без
      // объяснения и решит, что это поломка.
      'paid_until',
      'sleep_reason',
      // Гашение администратором (миграция 007). Колонка едет ВПЕРЕДИ кабинета
      // намеренно: `interface Product` во фронте её ещё не знает, и это не
      // рассогласование, а порядок — лишнее поле в ответе карточка молча
      // игнорирует, а недостающее рисует пустым местом. Обратный порядок
      // означал бы фронт, показывающий «Остановлен администратором» без
      // причины, потому что сервер её не отдаёт.
      'block_reason',
      'created_at',
    ]) {
      expect(calls[0].sql).toContain(column);
    }
  });
});

describe('ProductsService.getOwned', () => {
  it('отдаёт продукт своему владельцу', async () => {
    const { svc } = makeService([ROW]);

    await expect(svc.getOwned('p-1', '79030169187')).resolves.toMatchObject({ id: 'p-1' });
  });

  it('чужой продукт не отличим от несуществующего', async () => {
    const { svc, calls } = makeService([]);

    await expect(svc.getOwned('p-1', '70000000000')).rejects.toBeInstanceOf(NotFoundException);
    // Владелец в WHERE, а не в проверке после выборки: иначе existence чужого
    // продукта утекает через разницу между 403 и 404.
    //
    // Утверждение о тексте SQL здесь обязательно. Мок игнорирует sql и всегда
    // отдаёт заданный rows, поэтому проверка одних только params фиксирует
    // форму вызова, а не участие параметра в фильтрации: убери `AND user_id =
    // $2` из запроса, оставив параметр на месте, — и тест останется зелёным.
    expect(calls[0].sql).toContain('user_id = $2');
    // На getOwned завязаны все три клиентских маршрута из Task 8 — chat,
    // history и revert. Без этого условия заархивированный продукт останется
    // полностью управляемым по прямому id: клиент продолжит гонять агента в
    // чекауте продукта, выведенного из эксплуатации.
    expect(calls[0].sql).toContain('archived_at IS NULL');
    expect(calls[0].params).toEqual(['p-1', '70000000000']);
  });
});
