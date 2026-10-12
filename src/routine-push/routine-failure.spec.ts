import { looksLikeFailure } from './routine-push.service';

/**
 * ⚠️ 12.10.2026, 02:00: владелец получил пуш «от Райи» с текстом
 * «Failed to authenticate: OAuth session expired and could not be refreshed».
 *
 * Claude CLI вернул ошибку ТЕКСТОМ и кодом успеха, проверка на пустоту её не поймала,
 * и сбой инструмента ушёл человеку как сообщение ассистента. Рутина — сообщение, которого
 * он не просил: промолчать лучше, чем прислать мусор от его имени.
 */
describe('рутинный пуш не отправляет сбой как сообщение', () => {
  it('ловит ровно тот текст, который пришёл владельцу', () => {
    expect(looksLikeFailure('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true);
  });

  it('ловит соседние формы того же сбоя', () => {
    expect(looksLikeFailure('Failed to authenticate. API Error: 401 {"type":"error"}')).toBe(true);
    expect(looksLikeFailure('Invalid authentication credentials')).toBe(true);
    expect(looksLikeFailure('Rate limit exceeded')).toBe(true);
  });

  it('настоящий ответ Райи пропускает', () => {
    expect(looksLikeFailure('Доброе утро! Сегодня у тебя занятие с Вероникой в 8:15 — выспись.')).toBe(false);
    expect(looksLikeFailure('Энергия дня: начни с малого, не бери всё сразу.')).toBe(false);
  });

  it('длинный связный текст не считает ошибкой, даже если слово совпало', () => {
    const long = 'Сегодня стоит поговорить про api error: так называют ситуацию, когда сервис не ответил. '.repeat(6);
    expect(long.length).toBeGreaterThan(400);
    expect(looksLikeFailure(long)).toBe(false);
  });
});
