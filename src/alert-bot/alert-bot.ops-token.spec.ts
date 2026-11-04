import * as jwt from 'jsonwebtoken';
import { signOpsToken, verifyOpsToken } from './alert-bot.ops-token';

describe('ops token', () => {
  beforeEach(() => { process.env.JWT_SECRET = 'ops-spec-secret'; });
  afterEach(() => { delete process.env.ALERT_BOT_TIMEOUT_MS; });
  it('возвращает админа и чат', () => {
    const token = signOpsToken('u-admin', '1');
    expect(verifyOpsToken(token)).toEqual({ adminUserId: 'u-admin', chatId: '1' });
  });
  it('отклоняет чужую подпись, другой scope и истёкший токен', () => {
    expect(verifyOpsToken('broken')).toBeNull();
    expect(verifyOpsToken(jwt.sign({ scope: 'other', sub: 'u-admin', chatId: '1' }, 'ops-spec-secret'))).toBeNull();
    expect(verifyOpsToken(jwt.sign({ scope: 'ops', sub: 'u-admin', chatId: '1' }, 'wrong'))).toBeNull();
    expect(verifyOpsToken(jwt.sign({ scope: 'ops', sub: 'u-admin', chatId: '1' }, 'ops-spec-secret', { expiresIn: -1 }))).toBeNull();
  });
  it('оставляет TTL не короче максимального бюджета хода плюс 120 секунд', () => {
    process.env.ALERT_BOT_TIMEOUT_MS = '600000';
    const decoded = jwt.decode(signOpsToken('u-admin', '1')) as jwt.JwtPayload;
    expect(decoded.exp! - decoded.iat!).toBe(720);
  });
  it('без JWT_SECRET не выпускает токен', () => {
    delete process.env.JWT_SECRET;
    expect(() => signOpsToken('u-admin', '1')).toThrow('JWT_SECRET required');
  });
});
