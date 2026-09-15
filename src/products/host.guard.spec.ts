import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { HostGuard } from './host.guard';

const TOKEN = 'секрет-хоста';

/**
 * `auth === undefined` даёт запрос вовсе без заголовка, а не с пустым: это
 * разные ветки разбора. Массив допущен намеренно — см. тест про нестроковый
 * заголовок.
 */
const ctx = (auth?: string | string[]) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: auth === undefined ? {} : { authorization: auth } }),
    }),
  }) as any;

const guardWith = (expected?: string | null) => new HostGuard({ get: () => expected } as any);

describe('HostGuard', () => {
  afterEach(() => jest.restoreAllMocks());

  it('пропускает с верным токеном', async () => {
    const g = new HostGuard({ get: () => 'секрет-хоста' } as any);

    await expect(g.canActivate(ctx('Bearer секрет-хоста'))).resolves.toBe(true);
  });

  it('отвергает чужой токен', async () => {
    const g = new HostGuard({ get: () => 'секрет-хоста' } as any);

    await expect(g.canActivate(ctx('Bearer чужой'))).rejects.toThrow(UnauthorizedException);
  });

  it('отвергает запрос без токена', async () => {
    const g = new HostGuard({ get: () => 'секрет-хоста' } as any);

    await expect(g.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
  });

  it('не пускает никого, когда токен не настроен', async () => {
    // Пустой ожидаемый токен и пустой присланный совпали бы, и эндпоинты
    // провижининга открылись бы всему интернету.
    const g = new HostGuard({ get: () => undefined } as any);

    await expect(g.canActivate(ctx('Bearer '))).rejects.toThrow(UnauthorizedException);
  });

  it('ненастроенный токен даёт 401 и на непустом токене тоже', async () => {
    // Тест выше эту защиту не проверяет, хотя носит её имя: он шлёт `Bearer ` с
    // пустым токеном, и отказ приходит от проверки `!token`, а не от проверки
    // `!expected`. Снятие `if (!expected)` он не замечает — измерено, мутация
    // выжила на всём наборе.
    //
    // Нужен непустой токен: только тогда разбор доходит до Buffer.from(undefined)
    // и падает TypeError'ом, то есть агент получает 500 вместо внятного 401.
    const err = await guardWith(undefined)
      .canActivate(ctx(`Bearer ${TOKEN}`))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it('не пускает никого при любом пустом значении конфига', async () => {
    // `PRODUCT_HOST_TOKEN=` в .env даёт не undefined, а '' — самый вероятный вид
    // «забыли заполнить»; фабрика конфига может отдать и null. Сужение проверки
    // до `expected === undefined` пропустило бы оба значения дальше, и на null
    // разбор дошёл бы до Buffer.from(null) — 500 вместо 401.
    for (const empty of ['', null]) {
      const g = guardWith(empty);

      await expect(g.canActivate(ctx('Bearer '))).rejects.toThrow(UnauthorizedException);
      await expect(g.canActivate(ctx(`Bearer ${TOKEN}`))).rejects.toThrow(UnauthorizedException);
    }
  });

  it('отвергает чужой токен той же длины', async () => {
    // Без этого теста отказ держался бы на одной лишь проверке длины: мутация
    // «сравнивать только длины» осталась бы зелёной, потому что все остальные
    // отрицательные случаи в наборе отличаются и длиной тоже.
    const sameLength = 'хоста-секрет';
    expect(Buffer.byteLength(sameLength)).toBe(Buffer.byteLength(TOKEN));

    await expect(guardWith(TOKEN).canActivate(ctx(`Bearer ${sameLength}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('токен-префикс настоящего не принимается', async () => {
    // Классический промах — сравнение через startsWith/indexOf вместо
    // равенства: угадавший первые символы получал бы доступ, а подбор из
    // экспоненциального становился бы линейным. Мутация «сравнивать по
    // префиксу» без этого теста ловилась только проводкой timingSafeEqual.
    const prefix = TOKEN.slice(0, 6);
    expect(TOKEN.startsWith(prefix)).toBe(true);

    await expect(guardWith(TOKEN).canActivate(ctx(`Bearer ${prefix}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('токен, отличающийся только регистром, не принимается', async () => {
    // Кириллица меняет регистр без изменения длины в байтах, так что проверка
    // длины здесь не срабатывает и отказ обязан прийти именно от сравнения
    // содержимого. Ловит мутацию с toLowerCase() «чтобы не мучиться с
    // копипастой».
    const upper = TOKEN.toUpperCase();
    expect(upper).not.toBe(TOKEN);
    expect(Buffer.byteLength(upper)).toBe(Buffer.byteLength(TOKEN));

    await expect(guardWith(TOKEN).canActivate(ctx(`Bearer ${upper}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('заголовок без префикса Bearer не принимается', async () => {
    // Тест на отсутствие токена эту мутацию НЕ ловит: при фоллбэке на всю
    // строку запрос без заголовка всё равно даёт пустой токен и падает на
    // проверке `!token`. Нужен именно голый токен без префикса.
    await expect(guardWith(TOKEN).canActivate(ctx(TOKEN))).rejects.toThrow(UnauthorizedException);
  });

  it('префикс Bearer разбирается регистрозависимо', async () => {
    // RFC 7235 объявляет схему авторизации регистронезависимой, то есть мы
    // строже стандарта. Это осознанно и совпадает с RunnerGuard: агент хоста
    // пишем мы сами, заголовок формирует наш же код.
    await expect(guardWith(TOKEN).canActivate(ctx(`bearer ${TOKEN}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('лишний пробел вокруг токена не прощается', async () => {
    // Токен не тримится. Тест фиксирует это как решение, а не как случайность:
    // молчаливый trim() прятал бы кривой конфиг агента, а с ним и вопрос
    // «почему на одном хосте работает, а на другом нет».
    await expect(guardWith(TOKEN).canActivate(ctx(`Bearer ${TOKEN} `))).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(guardWith(TOKEN).canActivate(ctx(`Bearer  ${TOKEN}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('токен неверной длины даёт 401, а не 500', async () => {
    // timingSafeEqual на буферах разной длины бросает RangeError. Без проверки
    // длины перед ним агент с укороченным токеном получал бы 500 и писал в лог
    // «внутренняя ошибка сервера» вместо внятного отказа, а Nest отдал бы
    // стектрейс не туда. Утверждение именно про класс исключения.
    const short = 'коротыш';
    expect(Buffer.byteLength(short)).not.toBe(Buffer.byteLength(TOKEN));

    const err = await guardWith(TOKEN)
      .canActivate(ctx(`Bearer ${short}`))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err).not.toBeInstanceOf(RangeError);
  });

  it('нестроковый заголовок даёт 401, а не падение гварда', async () => {
    // Node для authorization дубликаты отбрасывает, так что массив сюда в
    // проде не придёт. Тест не про прод, а про то, что разбор не зовёт
    // .startsWith у чего попало: без приведения к строке это TypeError и 500.
    const err = await guardWith(TOKEN)
      .canActivate(ctx([`Bearer ${TOKEN}`, 'Bearer чужой']))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it('читает именно PRODUCT_HOST_TOKEN', async () => {
    // Мок отдаёт значение на любой ключ, поэтому без этого утверждения гвард,
    // читающий PRODUCT_SECRETS_KEY или JWT_SECRET, прошёл бы весь набор
    // зелёным — и пускал бы на провижининг по ключу шифрования секретов.
    const get = jest.fn((_key: string) => TOKEN);
    const g = new HostGuard({ get } as any);

    await g.canActivate(ctx(`Bearer ${TOKEN}`));

    expect(get).toHaveBeenCalledWith('PRODUCT_HOST_TOKEN');
  });

  it('решение принимает постоянно-временное сравнение', async () => {
    // Поведенческого теста на «=== против timingSafeEqual» не существует:
    // на всех достижимых входах результат одинаков, отличается только время, а
    // измерять его в jest — гарантированные ложные срабатывания. Поэтому
    // проверяем проводку: подменяем сравнение на «не равно» при верном токене.
    // Реализация на === спросит не его и вернёт true — тест покраснеет.
    const spy = jest.spyOn(crypto, 'timingSafeEqual').mockReturnValue(false);

    await expect(guardWith(TOKEN).canActivate(ctx(`Bearer ${TOKEN}`))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(spy).toHaveBeenCalled();
  });

  it('сообщение об отказе не выдаёт ни сам токен, ни его длину', async () => {
    // Диагностика вида «ожидалось 64 символа, пришло 8» превращает отказ в
    // оракул длины: снаружи угадывать нечего, а изнутри подсказка есть.
    const err: any = await guardWith(TOKEN)
      .canActivate(ctx('Bearer чужой'))
      .then(
        () => null,
        (e: unknown) => e,
      );

    // Сначала про сам отказ: без этого утверждения тест зелен вхолостую —
    // у пропустившего гварда err === null, message === '', и обе проверки
    // «ничего не выдаёт» проходят. Замерено на заглушке.
    expect(err).toBeInstanceOf(UnauthorizedException);

    const message = String(err?.message ?? '');
    expect(message).not.toContain(TOKEN);
    expect(message).not.toMatch(/\d/);
  });
});
