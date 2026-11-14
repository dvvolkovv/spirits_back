import {
  RECALL_ITEM_CHARS, RECALL_MAX_ITEMS, RECALL_TOTAL_CHARS,
  capRecall, isVague, rankRecall, stems,
} from './recall';
import { RecallService } from './recall.service';

const day = (d: string) => new Date(d).getTime();

/**
 * ⚠️ Проверяется не «похожесть», а поведение в звонке: человек говорит
 * «вернёмся к тому, что мы в прошлый раз делали» — и это ДОЛЖНО что-то найти,
 * а на конкретный запрос без совпадений честнее вернуть пусто, чем свежее
 * наугад. Повод — разговор 13.11.2026, где Роман ответил «у меня нет доступа»
 * к заметке, которая у человека есть.
 */
describe('recall — отбор', () => {
  it('грубый корень ловит разные формы одного слова', () => {
    expect(stems('финансового')).toEqual(stems('финансы'));
    // ё и регистр не должны расщеплять одно слово на два
    expect(stems('Ёлка')).toEqual(stems('елка'));
  });

  it('совпадение в заголовке весит больше, чем в тексте', () => {
    const cands = [
      { kind: 'note' as const, title: 'Обучение Савы', text: 'про финансы вскользь', at: day('2026-11-12') },
      { kind: 'note' as const, title: 'Финансовая стратегия', text: 'ипотека и резерв', at: day('2026-11-10') },
    ];
    expect(rankRecall(cands, 'финансы')[0].title).toBe('Финансовая стратегия');
  });

  it('запрос без значимых слов отдаёт самое свежее', () => {
    expect(isVague('посмотри, что мы делали в прошлый раз')).toBe(true);
    const cands = [
      { kind: 'talk' as const, title: 'Старое', text: 'т', at: day('2026-10-01') },
      { kind: 'talk' as const, title: 'Свежее', text: 'т', at: day('2026-11-13') },
    ];
    expect(rankRecall(cands, 'в прошлый раз')[0].title).toBe('Свежее');
  });

  it('значимые слова без совпадений — пусто, а не свежее наугад', () => {
    // Иначе на вопрос про ипотеку Роман уверенно пересказал бы вчерашний
    // разговор про другое — хуже, чем честное «не нашёл».
    expect(isVague('ипотека')).toBe(false);
    const cands = [{ kind: 'note' as const, title: 'Сдать кровь', text: 'анализы', at: day('2026-11-13') }];
    expect(rankRecall(cands, 'ипотека')).toEqual([]);
  });

  it('потолки держатся: не больше трёх, каждый в пределах, сумма в пределах', () => {
    const long = 'я'.repeat(5000);
    const cands = Array.from({ length: 10 }, (_, i) => ({
      kind: 'note' as const, title: `Заметка ${i}`, text: long, at: day('2026-11-01') + i,
    }));
    const items = capRecall(cands);
    expect(items.length).toBe(RECALL_MAX_ITEMS);
    for (const it of items) expect(it.text.length).toBeLessThanOrEqual(RECALL_ITEM_CHARS);
    expect(items.reduce((s, it) => s + it.text.length, 0)).toBeLessThanOrEqual(RECALL_TOTAL_CHARS);
  });

  it('обрез виден — иначе модель примет огрызок за весь текст', () => {
    const items = capRecall([
      { kind: 'note', title: 'Длинная', text: 'я'.repeat(5000), at: day('2026-11-01') },
    ]);
    expect(items[0].text.endsWith('…')).toBe(true);
    expect(items[0].date).toBe('01.11.2026');
  });
});

describe('RecallService', () => {
  const notesOf = (list: { title: string; content: string; updatedAt?: string }[]) => ({
    listNotes: jest.fn().mockResolvedValue(list.map((n, i) => ({ id: `n${i}`, ...n }))),
  }) as any;

  const pgOf = (rows: any[]) => ({ query: jest.fn().mockResolvedValue({ rows }) }) as any;

  it('ищет и в заметках, и в прошлых разговорах', async () => {
    const pg = pgOf([
      { started_at: '2026-11-10T10:00:00Z', summary: 'Говорили про ипотеку и резерв' },
    ]);
    const svc = new RecallService(pg, notesOf([
      { title: 'Финансовая стратегия', content: 'ипотека, резерв, портфель', updatedAt: '2026-11-10T17:08:00Z' },
    ]));

    const items = await svc.search('u1', 'ипотека');

    expect(items.map((i) => i.kind).sort()).toEqual(['note', 'talk']);
  });

  it('звонки берутся по пользователю звонка и только завершённые с резюме', async () => {
    const pg = pgOf([]);
    await new RecallService(pg, notesOf([])).search('u1', 'ипотека');

    const [sql, params] = pg.query.mock.calls[0];
    expect(params).toEqual(['u1']);
    expect(sql).toContain('user_id = $1');
    expect(sql).toContain("status = 'completed'");
    // Пустое резюме в выдаче — это строка «ничего», которая вытеснит настоящую находку.
    expect(sql).toMatch(/summary IS NOT NULL/);
  });

  it('kind сужает поиск до одного источника', async () => {
    const notes = notesOf([{ title: 'Финансовая стратегия', content: 'ипотека' }]);
    const pg = pgOf([{ started_at: '2026-11-10T10:00:00Z', summary: 'ипотека' }]);

    const onlyNotes = await new RecallService(pg, notes).search('u1', 'ипотека', 'note');
    expect(onlyNotes.every((i) => i.kind === 'note')).toBe(true);
    expect(pg.query).not.toHaveBeenCalled();

    const onlyTalks = await new RecallService(pg, notes).search('u1', 'ипотека', 'talk');
    expect(onlyTalks.every((i) => i.kind === 'talk')).toBe(true);
  });

  it('упавший TalerID не уносит с собой разговоры', async () => {
    // Заметки живут в чужом сервисе через MCP. Его падение не повод отвечать
    // человеку «ничего не помню»: разговоры лежат в нашей базе.
    const broken = { listNotes: jest.fn().mockRejectedValue(new Error('MCP down')) } as any;
    const pg = pgOf([{ started_at: '2026-11-10T10:00:00Z', summary: 'про ипотеку' }]);

    const items = await new RecallService(pg, broken).search('u1', 'ипотека');

    expect(items.length).toBe(1);
    expect(items[0].kind).toBe('talk');
  });

  it('без коннектора заметок сервис просто ищет по разговорам', async () => {
    const pg = pgOf([{ started_at: '2026-11-10T10:00:00Z', summary: 'про ипотеку' }]);
    const items = await new RecallService(pg).search('u1', 'ипотека');
    expect(items.length).toBe(1);
  });

  it('витрина для преамбулы — только заголовки и даты, без текста', async () => {
    const pg = pgOf([{ started_at: '2026-11-13T16:44:00Z', summary: 'Финансовое будущее\nподробности' }]);
    const svc = new RecallService(pg, notesOf([
      { title: 'Финансовая стратегия', content: 'ипотека, резерв, портфель', updatedAt: '2026-11-10T17:08:00Z' },
    ]));

    const text = await svc.digest('u1');

    expect(text).toContain('Финансовая стратегия');
    expect(text).toContain('Финансовое будущее');
    expect(text).not.toContain('портфель');
    expect(text).not.toContain('подробности');
  });
});
