/**
 * Unit-тест классификации ошибок операции Veo на транзиентные (ретраим) vs
 * фатальные (валим задачу). Inline-копия предиката из video.service.pollVeoJob.
 * Баг владельца (2026-06-05): "internal server issue / try again" валил всю
 * 24с-задачу без ретрая, хотя Google просит повторить.
 */
function isTransient(err) {
  return !!err && /internal server|try again|temporarily|unavailable|backend error|please retry|deadline exceeded|\b50[0-3]\b/i.test(err);
}

describe('Veo operation error classification', () => {
  test('ошибка владельца → транзиентная (ретраим)', () => {
    expect(isTransient('veo: Video generation failed due to an internal server issue. Please try again in a few minutes. If the problem persists, please contact Gemini API support.')).toBe(true);
  });
  test('5xx / temporarily unavailable → транзиентные', () => {
    expect(isTransient('503 Service Unavailable')).toBe(true);
    expect(isTransient('backend error, please retry')).toBe(true);
    expect(isTransient('model temporarily unavailable')).toBe(true);
  });
  test('контент-фильтр RAI → НЕ транзиентная (не ретраим)', () => {
    expect(isTransient('Veo отклонил генерацию (фильтр контента): celebrity')).toBe(false);
  });
  test('квота / no video → НЕ транзиентные', () => {
    expect(isTransient('Veo: на сегодня исчерпан дневной лимит генераций видео')).toBe(false);
    expect(isTransient('no video')).toBe(false);
    expect(isTransient('')).toBe(false);
  });
});
