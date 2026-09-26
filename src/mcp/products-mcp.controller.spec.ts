import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { UnauthorizedException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import * as jwt from 'jsonwebtoken';
import { ProductsMcpController } from './products-mcp.controller';
import { signProductToolToken } from '../products/product-tool.token';

describe('точка /mcp/products', () => {
  const OLD = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-product-tool'; });
  afterAll(() => { process.env.JWT_SECRET = OLD; });

  const make = () => {
    const calls: any[] = [];
    const tool = {
      execute: jest.fn(async (userId: string, input: any, channel?: string) => {
        calls.push({ userId, input, channel });
        return { ok: true };
      }),
    };
    return { ctrl: new ProductsMcpController(tool as any), calls, tool };
  };

  it('владелец берётся ИЗ ТОКЕНА', async () => {
    const { ctrl, calls } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187')}`, { action: 'list' });
    expect(calls[0].userId).toBe('79030169187');
  });

  // Главная защита этой точки. Поле userId в запросе не должно значить НИЧЕГО:
  // иначе возвращается ровно та дыра, из-за которой инструмент не отдали общей
  // точке /mcp (там userId пишет модель — mcp.controller.ts:74).
  it('поле userId в запросе игнорируется полностью', async () => {
    const { ctrl, calls } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187')}`, { action: 'list', userId: '70000000000' });
    expect(calls[0].userId).toBe('79030169187');
    expect(calls[0].input.userId).toBeUndefined();
  });

  // Канал хода (web/telegram) — из подписи, как и владелец. Правка из
  // Telegram ложится в product_turns с channel='telegram', из веба — 'web'.
  it('канал берётся ИЗ ТОКЕНА: telegram', async () => {
    const { ctrl, calls } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187', 'telegram')}`, { action: 'list' });
    expect(calls[0].channel).toBe('telegram');
  });

  it('веб-токен даёт канал web', async () => {
    const { ctrl, calls } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187', 'web')}`, { action: 'list' });
    expect(calls[0].channel).toBe('web');
  });

  // Токены релея, выпущенные до появления канала, живут до 30 минут после
  // выката — они обязаны работать и значить «веб».
  it('токен без канала (релей до правки) — канал web', async () => {
    const { ctrl, calls } = make();
    const legacy = jwt.sign({ userId: '79030169187', type: 'product-tool' }, process.env.JWT_SECRET!);
    await ctrl.callTool(`Bearer ${legacy}`, { action: 'list' });
    expect(calls[0].userId).toBe('79030169187');
    expect(calls[0].channel).toBe('web');
  });

  // Тот же приём, что с userId: поле пишет модель, и значить оно не должно ничего.
  it('поле channel в запросе не меняет канал и не доезжает до инструмента', async () => {
    const { ctrl, calls } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187', 'web')}`, { action: 'list', channel: 'telegram' });
    expect(calls[0].channel).toBe('web');
    expect(calls[0].input.channel).toBeUndefined();
  });

  it('без токена — отказ, инструмент не зовётся', async () => {
    const { ctrl, tool } = make();
    await expect(ctrl.callTool(undefined, { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('чужая подпись — отказ', async () => {
    const { ctrl, tool } = make();
    const alien = jwt.sign({ userId: '79030169187', type: 'product-tool' }, 'not-our-secret');
    await expect(ctrl.callTool(`Bearer ${alien}`, { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('access-токен пользователя сюда не пускают', async () => {
    const { ctrl, tool } = make();
    const access = jwt.sign({ userId: '79030169187', type: 'access' }, process.env.JWT_SECRET!);
    await expect(ctrl.callTool(`Bearer ${access}`, { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('общий MCP_SECRET здесь не работает', async () => {
    const { ctrl, tool } = make();
    process.env.MCP_SECRET = 'shared-secret';
    await expect(ctrl.callTool('Bearer shared-secret', { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('просроченный токен — отказ', async () => {
    const { ctrl, tool } = make();
    const stale = jwt.sign({ userId: '79030169187', type: 'product-tool' }, process.env.JWT_SECRET!, { expiresIn: -60 });
    await expect(ctrl.callTool(`Bearer ${stale}`, { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('список инструментов отдаётся без аргумента userId', () => {
    const { ctrl } = make();
    const tools = ctrl.listTools();
    expect(tools).toHaveLength(1);
    expect(Object.keys((tools[0] as any).inputSchema.properties)).not.toContain('userId');
  });
});

/**
 * АДРЕС ТОЧКИ ЗАВИСИТ ОТ ДВУХ ФАЙЛОВ СРАЗУ, и ни один из них по отдельности
 * правды не говорит.
 *
 * В main.ts стоит `setGlobalPrefix('webhook', { exclude: [{ path: 'mcp' }] })`.
 * Исключение написано как ТОЧНЫЙ путь `mcp`, а не как префикс `mcp/(.*)`,
 * поэтому из-под глобального префикса выходит только сама `/mcp` — а подпуть
 * `/mcp/products` остаётся под ним и живёт по адресу `/webhook/mcp/products`.
 *
 * Измерено живым приложением: `POST /mcp/products` отдаёт 404, `POST
 * /webhook/mcp/products` — 200 со списком инструментов.
 *
 * Почему адрес оставлен таким, а не «починен» правкой main.ts: на проде
 * nginx проксирует `location /mcp` префиксом, а на тестовом стенде такого
 * блока НЕТ ВОВСЕ — там `/mcp/products` ушёл бы в SPA-фолбэк и вернул 200 с
 * HTML. Зелёная проверка при неработающей точке — ровно тот тихий отказ,
 * которым этот проект уже наелся. `/webhook/*` работает на обеих средах
 * сегодня и ничего в nginx не требует.
 *
 * Цена разъезда молчаливая с обеих сторон: релей запущен со
 * `--strict-mcp-config`, недоступный сервер он просто не поднимет, и ассистент
 * скажет «не умею» — без ошибки в логе и без красного теста.
 */
describe('адрес точки', () => {
  const mainSrc = () => fs.readFileSync(path.join(__dirname, '../main.ts'), 'utf8');

  it('точка стоит ровно там, куда настроен релей', () => {
    const ctrlPath = Reflect.getMetadata(PATH_METADATA, ProductsMcpController) ?? '';
    const methodPath = Reflect.getMetadata(PATH_METADATA, ProductsMcpController.prototype.post) ?? '';
    const verb = Reflect.getMetadata(METHOD_METADATA, ProductsMcpController.prototype.post);
    const full = `/${['webhook', ctrlPath, methodPath].join('/')}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
    // Глагол склеен с путём: он лежит под ДРУГИМ ключом метаданных, и сторож,
    // читающий только путь, переживает замену @Post на @Get целиком.
    expect(`${RequestMethod[verb]} ${full}`).toBe('POST /webhook/mcp/products');
  });

  it('исключение в main.ts не расширено до подпутей', () => {
    const src = mainSrc();
    // Появление `mcp/(.*)` или `mcp/*` в списке исключений УВОДИТ точку на
    // /mcp/products — то есть на адрес, которого нет в nginx тестового стенда.
    expect(src).toMatch(/exclude:\s*\[\s*\{\s*path:\s*'mcp'/);
    expect(src).not.toMatch(/path:\s*'mcp\/[^']*'/);
  });
});
