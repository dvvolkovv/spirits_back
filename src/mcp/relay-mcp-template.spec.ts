import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Шаблон базового MCP-конфига релея лежит в публичном репозитории.
 *
 * До 26.10.2026 боевой файл на релее (/home/dv/file-agent/empty-mcp.json)
 * держал сервер linkeon с общим MCP_SECRET прода; с 06.08 по 07.10.2026 он
 * лежал здесь целиком. Теперь сервер linkeon подключается в конфиг хода из
 * токена хода (relay-agent/linkeon-mcp.mjs), и базовый конфиг пуст — ни
 * серверов, ни секретов.
 */
describe('relay-agent/empty-mcp.json', () => {
  const raw = readFileSync(join(__dirname, '../../relay-agent/empty-mcp.json'), 'utf8');

  it('серверов нет: linkeon — только из токена хода', () => {
    expect(JSON.parse(raw)).toEqual({ mcpServers: {} });
  });

  it('нигде в файле нет заголовков и строк, похожих на секрет', () => {
    expect(raw).not.toMatch(/[A-Za-z0-9]{32,}/);
    expect(raw).not.toMatch(/Bearer|Authorization/);
  });
});
