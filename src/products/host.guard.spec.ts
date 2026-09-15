import { Logger, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { HostGuard } from './host.guard';

/**
 * Документированная форма токена: `openssl rand -hex 32`. Набор строится именно
 * на ней, а не на удобной строке вроде 'секрет-хоста': кириллический токен наш
 * же агент отправить не может (`http.request` бросает ERR_INVALID_CHAR), а
 * досланный сырым сокетом приходит latin1-строкой и расходится с ожидаемым по
 * длине. Позитивный тест на таком входе был бы зелёным на том, чего продакшен
 * не породит.
 */
const TOKEN = 'f2af8c8ae9fc4a1aa704c164ed4172fdcb92fe3bf410be9dde84fae16461bb7c';
const OTHER = '5ed790c9760a53385a44929641c569868bc0d0a5e65c338ce431c5aed1ca480d';

/**
 * `auth === undefined` даёт запрос вовсе без заголовка, а не с пустым: это
 * разные ветки разбора. Массив допущен намеренно — см. тесты про нестроковый
 * заголовок.
 */
const ctx = (auth?: string | string[]) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: auth === undefined ? {} : { authorization: auth } }),
    }),
  }) as any;

const guardWith = (expected?: string | null) => new HostGuard({ get: () => expected } as any);

/** Возвращает то, чем упал гвард, либо null — если не упал вовсе. */
const refusal = (expected: string | null | undefined, auth?: string | string[]): Promise<any> =>
  guardWith(expected)
    .canActivate(ctx(auth))
    .then(
      () => null,
      (e: unknown) => e,
    );

