jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: jest.fn() }));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { MiscService } from './misc.service';

/**
 * Поиск единомышленников: проза и карточки обязаны говорить об одних и тех же
 * людях, в одном порядке.
 *
 * 12.10.2026 на проде запрос «коуч» дал вывод «Четвёртый и Шестой профили…
 * Восьмой профиль…» и при этом три карточки. Модели подавали десять найденных
 * профилей под номерами #1…#10; прозу она писала по этим номерам, а в список
 * клала только подходящих. Ни «четвёртого», ни «восьмого» пользователь не видел.
 * Из пяти прогонов того же запроса так вышло в трёх: число карточек плавало
 * от двух до десяти.
 */

const queryMock = query as unknown as jest.Mock;

// Глоссы, по которым видно, чьи данные попали в промпт.
const GLOSS = [
  'уточнение ценностей и духовная практика',
  'святые места и священные предметы',
  'спортивная одежда и целевая аудитория',
  'коучинг как обучение и развитие людей',
  'числовая символика и судьба',
  'консультирование клиентов с нумерологией',
  'текучесть кадров и аудит',
  'тренинги для предпринимателей онлайн',
  'любовь и верность',
  'кулинария и отдых',
];

// Десять найденных профилей, как их отдаёт searchProfiles: по убыванию totalScore.
const found = () =>
  GLOSS.map((gloss, i) => ({
    phone: `phone-${i}`,
    name: i === 9 ? 'Екатерина' : '',
    totalScore: 20 - i * 2,
    matches: [{ category: 'Interest', name: `узел ${i + 1}`, gloss, score: 0.6 }],
  }));

// ai_profiles_consolidated.id: профиль #k (с единицы) → 1000 + (k - 1).
const idOf = (k: number) => 1000 + (k - 1);

const COACH = { ref: 4, name: 'Коуч', values: [], intents: ['обучение людей'], interests: ['коучинг и обучение'], skills: [], matchReason: 'Учит людей.' };
const CONSULTANT = { ref: 6, name: 'Консультант-коуч', values: [], intents: [], interests: [], skills: ['консультирование и коучинг'], matchReason: 'Консультирует.' };
const TRAINER = { ref: 8, name: 'Тренер', values: [], intents: ['тренинги'], interests: [], skills: [], matchReason: 'Ведёт тренинги.' };

const PROSE = 'Первый учит людей, второй консультирует, третий ведёт тренинги.';

/** Модель отвечает по очереди заданными текстами, кусками, как стрим SDK. */
function modelAnswers(...answers: Array<string | Error>) {
  let call = 0;
  queryMock.mockImplementation(() => {
    const answer = answers[call++] ?? '';
    return (async function* () {
      if (answer instanceof Error) throw answer;
      for (let i = 0; i < answer.length; i += 7) {
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer.slice(i, i + 7) } },
        };
      }
      yield { type: 'result', subtype: 'success', result: answer };
    })();
  });
}

const systemPrompts = () => queryMock.mock.calls.map(([arg]) => String(arg.options.systemPrompt));

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM ai_profiles_consolidated WHERE user_id = ANY/.test(sql)) {
        return { rows: params[0].map((phone: string) => ({ user_id: phone, id: 1000 + Number(phone.slice(-1)) })) };
      }
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new MiscService(null as any, pg as any, null as any, language as any);
  jest.spyOn(svc as any, 'searchProfiles').mockImplementation(async () => found());
  return svc;
}

function makeRes() {
  const written: string[] = [];
  const res: any = {
    status: jest.fn(() => res),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => { written.push(s); return true; }),
    end: jest.fn(),
  };
  return { res, written };
}

/**
 * То, что видит клиент: веб (SearchInterface) и мобилка (parseSearchPayload)
 * склеивают item-события, прозу берут до маркера, карточки — массивом после.
 */
function clientView(written: string[]) {
  let text = '';
  for (const line of written.join('').split('\n').filter((l) => l.trim())) {
    const ev = JSON.parse(line);
    if (ev.type === 'item') text += ev.content;
  }
  const at = text.indexOf('search_result:');
  const prose = (at < 0 ? text : text.slice(0, at)).trim();
  let cards: any[] = [];
  if (at >= 0) {
    const tail = text.slice(at + 'search_result:'.length);
    cards = JSON.parse(tail.slice(tail.indexOf('['), tail.lastIndexOf(']') + 1));
  }
  return { prose, cards };
}

