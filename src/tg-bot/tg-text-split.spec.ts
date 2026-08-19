import { TELEGRAM_TEXT_LIMIT, splitForTelegram } from './tg-text-split';
import { TgGrammyClient } from './tg-grammy.client';

/**
 * Ответ длиннее 4096 символов Telegram не принимает: sendMessage отдаёт
 * 400 «message is too long». В tg-bot.service ошибка улетала из
 * handleGroupMessage вверх, до persistAssistantReply и списания дело не
 * доходило — ответ терялся целиком, юзер получал молчание (инцидент
 * 19.08.2026, чат -5383010540; в error-логе 12 таких падений).
 */

describe('splitForTelegram', () => {
  it('короткий текст отдаёт одним куском', () => {
    expect(splitForTelegram('привет')).toEqual(['привет']);
  });

  it('не режет текст ровно на границе лимита', () => {
    const text = 'a'.repeat(TELEGRAM_TEXT_LIMIT);
    expect(splitForTelegram(text)).toHaveLength(1);
  });

  it('режет длинный текст на куски в пределах лимита', () => {
    const chunks = splitForTelegram('a'.repeat(TELEGRAM_TEXT_LIMIT * 2 + 100));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  });

  it('не теряет содержимое: рвётся только пробельный разделитель', () => {
    const para = 'Пункт договора с длинным текстом. '.repeat(50);
    const text = Array.from({ length: 20 }, (_, i) => `${i}. ${para}`).join('\n\n');

    const joined = splitForTelegram(text).join('');
    expect(joined.replace(/\s+/g, '')).toEqual(text.replace(/\s+/g, ''));
  });

  it('предпочитает разрыв по границе абзаца', () => {
    const head = 'a'.repeat(TELEGRAM_TEXT_LIMIT - 100);
    const chunks = splitForTelegram(`${head}\n\n${'b'.repeat(200)}`);

    expect(chunks[0]).toEqual(head);
    expect(chunks[1]).toEqual('b'.repeat(200));
  });

  it('рвёт по строке, когда абзацной границы в окне нет', () => {
    const head = 'a'.repeat(TELEGRAM_TEXT_LIMIT - 100);
    const chunks = splitForTelegram(`${head}\n${'b'.repeat(200)}`);

    expect(chunks[0]).toEqual(head);
    expect(chunks[1]).toEqual('b'.repeat(200));
  });

  it('при отсутствии пробелов режет жёстко, а не отдаёт кусок сверх лимита', () => {
    const chunks = splitForTelegram('x'.repeat(TELEGRAM_TEXT_LIMIT + 10));

    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toEqual(TELEGRAM_TEXT_LIMIT);
    expect(chunks[1].length).toEqual(10);
  });

  it('не разрывает суррогатную пару: половинка эмодзи ломает UTF-8 на стороне Telegram', () => {
    // Эмодзи занимает 2 UTF-16 единицы — ровно как их считает Telegram.
    // Ставим пару так, чтобы жёсткий рез пришёлся между её половинами.
    const text = 'x'.repeat(TELEGRAM_TEXT_LIMIT - 1) + '😀' + 'y'.repeat(10);
    const chunks = splitForTelegram(text);

    for (const c of chunks) {
      expect(c).toEqual(c.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, ''));
      expect(c).toEqual(c.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, ''));
    }
    expect(chunks.join('')).toEqual(text);
  });

  it('пустой текст не порождает пустых отправок', () => {
    expect(splitForTelegram('')).toEqual([]);
    expect(splitForTelegram('   ')).toEqual([]);
  });
});

describe('TgGrammyClient.sendMessage', () => {
  function makeClient() {
    const api = { sendMessage: jest.fn(async () => ({ message_id: 1 })) };
    const client = new TgGrammyClient();
    (client as any).bot = { api };
    return { client, api };
  }

  it('длинный ответ уходит несколькими сообщениями, а не падает с 400', async () => {
    const { client, api } = makeClient();

    await client.sendMessage(-100500, 'a'.repeat(TELEGRAM_TEXT_LIMIT + 500));

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    for (const call of api.sendMessage.mock.calls as any[]) {
      expect(call[1].length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    }
  });

  it('reply_to_message_id только на первом куске: остальные не цитируют вопрос повторно', async () => {
    const { client, api } = makeClient();

    await client.sendMessage(-100500, 'a'.repeat(TELEGRAM_TEXT_LIMIT + 500), {
      reply_to_message_id: 77,
    });

    const calls = api.sendMessage.mock.calls as any[];
    expect(calls[0][2].reply_to_message_id).toEqual(77);
    expect(calls[1][2].reply_to_message_id).toBeUndefined();
  });

  it('короткий текст — ровно один вызов с исходными опциями', async () => {
    const { client, api } = makeClient();

    await client.sendMessage(-100500, 'привет', { parse_mode: 'Markdown' });

    expect(api.sendMessage.mock.calls).toEqual([[-100500, 'привет', { parse_mode: 'Markdown' }]]);
  });
});
