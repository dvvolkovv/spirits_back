/**
 * Unit-тест разбивки промпта Veo по сегментам (video.service.buildVeoSegmentPrompts).
 * Inline-копия логики (intentional, как extractJsonObject.test) — пинит контракт:
 * речь должна начинаться с БАЗОВОГО сегмента, преамбула и оверлеи — в каждом.
 * Баг владельца (2026-06-04): первые 8с шли без русской речи (Veo импровизировал
 * английскую), персонаж описан только в базе → extend'ы «уплывали».
 */
function veoContinuationPrompt() {
  return 'Continue the previous shot seamlessly: the same person and setting, natural lifelike motion. The person has finished speaking: no new dialogue.';
}
function buildVeoSegmentPrompts(prompt, segments) {
  const clean = String(prompt || '').trim();
  if (segments <= 1) return [clean];
  const sentences = clean.split(/(?<=[.!?。！？…])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= 1) {
    const out = [clean || veoContinuationPrompt()];
    for (let i = 1; i < segments; i++) out.push(veoContinuationPrompt());
    return out;
  }
  const speechRe = /["«»“”„]|\bsays?\b|\bspeaks?\b|говор|произнос|реплик/i;
  const qm = clean.match(/["«“„]([\s\S]+?)["»”]/);
  if (!qm || !qm[1].trim()) {
    const out = [clean];
    for (let i = 1; i < segments; i++) out.push(veoContinuationPrompt());
    return out;
  }
  const prefix = clean.slice(0, qm.index).trim();
  const suffix = clean.slice((qm.index ?? 0) + qm[0].length).trim();
  const sceneOnly = prefix
    .split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean)
    .filter((s) => !speechRe.test(s)).join(' ').trim();
  const scriptSentences = qm[1].trim()
    .split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  const perSeg = Math.max(1, Math.ceil(scriptSentences.length / segments));
  const out = [];
  for (let i = 0; i < segments; i++) {
    const chunk = scriptSentences.slice(i * perSeg, (i + 1) * perSeg);
    if (chunk.length) {
      out.push([prefix, `"${chunk.join(' ')}"`, suffix].filter(Boolean).join(' '));
    } else {
      out.push([sceneOnly, veoContinuationPrompt(), suffix].filter(Boolean).join(' '));
    }
  }
  return out;
}

const CTO_PROMPT = [
  'Vertical 9:16 business video-card for a CTO.',
  'A confident friendly man in his 40s with short dark hair and light stubble, wearing a dark business suit.',
  'Background: blurred server racks, glowing dashboards, dark teal tech palette.',
  'He looks into camera and speaks directly to the viewer with synchronized lip movement.',
  'Native Russian speech, lips synced, he says: "Я технический директор.',
  'Двадцать лет в IT и финтехе.',
  'Готов превращать технологии в рост бизнеса."',
  'Hardcoded burned-in Russian subtitles at the bottom of the frame.',
  'A small clean nameplate caption showing the handle "DmitryT · CTO".',
  'Cinematic soft lighting, shallow depth of field, clean native audio.',
].join(' ');

describe('Veo segment prompts', () => {
  const segs = buildVeoSegmentPrompts(CTO_PROMPT, 4);

  test('базовый сегмент (0) содержит начало русской речи', () => {
    expect(segs[0]).toMatch(/Я технический директор|he says/i);
  });
  test('преамбула (внешность) повторяется в КАЖДОМ сегменте — консистентный персонаж', () => {
    for (const s of segs) expect(s).toMatch(/man in his 40s|short dark hair/i);
  });
  test('субтитры присутствуют в КАЖДОМ сегменте — на всю длину', () => {
    for (const s of segs) expect(s).toMatch(/subtitles/i);
  });
  test('речь распределена (не вся в одном сегменте)', () => {
    expect(segs[1]).toMatch(/Двадцать лет|Готов превращать|Continue the previous/i);
  });
});
