/**
 * Unit-тест авто-детекта формата Veo (video.service.createVeoJob) — фидбэк katya
 * (A): не было выбора формата, хардкодили 16:9. Inline-копия предиката.
 */
function detectAspect(dtoAspect, prompt) {
  if (dtoAspect === '9:16' || dtoAspect === '16:9') return dtoAspect;
  return /вертикал|vertical|\breels\b|рилс|9:16|сторис|stories|tiktok|тикток|shorts|шортс/i.test(prompt) ? '9:16' : '16:9';
}

describe('Veo aspect ratio resolution', () => {
  test('явный dto.aspectRatio имеет приоритет', () => {
    expect(detectAspect('16:9', 'вертикальное видео для reels')).toBe('16:9');
    expect(detectAspect('9:16', 'horizontal landscape')).toBe('9:16');
  });
  test('авто-детект вертикали по словам', () => {
    expect(detectAspect(undefined, 'сделай вертикальное видео')).toBe('9:16');
    expect(detectAspect(undefined, 'ролик для Reels с Ириной')).toBe('9:16');
    expect(detectAspect(undefined, 'видео в формате 9:16')).toBe('9:16');
    expect(detectAspect(undefined, 'shorts про путешествия')).toBe('9:16');
  });
  test('по умолчанию 16:9, если нет признаков вертикали', () => {
    expect(detectAspect(undefined, 'видеовизитка СТО, говорит в камеру')).toBe('16:9');
  });
});
