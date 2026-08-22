import { TgRouterService } from './tg-router.service';

/**
 * Доступ бота в интернет.
 *
 * claude-cli.service трактует allowedTools=undefined как «built-in тулы
 * выключены полностью» (или только Read, если есть вложения). Поэтому бот
 * отвечал исключительно по обучающим данным и уверенно выдавал устаревшее за
 * актуальное — молча, без единой ошибки в логе.
 *
 * Тул нужен во всех режимах, а не только в sandbox: вопрос «что там сейчас с X»
 * приходит в обычном чате, где никакой песочницы нет.
 */

const WEB = ['WebSearch', 'WebFetch'];

function makeRouter() {
  // Аргументы в сигнатуре мока обязательны: без них jest выводит тип calls как
  // пустой кортеж, и обращение к calls[0][1] не компилируется.
  const claudeCli = {
    textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: 'ответ', costUsd: 0.01 })),
  };
  const svc = new TgRouterService({} as any, null as any, null as any, null as any, claudeCli as any);
  jest.spyOn(svc as any, 'resolveSystemPrompt').mockResolvedValue({ systemPrompt: 'системный промпт' });
  jest.spyOn(svc as any, 'loadHistory').mockResolvedValue([{ role: 'user', content: 'привет' }]);
  return { svc, claudeCli };
}

const cfg: any = { id: 1, tg_chat_id: '-100123' };

/** Значение --allowedTools, с которым роутер позвал CLI. */
const toolsFrom = (claudeCli: any) => String(claudeCli.textWithCost.mock.calls[0][1].allowedTools || '');

describe('TgRouterService.generateReply: веб-инструменты', () => {
  it('в обычном чате даёт WebSearch и WebFetch', async () => {
    const { svc, claudeCli } = makeRouter();

    await svc.generateReply(cfg, 'Дмитрий');

    const tools = toolsFrom(claudeCli);
    for (const t of WEB) expect(tools).toContain(t);
  });

  it('в sandbox-режиме веб добавляется к агентным тулам, не вытесняя их', async () => {
    const { svc, claudeCli } = makeRouter();

    await svc.generateReply(cfg, 'Дмитрий', undefined, undefined, '/tmp/sandbox-1');

    const tools = toolsFrom(claudeCli);
    for (const t of [...WEB, 'Bash', 'Write', 'Read']) expect(tools).toContain(t);
  });

  it('с вложениями сохраняет Read — иначе CLI не откроет присланные файлы', async () => {
    // Раньше Read подставлялся дефолтом внутри claude-cli.service именно для
    // этого случая. Передавая allowedTools явно, мы этот дефолт отключаем, и
    // потерять Read здесь — значит сломать чтение вложений.
    const { svc, claudeCli } = makeRouter();

    await svc.generateReply(cfg, 'Дмитрий', ['/tmp/photo.jpg']);

    const tools = toolsFrom(claudeCli);
    expect(tools).toContain('Read');
    for (const t of WEB) expect(tools).toContain(t);
  });

  it('сообщает модели про веб в системном промпте', async () => {
    // Без строки в ВОЗМОЖНОСТИ модель склонна отвечать по памяти и не проверять.
    const { svc, claudeCli } = makeRouter();

    await svc.generateReply(cfg, 'Дмитрий');

    expect(String(claudeCli.textWithCost.mock.calls[0][1].system)).toMatch(/интернет|поиск/i);
  });
});