async function search(...answers: Array<string | Error>) {
  modelAnswers(...answers);
  const svc = makeService();
  const { res, written } = makeRes();
  await svc.searchMate('u1', 'коуч', res);
  expect(res.end).toHaveBeenCalled();
  return clientView(written);
}

beforeEach(() => queryMock.mockReset());

describe('MiscService.searchMate: проза и карточки об одних и тех же людях', () => {
  it('прозу пишут по показанным карточкам и в их порядке — других людей модель-автор не видит', async () => {
    const view = await search(JSON.stringify([COACH, CONSULTANT, TRAINER]), PROSE);

    const prompts = systemPrompts();
    expect(prompts).toHaveLength(2);
    const prosePrompt = prompts[1];

    // Только трое показанных…
    for (const k of [1, 2, 3, 5, 7, 9, 10]) expect(prosePrompt).not.toContain(GLOSS[k - 1]);
    // …под теми же номерами, что у карточек на экране.
    expect(prosePrompt).toMatch(/^1\. «Коуч»/m);
    expect(prosePrompt).toMatch(/^2\. «Консультант-коуч»/m);
    expect(prosePrompt).toMatch(/^3\. «Тренер»/m);
    expect(prosePrompt).not.toMatch(/^4\. /m);
    expect(prosePrompt).not.toMatch(/#\d/);
    expect(prosePrompt.indexOf(GLOSS[3])).toBeLessThan(prosePrompt.indexOf(GLOSS[5]));
    expect(prosePrompt.indexOf(GLOSS[5])).toBeLessThan(prosePrompt.indexOf(GLOSS[7]));

    expect(view.prose).toBe(PROSE);
    expect(view.cards.map((c) => c.userId)).toEqual([idOf(4), idOf(6), idOf(8)]);
  });

  it('карточки собирает бэк: userId и процент — из поиска, а не со слов модели', async () => {
    const lying = { ...COACH, userId: 1, corellation: 0.99, correlation: 0.99 };
    const view = await search(JSON.stringify([lying, CONSULTANT, TRAINER]), PROSE);

    expect(view.cards).toEqual([
      { userId: idOf(4), name: 'Коуч', values: [], intents: ['обучение людей'], interests: ['коучинг и обучение'], skills: [], corellation: 0.7, matchReason: 'Учит людей.' },
      { userId: idOf(6), name: 'Консультант-коуч', values: [], intents: [], interests: [], skills: ['консультирование и коучинг'], corellation: 0.5, matchReason: 'Консультирует.' },
      { userId: idOf(8), name: 'Тренер', values: [], intents: ['тренинги'], interests: [], skills: [], corellation: 0.3, matchReason: 'Ведёт тренинги.' },
    ]);
  });

  it('чужие и повторные номера из ответа модели отбрасываются', async () => {
    const answer = JSON.stringify([
      CONSULTANT,
      { ...CONSULTANT, name: 'дубль' },
      { ...COACH, ref: 42 },
      { ...COACH, ref: 0 },
      { ...COACH, ref: 'abc' },
      { ...TRAINER, ref: '#8' },
    ]);
    const view = await search(answer, PROSE);

    expect(view.cards.map((c) => [c.userId, c.name])).toEqual([[idOf(6), 'Консультант-коуч'], [idOf(8), 'Тренер']]);
    expect(systemPrompts()[1]).not.toMatch(/^3\. /m);
  });

  it('ответ в markdown-ограде тоже разбирается', async () => {
    const view = await search('```json\n' + JSON.stringify([TRAINER]) + '\n```', PROSE);
    expect(view.cards.map((c) => c.userId)).toEqual([idOf(8)]);
  });

  it('модель никого не выбрала — «никого не нашли», прозу не заказываем', async () => {
    const view = await search('[]', PROSE);

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(view.prose).toMatch(/не найдено подходящих людей/);
    expect(view.cards).toEqual([]);
  });

  it('ответ модели не разобрать — сообщение об ошибке, без карточек и без второго вызова', async () => {
    const view = await search('Не могу выбрать.', PROSE);

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(view.prose).toBe('Ошибка при обработке запроса.');
    expect(view.cards).toEqual([]);
  });

  it('проза не удалась — карточки всё равно приходят', async () => {
    const view = await search(JSON.stringify([COACH, TRAINER]), new Error('relay down'));
    expect(view.cards.map((c) => c.userId)).toEqual([idOf(4), idOf(8)]);
  });
});
