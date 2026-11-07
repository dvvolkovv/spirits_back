jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: jest.fn() }));
jest.mock('../privacy/profile-privacy', () => ({
  listSearchCandidateIds: jest.fn(),
  filterSearchCandidateIds: jest.fn(),
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { MiscService } from './misc.service';
import {
  filterSearchCandidateIds,
  listSearchCandidateIds,
} from '../privacy/profile-privacy';

const listMock = listSearchCandidateIds as jest.MockedFunction<typeof listSearchCandidateIds>;
const filterMock = filterSearchCandidateIds as jest.MockedFunction<typeof filterSearchCandidateIds>;

const source = readFileSync(join(__dirname, 'misc.service.ts'), 'utf8');
const searchProfilesSource = source.slice(
  source.indexOf('private async searchProfiles'),
  source.indexOf('private async *llmText'),
);
const searchMateSource = source.slice(
  source.indexOf('async searchMate'),
  source.indexOf('private async writePaced'),
);

function profileRecord(phone = 'visible', matches: any[] = [], totalScore = 1) {
  const values: Record<string, any> = {
    phone,
    name: phone,
    matches,
    totalScore,
  };
  return { get: (key: string) => values[key] };
}

function foundProfile(phone: string, gloss: string) {
  return {
    phone,
    name: phone,
    totalScore: 1,
    matches: [{ category: 'Interest', name: `${phone}-node`, gloss, score: 0.9 }],
  };
}

function selection(ref: number, name: string) {
  return {
    ref,
    name,
    values: [],
    intents: [],
    interests: [`${name}-interest`],
    skills: [],
    matchReason: `${name} подходит.`,
  };
}

function makeService(records: any[] = []) {
  const run = jest.fn(async (_cypher?: string, _params?: any) => ({ records }));
  const session = { run, close: jest.fn(async () => undefined) };
  const neo4j = { getSession: jest.fn(() => session) };
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM ai_profiles_consolidated WHERE user_id = ANY/.test(sql)) {
        return {
          rows: params[0].map((phone: string, index: number) => ({
            user_id: phone,
            id: 1000 + index,
          })),
        };
      }
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new MiscService(neo4j as any, pg as any, null as any, language as any);
  const embedding = jest.spyOn(svc as any, 'getGlossQueryEmbedding').mockResolvedValue([0.1, 0.2]);
  const complete = jest.spyOn(svc as any, 'completeLLM').mockResolvedValue('[]');
  const pipe = jest.spyOn(svc as any, 'pipeLLM').mockResolvedValue(undefined);
  jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);
  jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  return { svc, pg, run, session, embedding, complete, pipe };
}

function makeRes() {
  const written: string[] = [];
  const res: any = {
    status: jest.fn(() => res),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => {
      written.push(s);
      return true;
    }),
    end: jest.fn(),
  };
  return { res, written };
}

