import { buildDigest, buildKeyboard, DIGEST_MAX_CHARS, insightsChatId, orderFindings, type DigestFinding } from './insights-digest';
import { emptySignals } from './insights.types';

const F = (over: Partial<DigestFinding> = {}): DigestFinding => ({
  id: '00000000-0000-0000-0000-000000000001',
  status: 'open',
  weeksSeen: 1,
  prevPeople: null,
  priorId: null,
  type: 'confused',
  title: 'Путают два вида ботов',
  description: 'Идут за своим ботом во вкладку групповых ботов',
  proposal: 'Дать во вкладке ссылку на Продукты',
  people: 3,
  conversations: 4,
  assistants: ['Роман'],
  severity: 2,
  ...over,
});

const base = { weekStart: '2026-10-19', conversations: 74, people: 20, crisis: 1, signals: emptySignals() };

describe('buildDigest', () => {
  it('шапка: неделя, счётчики, кризисные — только число', () => {
    const { text } = buildDigest({ ...base, findings: [F()] });
    expect(text.split('\n')[0]).toBe('Затыки недели · 19–25 окт');
    expect(text).toContain('Разговоров: 74 · людей: 20 · кризисных: 1');
  });

  it('находка одного человека — ниже и с пометкой', () => {
    const one = F({ id: 'one', people: 1, conversations: 1, severity: 3, title: 'Хочет бота-аналитика' });
    const ordered = orderFindings([one, F()]);
    expect(ordered.map((f) => f.id)).toEqual(['00000000-0000-0000-0000-000000000001', 'one']);
    expect(buildDigest({ ...base, findings: [one] }).text).toContain('· 1 человек ·');
  });

  it('динамика: новое, держится, стало меньше', () => {
    expect(buildDigest({ ...base, findings: [F()] }).text).toContain('· новое');
    expect(buildDigest({ ...base, findings: [F({ weeksSeen: 3, prevPeople: 2 })] }).text).toContain('держится 3 нед.');
    expect(buildDigest({ ...base, findings: [F({ weeksSeen: 2, prevPeople: 5 })] }).text).toContain('стало меньше');
  });

  it('не длиннее экрана: хвост отрезается с пометкой', () => {
    const long = Array.from({ length: 10 }, (_, i) => F({ id: `id-${i}`, description: 'д'.repeat(290), proposal: 'п'.repeat(290) }));
    const { text, shown } = buildDigest({ ...base, findings: long });
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(shown.length).toBeLessThan(10);
    expect(text).toContain(`Не вошло: ${10 - shown.length}.`);
  });

  it('пустая неделя', () => {
    const out = buildDigest({ ...base, findings: [] });
    expect(out.text).toContain('Затыков на этой неделе не нашлось.');
    expect(out.shown).toEqual([]);
  });

  it('неразобранные пачки и урезанная разметка — строками в шапке', () => {
    const { text } = buildDigest({
      ...base,
      findings: [F()],
      failedBatches: { failed: 1, total: 6 },
      labelsInSynth: { used: 290, total: 400 },
    });
    expect(text).toContain('Не разобрано пачек разговоров: 1 из 6');
    expect(text).toContain('В сводку вошло пунктов разметки: 290 из 400');
  });

  it('без пропусков этих строк нет', () => {
    const { text } = buildDigest({
      ...base,
      findings: [F()],
      failedBatches: { failed: 0, total: 6 },
      labelsInSynth: { used: 12, total: 12 },
    });
    expect(text).not.toContain('Не разобрано');
    expect(text).not.toContain('В сводку вошло');
  });

  it('пропуск виден и когда затыков не нашлось', () => {
    const { text } = buildDigest({ ...base, findings: [], failedBatches: { failed: 2, total: 6 } });
    expect(text).toContain('Не разобрано пачек разговоров: 2 из 6');
    expect(text).toContain('Затыков на этой неделе не нашлось.');
  });
});

describe('buildKeyboard', () => {
  it('открытая — две кнопки, решённая — пометка без действия', () => {
    const kb = buildKeyboard([
      { id: 'a', status: 'open' },
      { id: 'b', status: 'backlog' },
      { id: 'c', status: 'rejected' },
    ]);
    expect(kb.inline_keyboard[0].map((b) => b.callback_data)).toEqual(['ins:b:a', 'ins:r:a']);
    expect(kb.inline_keyboard[1]).toEqual([{ text: '2 ✓ В бэклоге', callback_data: 'ins:noop:b' }]);
    expect(kb.inline_keyboard[2]).toEqual([{ text: '3 ✗ Отклонено', callback_data: 'ins:noop:c' }]);
  });
});

describe('insightsChatId', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('своя переменная важнее чата блога', () => {
    process.env.INSIGHTS_TG_CHAT_ID = '111';
    process.env.BLOG_APPROVER_TG_ID = '222';
    expect(insightsChatId()).toBe(111);
  });

  it('без своей — чат одобрения блога; без обеих — null', () => {
    delete process.env.INSIGHTS_TG_CHAT_ID;
    process.env.BLOG_APPROVER_TG_ID = '222';
    expect(insightsChatId()).toBe(222);
    delete process.env.BLOG_APPROVER_TG_ID;
    expect(insightsChatId()).toBeNull();
  });
});
