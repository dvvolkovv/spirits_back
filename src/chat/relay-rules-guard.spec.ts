import * as fs from 'fs';
import * as path from 'path';

/**
 * Правила SYSTEM_PROMPT релея о ссылках, источниках и файлах — спека
 * docs/superpowers/specs/2026-10-27-assistant-links-sources-roles-design.md,
 * п. 3 (решение владельца 27.10.2026). Копия в relay-agent/ — то, что
 * выкатывается на релей; сторож держит обещания текста:
 *   • правило 9: запрет — только на пути файлов и внутренние адреса; ссылки на
 *     разделы my.linkeon.io и на страницы, открытые в этом ходе, можно;
 *     картинки инструментов — по-прежнему ![](url);
 *   • «файлы прикреплены ниже» — только про файлы, сохранённые в этом ходе;
 *   • правило 7 (адреса созданных файлов не печатать) — на месте;
 *   • «ПРОВЕРКА ФАКТОВ»: факт из внешнего источника — со ссылкой и тем, что
 *     видно; «не нашёл» — не «не существует»;
 *   • правило 4: картинки в pptx — по смыслу своего слайда, вопрос, перечень.
 */
const src = fs.readFileSync(path.join(__dirname, '../../relay-agent/server.mjs'), 'utf8');
const SYS_START = src.indexOf('const SYSTEM_PROMPT = `');
const system = src.slice(SYS_START, src.indexOf('`;', SYS_START));
const rules = system.slice(system.indexOf('\nRULES:\n'), system.indexOf('\nRECURRING / ROUTINE REQUESTS'));
const rule = (n: number): string => new RegExp(`^${n}\\. [^\\n]+`, 'm').exec(rules)?.[0] ?? '';
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('релей: правила о ссылках, источниках и файлах', () => {
  it('SYSTEM_PROMPT и список RULES нашлись, нумерация 1–11 цела', () => {
    expect(SYS_START).toBeGreaterThan(-1);
    expect(rules.length).toBeGreaterThan(100);
    const missing = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter((n) => rule(n) === '');
    expect(missing).toEqual([]);
  });

  it('правило 9 больше не запрещает любые адреса', () => {
    expect(system).not.toContain('NEVER print URLs or filesystem paths in your response');
    expect(rule(9)).toMatch(/^9\. LINKS AND PATHS\./);
  });

  it('правило 9: пути файлов и внутренние адреса — по-прежнему нельзя', () => {
    for (const closed of ['/tmp/', '/files/', 'output directory', 'localhost', 'IP addresses', '/webhook/']) {
      expect(rule(9)).toContain(closed);
    }
    expect(rule(9)).toMatch(/any host of the platform other than my\.linkeon\.io/);
  });

  it('правило 9: можно разделы my.linkeon.io и страницы, открытые в этом ходе', () => {
    const r = rule(9);
    expect(r).toMatch(/https:\/\/my\.linkeon\.io\/\.\.\. exactly as/);
    expect(r).toMatch(/never make up a cabinet address/);
    expect(r).toMatch(/an external page you opened yourself in THIS turn/);
    expect(r).toMatch(/never a link you did not open in this turn/);
  });

  it('правило 9: картинки инструментов и найденные файлы — как раньше', () => {
    expect(rule(9)).toContain('MUST be embedded as ![](url)');
    expect(rule(9)).toContain('mcp__products__find_files');
  });

  it('«файлы прикреплены ниже» — только про файлы этого хода; старый — пересохранить', () => {
    const r = rule(9);
    expect(r).toMatch(/only files you saved to the output directory in THIS turn are attached/);
    expect(r).toContain('«файлы прикреплены ниже»');
    expect(r).toMatch(/save it to the output directory again in this turn instead of claiming it is attached/);
    expect(system).not.toMatch(/If the user asks "where are the files\?", answer "файлы прикреплены ниже"/);
  });

  it('правило 7 на месте: адреса созданных файлов не печатаются', () => {
    expect(rule(7)).toContain('DO NOT print absolute paths or URLs');
    expect(rule(9)).toContain('Rule 7 is about files you create');
  });

  it('ПРОВЕРКА ФАКТОВ: ссылка на открытую страницу и что на ней видно', () => {
    const f = flat(/ПРОВЕРКА ФАКТОВ:[^\n]+/.exec(system)?.[0] ?? '');
    expect(f).toMatch(/реестра, сайта, профиля в мессенджере/);
    expect(f).toMatch(/ссылкой на страницу, которую ты сам открыл в этом ходе/);
    expect(f).toMatch(/что именно на ней видно/);
    expect(f).toMatch(/совпадение неполное/);
    expect(f).toMatch(/не выдавай за проверенный/);
    expect(f).toMatch(/«Не нашёл» не значит «не существует»/);
    expect(f).toMatch(/как человеку проверить самому/);
  });

  it('ПРОВЕРКА ФАКТОВ — отдельным абзацем до RULES, не сбивая нумерацию', () => {
    const at = system.indexOf('\nПРОВЕРКА ФАКТОВ:');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(system.indexOf('\nRULES:\n'));
  });

  it('правило 4: картинка — под свой слайд, вопрос одной фразой, перечень в ответе', () => {
    const r = rule(4);
    expect(r).toContain('python-pptx');
    expect(r).toMatch(/ask ONE short question before building/);
    expect(r).toMatch(/for the content of ITS OWN slide/);
    expect(r).toMatch(/list what each picture shows/);
  });
});
