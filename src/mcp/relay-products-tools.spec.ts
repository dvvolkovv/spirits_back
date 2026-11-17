import * as fs from 'fs';
import * as path from 'path';
import { ProductsMcpController } from './products-mcp.controller';

/**
 * relay-agent/server.mjs — копия того, что едет на релей (веб-ассистенты).
 * Инструмент точки продуктов без имени в PRODUCTS_TOOLS CLI в -p отклонит
 * молча, а без строки «Тебе доступен инструмент …» в PRODUCTS_PROMPT модель
 * сочтёт его запрещённым (правило «только mcp__linkeon__*»).
 */
const relay = fs.readFileSync(path.join(__dirname, '../../relay-agent/server.mjs'), 'utf8');
const allowed = (/const PRODUCTS_TOOLS = "([^"]+)";/.exec(relay)?.[1] ?? '').split(',');

describe('копия релея знает все инструменты точки продуктов', () => {
  // Набор веба зависит от CHAT_UPLOADS_ENABLED (note_file): проверка не должна
  // меняться от флага в окружении прогона.
  const OLD_FLAG = process.env.CHAT_UPLOADS_ENABLED;
  beforeEach(() => { delete process.env.CHAT_UPLOADS_ENABLED; });
  afterAll(() => {
    if (OLD_FLAG === undefined) delete process.env.CHAT_UPLOADS_ENABLED;
    else process.env.CHAT_UPLOADS_ENABLED = OLD_FLAG;
  });

  it('веб: каждый инструмент — в PRODUCTS_TOOLS и с явным исключением в PRODUCTS_PROMPT', () => {
    const ctrl = new ProductsMcpController({} as any, {} as any, {} as any, {} as any);
    const tools = ctrl.listTools('web') as any[];
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      const name = `mcp__products__${t.name}`;
      expect(allowed).toContain(name);
      expect(relay).toContain(`Тебе доступен инструмент ${name}`);
    }
  });

  // note_file точка показывает только при CHAT_UPLOADS_ENABLED=true, а копия
  // релея флага не знает: имя и оговорка должны стоять в ней заранее, иначе
  // включение флага молча оставит веб-ассистентов без инструмента.
  it('веб с включённой памятью загрузок: note_file тоже в PRODUCTS_TOOLS и с оговоркой', () => {
    const old = process.env.CHAT_UPLOADS_ENABLED;
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    try {
      const ctrl = new ProductsMcpController({} as any, {} as any, {} as any, {} as any, {} as any);
      const names = (ctrl.listTools('web') as any[]).map((t) => t.name);
      expect(names).toContain('note_file');
      for (const n of names) {
        const name = `mcp__products__${n}`;
        expect(allowed).toContain(name);
        expect(relay).toContain(`Тебе доступен инструмент ${name}`);
      }
    } finally {
      if (old === undefined) delete process.env.CHAT_UPLOADS_ENABLED;
      else process.env.CHAT_UPLOADS_ENABLED = old;
    }
  });

  // Ключевые строки описания инструмента (note-file.tool.ts; сверка с ним — в
  // note-file.tool.spec.ts): абзац про комментарии в PRODUCTS_PROMPT повторяет
  // их дословно, чтобы копии указаний не разошлись.
  it('абзац про note_file в PRODUCTS_PROMPT повторяет ключевые строки описания инструмента', () => {
    const block = relay.slice(relay.indexOf('const PRODUCTS_PROMPT'), relay.indexOf('app.post("/chat"'));
    const para = block.slice(block.indexOf('КОММЕНТАРИИ К ЗАГРУЗКАМ'), block.indexOf('СООБЩИТЬ В ПОДДЕРЖКУ'));
    expect(para).toContain('mcp__products__note_file');
    for (const phrase of [
      'Пиши комментарий на языке разговора с пользователем',
      'Если комментарий уже есть и ничего нового не решили — не переписывай его',
      'паролей, номеров документов, карт и счетов',
      'mcp__products__find_files (origin=upload)',
    ]) {
      expect(para).toContain(phrase);
    }
  });
});
