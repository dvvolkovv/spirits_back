import * as fs from 'fs';
import * as path from 'path';
import { productsRelayFields } from './products-relay-fields';
import { verifyProductToolToken } from '../products/product-tool.token';

describe('поля инструмента продуктов для релея', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  const OLD_BASE = process.env.BACKEND_URL;
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-product-tool'; });
  afterAll(() => {
    process.env.JWT_SECRET = OLD_SECRET;
    if (OLD_BASE === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = OLD_BASE;
  });
  afterEach(() => {
    if (OLD_BASE === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = OLD_BASE;
  });

  it('токен разбирается обратно в того же пользователя', () => {
    const f = productsRelayFields('79030169187');
    expect(verifyProductToolToken(f.products_token)).toBe('79030169187');
  });

  it('адрес точки — https и ведёт на /webhook/mcp/products', () => {
    delete process.env.BACKEND_URL;
    const f = productsRelayFields('79030169187');
    expect(f.products_mcp_url).toMatch(/^https:\/\//);
    // Именно /webhook/mcp/products: исключение глобального префикса в main.ts
    // покрывает точный путь `mcp`, но не его подпути. Измерено живым
    // приложением: /mcp/products отдаёт 404.
    expect(f.products_mcp_url).toMatch(/\/webhook\/mcp\/products$/);
  });

  it('база берётся из окружения, хвостовой слеш не дублируется', () => {
    process.env.BACKEND_URL = 'https://test.linkeon.io/';
    expect(productsRelayFields('79030169187').products_mcp_url)
      .toBe('https://test.linkeon.io/webhook/mcp/products');
  });

  // Поля обязаны реально уезжать на релей. Без этого инструмент собран,
  // проверен и недоступен ассистенту — ровно тот тихий отказ, на котором в
  // куске 4а автооткат был выключен целиком при зелёных тестах.
  it('chat.service действительно шлёт оба поля', () => {
    const src = fs.readFileSync(path.join(__dirname, 'chat.service.ts'), 'utf8');
    expect(src).toContain('productsRelayFields');
    expect(src).toContain("fd.append('products_token'");
    expect(src).toContain("fd.append('products_mcp_url'");
  });

  it('у каждого пользователя свой токен', () => {
    const a = productsRelayFields('79030169187').products_token;
    const b = productsRelayFields('70000000000').products_token;
    expect(a).not.toBe(b);
    expect(verifyProductToolToken(b)).toBe('70000000000');
  });
});
