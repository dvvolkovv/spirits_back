import { buildSynthPrompt, MAX_FINDINGS, parseFindings } from './insights-synth';
import { emptySignals, type Label, type PriorFinding } from './insights.types';

const L = (person: number, assistant: string, type: Label['type'] = 'confused'): Label => ({
  person,
  assistant,
  type,
  about: 'путает два вида ботов',
  severity: 2,
});

const finding = (over: Record<string, unknown> = {}) => ({
  prior_id: null,
  type: 'confused',
  title: 'Путают два вида ботов',
  description: 'Идут за своим ботом во вкладку групповых ботов',
  proposal: 'Дать во вкладке ссылку на Продукты',
  people: [1, 2],
  severity: 2,
  ...over,
});

const labels = [L(1, 'Роман'), L(2, 'Роман'), L(2, 'Кира'), L(3, 'Кира', 'money')];

describe('buildSynthPrompt', () => {
  it('отдаёт модели разметку без userId и прошлые находки', () => {
    const prior: PriorFinding[] = [{ id: 'p1', type: 'confused', title: 'Т', status: 'open', weeks: 2, lastPeople: 3, rejectedPeople: null }];
    const s = buildSynthPrompt({ weekLabel: '19–25 окт', labels, signals: emptySignals(), prior });
    const j = JSON.parse(s);
    expect(j.labels[0]).toEqual({ person: 1, assistant: 'Роман', type: 'confused', about: 'путает два вида ботов', severity: 2 });
    expect(j.prior[0]).toMatchObject({ id: 'p1', last_people: 3 });
  });
});

describe('parseFindings', () => {
  it('людей и разговоры считает по разметке, а не верит модели', () => {
    const out = parseFindings(JSON.stringify({ findings: [finding({ people: [1, 2, 99] })] }), labels, [])!;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ people: 2, conversations: 3, assistants: ['Роман', 'Кира'], priorId: null });
  });

  it('находка без людей из разметки отбрасывается', () => {
    expect(parseFindings(JSON.stringify({ findings: [finding({ people: [42] })] }), labels, [])).toEqual([]);
  });

  it.each([
    ['цифры о людях', { description: 'Так было у 4 человек' }],
    ['цитата', { title: 'Говорят «у меня ничего не выходит с ботом»' }],
    ['чужой тип', { type: 'other' }],
  ])('отбрасывает: %s', (_name, over) => {
    expect(parseFindings(JSON.stringify({ findings: [finding(over)] }), labels, [])).toEqual([]);
  });

  it('незнакомый prior_id — новая находка', () => {
    const out = parseFindings(JSON.stringify({ findings: [finding({ prior_id: 'nope' })] }), labels, [])!;
    expect(out[0].priorId).toBeNull();
  });

  it('отклонённая всплывает только при вдвое большем числе людей', () => {
    const prior: PriorFinding[] = [{ id: 'r1', type: 'confused', title: 'Т', status: 'rejected', weeks: 1, lastPeople: 1, rejectedPeople: 2 }];
    expect(parseFindings(JSON.stringify({ findings: [finding({ prior_id: 'r1', people: [1, 2] })] }), labels, prior)).toEqual([]);
    const many = [...labels, L(4, 'Роман'), L(5, 'Роман')];
    const out = parseFindings(JSON.stringify({ findings: [finding({ prior_id: 'r1', people: [1, 2, 4, 5] })] }), many, prior)!;
    expect(out[0].priorId).toBe('r1');
  });

  it('одна прошлая находка — не дважды', () => {
    const prior: PriorFinding[] = [{ id: 'p1', type: 'confused', title: 'Т', status: 'open', weeks: 1, lastPeople: 1, rejectedPeople: null }];
    const out = parseFindings(
      JSON.stringify({ findings: [finding({ prior_id: 'p1' }), finding({ prior_id: 'p1', people: [1] })] }),
      labels,
      prior,
    )!;
    expect(out.filter((f) => f.priorId === 'p1')).toHaveLength(1);
  });

  it('сортировка по важности и потолок', () => {
    const many = Array.from({ length: 15 }, (_, i) => finding({ title: `Находка ${i}`, people: i % 2 ? [1, 2] : [1] }));
    const out = parseFindings(JSON.stringify({ findings: many }), labels, [])!;
    expect(out).toHaveLength(MAX_FINDINGS);
    expect(out[0].people).toBe(2);
  });

  it('не JSON — null', () => {
    expect(parseFindings('мусор', labels, [])).toBeNull();
  });
});
