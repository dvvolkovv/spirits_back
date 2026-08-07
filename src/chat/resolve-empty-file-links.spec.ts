import { resolveEmptyFileLinks, SessionFile } from './chat.service';

const AGENT = 'https://r.linkeon.io';

const files: SessionFile[] = [
  { name: 'film-chernovaya-sborka.mp4', url: '/files/79030169187_12/film-chernovaya-sborka.mp4' },
  { name: 'montazhnyy-list.csv', url: '/files/79030169187_12/montazhnyy-list.csv' },
  { name: 'film-step3-registry.pdf', url: '/files/79030169187_12/film-step3-registry.pdf' },
];

describe('resolveEmptyFileLinks', () => {
  it('достраивает пустую ссылку, которую оставил ассистент', () => {
    // Ровно то, что видел пользователь: скобки пустые, файл на диске есть.
    const out = resolveEmptyFileLinks('Готово. [Скачать film-chernovaya-sborka.mp4]()', files, AGENT);
    expect(out).toEqual([
      '[Скачать film-chernovaya-sborka.mp4](https://r.linkeon.io/files/79030169187_12/film-chernovaya-sborka.mp4)',
    ]);
  });

  it('понимает метку без слова «Скачать»', () => {
    const out = resolveEmptyFileLinks('Смотри [montazhnyy-list.csv]()', files, AGENT);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('/montazhnyy-list.csv');
  });

  it('несколько файлов за один ответ', () => {
    const text = '[Скачать montazhnyy-list.csv]()\n[Скачать film-step3-registry.pdf]()';
    expect(resolveEmptyFileLinks(text, files, AGENT)).toHaveLength(2);
  });

  it('один и тот же файл не дублируется', () => {
    const text = '[Скачать montazhnyy-list.csv]() и ещё раз [montazhnyy-list.csv]()';
    expect(resolveEmptyFileLinks(text, files, AGENT)).toHaveLength(1);
  });

  // Регрессия, которая уже случилась в бою: полный список файлов сессии
  // цеплялся к КАЖДОМУ ответу. Сессия живёт неделями — там десятки файлов,
  // и обычная реплика обрастала ссылками. Пришлось откатывать на проде.
  it('обычный ответ без пустых ссылок не получает НИЧЕГО', () => {
    expect(resolveEmptyFileLinks('Да, всё верно.', files, AGENT)).toEqual([]);
    expect(resolveEmptyFileLinks('', files, AGENT)).toEqual([]);
  });

  it('заполненные ссылки не трогаем — там уже есть адрес', () => {
    const text = '[Скачать montazhnyy-list.csv](https://r.linkeon.io/files/x/y.csv)';
    expect(resolveEmptyFileLinks(text, files, AGENT)).toEqual([]);
  });

  it('упомянут файл, которого в сессии нет — ссылку не выдумываем', () => {
    expect(resolveEmptyFileLinks('[Скачать otchet-za-mart.xlsx]()', files, AGENT)).toEqual([]);
  });

  it('пустой список файлов не роняет и ничего не возвращает', () => {
    expect(resolveEmptyFileLinks('[Скачать a.pdf]()', [], AGENT)).toEqual([]);
    expect(resolveEmptyFileLinks('[Скачать a.pdf]()', undefined as any, AGENT)).toEqual([]);
  });

  it('битые записи в списке пропускаются', () => {
    const broken = [{ name: 'x.pdf' } as any, { url: '/files/s/y.pdf' } as any, ...files];
    const out = resolveEmptyFileLinks('[Скачать montazhnyy-list.csv]()', broken, AGENT);
    expect(out).toHaveLength(1);
  });

  // Метка может быть с пробелами внутри скобок — регулярка не должна
  // принимать её за уже заполненную ссылку.
  it('скобки с пробелами считаются пустыми', () => {
    const out = resolveEmptyFileLinks('[Скачать montazhnyy-list.csv](   )', files, AGENT);
    expect(out).toHaveLength(1);
  });

  // Реальный случай из чата: ассистент положил адрес в блок кода и написал
  // «скопируй строку». Внутри ``` разметка не работает — кликнуть нельзя,
  // и человек говорит «ссылки нет», хотя адрес перед глазами.
  it('адрес в блоке кода превращается в кликабельную ссылку', () => {
    const text = [
      'Итог — версия 3:',
      '```',
      'https://r.linkeon.io/files/79030169187_12/film-chernovaya-sborka-v3.mp4',
      '```',
      'Дальше нужен твой глаз.',
    ].join('\n');
    const out = resolveEmptyFileLinks(text, files, AGENT);
    expect(out).toEqual([
      '[Скачать film-chernovaya-sborka-v3.mp4](https://r.linkeon.io/files/79030169187_12/film-chernovaya-sborka-v3.mp4)',
    ]);
  });

  it('адреса нет в списке сессии — всё равно оформляем: он уже проверен ассистентом', () => {
    // Список нужен только для пустых скобок; готовый адрес самодостаточен.
    const text = 'https://r.linkeon.io/files/sid/otchet.pdf';
    expect(resolveEmptyFileLinks(text, [], AGENT)).toHaveLength(1);
  });

  it('уже кликабельная ссылка не дублируется', () => {
    const text = '[Скачать v3](https://r.linkeon.io/files/79030169187_12/film-chernovaya-sborka-v3.mp4)';
    expect(resolveEmptyFileLinks(text, files, AGENT)).toEqual([]);
  });

  it('один адрес, упомянутый дважды, даёт одну ссылку', () => {
    const text = 'вот: https://r.linkeon.io/files/s/a.mp4 и ещё раз https://r.linkeon.io/files/s/a.mp4';
    expect(resolveEmptyFileLinks(text, files, AGENT)).toHaveLength(1);
  });

  it('пустые скобки и адрес на ОДИН файл не дают двух ссылок', () => {
    const text = '[Скачать montazhnyy-list.csv]() https://r.linkeon.io/files/79030169187_12/montazhnyy-list.csv';
    expect(resolveEmptyFileLinks(text, files, AGENT)).toHaveLength(1);
  });

  it('чужие адреса не трогаем', () => {
    const text = 'Смотри https://example.com/files/secret.pdf и https://my.linkeon.io/chat';
    expect(resolveEmptyFileLinks(text, files, AGENT)).toEqual([]);
  });

  it('текст без единого адреса и скобок не даёт ничего', () => {
    expect(resolveEmptyFileLinks('Правлю кадры, скоро покажу.', files, AGENT)).toEqual([]);
  });
});
