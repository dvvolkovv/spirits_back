import { TgRouterService } from './tg-router.service';

/**
 * Тулы Telegram-бота после lockdown (безопасность, 25.09.2026).
 *
 * Решение владельца: Bash/Write/Edit/Glob/Grep из ходов бота ВРЕМЕННО убраны —
 * они выполнялись под OS-пользователем API, владеющим ~/spirits_back/.env, и
 * присланный в чат контент мог довести модель до чтения секретов. До появления
 * настоящей изоляции sandbox бот получает только:
 *   • ДОСТУПНЫЙ набор (--tools): Read (когда есть рабочая папка/вложения) + веб;
 *   • АВТО-ОДОБРЕНИЕ (--allowedTools): только веб (Read внутри cwd в -p и так не
 *     спрашивает, наружу отклоняется).
 * Веб (WebSearch/WebFetch) — во всех режимах: без него бот отвечал по обучающим
 * данным и выдавал устаревшее за актуальное молча.
 */

const WEB = ['WebSearch', 'WebFetch'];
const AGENTIC = ['Bash', 'Write', 'Edit', 'Glob', 'Grep'];

function makeRouter() {
  const claudeCli = {
    textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: 'ответ', costUsd: 0.01 })),
  };
  const svc = new TgRouterService({} as any, null as any, null as any, null as any, claudeCli as any);
  jest.spyOn(svc as any, 'resolveSystemPrompt').mockResolvedValue({ systemPrompt: 'системный промпт' });
  jest.spyOn(svc as any, 'loadHistory').mockResolvedValue([{ role: 'user', content: 'привет' }]);
  return { svc, claudeCli };
}

const cfg: any = { id: 1, tg_chat_id: '-100123' };

/** --tools (ДОСТУПНЫЙ набор), с которым роутер позвал CLI. */
const availFrom = (c: any) => String(c.textWithCost.mock.calls[0][1].tools || '');
/** --allowedTools (АВТО-ОДОБРЕНИЕ). */
const allowedFrom = (c: any) => String(c.textWithCost.mock.calls[0][1].allowedTools || '');
const systemFrom = (c: any) => String(c.textWithCost.mock.calls[0][1].system || '');

describe('TgRouterService.generateReply: тулы после lockdown', () => {
  it('в обычном чате: доступны только веб-тулы, агентных нет', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий');

    const avail = availFrom(claudeCli);
    for (const t of WEB) expect(avail).toContain(t);
    expect(avail).not.toContain('Read'); // читать нечего — Read не выдаём
    for (const t of AGENTIC) expect(avail).not.toContain(t);
    // allowedTools — только веб.
    expect(allowedFrom(claudeCli).split(',').sort()).toEqual([...WEB].sort());
  });

  it('в sandbox-режиме: Read + веб в доступном наборе, но НИ ОДНОГО агентного тула', async () => {
    const { svc, claudeCli } = makeRouter();
    jest.spyOn(svc as any, 'listWorkspace').mockReturnValue([]);
    await svc.generateReply(cfg, 'Дмитрий', undefined, undefined, '/tmp/sandbox-1');

    const avail = availFrom(claudeCli);
    expect(avail).toContain('Read');
    for (const t of WEB) expect(avail).toContain(t);
    for (const t of AGENTIC) {
      expect(avail).not.toContain(t);
      expect(allowedFrom(claudeCli)).not.toContain(t);
    }
    // Автоодобряем только веб — не Read.
    expect(allowedFrom(claudeCli).split(',').sort()).toEqual([...WEB].sort());
  });

  it('с вложениями (без sandbox): Read доступен, чтобы CLI открыл присланные файлы', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий', ['/tmp/photo.jpg']);

    const avail = availFrom(claudeCli);
    expect(avail).toContain('Read');
    for (const t of WEB) expect(avail).toContain(t);
    for (const t of AGENTIC) expect(avail).not.toContain(t);
  });

  it('сообщает модели про веб в системном промпте', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий');
    expect(systemFrom(claudeCli)).toMatch(/интернет|поиск/i);
  });
});

