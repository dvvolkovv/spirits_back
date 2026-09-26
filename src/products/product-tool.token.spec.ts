import * as jwt from 'jsonwebtoken';
import { signProductToolToken, verifyProductToolToken, PRODUCT_TOOL_TOKEN_TYPE } from './product-tool.token';

describe('токен инструмента продуктов', () => {
  const OLD = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-product-tool'; });
  afterAll(() => { process.env.JWT_SECRET = OLD; });

  it('свой токен разбирается обратно в того же владельца', () => {
    expect(verifyProductToolToken(signProductToolToken('79030169187')).userId).toBe('79030169187');
  });

  // Канал хода — часть подписи, как и владелец: правка из Telegram должна лечь
  // в product_turns с channel='telegram', и подменить его запросом нельзя.
  it('канал по умолчанию — web', () => {
    expect(verifyProductToolToken(signProductToolToken('79030169187'))).toEqual({
      userId: '79030169187',
      channel: 'web',
    });
  });

  it('токен Telegram разбирается с каналом telegram', () => {
    expect(verifyProductToolToken(signProductToolToken('79030169187', 'telegram'))).toEqual({
      userId: '79030169187',
      channel: 'telegram',
    });
  });

  // Обратная совместимость: токены, выпущенные до появления канала (живые на
  // релее до 30 минут после выката), обязаны работать дальше — это веб.
  it('токен без канала (выпущенный до правки) разбирается как web', () => {
    const legacy = jwt.sign({ userId: '79030169187', type: PRODUCT_TOOL_TOKEN_TYPE }, process.env.JWT_SECRET!);
    expect(verifyProductToolToken(legacy)).toEqual({ userId: '79030169187', channel: 'web' });
  });

  // Незнакомый канал подписать можем только мы сами, то есть это ошибка в коде.
  // Молча записать его «вебом» — значит соврать в истории правок.
  it('незнакомый канал — отказ, а не молчаливый web', () => {
    const odd = jwt.sign(
      { userId: '79030169187', type: PRODUCT_TOOL_TOKEN_TYPE, channel: 'sms' },
      process.env.JWT_SECRET!,
    );
    expect(() => verifyProductToolToken(odd)).toThrow(/канал/i);
  });

  it('чужая подпись отвергается', () => {
    const alien = jwt.sign({ userId: '79030169187', type: PRODUCT_TOOL_TOKEN_TYPE }, 'not-our-secret');
    expect(() => verifyProductToolToken(alien)).toThrow();
  });

  // Тип проверяется ЯВНО. Без него access-токен пользователя (тот же секрет,
  // тот же userId) открывал бы эту точку — то есть утечка access-токена
  // превращалась бы ещё и в правку продуктов, а наш токен на релее работал бы
  // как полный ключ от аккаунта. JwtGuard симметрично требует type='access'
  // (src/common/guards/jwt.guard.ts:25), поэтому обратная подмена тоже закрыта.
  it('access-токен пользователя сюда не годится', () => {
    const access = jwt.sign({ userId: '79030169187', sub: '79030169187', type: 'access' }, process.env.JWT_SECRET!);
    expect(() => verifyProductToolToken(access)).toThrow(/тип/i);
  });

  it('просроченный токен отвергается', () => {
    const stale = jwt.sign(
      { userId: '79030169187', type: PRODUCT_TOOL_TOKEN_TYPE },
      process.env.JWT_SECRET!,
      { expiresIn: -60 },
    );
    expect(() => verifyProductToolToken(stale)).toThrow();
  });

  // Токен живёт дольше хода (RELAY_TURN_BUDGET_MS = 10 мин), иначе длинная
  // правка упёрлась бы в протухшую подпись на последнем шаге, и ассистент
  // потерял бы доступ к продукту посреди собственной работы.
  it('живёт дольше одного хода', () => {
    const p: any = jwt.decode(signProductToolToken('79030169187'));
    expect((p.exp - p.iat) * 1000).toBeGreaterThan(600_000);
  });

  it('веб-токен — 30 минут, как и был', () => {
    const p: any = jwt.decode(signProductToolToken('79030169187', 'web'));
    expect(p.exp - p.iat).toBe(30 * 60);
  });

  // У хода Telegram-бота таймаута нет (tg-router: timeoutMs 0 — прогресс виден
  // статусом в чате). 30 минут оборвали бы доступ к продуктам посреди долгого
  // хода; 2 часа — дольше любого разумного хода бота и заметно короче суток.
  it('токен Telegram — 2 часа', () => {
    const p: any = jwt.decode(signProductToolToken('79030169187', 'telegram'));
    expect(p.exp - p.iat).toBe(2 * 60 * 60);
  });

  // Срок берётся по каналу; незнакомый канал без проверки дал бы expiresIn
  // undefined — то есть токен без срока вовсе.
  it('незнакомый канал при выпуске — отказ, а не вечный токен', () => {
    expect(() => signProductToolToken('79030169187', 'sms' as any)).toThrow(/канал/i);
  });
});
