import * as jwt from 'jsonwebtoken';
import { JwtService } from './jwt.service';
import { signProductToolToken, verifyProductToolToken } from '../../products/product-tool.token';

/**
 * Смена JWT_SECRET без массового выхода. На время перехода бэк ПРОВЕРЯЕТ и
 * прежним секретом (JWT_SECRET_PREVIOUS), а подписывает только новым:
 * открытые сессии доживают до ближайшего обновления токена и получают уже
 * новые. Потом JWT_SECRET_PREVIOUS убирают, и старый секрет больше ничего не
 * открывает.
 */
const OLD = 'old-secret-rotation-spec';
const NEW = 'new-secret-rotation-spec';

const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
  const saved = { JWT_SECRET: process.env.JWT_SECRET, JWT_SECRET_PREVIOUS: process.env.JWT_SECRET_PREVIOUS };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try { fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

const oldAccess = () => jwt.sign({ sub: 'u-1', userId: 'u-1', type: 'access' }, OLD, { expiresIn: 600 });

describe('JwtService на время смены секрета', () => {
  it('принимает токен, подписанный прежним секретом', () => {
    withEnv({ JWT_SECRET: NEW, JWT_SECRET_PREVIOUS: OLD }, () => {
      expect(new JwtService().verifyAccess(oldAccess()).userId).toBe('u-1');
    });
  });

  it('подписывает только новым', () => {
    withEnv({ JWT_SECRET: NEW, JWT_SECRET_PREVIOUS: OLD }, () => {
      const t = new JwtService().signRefresh('u-1');
      expect(() => jwt.verify(t, OLD)).toThrow();
      expect((jwt.verify(t, NEW) as any).type).toBe('refresh');
    });
  });

  it('без JWT_SECRET_PREVIOUS прежний секрет ничего не открывает', () => {
    withEnv({ JWT_SECRET: NEW, JWT_SECRET_PREVIOUS: undefined }, () => {
      expect(() => new JwtService().verify(oldAccess())).toThrow();
    });
  });

  it('прежний секрет не отменяет проверку типа', () => {
    withEnv({ JWT_SECRET: NEW, JWT_SECRET_PREVIOUS: OLD }, () => {
      const oldRefresh = jwt.sign({ userId: 'u-1', type: 'refresh' }, OLD, { expiresIn: 600 });
      expect(() => new JwtService().verifyAccess(oldRefresh)).toThrow('not an access token');
    });
  });

  it('просроченный токен не оживает на прежнем секрете', () => {
    withEnv({ JWT_SECRET: NEW, JWT_SECRET_PREVIOUS: OLD }, () => {
      const expired = jwt.sign({ userId: 'u-1', type: 'access', exp: Math.floor(Date.now() / 1000) - 10 }, OLD);
      expect(() => new JwtService().verify(expired)).toThrow();
    });
  });
});

describe('токен инструмента продуктов на время смены секрета', () => {
  it('токен, выпущенный до смены, доживает свои 30 минут', () => {
    let t = '';
    withEnv({ JWT_SECRET: OLD, JWT_SECRET_PREVIOUS: undefined }, () => { t = signProductToolToken('u-1'); });
    withEnv({ JWT_SECRET: NEW, JWT_SECRET_PREVIOUS: OLD }, () => {
      expect(verifyProductToolToken(t).userId).toBe('u-1');
    });
    withEnv({ JWT_SECRET: NEW, JWT_SECRET_PREVIOUS: undefined }, () => {
      expect(() => verifyProductToolToken(t)).toThrow();
    });
  });
});