describe('TgRouterService.generateReply: системный промпт без обещаний генерации файлов', () => {
  it('в sandbox-режиме промпт НЕ упоминает Bash/pip/Write, но перечисляет файлы папки', async () => {
    const { svc, claudeCli } = makeRouter();
    jest.spyOn(svc as any, 'listWorkspace').mockReturnValue(['dds.xlsx (16 КБ)']);
    await svc.generateReply(cfg, 'Дмитрий', undefined, undefined, '/tmp/sandbox-files');

    const system = systemFrom(claudeCli);
    // Никаких обещаний исполнять код/ставить пакеты/писать файлы.
    expect(system).not.toContain('Bash');
    expect(system).not.toContain('pip install');
    expect(system).not.toContain('Write');
    // Список файлов рабочей папки остаётся — это память чата.
    expect(system).toContain('dds.xlsx');
    // Явно сказано, что генерация файлов временно недоступна.
    expect(system).toMatch(/временно недоступн|временно отключен|сохранить новый файл временно нельзя/i);
  });

  it('медиа-маркеры (image/video/file) остаются — их обрабатывает бэкенд, не тулы', async () => {
    const { svc, claudeCli } = makeRouter();
    jest.spyOn(svc as any, 'listWorkspace').mockReturnValue([]);
    await svc.generateReply(cfg, 'Дмитрий', undefined, undefined, '/tmp/sandbox-markers');
    const system = systemFrom(claudeCli);
    expect(system).toContain('{{image:');
    expect(system).toContain('{{video:');
    expect(system).toContain('{{file:');
  });

  it('маркер картинки не называет снятую модель Imagen', async () => {
    // Google снял Imagen 4.0 Ultra 17.08.2026; {{image:}} идёт через
    // misc.generateImage, а там теперь Nano Banana — название из промпта
    // модель пересказала бы пользователю.
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий');
    expect(systemFrom(claudeCli)).not.toMatch(/Imagen/i);
  });

  it('запрет генерации — только про НОВЫЕ файлы: приложить готовую картинку/файл по адресу можно {{file:}} (ревью качества 02.11)', async () => {
    const { svc, claudeCli } = makeRouter();
    jest.spyOn(svc as any, 'listWorkspace').mockReturnValue([]);
    await svc.generateReply(cfg, 'Дмитрий', undefined, undefined, '/tmp/sandbox-markers-2');
    const system = systemFrom(claudeCli);
    expect(system).toContain('можно приложить маркером {{file:');
  });
});

describe('TgRouterService.generateReply: картинка из сети (находка bfc4c3ad)', () => {
  it('правило: прислать саму картинку маркером file, а не одни ссылки', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий');
    const system = systemFrom(claudeCli);
    expect(system).toContain('ПОКАЗАТЬ КАРТИНКУ ИЗ СЕТИ');
    expect(system).toContain('{{file: url=<прямой адрес изображения>');
    expect(system).toContain('не одни ссылки');
    // Схема мест в зале — это план помещения, не любой «план» вообще.
    expect(system).toContain('план помещения или этажа');
  });

  it('адрес — полный https://, относительный путь со страницы — доменом ЭТОЙ страницы (ревью качества 02.11)', async () => {
    // own-media.ts toAbsoluteUrl достраивает относительный путь НАШИМ доменом —
    // соблазн модели дать относительный путь со страницы-источника бил бы по
    // нашему же SPA, а не по странице с картинкой.
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий');
    const system = systemFrom(claudeCli);
    expect(system).toContain('Адрес — полный, начиная с https://');
    expect(system).toContain('дополни ДОМЕНОМ ЭТОЙ СТРАНИЦЫ');
  });

  it('ссылка на страницу картинки (Викисклад File:…) — не адрес самой картинки; не нашёл — не угадывать', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий');
    const system = systemFrom(claudeCli);
    expect(system).toContain('это не адрес самой картинки');
    expect(system).toContain('адрес не угадывай');
    expect(system).toContain('ссылка на страницу-источник');
  });

  it('перевод надписей — image_edit, только по просьбе, с оговоркой и предупреждением про платность', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий');
    const system = systemFrom(claudeCli);
    expect(system).toContain('только по просьбе');
    expect(system).toContain('перерисованы нейросетью');
    expect(system).toContain('правка картинки платная');
  });

  it('source у image_edit — и адрес картинки из сети', async () => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий');
    expect(systemFrom(claudeCli)).toContain('или адрес изображения, найденного в сети');
  });
});
