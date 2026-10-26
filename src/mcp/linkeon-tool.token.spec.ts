import * as jwt from 'jsonwebtoken';
import { LINKEON_TOOL_TOKEN_TYPE, signLinkeonToolToken, verifyLinkeonToolToken } from './linkeon-tool.token';
import { signProductToolToken, verifyProductToolToken } from '../products/product-tool.token';

/**
 * Токен хода для инструментов Linkeon (mcp__linkeon__*) — спека
 * docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
 */
describe('токен хода для инструментов Linkeon', () => {
  const OLD = { cur: process.env.JWT_SECRET, prev: process.env.JWT_SECRET_PREVIOUS };
  beforeEach(() => {
    process.env.JWT_SECRET = 'linkeon-tool-spec';
    delete process.env.JWT_SECRET_PREVIOUS;
  });
  afterAll(() => {
    if (OLD.cur === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD.cur;
    if (OLD.prev === undefined) delete process.env.JWT_SECRET_PREVIOUS; else process.env.JWT_SECRET_PREVIOUS = OLD.prev;
  });

  it('выпуск и разбор: тот же пользователь — и больше ничего', () => {
    expect(verifyLinkeonToolToken(signLinkeonToolToken('79030169187'))).toEqual({ userId: '79030169187' });
  });

  it('пользователь с почтовым входом (UUID) — так же', () => {
    const id = '0b7c2a4e-1f3d-4c8a-9e2b-5d6f7a8b9c0d';
    expect(verifyLinkeonToolToken(signLinkeonToolToken(id))).toEqual({ userId: id });
  });

  it('в подписи только userId и тип; срок — 30 минут', () => {
    const p: any = jwt.decode(signLinkeonToolToken('u-1'));
    expect(Object.keys(p).sort()).toEqual(['exp', 'iat', 'type', 'userId']);
    expect(LINKEON_TOOL_TOKEN_TYPE).toBe('linkeon-tool');
    expect(p.type).toBe(LINKEON_TOOL_TOKEN_TYPE);
    expect(p.exp - p.iat).toBe(30 * 60);
  });

  it('без пользователя токен не выпускается', () => {
    expect(() => signLinkeonToolToken('')).toThrow();
  });

  it('чужая подпись — отказ', () => {
    const alien = jwt.sign({ userId: 'u-1', type: LINKEON_TOOL_TOKEN_TYPE }, 'not-our-secret');
    expect(() => verifyLinkeonToolToken(alien)).toThrow();
  });

  // JwtGuard симметрично требует type='access' (src/common/guards/jwt.guard.ts):
  // токен хода, лежащий на релее в конфиге хода, не открывает защищённых ручек.
  it('access-токен пользователя сюда не годится', () => {
    const access = jwt.sign({ userId: 'u-1', sub: 'u-1', type: 'access' }, process.env.JWT_SECRET!);
    expect(() => verifyLinkeonToolToken(access)).toThrow(/тип/i);
  });

  it('токен продуктов сюда не годится, и наоборот', () => {
    expect(() => verifyLinkeonToolToken(signProductToolToken('u-1'))).toThrow(/тип/i);
    expect(() => verifyProductToolToken(signLinkeonToolToken('u-1'))).toThrow(/тип/i);
  });

  it('просроченный — отказ', () => {
    const stale = jwt.sign({ userId: 'u-1', type: LINKEON_TOOL_TOKEN_TYPE }, process.env.JWT_SECRET!, { expiresIn: -60 });
    expect(() => verifyLinkeonToolToken(stale)).toThrow();
  });

  it('без userId в подписи — отказ', () => {
    const empty = jwt.sign({ type: LINKEON_TOOL_TOKEN_TYPE }, process.env.JWT_SECRET!);
    expect(() => verifyLinkeonToolToken(empty)).toThrow(/пользовател/i);
  });

  describe('смена JWT_SECRET', () => {
    it('токен на прежнем секрете принимается, пока задан JWT_SECRET_PREVIOUS', () => {
      const old = signLinkeonToolToken('u-1');
      process.env.JWT_SECRET_PREVIOUS = 'linkeon-tool-spec';
      process.env.JWT_SECRET = 'linkeon-tool-spec-new';
      expect(verifyLinkeonToolToken(old)).toEqual({ userId: 'u-1' });
    });

    it('без JWT_SECRET_PREVIOUS — отказ', () => {
      const old = signLinkeonToolToken('u-1');
      process.env.JWT_SECRET = 'linkeon-tool-spec-new';
      expect(() => verifyLinkeonToolToken(old)).toThrow();
    });

    it('просроченный на прежнем секрете — отказ и при JWT_SECRET_PREVIOUS', () => {
      const stale = jwt.sign({ userId: 'u-1', type: LINKEON_TOOL_TOKEN_TYPE }, 'linkeon-tool-spec', { expiresIn: -60 });
      process.env.JWT_SECRET_PREVIOUS = 'linkeon-tool-spec';
      process.env.JWT_SECRET = 'linkeon-tool-spec-new';
      expect(() => verifyLinkeonToolToken(stale)).toThrow();
    });
  });
});