function clientView(written: string[]) {
  let text = '';
  for (const line of written.join('').split('\n').filter((l) => l.trim())) {
    const event = JSON.parse(line);
    if (event.type === 'item') text += event.content;
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

beforeEach(() => {
  listMock.mockReset();
  filterMock.mockReset().mockImplementation(async (_pg, _requester, ids) => new Set(ids));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('searchProfiles privacy structure', () => {
  it('использует шесть eligible-only cosine-веток вместо глобального vector index', () => {
    expect(searchProfilesSource).not.toContain('db.index.vector.queryNodes');
    expect(searchProfilesSource.match(/p\.phone IN \$candidatePhones/g) ?? []).toHaveLength(6);
    const normalizedScore = '(1.0 + vector.similarity.cosine(node.embedding, emb)) / 2.0 AS score';
    expect(searchProfilesSource.split(normalizedScore)).toHaveLength(7);
    expect(searchProfilesSource).not.toContain('WITH p, node, vector.similarity.cosine(node.embedding, emb) AS score');
    expect(searchProfilesSource.match(/size\(node\.embedding\) = 1536/g) ?? []).toHaveLength(6);
    expect(searchProfilesSource.match(/LIMIT 20/g) ?? []).toHaveLength(6);

    const branches = [
      ['Value', 'HAS_VALUE', '3.0'],
      ['Desire', 'HAS_DESIRE', '2.5'],
      ['Interest', 'HAS_INTEREST', '2.0'],
      ['Intent', 'HAS_INTENT', '2.0'],
      ['Belief', 'HAS_BELIEF', '1.2'],
      ['Skill', 'HAS_SKILL', '1.0'],
    ];
    for (const [label, relation, weight] of branches) {
      expect(searchProfilesSource).toContain(`(p:Profile)-[:${relation}]->(node:${label})`);
      expect(searchProfilesSource).toContain(`'${label}' AS category, ${weight} AS weight`);
    }
    expect(searchProfilesSource).toContain('ORDER BY totalScore DESC');
    expect(searchProfilesSource).toContain('LIMIT 10');
    expect(searchProfilesSource).toContain('RETURN p.phone AS phone, COALESCE(p.name, \'\') AS name, matches, totalScore');
  });

  it('получает кандидатов из PG до embedding и передаёт их в Neo4j массивом', () => {
    const listAt = searchProfilesSource.indexOf('await listSearchCandidateIds(this.pg, excludePhone)');
    const embeddingAt = searchProfilesSource.indexOf('await this.getGlossQueryEmbedding(query)');
    expect(listAt).toBeGreaterThanOrEqual(0);
    expect(embeddingAt).toBeGreaterThan(listAt);
    expect(searchProfilesSource).toContain('candidatePhones: Array.from(candidatePhones)');
  });

  it('перепроверяет доступ перед выбором, прозой и карточками', () => {
    const order: Array<[string, number]> = [
      ['beforeSelection', searchMateSource.indexOf('const beforeSelection')],
      ['selection prompt', searchMateSource.indexOf('buildSelectionPrompt(allowedMatches, userLanguage)')],
      ['beforeProse', searchMateSource.indexOf('const beforeProse')],
      ['buffered prose generation', searchMateSource.indexOf('await this.completeLLM(buildProsePrompt(selected, userLanguage), userMessage)')],
      ['beforeCards', searchMateSource.indexOf('const beforeCards')],
      ['buffered prose write', searchMateSource.indexOf("res.write(JSON.stringify({ type: 'item', content: prose })")],
      ['cards', searchMateSource.indexOf('const cards = selected.map')],
    ];
    for (const [, at] of order) expect(at).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i++) {
      expect(order[i][1]).toBeGreaterThan(order[i - 1][1]);
    }
    expect(searchMateSource).toContain('selectSearchProfiles(allowedMatches, selection)');
    expect(searchMateSource).not.toContain('pipeLLM(buildProsePrompt');
  });
});

describe('searchProfiles privacy runtime', () => {
  it('ограничивает Neo4j списком PG до embedding и закрывает session', async () => {
    const order: string[] = [];
    listMock.mockImplementation(async () => {
      order.push('list');
      return new Set(['visible', 'peer']);
    });
    const { svc, pg, run, session, embedding } = makeService();
    embedding.mockImplementation(async () => {
      order.push('embedding');
      return [0.1, 0.2];
    });
    run.mockImplementation(async () => {
      order.push('neo4j');
      return { records: [] };
    });

    await expect((svc as any).searchProfiles('коуч', 'requester')).resolves.toEqual([]);

    expect(order).toEqual(['list', 'embedding', 'neo4j']);
    expect(listMock).toHaveBeenCalledWith(pg, 'requester');
    expect(run).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      candidatePhones: ['visible', 'peer'],
    }));
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('пустой список кандидатов не вызывает embedding или Neo4j и закрывает session', async () => {
    listMock.mockResolvedValue(new Set());
    const { svc, run, session, embedding } = makeService([profileRecord()]);

    await expect((svc as any).searchProfiles('коуч', 'requester')).resolves.toEqual([]);

    expect(embedding).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('ошибка PG fail-closed возвращает [] без embedding и закрывает session', async () => {
    listMock.mockRejectedValue(new Error('pg down'));
    const { svc, run, session, embedding } = makeService([profileRecord()]);

    await expect((svc as any).searchProfiles('коуч', 'requester')).resolves.toEqual([]);

    expect(embedding).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('сохраняет шкалу vector index: cosine=-1 даёт score=0, а не отрицательный score', async () => {
    listMock.mockResolvedValue(new Set(['visible']));
    const { svc, run } = makeService();
    run.mockImplementation(async (cypher?: string) => {
      const cosine = -1;
      const normalized = cypher?.includes('(1.0 + vector.similarity.cosine(node.embedding, emb)) / 2.0 AS score');
      const score = normalized ? (1.0 + cosine) / 2.0 : cosine;
      return {
        records: [profileRecord('visible', [
          { category: 'Interest', name: 'node', gloss: 'gloss', score },
        ], score)],
      };
    });

    const [profile] = await (svc as any).searchProfiles('коуч', 'requester');

    expect(profile.totalScore).toBe(0);
    expect(profile.matches[0].score).toBe(0);
    expect(profile.matches[0].score).toBeGreaterThanOrEqual(0);
  });

  it('кандидат с embedding не той размерности не отравляет остальные результаты', async () => {
    listMock.mockResolvedValue(new Set(['stale', 'valid']));
    const { svc, run } = makeService();
    run.mockImplementation(async (cypher?: string) => {
      const candidates = [
        { phone: 'stale', embedding: [0.1, 0.2] },
        { phone: 'valid', embedding: new Array(1536).fill(0.1) },
      ];
      const guarded = cypher?.includes('size(node.embedding) = 1536');
      const eligible = guarded
        ? candidates.filter((candidate) => candidate.embedding.length === 1536)
        : candidates;
      if (eligible.some((candidate) => candidate.embedding.length !== 1536)) {
        throw new Error('vector dimensions differ');
      }
      return {
        records: eligible.map((candidate) => profileRecord(candidate.phone, [
          { category: 'Interest', name: 'node', gloss: 'gloss', score: 0.5 },
        ], 0.5)),
      };
    });

    const profiles = await (svc as any).searchProfiles('коуч', 'requester');

    expect(profiles.map((profile: any) => profile.phone)).toEqual(['valid']);
  });
});

describe('searchMate privacy runtime', () => {
  it('скрытый кандидат не попадает в выбор, прозу или финальные карточки', async () => {
    filterMock.mockResolvedValueOnce(new Set(['visible']));
    const { svc, complete, pipe } = makeService();
    jest.spyOn(svc as any, 'searchProfiles').mockResolvedValue([
      foundProfile('visible', 'VISIBLE-GLOSS'),
      foundProfile('hidden', 'HIDDEN-GLOSS'),
    ]);
    complete
      .mockResolvedValueOnce(JSON.stringify([
        selection(1, 'Visible'),
        selection(2, 'Hidden'),
      ]))
      .mockResolvedValueOnce('VISIBLE PROSE');
    pipe.mockImplementation(async (_prompt: string, _message: string, res: any) => {
      res.write(JSON.stringify({ type: 'item', content: 'VISIBLE PROSE' }) + '\n');
    });
    const { res, written } = makeRes();

    await svc.searchMate('requester', 'коуч', res);

    const selectionPrompt = String(complete.mock.calls[0]?.[0] ?? '');
    const prosePrompt = String(complete.mock.calls[1]?.[0] ?? pipe.mock.calls[0]?.[0] ?? '');
    const view = clientView(written);
    expect({
      selectionVisible: selectionPrompt.includes('VISIBLE-GLOSS'),
      selectionHidden: selectionPrompt.includes('HIDDEN-GLOSS'),
      proseVisible: prosePrompt.includes('VISIBLE-GLOSS'),
      proseHidden: prosePrompt.includes('HIDDEN-GLOSS'),
      responseProse: view.prose,
      cards: view.cards.map((card) => card.name),
    }).toEqual({
      selectionVisible: true,
      selectionHidden: false,
      proseVisible: true,
      proseHidden: false,
      responseProse: 'VISIBLE PROSE',
      cards: ['Visible'],
    });
    expect(pipe).not.toHaveBeenCalled();
    expect(filterMock.mock.calls.map((call) => call[2])).toEqual([
      ['visible', 'hidden'],
      ['visible'],
      ['visible'],
    ]);
  });

  it('отозванный после выбора профиль удаляется и из прозы, и из карточек', async () => {
    filterMock
      .mockResolvedValueOnce(new Set(['visible', 'hidden']))
      .mockResolvedValueOnce(new Set(['visible']));
    const { svc, complete, pipe } = makeService();
    jest.spyOn(svc as any, 'searchProfiles').mockResolvedValue([
      foundProfile('visible', 'VISIBLE-GLOSS'),
      foundProfile('hidden', 'HIDDEN-GLOSS'),
    ]);
    complete
      .mockResolvedValueOnce(JSON.stringify([
        selection(1, 'Visible'),
        selection(2, 'Hidden'),
      ]))
      .mockResolvedValueOnce('VISIBLE PROSE');
    pipe.mockImplementation(async (_prompt: string, _message: string, res: any) => {
      res.write(JSON.stringify({ type: 'item', content: 'VISIBLE PROSE' }) + '\n');
    });
    const { res, written } = makeRes();

    await svc.searchMate('requester', 'коуч', res);

    const prosePrompt = String(complete.mock.calls[1]?.[0] ?? pipe.mock.calls[0]?.[0] ?? '');
    const view = clientView(written);
    expect(prosePrompt).toContain('VISIBLE-GLOSS');
    expect(prosePrompt).not.toContain('HIDDEN-GLOSS');
    expect(view.prose).toBe('VISIBLE PROSE');
    expect(view.cards.map((card) => card.name)).toEqual(['Visible']);
    expect(pipe).not.toHaveBeenCalled();
    expect(filterMock.mock.calls.map((call) => call[2])).toEqual([
      ['visible', 'hidden'],
      ['visible', 'hidden'],
      ['visible'],
    ]);
  });

  it('если перед прозой никого не осталось, возвращает noResults без второго LLM', async () => {
    filterMock
      .mockResolvedValueOnce(new Set(['visible']))
      .mockResolvedValueOnce(new Set());
    const { svc, complete, pipe } = makeService();
    jest.spyOn(svc as any, 'searchProfiles').mockResolvedValue([
      foundProfile('visible', 'VISIBLE-GLOSS'),
    ]);
    complete.mockResolvedValue(JSON.stringify([selection(1, 'Visible')]));
    pipe.mockImplementation(async (_prompt: string, _message: string, response: any) => {
      response.write(JSON.stringify({ type: 'item', content: 'PRIVATE-PROSE Visible' }) + '\n');
    });
    const { res, written } = makeRes();

    await svc.searchMate('requester', 'коуч', res);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(pipe).not.toHaveBeenCalled();
    expect(written.join('')).not.toContain('PRIVATE-PROSE');
    const view = clientView(written);
    expect(view.prose).toContain('не найдено подходящих людей');
    expect(view.cards).toEqual([]);
  });

  it('поздний полный отзыв не выпускает уже сгенерированную личную прозу или карточки', async () => {
    filterMock
      .mockResolvedValueOnce(new Set(['visible']))
      .mockResolvedValueOnce(new Set(['visible']))
      .mockResolvedValueOnce(new Set());
    const { svc, complete, pipe } = makeService();
    jest.spyOn(svc as any, 'searchProfiles').mockResolvedValue([
      foundProfile('visible', 'VISIBLE-GLOSS'),
    ]);
    complete
      .mockResolvedValueOnce(JSON.stringify([selection(1, 'Visible')]))
      .mockResolvedValueOnce('PRIVATE-PROSE Visible');
    pipe.mockImplementation(async (_prompt: string, _message: string, response: any) => {
      response.write(JSON.stringify({ type: 'item', content: 'PRIVATE-PROSE Visible' }) + '\n');
    });
    const { res, written } = makeRes();

    await svc.searchMate('requester', 'коуч', res);

    expect(written.join('')).not.toContain('PRIVATE-PROSE');
    expect(written.join('')).not.toContain('Visible');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(pipe).not.toHaveBeenCalled();
    expect(filterMock).toHaveBeenCalledTimes(3);
    const view = clientView(written);
    expect(view.prose).toContain('не найдено подходящих людей');
    expect(view.cards).toEqual([]);
  });

  it('поздний частичный отзыв скрывает устаревшую прозу и оставляет согласованные карточки', async () => {
    filterMock
      .mockResolvedValueOnce(new Set(['visible', 'hidden']))
      .mockResolvedValueOnce(new Set(['visible', 'hidden']))
      .mockResolvedValueOnce(new Set(['visible']));
    const { svc, complete, pipe } = makeService();
    jest.spyOn(svc as any, 'searchProfiles').mockResolvedValue([
      foundProfile('visible', 'VISIBLE-GLOSS'),
      foundProfile('hidden', 'HIDDEN-GLOSS'),
    ]);
    complete
      .mockResolvedValueOnce(JSON.stringify([
        selection(1, 'Visible'),
        selection(2, 'Hidden'),
      ]))
      .mockResolvedValueOnce('HIDDEN-PROSE Hidden; VISIBLE-PROSE Visible');
    pipe.mockImplementation(async (_prompt: string, _message: string, response: any) => {
      response.write(JSON.stringify({ type: 'item', content: 'HIDDEN-PROSE Hidden; VISIBLE-PROSE Visible' }) + '\n');
    });
    const { res, written } = makeRes();

    await svc.searchMate('requester', 'коуч', res);

    const view = clientView(written);
    expect(view.prose).toBe('');
    expect(written.join('')).not.toContain('HIDDEN-PROSE');
    expect(view.cards.map((card) => card.name)).toEqual(['Visible']);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(pipe).not.toHaveBeenCalled();
    expect(filterMock.mock.calls.map((call) => call[2])).toEqual([
      ['visible', 'hidden'],
      ['visible', 'hidden'],
      ['visible', 'hidden'],
    ]);
  });

  it('ошибка PG при перепроверке fail-closed возвращает noResults без LLM', async () => {
    filterMock.mockRejectedValue(new Error('pg down'));
    const { svc, complete, pipe } = makeService();
    jest.spyOn(svc as any, 'searchProfiles').mockResolvedValue([
      foundProfile('visible', 'VISIBLE-GLOSS'),
    ]);
    const { res, written } = makeRes();

    await svc.searchMate('requester', 'коуч', res);

    expect(complete).not.toHaveBeenCalled();
    expect(pipe).not.toHaveBeenCalled();
    const view = clientView(written);
    expect(view.prose).toContain('не найдено подходящих людей');
    expect(view.cards).toEqual([]);
  });
});
