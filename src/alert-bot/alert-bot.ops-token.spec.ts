import * as jwt from 'jsonwebtoken';
import { signOpsToken, signRepairToken, verifyAlertBotToken, verifyOpsToken } from './alert-bot.ops-token';

const ENV_KEYS = ['JWT_SECRET', 'ALERT_BOT_TIMEOUT_MS', 'ALERT_BOT_REPAIR_TIMEOUT_MS'] as const;
const SAVED_ENV = ENV_KEYS.map((key) => [key, process.env[key]] as const);

describe('ops token', () => {
  beforeEach(() => { process.env.JWT_SECRET = 'ops-spec-secret'; });
  afterEach(() => {
    for (const [key, value] of SAVED_ENV) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
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
  it('repair token привязан к admin, chat, turn и repair', () => {
    const token = signRepairToken({ adminUserId: 'tg:123', adminTgId: '123', chatId: '-1001', turnId: 'turn-1', repairId: 'repair-1' });
    expect(verifyAlertBotToken(token)).toEqual({ scope: 'repair', adminUserId: 'tg:123', adminTgId: '123', chatId: '-1001', turnId: 'turn-1', repairId: 'repair-1' });
    expect(verifyOpsToken(token)).toBeNull();
  });
  it('repair token использует часовой бюджет и не принимает ops scope', () => {
    delete process.env.ALERT_BOT_REPAIR_TIMEOUT_MS;
    const token = signRepairToken({ adminUserId: 'tg:123', adminTgId: '123', chatId: '1', turnId: 't', repairId: 'r' });
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded.exp! - decoded.iat!).toBe(3720);
    expect(verifyAlertBotToken(signOpsToken('u-admin', '1'))).toEqual({ scope: 'ops', adminUserId: 'u-admin', chatId: '1' });
  });
});
