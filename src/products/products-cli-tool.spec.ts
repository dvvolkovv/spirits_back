import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { PATH_METADATA } from '@nestjs/common/constants';
import { productsCliMcp, PRODUCTS_CLI_TOOL_NAME } from './products-cli-tool';
import { verifyProductToolToken } from './product-tool.token';
import { PRODUCT_TOOL_NAME } from './product-tool.service';
import { ProductsMcpController } from '../mcp/products-mcp.controller';

/**
 * Инструмент продуктов для ЛОКАЛЬНОГО claude CLI (Маша в вебе, Telegram-бот):
 * тот же MCP-сервер /webhook/mcp/products, что у релея, но по loopback — CLI
 * запущен этим же процессом бэкенда, и ходить к себе через nginx незачем.
 *
 * Молчаливые поломки здесь такие: адрес или порт разъехались с тем, где
 * слушает приложение, — CLI с --strict-mcp-config просто не поднимет сервер, и
 * ассистент скажет «не умею»; имя инструмента разъехалось с реальным —
 * allowedTools не совпадёт, и вызов отклонится. Ни то ни другое не даёт
 * ошибки в логе, поэтому оба сторожатся здесь.
 */
describe('инструмент продуктов для локального CLI', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  const OLD_PORT = process.env.PORT;
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-product-tool'; });
  afterAll(() => { process.env.JWT_SECRET = OLD_SECRET; });
  afterEach(() => {
    if (OLD_PORT === undefined) delete process.env.PORT;
    else process.env.PORT = OLD_PORT;
  });

  const bearerOf = (r: ReturnType<typeof productsCliMcp>) =>
    String(r.mcpServers.products.headers?.Authorization ?? '');

  it('адрес — loopback и порт приложения (по умолчанию 3001)', () => {
    delete process.env.PORT;
    const r = productsCliMcp('79030169187', 'web');
    expect(r.mcpServers.products.type).toBe('http');
    expect(r.mcpServers.products.url).toBe('http://127.0.0.1:3001/webhook/mcp/products');
  });

  it('порт берётся из того же PORT, на котором слушает приложение', () => {
    process.env.PORT = '4555';
    expect(productsCliMcp('79030169187', 'web').mcpServers.products.url)
      .toBe('http://127.0.0.1:4555/webhook/mcp/products');
  });

  // Порт хелпера и порт приложения — из одного источника. Разойдутся (кто-то
  // поменяет умолчание в main.ts) — CLI будет стучаться в пустоту молча.
  it('main.ts слушает на том же process.env.PORT || 3001', () => {
    const src = fs.readFileSync(path.join(__dirname, '../main.ts'), 'utf8');
    expect(src).toMatch(/const port = process\.env\.PORT \|\| 3001;/);
    expect(src).toMatch(/app\.listen\(port\)/);
  });

  it('путь адреса — ровно маршрут точки инструмента', () => {
    const ctrlPath = Reflect.getMetadata(PATH_METADATA, ProductsMcpController) ?? '';
    const route = `/${['webhook', ctrlPath].join('/')}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
    expect(new URL(productsCliMcp('79030169187', 'web').mcpServers.products.url).pathname).toBe(route);
  });

  it('заголовок — Bearer с подписанным токеном этого пользователя и канала web', () => {
    const r = productsCliMcp('79030169187', 'web');
    const bearer = bearerOf(r);
    expect(bearer).toMatch(/^Bearer \S+$/);
    expect(verifyProductToolToken(bearer.replace(/^Bearer /, ''))).toEqual({ userId: '79030169187', channel: 'web' });
  });

  it('для Telegram токен несёт канал telegram', () => {
    const r = productsCliMcp('70000000000', 'telegram');
    expect(verifyProductToolToken(bearerOf(r).replace(/^Bearer /, ''))).toEqual({
      userId: '70000000000',
      channel: 'telegram',
    });
  });

  // Имя складывает CLI: mcp__<ключ сервера>__<имя инструмента>. Ключ — наш
  // ('products'), имя — из контракта сервера. То же имя стоит в релее
  // (PRODUCTS_TOOLS в relay-agent/server.mjs).
  it('имя инструмента совпадает с тем, что CLI сложит из ключа и контракта', () => {
    const r = productsCliMcp('79030169187', 'web');
    expect(Object.keys(r.mcpServers)).toEqual(['products']);
    expect(r.toolName).toBe(`mcp__products__${PRODUCT_TOOL_NAME}`);
    expect(r.toolName).toBe('mcp__products__manage_product');
    expect(PRODUCTS_CLI_TOOL_NAME).toBe(r.toolName);
  });

  describe('блок системного промпта', () => {
    const block = () => productsCliMcp('79030169187', 'web').promptBlock;

    it('называет инструмент и все четыре действия, включая check и remove у домена', () => {
      const b = block();
      expect(b).toContain('mcp__products__manage_product');
      for (const a of ['"list"', '"edit"', '"status"', '"domain"']) expect(b).toContain(a);
      expect(b).toMatch(/check: true/);
      expect(b).toMatch(/remove: true/);
    });

    it('держит главные правила честности: откат и провал — не успех, домен — только active', () => {
      const b = block();
      expect(b).toMatch(/reverted/);
      expect(b).toMatch(/failed/);
      expect(b).toMatch(/outcome="done"/);
      expect(b).toMatch(/ДОСЛОВНО/);
      expect(b).toMatch(/"active"/);
      expect(b).toMatch(/ambiguous/);
      expect(b).toMatch(/СПРОСИ/);
    });

    it('запрещает передавать userId/телефон', () => {
      expect(block()).toMatch(/НЕ передавай[^\n]*userId/);
    });

    // Оговорка релея про «только mcp__linkeon__*» относится к ЕГО системному
    // промпту. У Маши и бота такого правила нет, и фраза про «исключение» лишь
    // сбивала бы модель.
    it('без релейной оговорки про исключение из правила mcp__linkeon__*', () => {
      const b = block();
      expect(b).not.toMatch(/исключени/i);
      expect(b).not.toContain('mcp__linkeon__');
    });

    // В локальном CLI нет ни Bash, ни Write — ссылаться на них незачем.
    it('не упоминает Bash/Write', () => {
      const b = block();
      expect(b).not.toContain('Bash');
      expect(b).not.toContain('Write');
    });
  });
});
