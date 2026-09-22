import * as jwt from 'jsonwebtoken';
import { signProductToolToken, verifyProductToolToken, PRODUCT_TOOL_TOKEN_TYPE } from './product-tool.token';

describe('токен инструмента продуктов', () => {
  const OLD = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-product-tool'; });
  afterAll(() => { process.env.JWT_SECRET = OLD; });

  it('свой токен разбирается обратно в того же владельца', () => {
    expect(verifyProductToolToken(signProductToolToken('79030169187'))).toBe('79030169187');
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
});
