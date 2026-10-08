import { ExtractedFile, extractChatFiles, kindByExt } from './extract';

const ENV = {
  publicBaseUrl: 'https://my.linkeon.io/smm-media',
  agentUrl: 'https://r.linkeon.io',
  backendUrl: 'https://my.linkeon.io',
};
const MINIO = 'https://my.linkeon.io/smm-media';
const RELAY = 'https://r.linkeon.io/files/u1_12_ru';
const VID = '11111111-2222-4333-8444-555555555555';
const AUD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CHAT_FILE = `${MINIO}/linkeon-chat-files/0f8e6a1c-1111-4222-8333-444455556666/report.pdf`;

const x = (content: string) => extractChatFiles(content, ENV);
const pick = (f: ExtractedFile) => ({ kind: f.kind, name: f.name, stored: f.stored, url: f.url, refId: f.refId });

describe('extractChatFiles — что считается файлом', () => {
  it('картинка markdown-ом из нашего MinIO', () => {
    const url = `${MINIO}/linkeon-assets/images/1700000000000-abc123.png`;
    expect(x(`Готово:\n\n![](${url})`).map(pick)).toEqual([
      { kind: 'image', name: '1700000000000-abc123.png', stored: true, url, refId: undefined },
    ]);
  });

  it('голый адрес картинки — как его рисует чат', () => {
    const url = `${MINIO}/linkeon-assets/images/1.webp`;
    expect(x(`Вот:\n\n${url}\n\n`).map((f) => f.kind)).toEqual(['image']);
  });

  it('метафорическая карта с чужого хоста — тоже картинка', () => {
    expect(x('![Метафорическая карта](https://images.linkeon.io/cards/card-3.jpg)').map(pick)).toEqual([
      { kind: 'image', name: 'card-3.jpg', stored: true, url: 'https://images.linkeon.io/cards/card-3.jpg', refId: undefined },
    ]);
  });

  it('ссылка на релей — документ, не сохранился; пробел в имени не мешает', () => {
    expect(x(`[Скачать Договор аренды.docx](${RELAY}/Договор аренды.docx)`).map(pick)).toEqual([
      { kind: 'document', name: 'Договор аренды.docx', stored: false, url: `${RELAY}/Договор аренды.docx`, refId: undefined },
    ]);
  });

  it('парные скобки в имени файла на релее не обрезают адрес', () => {
    expect(x(`[Скачать Договор (1).docx](${RELAY}/Договор (1).docx)`).map((f) => f.name)).toEqual(['Договор (1).docx']);
  });

  it('ссылка на сохранённый файл переписки', () => {
    expect(x(`[Скачать report.pdf](${CHAT_FILE})`).map(pick)).toEqual([
      { kind: 'document', name: 'report.pdf', stored: true, url: CHAT_FILE, refId: undefined },
    ]);
  });

  it('документ звонка называется по заголовку ответа', () => {
    const url = `${MINIO}/linkeon-assets/documents/u1/d1.md`;
    const text = `## План на неделю\n\nКоротко о главном.\n\n[Открыть документ полностью](${url})`;
    expect(x(text).map((f) => f.name)).toEqual(['План на неделю.md']);
    expect(x(`[Открыть документ полностью](${url})`).map((f) => f.name)).toEqual(['d1.md']);
  });

  it('маркеры видео и озвучки', () => {
    expect(x(`Ролик готов.\n\n[VIDEO_JOB:${VID}]\n\n{{audio:id=${AUD}}}`).map(pick)).toEqual([
      { kind: 'video', name: 'video-11111111.mp4', stored: true, url: undefined, refId: VID },
      { kind: 'audio', name: 'linkeon-speech-aaaaaaaa.mp3', stored: true, url: undefined, refId: AUD },
    ]);
  });

  it('голый адрес ролика', () => {
    expect(x('https://my.linkeon.io/static/videos/abc.mp4').map((f) => f.kind)).toEqual(['video']);
  });

  it('голая картинка на релее — картинка, не сохранилась', () => {
    expect(x(`${RELAY}/chart.png`).map(pick)).toEqual([
      { kind: 'image', name: 'chart.png', stored: false, url: `${RELAY}/chart.png`, refId: undefined },
    ]);
  });

  it('старая картинка из /static/', () => {
    expect(x('https://my.linkeon.io/static/generated/x.png').map((f) => [f.kind, f.stored])).toEqual([['image', true]]);
  });
});

describe('extractChatFiles — что файлом не считается', () => {
  it('код — это текст, а не ссылки', () => {
    expect(x('```\n![x](https://a.example/b.png)\n```\nи `https://a.example/c.png`')).toEqual([]);
  });

  it('ссылки на сайты и чужие файлы', () => {
    expect(x('[Википедия](https://ru.wikipedia.org/wiki/Тест) и [PDF](https://example.com/a.pdf)')).toEqual([]);
  });

  it('ссылки на наши страницы без расширения', () => {
    expect(x('[Пополнить баланс](/chat?view=tokens) и [Профиль](https://my.linkeon.io/profile)')).toEqual([]);
  });

  it('карточки встреч и календаря', () => {
    expect(x(`{{meeting_join: code=ABC234 title=Встреча}}\n[CALENDAR_PROPOSAL:${VID}]`)).toEqual([]);
  });
});

describe('extractChatFiles — порядок и повторы', () => {
  it('один адрес дважды — один файл', () => {
    const url = `${MINIO}/linkeon-assets/images/1.png`;
    expect(x(`![](${url})\n\n${url}`)).toHaveLength(1);
  });

  it('в порядке появления в ответе, соседние ссылки не теряются', () => {
    const a = `${MINIO}/x/a.pdf`;
    const b = `${MINIO}/x/b.pdf`;
    expect(x(`[a](${a})[b](${b}) ![](${MINIO}/x/c.png)`).map((f) => f.name)).toEqual(['a.pdf', 'b.pdf', 'c.png']);
  });
});

describe('kindByExt', () => {
  it.each([
    ['png', 'image'], ['svg', 'image'], ['mp4', 'video'], ['mov', 'video'],
    ['mp3', 'audio'], ['m4a', 'audio'], ['pdf', 'document'], ['zip', 'document'], ['', 'document'],
  ])('%s → %s', (ext, kind) => expect(kindByExt(ext)).toBe(kind));
});
