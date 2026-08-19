import { TgBotService } from './tg-bot.service';

/**
 * Провал доставки ответа не должен быть тихим.
 *
 * Инцидент 19.08.2026: ответ длиннее 4096 символов, sendMessage вернул 400,
 * исключение ушло из handleGroupMessage наверх. Юзер не увидел ни ответа, ни
 * ошибки (статус «🤔 Думаю…» удалён строкой выше), в БД не осталось ничего —
 * текст пришлось доставать из сессии Claude CLI на проде. Нарезка закрыла
 * конкретную причину, здесь закрывается сам класс отказа: любая ошибка
 * отправки видна юзеру, а текст ответа лежит в error-логе.
 */

function makeService(sendMessage: jest.Mock) {
  const grammy = { sendMessage } as any;
  // Метод трогает только grammy и logger — остальные зависимости не нужны.
  const svc = new TgBotService(
    null as any, null as any, null as any, null as any, null as any, null as any,
    null as any, null as any, grammy, null as any, null as any,
  );
  const errors: string[] = [];
  (svc as any).logger = { error: (m: string) => errors.push(m), warn: () => {}, log: () => {} };
  return { svc, errors };
}

describe('TgBotService.deliverReplyText', () => {
  it('успешная отправка — одно сообщение, цитатой на вопрос', async () => {
    const send = jest.fn(async () => ({ message_id: 5 }));
    const { svc } = makeService(send);

    await svc.deliverReplyText(-100500, 42, 'ответ');

    expect(send.mock.calls).toEqual([[-100500, 'ответ', { reply_to_message_id: 42 }]]);
  });

  it('провал отправки: юзер получает уведомление вместо молчания', async () => {
    const send = jest.fn()
      .mockRejectedValueOnce(new Error('400: Bad Request: message is too long'))
      .mockResolvedValueOnce({ message_id: 6 });
    const { svc } = makeService(send);

    await expect(svc.deliverReplyText(-100500, 42, 'длинный ответ')).rejects.toThrow('too long');

    expect(send).toHaveBeenCalledTimes(2);
    const notice = send.mock.calls[1][1] as string;
    expect(notice).toContain('не отправился');
  });

  it('провал отправки: полный текст ответа уходит в error-лог, а не теряется', async () => {
    const send = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ message_id: 6 });
    const { svc, errors } = makeService(send);

    await expect(svc.deliverReplyText(-100500, 42, 'уникальный текст ответа')).rejects.toThrow('boom');

    expect(errors.join('\n')).toContain('уникальный текст ответа');
  });

  it('исходная ошибка не маскируется, даже если уведомление тоже не ушло', async () => {
    const send = jest.fn()
      .mockRejectedValueOnce(new Error('исходная'))
      .mockRejectedValueOnce(new Error('и уведомление тоже'));
    const { svc } = makeService(send);

    await expect(svc.deliverReplyText(-100500, 42, 'текст')).rejects.toThrow('исходная');
  });

  it('ошибка пробрасывается: ход не списывается и не попадает в историю как доставленный', async () => {
    const send = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ message_id: 6 });
    const { svc } = makeService(send);

    // Списание и persistAssistantReply идут после доставки в handleGroupMessage,
    // поэтому единственная гарантия «не списали за недоставленное» — это throw.
    await expect(svc.deliverReplyText(-100500, 42, 'текст')).rejects.toThrow();
  });
});