describe('HostGuard', () => {
  let logged: string[];

  beforeEach(() => {
    // Лог глушится во всех тестах разом: иначе прогон засыпается ошибками из
    // тестов про сломанный конфиг. Записи собираем — на них держится проверка
    // «сервер не молчит».
    logged = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      logged.push(String(m));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('фикстура совпадает с документированной формой токена', () => {
    // Если константа поедет, весь набор поедет вместе с ней молча.
    expect(TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(OTHER).toMatch(/^[0-9a-f]{64}$/);
    expect(OTHER).not.toBe(TOKEN);
    // То, что такой токен вообще долетает по HTTP: значения заголовков latin1.
    expect(Buffer.byteLength(TOKEN)).toBe(TOKEN.length);
  });

  it('пропускает с верным токеном', async () => {
    const g = guardWith(TOKEN);

    await expect(g.canActivate(ctx(`Bearer ${TOKEN}`))).resolves.toBe(true);
  });

  it('отвергает чужой токен', async () => {
    // Класс И сообщение: см. тест про три разных отказа ниже.
    const err = await refusal(TOKEN, `Bearer ${OTHER}`);

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe('Bad host token');
  });

  it('отвергает запрос без токена', async () => {
    const err = await refusal(TOKEN);

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe('Missing host token');
  });

  it('не пускает никого, когда токен не настроен', async () => {
    // Спека даёт этот вход с пустым токеном — и на нём тест ложно-зелёный:
    // отказ приходит от проверки `!token`, а не от проверки конфига. Поэтому
    // здесь закреплено именно сообщение, а непустой токен вынесен в тест ниже.
    const err = await refusal(undefined, 'Bearer ');

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe('host token not configured');
  });

  it('ненастроенный токен даёт 401 и на непустом токене тоже', async () => {
    // Нужен непустой токен: только тогда разбор доходит до Buffer.from(undefined)
    // и падает TypeError'ом, то есть агент получает 500 вместо внятного 401.
    const err = await refusal(undefined, `Bearer ${TOKEN}`);

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toBe('host token not configured');
  });

  it('три разных отказа различимы по сообщению', async () => {
    // Сообщения — единственная диагностика на стороне того, кто поднимает
    // агента: «не настроен» и «не тот токен» ведут в совершенно разные места.
    // Без этой проверки рефактор, схлопнувший три сообщения в одно, остался бы
    // зелёным (измерено: мутация выживала), и различие потерялось бы молча.
    const messages = [
      (await refusal(undefined, `Bearer ${TOKEN}`)).message,
      (await refusal(TOKEN)).message,
      (await refusal(TOKEN, `Bearer ${OTHER}`)).message,
    ];

    expect(new Set(messages).size).toBe(3);
    expect(messages).toEqual(['host token not configured', 'Missing host token', 'Bad host token']);
  });

  it('не пускает никого при любом пустом значении конфига', async () => {
    // `PRODUCT_HOST_TOKEN=` в .env даёт не undefined, а '' — самый вероятный вид
    // «забыли заполнить»; фабрика конфига может отдать и null. Сужение проверки
    // до `expected === undefined` пропустило бы оба значения дальше, и на null
    // разбор дошёл бы до Buffer.from(null) — 500 вместо 401.
    for (const empty of ['', null]) {
      expect((await refusal(empty, 'Bearer ')).message).toBe('host token not configured');
      expect((await refusal(empty, `Bearer ${TOKEN}`)).message).toBe('host token not configured');
    }
  });

  it('короткий токен в конфиге отвергается, а не принимается молча', async () => {
    // `PRODUCT_HOST_TOKEN=test` на тестовом стенде вероятнее, чем хотелось бы, а
    // за гвардом claimJob с расшифрованными секретами всех продуктов. Комментарий
    // в .env.example — не валидация.
    for (const weak of ['test', 'changeme', 'a'.repeat(31)]) {
      const err = await refusal(weak, `Bearer ${weak}`);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toBe('host token not configured');
    }

    // Граница ровно на 32, а не «где-то около»: иначе `>=`/`>` не различить.
    await expect(guardWith('b'.repeat(32)).canActivate(ctx(`Bearer ${'b'.repeat(32)}`))).resolves.toBe(
      true,
    );
  });

  it('неASCII в конфиге отвергается громко, а не превращается в вечный 401', async () => {
    // Кириллический токен недостижим: агент его не отправит (ERR_INVALID_CHAR),
    // а досланный сырым сокетом придёт latin1-строкой и разойдётся по длине
    // (измерено: 23 байта против 45). Снаружи это выглядело бы как «правильный
    // токен не подходит».
    //
    // Отказ здесь ещё и снимает целый класс кодировочных промахов: пока конфиг
    // мог быть неASCII, сравнение через latin1 пускало отправимую ASCII-строку
    // 'A5:@5B-E>AB0' вместо 'секрет-хоста' (U+0441 схлопывается в 0x41).
    // Для ASCII-конфига такой тени не существует — она совпадает с самим токеном.
    for (const bad of ['секрет-хоста-достаточно-длинный-чтобы-пройти-длину', `${TOKEN} `, `${TOKEN}\n`]) {
      const err = await refusal(bad, `Bearer ${bad}`);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toBe('host token not configured');
    }
  });

  it('сломанный конфиг пишется в лог с причиной, но без самого токена', async () => {
    // Без лога 401 — единственный сигнал, и оператор увидит его только когда
    // кто-нибудь постучится.
    await refusal(`${TOKEN}-но-с-кириллицей`, `Bearer ${TOKEN}`);
    await refusal('test', `Bearer ${TOKEN}`);
    await refusal(undefined, `Bearer ${TOKEN}`);

    expect(logged).toHaveLength(3);
    expect(logged[0]).toContain('PRODUCT_HOST_TOKEN');
    expect(logged[0]).toMatch(/неASCII|управляющий|пробел/);
    expect(logged[1]).toMatch(/короче/);
    expect(logged[2]).toMatch(/не задан/);
    // Токен в логи не уезжает: логи читает больше людей, чем .env.
    for (const line of logged) expect(line).not.toContain(TOKEN);
  });

  it('верный токен ничего не пишет в лог', async () => {
    await guardWith(TOKEN).canActivate(ctx(`Bearer ${TOKEN}`));

    expect(logged).toEqual([]);
  });

  it('отвергает чужой токен той же длины', async () => {
    // Без этого теста отказ держался бы на одной лишь проверке длины.
    expect(Buffer.byteLength(OTHER)).toBe(Buffer.byteLength(TOKEN));

    expect((await refusal(TOKEN, `Bearer ${OTHER}`)).message).toBe('Bad host token');
  });

  it('токен-префикс настоящего не принимается', async () => {
    // Классический промах — сравнение через startsWith/indexOf вместо
    // равенства: угадавший первые символы получал бы доступ, а подбор из
    // экспоненциального становился бы линейным.
    const prefix = TOKEN.slice(0, 32);
    expect(TOKEN.startsWith(prefix)).toBe(true);

    expect((await refusal(TOKEN, `Bearer ${prefix}`)).message).toBe('Bad host token');
  });

  it('токен, отличающийся только регистром, не принимается', async () => {
    // hex в верхнем регистре — ровно то, что принесёт копипаста из другого
    // инструмента: длина та же, так что отказ обязан прийти от сравнения
    // содержимого, а не от длины. Ловит мутацию с toLowerCase().
    const upper = TOKEN.toUpperCase();
    expect(upper).not.toBe(TOKEN);
    expect(Buffer.byteLength(upper)).toBe(Buffer.byteLength(TOKEN));

    expect((await refusal(TOKEN, `Bearer ${upper}`)).message).toBe('Bad host token');
  });

  it('заголовок без префикса Bearer не принимается', async () => {
    // Тест на отсутствие токена эту мутацию НЕ ловит: при фоллбэке на всю
    // строку запрос без заголовка всё равно даёт пустой токен и падает на
    // проверке `!token`. Нужен именно голый токен без префикса.
    expect((await refusal(TOKEN, TOKEN)).message).toBe('Missing host token');
  });

  it('префикс Bearer разбирается регистрозависимо', async () => {
    // RFC 7235 объявляет схему авторизации регистронезависимой, то есть мы
    // строже стандарта. Это осознанно и совпадает с RunnerGuard: агент хоста
    // пишем мы сами, заголовок формирует наш же код.
    expect((await refusal(TOKEN, `bearer ${TOKEN}`)).message).toBe('Missing host token');
  });

  it('лишний пробел вокруг токена не прощается', async () => {
    // Токен не тримится. Тест фиксирует это как решение, а не как случайность:
    // молчаливый trim() прятал бы кривой конфиг агента.
    expect((await refusal(TOKEN, `Bearer ${TOKEN} `)).message).toBe('Bad host token');
    expect((await refusal(TOKEN, `Bearer  ${TOKEN}`)).message).toBe('Bad host token');
  });

  it('токен неверной длины даёт 401, а не 500', async () => {
    // timingSafeEqual на буферах разной длины бросает RangeError. Без проверки
    // длины перед ним агент с укороченным токеном получал бы 500 и писал в лог
    // «внутренняя ошибка сервера» вместо внятного отказа.
    const short = 'deadbeef';
    expect(Buffer.byteLength(short)).not.toBe(Buffer.byteLength(TOKEN));

    const err = await refusal(TOKEN, `Bearer ${short}`);

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err).not.toBeInstanceOf(RangeError);
  });

  it('нестроковый заголовок даёт 401, а не падение гварда', async () => {
    const err = await refusal(TOKEN, [`Bearer ${TOKEN}`, 'Bearer чужой']);

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it('одноэлементный массив в заголовке не принимается', async () => {
    // `String(['Bearer x'])` даёт 'Bearer x', то есть при приведении строкой
    // такой заголовок ПРОХОДИЛ БЫ. Node дубликаты Authorization отбрасывает и
    // массива не отдаёт никогда — но это деталь ядра вне нашего репозитория, а
    // за гвардом лежат чужие секреты, поэтому не полагаемся на неё.
    expect(String([`Bearer ${TOKEN}`])).toBe(`Bearer ${TOKEN}`);

    expect((await refusal(TOKEN, [`Bearer ${TOKEN}`])).message).toBe('Missing host token');
  });

  it('символы вне latin1 не схлопываются в настоящий токен', async () => {
    // Buffer.from(s, 'latin1'|'ascii') режет code point по младшему байту, так
    // что строка из символов «настоящий + 0x100» под такой кодировкой даёт
    // ровно байты токена (измерено), а utf8 разводит их на 128 байт против 64.
    // По HTTP такое не прислать — значения заголовков latin1, все символы
    // ≤ 0xFF, — но опираться на это не хочется ровно по той же причине, что и в
    // тесте про массив: инвариант живёт в ядре Node, а не в этом репозитории.
    const shadow = [...TOKEN].map((c) => String.fromCharCode(c.charCodeAt(0) + 0x100)).join('');
    expect(shadow).toHaveLength(TOKEN.length);
    expect(Buffer.from(shadow, 'latin1').equals(Buffer.from(TOKEN))).toBe(true);

    const err = await refusal(TOKEN, `Bearer ${shadow}`);

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe('Bad host token');
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
    const err = await refusal(TOKEN, `Bearer ${OTHER}`);

    // Сначала про сам отказ: без этого утверждения тест зелен вхолостую —
    // у пропустившего гварда err === null, message === '', и обе проверки
    // «ничего не выдаёт» проходят. Замерено на заглушке.
    expect(err).toBeInstanceOf(UnauthorizedException);

    const message = String(err?.message ?? '');
    expect(message).not.toContain(TOKEN);
    expect(message).not.toMatch(/\d/);
  });
});
