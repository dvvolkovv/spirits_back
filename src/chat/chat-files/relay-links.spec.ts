// src/chat/chat-files/relay-links.spec.ts
import {
  RelayOutputFile,
  collectOutputFiles,
  collectRelayUrls,
  outputFileLines,
  replaceUrls,
  storeRelayLinks,
} from './relay-links';

const AGENT = 'https://r.linkeon.io';
const R = `${AGENT}/files/u1_12_ru`;

describe('collectOutputFiles / outputFileLines', () => {
  it('собирает файлы из done.outputFiles без повторов и строит строки ссылок', () => {
    const into: RelayOutputFile[] = [];
    collectOutputFiles(into, [{ name: 'a.pdf', url: '/files/u1_12_ru/a.pdf', size: 1 }, { name: 'a.pdf', url: '/files/u1_12_ru/a.pdf' }]);
    collectOutputFiles(into, [{ name: 'b.png', url: '/files/u1_12_ru/b.png' }, null, { name: 'x' }]);
    collectOutputFiles(into, undefined);

    expect(into).toEqual([
      { name: 'a.pdf', url: '/files/u1_12_ru/a.pdf' },
      { name: 'b.png', url: '/files/u1_12_ru/b.png' },
    ]);
    expect(outputFileLines(into, AGENT)).toEqual([`[Скачать a.pdf](${R}/a.pdf)`, `[Скачать b.png](${R}/b.png)`]);
  });
});

