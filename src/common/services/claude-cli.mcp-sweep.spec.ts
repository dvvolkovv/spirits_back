import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeCliService } from './claude-cli.service';

/**
 * Уборка брошенных конфигов MCP при старте сервиса.
 *
 * Конфиг вызова (claude-mcp-XXXXXX/mcp.json) несёт токен к продуктам пользователя и
 * снимается в finally каждого вызова. Но процесс, убитый посреди хода
 * (рестарт, OOM, kill -9), finally не выполняет — файл с живым токеном
 * остаётся в /tmp. При старте сервиса такие каталоги старше часа снимаются.
 * Час — с запасом дольше хода Маши (10 мин) и срока веб-токена (30 мин); ход
 * бота может идти дольше, но CLI читает конфиг один раз на старте, и снятый
 * позже файл ему уже не нужен.
 */
describe('ClaudeCliService: уборка брошенных конфигов MCP', () => {
  const HOUR = 60 * 60 * 1000;
  let root: string;
  const extra: string[] = [];

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sweep-spec-')); });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const p of extra.splice(0)) fs.rmSync(p, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  /** Выставить mtime в прошлое (сек). Содержимое каталога — заранее: запись файла двигает mtime. */
  const age = (p: string, ms: number, link = false) => {
    const t = (Date.now() - ms) / 1000;
    if (link) fs.lutimesSync(p, t, t); else fs.utimesSync(p, t, t);
  };

  it('снимает только каталоги claude-mcp-* старше порога', () => {
    const stale = path.join(root, 'claude-mcp-old1');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'mcp.json'), '{"token":"x"}');
    age(stale, 2 * HOUR);

    const fresh = path.join(root, 'claude-mcp-new1');
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(fresh, 'mcp.json'), '{}');
    age(fresh, 5 * 60 * 1000);

    // Чужие имена и не-каталоги не трогаем, даже старые.
    const foreign = path.join(root, 'claude-cli-old1');
    fs.mkdirSync(foreign);
    age(foreign, 2 * HOUR);
    const file = path.join(root, 'claude-mcp-file');
    fs.writeFileSync(file, 'x');
    age(file, 2 * HOUR);

    // Симлинк с нашим именем — не каталог: не удаляем ни его, ни цель. Цель
    // тоже старая — иначе stat вместо lstat прошёл бы проверку незамеченным.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sweep-target-'));
    extra.push(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
    age(target, 2 * HOUR);
    const link = path.join(root, 'claude-mcp-link');
    fs.symlinkSync(target, link);
    age(link, 2 * HOUR, true);

    const removed = ClaudeCliService.sweepStaleMcpConfigDirs(root, HOUR);

    expect(removed).toEqual([stale]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true);
  });

  it('несуществующий корень — не падает и ничего не снимает', () => {
    expect(ClaudeCliService.sweepStaleMcpConfigDirs(path.join(root, 'nope'), HOUR)).toEqual([]);
  });

  it('при старте сервиса уборка идёт в os.tmpdir() с порогом в час', () => {
    const spy = jest.spyOn(ClaudeCliService, 'sweepStaleMcpConfigDirs').mockReturnValue([]);
    new ClaudeCliService().onModuleInit();
    expect(spy).toHaveBeenCalledWith(os.tmpdir(), HOUR);
  });

  it('сбой уборки не роняет старт сервиса', () => {
    jest.spyOn(ClaudeCliService, 'sweepStaleMcpConfigDirs').mockImplementation(() => { throw new Error('EACCES'); });
    expect(() => new ClaudeCliService().onModuleInit()).not.toThrow();
  });
});
