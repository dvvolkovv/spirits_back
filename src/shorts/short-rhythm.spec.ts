import { IdeaLite, nextAngle, pickAssistants, planNext } from './short-rhythm';
import { ShortAngle } from './shorts.types';

describe('nextAngle', () => {
  it('из пустой истории — неудобный вопрос, затем разнос, затем спокойный', () => {
    expect(nextAngle([])).toBe('uncomfortable');
    expect(nextAngle(['uncomfortable'])).toBe('roast');
    expect(nextAngle(['roast', 'uncomfortable'])).toBe('calm');
  });

  it('в любых трёх подряд — ровно один calm, провокации подряд не повторяются', () => {
    const recent: ShortAngle[] = [];
    for (let i = 0; i < 12; i++) recent.unshift(nextAngle(recent));
    const chrono = [...recent].reverse();
    for (let i = 0; i + 3 <= chrono.length; i++) {
      expect(chrono.slice(i, i + 3).filter((a) => a === 'calm')).toHaveLength(1);
    }
    const provocative = chrono.filter((a) => a !== 'calm');
    for (let i = 1; i < provocative.length; i++) expect(provocative[i]).not.toBe(provocative[i - 1]);
  });
});

const idea = (over: Partial<IdeaLite>): IdeaLite => ({
  id: 'x', rubric: 'assistant', assistantName: 'Алексей', angle: 'calm', angleLocked: false,
  source: 'catalog', createdAt: new Date('2026-10-20T00:00:00Z'), ...over,
});

describe('planNext', () => {
  it('пустая очередь — запускать нечего', () => {
    expect(planNext([], [])).toBeNull();
  });

  it('заказ владельца — раньше каталога', () => {
    const p = planNext([idea({ id: 'cat' }), idea({ id: 'own', source: 'manual', createdAt: new Date('2026-10-24T00:00:00Z') })], []);
    expect(p).toEqual({ ideaId: 'own', angle: 'uncomfortable' });
  });

  it('две одинаковые рубрики подряд не ставятся, если в очереди есть другая', () => {
    const p = planNext([idea({ id: 'a', rubric: 'case', source: 'manual' }), idea({ id: 'b' })], [{ rubric: 'case', angle: 'calm' }]);
    expect(p?.ideaId).toBe('b');
  });

  it('другой рубрики нет — берётся та же', () => {
    expect(planNext([idea({ id: 'a' })], [{ rubric: 'assistant', angle: 'calm' }])?.ideaId).toBe('a');
  });

  it('подача, заданная при заказе, не меняется', () => {
    expect(planNext([idea({ id: 'a', angle: 'myth', angleLocked: true })], [])).toEqual({ ideaId: 'a', angle: 'myth' });
  });

  it('здоровье в провокационный слот не идёт, если есть другая тема', () => {
    const p = planNext(
      [idea({ id: 'h', assistantName: 'Полина' }), idea({ id: 'k', assistantName: 'Кира', createdAt: new Date('2026-10-21T00:00:00Z') })],
      [],
    );
    expect(p).toEqual({ ideaId: 'k', angle: 'uncomfortable' });
  });

  it('другой темы нет — здоровье выходит спокойным', () => {
    expect(planNext([idea({ id: 'h', assistantName: 'Шанкара' })], [])).toEqual({ ideaId: 'h', angle: 'calm' });
  });

  it('ради провокационного слота берётся безопасная тема даже той же рубрики', () => {
    const p = planNext(
      [
        idea({ id: 'h', rubric: 'feature', assistantName: 'Полина' }),
        idea({ id: 'k', rubric: 'assistant', assistantName: 'Кира', createdAt: new Date('2026-10-21T00:00:00Z') }),
      ],
      [{ rubric: 'assistant', angle: 'calm' }],
    );
    expect(p).toEqual({ ideaId: 'k', angle: 'uncomfortable' });
  });
});

describe('pickAssistants', () => {
  const all = [
    { id: 1, name: 'Миша', description: '' },
    { id: 10, name: 'Алексей', description: '' },
    { id: 22, name: 'Кира', description: '' },
    { id: 4, name: 'Ирина', description: '' },
  ];

  it('сначала те, о ком роликов не было, затем давно показанные; с открытой идеей — пропуск', () => {
    const last = new Map([[10, new Date('2026-10-01')], [22, new Date('2026-09-01')]]);
    expect(pickAssistants(all, last, new Set([4]), 3).map((a) => a.id)).toEqual([1, 22, 10]);
  });
});
