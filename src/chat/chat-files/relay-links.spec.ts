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
});

describe('replaceUrls', () => {
  it('меняет точные вхождения, не задевая более длинный адрес', () => {
    const text = `[1](${R}/a.pdf) и [2](${R}/a.pdf.zip) и ${R}/a.pdf`;
    const out = replaceUrls(text, new Map([[`${R}/a.pdf`, 'https://pub/x/a.pdf']]));
    expect(out).toBe(`[1](https://pub/x/a.pdf) и [2](${R}/a.pdf.zip) и https://pub/x/a.pdf`);
  });

  it('знак $ в новом адресе не портит подстановку', () => {
    expect(replaceUrls(`(${R}/a.pdf)`, new Map([[`${R}/a.pdf`, 'https://pub/$1/a.pdf']]))).toBe('(https://pub/$1/a.pdf)');
  });
});