describe('storeRelayLinks', () => {
  const okStore = (to = (u: string) => u.replace(`${AGENT}/files/u1_12_ru`, 'https://pub/linkeon-chat-files/id')) => ({
    persist: jest.fn(async (urls: string[]) => new Map(urls.map((u) => [u, to(u)]))),
  });

  it('подменяет адрес релея нашим, текст ссылки не трогает', async () => {
    const store = okStore();
    const out = await storeRelayLinks([`[Скачать a b.pdf](${R}/a b.pdf)`], AGENT, store);
    expect(store.persist).toHaveBeenCalledWith([`${R}/a b.pdf`]);
    expect(out).toEqual(['[Скачать a b.pdf](https://pub/linkeon-chat-files/id/a b.pdf)']);
  });

  it('файл, который не скопировался, остаётся ссылкой на релей', async () => {
    const store = { persist: jest.fn(async () => new Map<string, string>()) };
    const lines = [`[Скачать a.pdf](${R}/a.pdf)`];
    expect(await storeRelayLinks(lines, AGENT, store)).toEqual(lines);
  });

  it('без хранилища — строки как были и предупреждение в лог', async () => {
    const warn = jest.fn();
    const lines = [`[Скачать a.pdf](${R}/a.pdf)`];
    expect(await storeRelayLinks(lines, AGENT, undefined, warn)).toEqual(lines);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('хранилище не подключено'));
  });

  it('хранилище бросило — строки как были', async () => {
    const warn = jest.fn();
    const store = { persist: jest.fn(async () => { throw new Error('boom'); }) };
    const lines = [`[Скачать a.pdf](${R}/a.pdf)`];
    expect(await storeRelayLinks(lines, AGENT, store, warn)).toEqual(lines);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('файл без имени тоже переносится', async () => {
    const store = okStore();
    const out = await storeRelayLinks([`[Скачать ](${R}/x)`], AGENT, store);
    expect(store.persist).toHaveBeenCalledWith([`${R}/x`]);
    expect(out).toEqual(['[Скачать ](https://pub/linkeon-chat-files/id/x)']);
  });

  it('agentUrl со слэшем на конце: строки без двойного слэша, ссылки переносятся', async () => {
    const lines = outputFileLines([{ name: 'a.pdf', url: '/files/u1_12_ru/a.pdf' }], `${AGENT}/`);
    expect(lines).toEqual([`[Скачать a.pdf](${R}/a.pdf)`]);
    const store = okStore();
    expect(await storeRelayLinks(lines, `${AGENT}/`, store)).toEqual([
      '[Скачать a.pdf](https://pub/linkeon-chat-files/id/a.pdf)',
    ]);
  });

  it('строки без адреса релея не трогает и хранилище не зовёт', async () => {
    const store = okStore();
    const lines = ['[Скачать x.pdf](https://example.com/x.pdf)', 'просто текст'];
    expect(await storeRelayLinks(lines, AGENT, store)).toEqual(lines);
    expect(store.persist).not.toHaveBeenCalled();
  });
});

describe('collectRelayUrls', () => {
  it('цели ссылок, в том числе с пробелом в имени, и голые адреса', () => {
    const text = [
      `[Скачать a b.pdf](${R}/a b.pdf)`,
      `Вот: ${R}/c.docx и ещё \`${R}/d.txt\``,
      `[чужой](https://example.com/files/x.pdf)`,
      `[Скачать a b.pdf](${R}/a b.pdf)`,
    ].join('\n');
    expect(collectRelayUrls(text, AGENT).sort()).toEqual([`${R}/a b.pdf`, `${R}/c.docx`, `${R}/d.txt`].sort());
  });

  it('строки бэка со скобками в имени — адрес целиком, а не до первой «)»', () => {
    const text = [
      'Готово.',
      '',
      `[Скачать Договор (1).docx](${R}/Договор (1).docx)`,
      `[Скачать 1) План.docx](${R}/1) План.docx)`,
    ].join('\n');
    expect(collectRelayUrls(text, AGENT).sort()).toEqual([`${R}/1) План.docx`, `${R}/Договор (1).docx`].sort());
  });

  it('ссылка внутри текста: парные скобки в адресе, заголовок ссылки — не часть адреса', () => {
    const text = `Вот договор: [скачать](${R}/Договор (2).docx), а вот [отчёт](${R}/a.pdf "Отчёт за май").`;
    expect(collectRelayUrls(text, AGENT).sort()).toEqual([`${R}/a.pdf`, `${R}/Договор (2).docx`].sort());
  });

  it('голый адрес: точка, «ёлочка», многоточие после него — не часть адреса', () => {
    const text = `Файл: ${R}/c.docx. И ещё «${R}/d.pdf»; и ${R}/e.txt…`;
    expect(collectRelayUrls(text, AGENT).sort()).toEqual([`${R}/c.docx`, `${R}/d.pdf`, `${R}/e.txt`].sort());
  });

  it('адрес, который лишь начало другого, но стоит в другом месте текста, — отдельный файл', () => {
    const text = `[архив](${R}/a.pdf.zip) и [файл](${R}/a.pdf)\nголые: ${R}/b.pdf.zip и ${R}/b.pdf`;
    expect(collectRelayUrls(text, AGENT).sort()).toEqual(
      [`${R}/a.pdf`, `${R}/a.pdf.zip`, `${R}/b.pdf`, `${R}/b.pdf.zip`].sort(),
    );
  });

  // Модель пишет строки того же вида, что и бэк, но дописывает после ссылки своё.
  it.each([
    ['пояснение в скобках', `[Скачать отчёт](${R}/report.pdf) (PDF, 2 стр.)`, [`${R}/report.pdf`]],
    ['смайлик', `[Скачать отчёт](${R}/report.pdf) :)`, [`${R}/report.pdf`]],
    ['заголовок ссылки', `[Скачать a.pdf](${R}/a.pdf "Отчёт")`, [`${R}/a.pdf`]],
    [
      'две ссылки в строке и хвост',
      `[Скачать a.pdf](${R}/a.pdf) и [Скачать b.pdf](${R}/b.pdf) (новая версия)`,
      [`${R}/a.pdf`, `${R}/b.pdf`],
    ],
    [
      'хвост кончается на «/имя)»',
      `[Скачать отчёт.pdf](${R}/отчёт.pdf) (копия: ${R}/old/отчёт.pdf)`,
      [`${R}/old/отчёт.pdf`, `${R}/отчёт.pdf`],
    ],
  ])('строка «Скачать» от модели, %s: хвост не становится частью адреса', (_why, text, urls) => {
    expect(collectRelayUrls(text, AGENT).sort()).toEqual([...urls].sort());
  });

  it('собственные строки бэка по-прежнему берутся целиком', () => {
    const text = [
      // outputFiles: имя — путь от папки хода, со скобками и подпапкой.
      `[Скачать sub/x (2).pdf](${R}/sub/x (2).pdf)`,
      `[Скачать Договор (1).docx](${R}/Договор (1).docx)`,
      `[Скачать 1) План.docx](${R}/1) План.docx)`,
      // Форма 2 resolveEmptyFileLinks: адрес закодирован, имя — раскодированный хвост.
      `[Скачать a b.pdf](${R}/a%20b.pdf)`,
      `[Скачать Отчёт (итог).pdf](${R}/%D0%9E%D1%82%D1%87%D1%91%D1%82%20%28%D0%B8%D1%82%D0%BE%D0%B3%29.pdf)`,
      // Имя пустое: collectOutputFiles подставляет '' вместо отсутствующего.
      `[Скачать ](${R}/2) Итог.docx)`,
    ].join('\n');
    expect(collectRelayUrls(text, AGENT).sort()).toEqual(
      [
        `${R}/sub/x (2).pdf`,
        `${R}/Договор (1).docx`,
        `${R}/1) План.docx`,
        `${R}/a%20b.pdf`,
        `${R}/%D0%9E%D1%82%D1%87%D1%91%D1%82%20%28%D0%B8%D1%82%D0%BE%D0%B3%29.pdf`,
        `${R}/2) Итог.docx`,
      ].sort(),
    );
  });
});

describe('collectRelayUrls: строка в 50 тысяч символов разбирается быстро', () => {
  const N = 50_000;
  it.each([
    ['«](», пробелы, «x)»', '](' + ' '.repeat(N) + 'x)'],
    ['цель ссылки с пробелами внутри', '](x' + ' '.repeat(N) + 'y)'],
    ['цель ссылки — адрес релея с пробелами внутри', `](${R}/a` + ' '.repeat(N) + 'b)'],
    ['голый адрес релея из точек', `${R}/` + '.'.repeat(N) + 'a'],
    ['строка «Скачать» без закрывающей скобки', '[Скачать ' + '](x'.repeat(Math.floor(N / 3))],
  ])('%s — меньше 200 мс', (_why, text) => {
    const t0 = Date.now();
    collectRelayUrls(text, AGENT);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('строка «Скачать» длиннее 2000 символов: первый проход её не берёт, адрес находит второй', () => {
    const name = 'а'.repeat(1200) + '.pdf';
    expect(collectRelayUrls(`[Скачать ${name}](${R}/${name})`, AGENT)).toEqual([`${R}/${name}`]);
  });

  it('заголовок ссылки в одинарных кавычках и с несколькими пробелами перед ним — не часть адреса', () => {
    expect(collectRelayUrls(`см. [отчёт](${R}/a.pdf   'Отчёт за май')`, AGENT)).toEqual([`${R}/a.pdf`]);
  });
});

describe('бэкфилл: collectRelayUrls → replaceUrls', () => {
  it('скобки, заголовок ссылки и пунктуация: каждый адрес находится и подставляется на своё место', () => {
    const text = [
      `[Скачать 1) План.docx](${R}/1) План.docx)`,
      `[Скачать Договор (1).docx](${R}/Договор (1).docx)`,
      `Ещё [отчёт](${R}/a.pdf "Отчёт") и ${R}/c.docx.`,
    ].join('\n');
    // Копируются только настоящие файлы: обрезок адреса на релее — это 404.
    const onRelay = new Map([
      [`${R}/1) План.docx`, 'https://pub/b/plan'],
      [`${R}/Договор (1).docx`, 'https://pub/b/dogovor'],
      [`${R}/a.pdf`, 'https://pub/b/a'],
      [`${R}/c.docx`, 'https://pub/b/c'],
    ]);
    const stored = new Map(
      collectRelayUrls(text, AGENT)
        .filter((u) => onRelay.has(u))
        .map((u) => [u, onRelay.get(u)] as [string, string]),
    );
    expect(replaceUrls(text, stored)).toBe(
      [
        '[Скачать 1) План.docx](https://pub/b/plan)',
        '[Скачать Договор (1).docx](https://pub/b/dogovor)',
        'Ещё [отчёт](https://pub/b/a "Отчёт") и https://pub/b/c.',
      ].join('\n'),
    );
  });
});

describe('replaceUrls', () => {
  it('меняет точные вхождения, не задевая более длинный адрес', () => {
    const text = `[1](${R}/a.pdf) и [2](${R}/a.pdf.zip) и ${R}/a.pdf`;
    const out = replaceUrls(text, new Map([[`${R}/a.pdf`, 'https://pub/x/a.pdf']]));
    expect(out).toBe(`[1](https://pub/x/a.pdf) и [2](${R}/a.pdf.zip) и https://pub/x/a.pdf`);
  });

  it('адрес с точкой или «ёлочкой» после него меняется, более длинный — нет', () => {
    const text = `Файл: ${R}/c.docx. И «${R}/c.docx»; и ${R}/c.docx.zip`;
    const out = replaceUrls(text, new Map([[`${R}/c.docx`, 'https://pub/x/c.docx']]));
    expect(out).toBe(`Файл: https://pub/x/c.docx. И «https://pub/x/c.docx»; и ${R}/c.docx.zip`);
  });

  it('знак $ в новом адресе не портит подстановку', () => {
    expect(replaceUrls(`(${R}/a.pdf)`, new Map([[`${R}/a.pdf`, 'https://pub/$1/a.pdf']]))).toBe('(https://pub/$1/a.pdf)');
  });
});
