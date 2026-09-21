import { canTransition, rowToPost } from './blog.types';

describe('canTransition', () => {
  it('idea → drafting разрешён', () => {
    expect(canTransition('idea', 'drafting')).toBe(true);
  });

  it('pending_review → drafting разрешён (кнопка «переписать»)', () => {
    expect(canTransition('pending_review', 'drafting')).toBe(true);
  });

  it('approved → publishing → published — рабочий путь публикации', () => {
    expect(canTransition('approved', 'publishing')).toBe(true);
    expect(canTransition('publishing', 'published')).toBe(true);
  });

  it('publishing → approved разрешён: возврат на повторную попытку отправки', () => {
    expect(canTransition('publishing', 'approved')).toBe(true);
  });

  it('в approved нельзя попасть из drafting или failed — только человек одобряет', () => {
    expect(canTransition('drafting', 'approved')).toBe(false);
    expect(canTransition('failed', 'approved')).toBe(false);
    expect(canTransition('idea', 'approved')).toBe(false);
  });

  it('idea → published запрещён: пост не может выйти минуя апрув', () => {
    expect(canTransition('idea', 'published')).toBe(false);
  });

  it('published — терминальный статус, из него никуда', () => {
    expect(canTransition('published', 'drafting')).toBe(false);
    expect(canTransition('published', 'approved')).toBe(false);
  });

  it('rejected — терминальный статус', () => {
    expect(canTransition('rejected', 'drafting')).toBe(false);
  });

  // Перезапуск черновика — это переход drafting → drafting: и кнопка
  // «Переписать», и подбор осиротевшего черновика кроном приходят именно
  // сюда. Петля ничего не продвигает и апрув не обходит.
  it('drafting → drafting разрешён: перезапуск черновика', () => {
    expect(canTransition('drafting', 'drafting')).toBe(true);
  });

  it('петля на drafting не открывает дорогу мимо апрува', () => {
    expect(canTransition('drafting', 'approved')).toBe(false);
    expect(canTransition('drafting', 'published')).toBe(false);
  });

  it('failed → drafting разрешён: отказ можно перезапустить руками', () => {
    expect(canTransition('failed', 'drafting')).toBe(true);
  });
});

describe('rowToPost', () => {
  it('переводит snake_case строку БД в camelCase объект', () => {
    const post = rowToPost({
      id: 'abc', rubric: 'case', source: 'stats', source_ref: null,
      topic_key: 'arenda', topic_hint: 'про аренду', lang: 'ru',
      title: 'Заголовок', body: 'Текст', image_prompt: 'сцена', image_url: null,
      status: 'pending_review', slot_at: null, published_at: null,
      review_chat_id: '77', review_message_id: '12',
      tg_message_id: null, tg_url: null, attempts: 0, last_error: null,
      created_at: '2026-09-21T10:00:00Z', updated_at: '2026-09-21T10:00:00Z',
    });
    expect(post.topicKey).toBe('arenda');
    expect(post.reviewMessageId).toBe(12);
    expect(post.tgMessageId).toBeNull();
  });
});
