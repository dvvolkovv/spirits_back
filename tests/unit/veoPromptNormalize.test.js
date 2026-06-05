/**
 * Unit-тест нормализации промпта Veo (video.service.createVeoJob).
 * Баг владельца (2026-06-05): ассистент слал в Veo голый сценарий речи без
 * визуального обрамления → вырожденная база → extend падал "internal server
 * issue". Inline-копия предиката+обёртки.
 */
const SCENE_RE = /camera|кадр|\bscene\b|сцен|background|\bфон\b|wearing|\bодет|lighting|освещ|portrait|talking|\bspeaks?\b|в камеру|\bvideo\b|\bвидео\b|\bsuit\b|костюм|office|офис|9:16|16:9|subtitle|субтитр|vertical|вертикал|\bshot\b|says:|говорит/i;
function normalize(prompt, mode) {
  if (SCENE_RE.test(prompt)) return prompt;
  const who = mode === 'image2video' ? 'The person from the reference photo' : 'A confident professional in their 40s';
  return `Talking-head business video-card. ${who} looks directly into the camera in a clean modern office with soft cinematic lighting and shallow depth of field, natural perfectly lip-synced speech, calm confident tone, slight smile. He speaks in his native language and says: "${prompt}" Burned-in subtitles at the bottom of the frame, in sync with the speech.`;
}

const BARE = 'Я операционный директор. Двадцать лет в управлении продуктом. Готов превращать операционку в рост бизнеса.';

describe('Veo prompt normalization', () => {
  test('голая речь → оборачивается в talking-head с речью в кавычках + субтитры', () => {
    const out = normalize(BARE, 'image2video');
    expect(out).not.toBe(BARE);
    expect(out).toMatch(/reference photo/);          // ссылка на фото
    expect(out).toMatch(/says: "Я операционный директор/);
    expect(out).toMatch(/subtitles/i);
    expect(out).toMatch(/camera/i);
  });
  test('уже обрамлённый промпт не меняется', () => {
    const framed = 'Vertical 9:16 video, a man in a suit speaks to camera. He says: "Привет". Burned-in subtitles.';
    expect(normalize(framed, 'image2video')).toBe(framed);
  });
  test('text2video без фото — обёртка без ссылки на фото', () => {
    const out = normalize(BARE, 'text2video');
    expect(out).toMatch(/confident professional/);
    expect(out).not.toMatch(/reference photo/);
  });
});
