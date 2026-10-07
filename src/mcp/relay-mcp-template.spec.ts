import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Шаблон MCP-конфига релея лежит в публичном репозитории.
 *
 * Боевой файл на релее (/home/dv/file-agent/empty-mcp.json) хранит
 * MCP_SECRET прода. При переносе релея в репозиторий (34470d7, 06.08.2026)
 * его скопировали целиком, и до 07.10.2026 любой читатель GitHub мог звать
 * /mcp от имени любого пользователя: календарь, рутины, генерация за чужие
 * токены. Секрет заменён; здесь — только плейсхолдер.
 */
describe('relay-agent/empty-mcp.json', () => {
  const raw = readFileSync(join(__dirname, '../../relay-agent/empty-mcp.json'), 'utf8');

  it('в заголовке Authorization плейсхолдер, а не настоящий секрет', () => {
    const auth: string = JSON.parse(raw).mcpServers.linkeon.headers.Authorization;
    expect(auth).not.toMatch(/Bearer [A-Za-z0-9._~+/=-]{20,}/);
  });

  it('нигде в файле нет строки, похожей на секрет', () => {
    expect(raw).not.toMatch(/[A-Za-z0-9]{32,}/);
  });
});
