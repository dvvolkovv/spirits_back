import { chat } from './articles/chat';
import { renderArticle } from './render';
import { KB_CLIENTS } from './kb.types';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

/**
 * Справка о чате после «Памяти загрузок» (spec 2026-11-16-chat-uploads-media-notes):
 * загрузки человека видны в «Медиа и файлы», ассистент оставляет к ним
 * комментарий и находит файл по нему, человек удаляет свою загрузку сам.
 */
describe('статья «Чат»: загрузки пользователя', () => {
  const web = renderArticle(chat, 'ru', 'web');

  it('старой фразы «Загруженное человеком туда не попадает» нет', () => {
    expect(web).not.toContain('Загруженное человеком туда не попадает');
  });

  it('в панели — и созданное ассистентом, и загруженное человеком', () => {
    expect(web).toContain('созданные ассистентом и загруженные человеком');
  });

  it('ассистент оставляет комментарий к загрузке и находит файл по нему в любом чате', () => {
    expect(web).toContain('ассистент оставляет комментарий');
    expect(web).toContain('находит файл в любом чате');
  });

  it('свою загрузку человек удаляет сам, после этого ассистенты её не откроют', () => {
    expect(web).toContain('Свою загрузку человек удаляет там же');
    expect(web).toContain('ассистенты её больше не откроют');
  });

  it('во всех языках и клиентах статья не длиннее 5 КБ', () => {
    const big: string[] = [];
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const client of KB_CLIENTS) {
        const bytes = Buffer.byteLength(renderArticle(chat, lang, client), 'utf8');
        if (bytes > 5 * 1024) big.push(`${lang}/${client}: ${bytes}`);
      }
    }
    expect(big).toEqual([]);
  });
});
