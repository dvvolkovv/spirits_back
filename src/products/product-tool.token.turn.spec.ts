import * as jwt from 'jsonwebtoken';
import { signProductToolToken, verifyProductToolToken, PRODUCT_TOOL_TOKEN_TYPE } from './product-tool.token';
import { productsRelayFields } from '../chat/products-relay-fields';
import { productsCliMcp } from './products-cli-tool';

const TURN = '11111111-2222-4333-8444-555555555555';

describe('метка хода в токене инструмента продуктов', () => {
  it('подписанная метка доезжает до проверки', () => {
    expect(verifyProductToolToken(signProductToolToken('u1', 'web', { turn: TURN }))).toEqual({ userId: 'u1', channel: 'web', turn: TURN });
  });

  it('метка соседствует с полями справки', () => {
    const t = signProductToolToken('u1', 'web', { lang: 'en', client: 'web', agent: 'staff', turn: TURN });
    expect(verifyProductToolToken(t)).toEqual({ userId: 'u1', channel: 'web', lang: 'en', client: 'web', agent: 'staff', turn: TURN });
  });

  it('без метки — null, как у старых токенов', () => {
    expect(verifyProductToolToken(signProductToolToken('u1', 'telegram'))).toEqual({ userId: 'u1', channel: 'telegram', turn: null });
  });

  it('подписать не-uuid нельзя', () => {
    expect(() => signProductToolToken('u1', 'web', { turn: 'drop table' })).toThrow(/uuid/);
  });

  it('чужая форма метки в подписанном токене — null, а не строка как есть', () => {
    const t = jwt.sign({ userId: 'u1', type: PRODUCT_TOOL_TOKEN_TYPE, channel: 'web', turn: 'x' }, process.env.JWT_SECRET || 'default_secret_change_me');
    expect(verifyProductToolToken(t).turn).toBeNull();
  });

  it('релей и локальный CLI кладут метку в токен', () => {
    const relay = productsRelayFields('u1', { turn: TURN }).products_token;
    expect(verifyProductToolToken(relay).turn).toBe(TURN);
    const cli = productsCliMcp('u1', 'telegram', { turn: TURN });
    const auth = (Object.values(cli.mcpServers)[0] as any).headers.Authorization as string;
    expect(verifyProductToolToken(auth.replace(/^Bearer /, ''))).toEqual({ userId: 'u1', channel: 'telegram', turn: TURN });
  });
});
