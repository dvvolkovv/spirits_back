import { createHmac } from 'crypto';
import { appendLinkeonFields, linkeonRelayFields, relayFsKey } from './linkeon-relay-fields';
import { verifyLinkeonToolToken } from '../mcp/linkeon-tool.token';

/**
 * Поля, которыми бэк передаёт релею инструменты Linkeon и папку хода — спека
 * docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
 */
describe('поля инструментов Linkeon для релея', () => {
  const OLD = { jwt: process.env.JWT_SECRET, salt: process.env.RELAY_FS_SALT, base: process.env.BACKEND_URL };
  const put = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  beforeEach(() => {
    put('JWT_SECRET', 'jwt-linkeon-fields');
    put('RELAY_FS_SALT', 'salt-linkeon-fields');
    put('BACKEND_URL', undefined);
  });
  afterAll(() => {
    put('JWT_SECRET', OLD.jwt);
    put('RELAY_FS_SALT', OLD.salt);
    put('BACKEND_URL', OLD.base);
  });

  it('токен хода разбирается в того же пользователя', () => {
    const f = linkeonRelayFields('79030169187', '79030169187_12_ru');
    expect(verifyLinkeonToolToken(f.linkeon_token)).toEqual({ userId: '79030169187' });
  });

  it('адрес точки по умолчанию — прод, /webhook/mcp/linkeon', () => {
    expect(linkeonRelayFields('u-1', 'k').linkeon_mcp_url).toBe('https://my.linkeon.io/webhook/mcp/linkeon');
  });

  it('база — из BACKEND_URL, хвостовой слеш не дублируется', () => {
    put('BACKEND_URL', 'https://test.linkeon.io/');
    expect(linkeonRelayFields('u-1', 'k').linkeon_mcp_url).toBe('https://test.linkeon.io/webhook/mcp/linkeon');
  });

  it('fs_key — 32 hex, постоянен для сессии, разный у разных сессий', () => {
    const a = linkeonRelayFields('79030169187', '79030169187_12_ru').fs_key;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(linkeonRelayFields('79030169187', '79030169187_12_ru').fs_key).toBe(a);
    expect(linkeonRelayFields('79030169187', '79030169187_12_en').fs_key).not.toBe(a);
  });

  it('fs_key не содержит номера', () => {
    const key = linkeonRelayFields('79030169187', '79030169187_12_ru').fs_key;
    expect(key).not.toContain('79030169187');
    expect(key).not.toContain('9030169187');
  });

  it('fs_key — первые 32 hex от HMAC-SHA256 ключа сессии на RELAY_FS_SALT', () => {
    const want = createHmac('sha256', 'salt-linkeon-fields').update('79030169187_12_ru').digest('hex').slice(0, 32);
    expect(relayFsKey('79030169187_12_ru')).toBe(want);
  });

  it('без RELAY_FS_SALT — на JWT_SECRET', () => {
    put('RELAY_FS_SALT', undefined);
    const want = createHmac('sha256', 'jwt-linkeon-fields').update('79030169187_12_ru').digest('hex').slice(0, 32);
    expect(relayFsKey('79030169187_12_ru')).toBe(want);
  });

  it('appendLinkeonFields кладёт три поля под их именами', () => {
    const got: Record<string, string> = {};
    const f = linkeonRelayFields('u-1', 'k');
    appendLinkeonFields({ append: (n: string, v: string) => { got[n] = v; } }, f);
    expect(got).toEqual({ linkeon_token: f.linkeon_token, linkeon_mcp_url: f.linkeon_mcp_url, fs_key: f.fs_key });
  });
});
