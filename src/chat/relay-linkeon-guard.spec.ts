import * as fs from 'fs';
import * as path from 'path';
import { CHAT_TOOLS } from './chat-tools';
import { relayFsKey } from './linkeon-relay-fields';

/**
 * Релей и инструменты Linkeon по токену хода — спека
 * docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md. Копия в
 * relay-agent/ — то, что выкатывается на релей; сторож держит обещания:
 *   • номер телефона не уходит модели строкой в реплике хода;
 *   • в правилах mcp__linkeon__* нет аргумента userId, есть оговорка «не передавай»;
 *   • сервер linkeon и его имена в --allowedTools — только из токена хода;
 *   • папка хода — по fs_key, и формат fs_key у бэка и релея один.
 */
const dir = path.join(__dirname, '../../relay-agent');
const server = fs.readFileSync(path.join(dir, 'server.mjs'), 'utf8');
const linkeonMcp = fs.readFileSync(path.join(dir, 'linkeon-mcp.mjs'), 'utf8');
const paths = fs.readFileSync(path.join(dir, 'paths.mjs'), 'utf8');
const SYS_START = server.indexOf('const SYSTEM_PROMPT = `');
const systemPrompt = server.slice(SYS_START, server.indexOf('`;', SYS_START));
const DISCLAIMER = 'НЕ передавай в них userId/телефон';

describe('релей: инструменты Linkeon по токену хода', () => {
  it('номера в реплике хода нет', () => {
    expect(server).not.toContain('Current user phone');
    expect(server).not.toContain('_phonePart');
  });

  it('в правилах SYSTEM_PROMPT нет userId, кроме оговорки «не передавай»', () => {
    expect(SYS_START).toBeGreaterThan(-1);
    expect(systemPrompt).toContain(DISCLAIMER);
    expect(systemPrompt.split(DISCLAIMER).join('')).not.toMatch(/userId/);
  });

  it('оговорка стоит в строке про mcp__linkeon__*', () => {
    const line = systemPrompt.split('\n').find((l) => l.includes(DISCLAIMER)) ?? '';
    expect(line).toContain('mcp__linkeon__*');
  });

  it('LINKEON_TOOLS — ровно инструменты CHAT_TOOLS бэка', () => {
    const names = [...linkeonMcp.matchAll(/"(mcp__linkeon__\w+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual(CHAT_TOOLS.map((t) => `mcp__linkeon__${t.name}`).sort());
  });

  it('базовый список инструментов без mcp__linkeon__*; имена — только вместе с сервером из токена', () => {
    const base = /const BASE_TOOLS = "([^"]+)";/.exec(server)?.[1];
    expect(base).toBeDefined();
    expect(base).not.toContain('mcp__linkeon__');
    expect(server).not.toContain('WebFetch(*),mcp__linkeon__');
    expect(server).toContain('const linkeonSrv = linkeonServer(req.body);');
    expect(server).toMatch(/if \(wantLinkeon\) allowedTools \+= "," \+ LINKEON_TOOLS;/);
  });

  it('папка хода — по fs_key от бэка', () => {
    expect(server).toContain('turnFsKey(req.body.fs_key, sessionId, randomUUID())');
    expect(server).not.toMatch(/const fsKey = sessionFsKey\(/);
  });

  it('формат fs_key у бэка и проверка релея совпадают: 32 hex', () => {
    // relayFsKey без секретов (ревью 26.10.2026) ничего не выдаёт — для
    // проверки формата нужен хоть один.
    const OLD_SALT = process.env.RELAY_FS_SALT;
    process.env.RELAY_FS_SALT = 'relay-linkeon-guard-spec';
    try {
      expect(/const FS_KEY_RE = \/(.+)\/;/.exec(paths)?.[1]).toBe('^[0-9a-f]{32}$');
      expect(relayFsKey('79030169187_12_ru')).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      if (OLD_SALT === undefined) delete process.env.RELAY_FS_SALT; else process.env.RELAY_FS_SALT = OLD_SALT;
    }
  });
});
