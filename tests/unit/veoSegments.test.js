/**
 * Unit-тест разбивки промпта Veo по сегментам (video.service.buildVeoSegmentPrompts).
 * Inline-копия логики (intentional, как остальные veo/* тесты).
 *
 * Контракт: речь распределяется по клипам БЕЗ повторов, а полный текст реплики
 * ВЫРЕЗАЕТСЯ из тела промпта (иначе утекает в каждый клип). Баг katya 2026-06-09:
 * 16с-вертикаль = 2 клипа, на стыке (8с) второй клип повторял начало сценария,
 * потому что промпт нёс реплику дважды (раскадровка по beat'ам + блок «Spoken
 * dialogue: «весь текст»»), а старый сплиттер брал только ПЕРВУЮ кавычку и
 * дублировал остаток в каждый клип.
 */

const QUOTE_SRC = '«([^»]+)»|“([^”]+)”|„([^“"]+)[“"]|"([^"]+)"';
const continuation = () => 'Continue the previous shot seamlessly: no new dialogue, do not repeat earlier words.';

function build(prompt, segments) {
  const clean = String(prompt || '').trim();
  if (segments <= 1) return [clean];
  const quotes = [];
  const qre = new RegExp(QUOTE_SRC, 'g');
  let m;
  while ((m = qre.exec(clean))) {
    const q = (m[1] || m[2] || m[3] || m[4] || '').trim();
    if (q) quotes.push(q);
  }
  if (quotes.length === 0) {
    const out = [clean];
    for (let i = 1; i < segments; i++) out.push(continuation());
    return out;
  }
  let full = '';
  const sd = clean.match(/(?:spoken dialogue|реплик[аи]|полный текст|весь текст|говорит)[^«“"„]{0,60}?[«“"„]([^»”"]+)[»”"]/i);
  if (sd && sd[1].trim()) full = sd[1].trim();
  else { const u = []; for (const q of quotes) if (!u.includes(q)) u.push(q); full = u.join(' '); }
  const body = clean
    .replace(/(?:spoken dialogue|реплика|полный текст|весь текст)[^\n«“"„]*[:：]?/gi, '')
    .replace(new RegExp(QUOTE_SRC, 'g'), '')
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const ss = full.split(/(?<=[.!?。！？…])\s+/).map((s) => s.trim()).filter(Boolean);
  const perSeg = Math.max(1, Math.ceil(ss.length / segments));
  const out = [];
  for (let i = 0; i < segments; i++) {
    const c = ss.slice(i * perSeg, (i + 1) * perSeg);
    out.push(c.length
      ? `${body}\n=== РЕЧЬ ===\nтолько эти слова: «${c.join(' ')}»`
      : `${body}\n=== РЕЧЬ ===\nМОЛЧИТ`);
  }
  return out;
}

describe('buildVeoSegmentPrompts', () => {
  test('1 сегмент — промпт как есть', () => {
    expect(build('текст', 1)).toEqual(['текст']);
  });

  test('простой случай: одна реплика делится на 2 клипа без повтора', () => {
    const out = build('Девушка говорит: «Привет. Как дела? Пока.» Тёплый свет.', 2);
    expect(out[0]).toContain('Привет');
    expect(out[1]).toContain('Пока');
    expect(out[1]).not.toContain('Привет');  // нет повтора
  });

  test('кейс katya: раскадровка + блок Spoken dialogue → НЕТ повтора на стыке', () => {
    const prompt = [
      'Talking head, 16s, dusty rose top.',
      '0–3s: close-up. «Первый полёт с малышом пугает.» (сочувствие)',
      '3–6s: pull back. «Слёзы, ушки. Сама так боялась.» (тепло)',
      '9–12s: medium. «Кормите при взлёте и посадке.» (практично)',
      '14–16s: lean in. «Напишите МАЛЫШ, дам чек-лист.» (дружелюбно)',
      'Spoken dialogue (4 sentences): «Первый полёт с малышом пугает. Слёзы, ушки. Сама так боялась. Кормите при взлёте и посадке. Напишите МАЛЫШ, дам чек-лист.»',
      'Critical: no extra voices.',
    ].join('\n');
    const out = build(prompt, 2);
    // полный текст вырезан из тела — нет дубля в "обвязке"
    expect(out[0]).not.toContain('Spoken dialogue');
    // клип 1 несёт первую половину, клип 2 — вторую; БЕЗ пересечений
    expect(out[0]).toContain('Первый полёт');
    expect(out[1]).not.toContain('Первый полёт');     // ← главное: нет повтора
    expect(out[1]).toContain('Напишите МАЛЫШ');
    expect(out[0]).not.toContain('Напишите МАЛЫШ');
    // визуальная обвязка сохранилась
    expect(out[0]).toContain('dusty rose');
    expect(out[1]).toContain('dusty rose');
  });

  test('нет кавычек — база несёт всё, хвост продолжает без речи', () => {
    const out = build('Мужчина в офисе смотрит в камеру. Тёплый свет.', 3);
    expect(out[0]).toContain('офисе');
    expect(out[1]).toBe(continuation());
    expect(out[2]).toBe(continuation());
  });
});
