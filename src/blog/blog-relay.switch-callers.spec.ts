import 'reflect-metadata';
import axios from 'axios';
import { Readable } from 'stream';
import { BlogRelayClient } from './blog-relay.client';
import { BlogEditorService } from './blog-editor.service';
import { BlogNewsService } from './blog-news.service';
import { ShortsWriterService } from '../shorts/shorts-writer.service';
import { ShortsDirectorService } from '../shorts/shorts-director.service';
import { rowToShort } from '../shorts/shorts.types';

jest.mock('axios');

/**
 * Кто из клиентов BlogRelayClient идёт по общему рубильнику (Задача 14,
 * проверка фоновых задач на проде 01.11). Редактор автоблога и отбор новостей
 * недели — всегда Claude: Qwen вместо JSON сохранял пост и дайджест в файл
 * (Bash/Write) и отвечал «Готово, сохранено», разбор падал. Сценарист и
 * режиссёр роликов проверку прошли — по рубильнику. Клиент настоящий, подменён
 * только axios: проверяется то, что реально уехало в релей.
 */

/** Поля multipart-запроса к релею — то, что реально уехало. */
function fieldsOf(fd: any): Record<string, string> {
  const boundary = fd.getBoundary();
  const raw = fd.getBuffer().toString('utf8');
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part);
    const head = part.indexOf('\r\n\r\n');
    if (!name || head < 0) continue;
    out[name[1]] = part.slice(head + 4).replace(/\r\n$/, '');
  }
  return out;
}

const AGENTS = [{ id: 10, name: 'Алексей', description: 'Юрист' }];
const PARAGRAPHS = [{ n: 1, text: 'Залог возвращается в течение 7 дней после выезда.' }];

function short(over: Record<string, any> = {}) {
  return rowToShort({
    id: 'ab12cd34-0000-4000-8000-000000000000', rubric: 'assistant', angle: 'uncomfortable', source: 'catalog',
    topic_key: 'assistant-10', topic_hint: 'Ассистент «Алексей»', title: 'Залог при аренде', slug: 'zalog_ab12',
    assistant_id: 10, attempts: 1,
    ...over,
  });
}

describe('BlogRelayClient: кто идёт по рубильнику (рубильник на Qwen)', () => {
  const post = axios.post as jest.Mock;
  let get: jest.Mock;
  let relay: BlogRelayClient;
  beforeEach(() => {
    post.mockReset();
    // Ровно то, что Qwen отвечал автоблогу 01.11: разбор у вызывающих упадёт,
    // а запрос — то, что проверяем, — к этому моменту уже ушёл.
    post.mockImplementation(async () => ({ data: Readable.from(['data: {"type":"delta","text":"Готово, сохранено"}\n\n']) }));
    get = jest.fn(async () => 'qwen');
    relay = new BlogRelayClient({ get } as any);
  });

  it('редактор автоблога — без provider, рубильник не читается', async () => {
    const svc = new BlogEditorService(relay, { recentTitles: jest.fn(async () => []) } as any);
    await svc.draft({ id: 'p1', rubric: 'case', topicKey: 'аренда', topicHint: 'про аренду' } as any).catch(() => undefined);
    expect(post).toHaveBeenCalled();
    for (const [, fd] of post.mock.calls) expect(fieldsOf(fd).provider).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('отбор новостей недели — без provider, рубильник не читается', async () => {
    const git = { weeklyCommits: jest.fn(async () => [{ sha: 'x', subject: 'feat(trip): маршрут одной кнопкой' }]) };
    const svc = new BlogNewsService(git as any, relay);
    await svc.weeklyTopics(new Date('2026-09-20T06:00:00Z')).catch(() => undefined);
    expect(post).toHaveBeenCalled();
    for (const [, fd] of post.mock.calls) expect(fieldsOf(fd).provider).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('сценарист роликов — provider=qwen', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [], rowCount: 1 })) };
    const agents = { getAgents: jest.fn(async () => AGENTS) };
    const settings = { get: jest.fn(async () => ({ narratorVoice: 'alena' })) };
    const svc = new ShortsWriterService(pg as any, relay, agents as any, settings as any);
    const v = short({
      status: 'writing',
      scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Как не потерять залог?', followups: [] },
      capture: { paragraphs: PARAGRAPHS, answerText: PARAGRAPHS[0].text, boxes: [] },
    });
    await svc.write(v).catch(() => undefined);
    expect(post).toHaveBeenCalled();
    for (const [, fd] of post.mock.calls) expect(fieldsOf(fd).provider).toBe('qwen');
    expect(get).toHaveBeenCalled();
  });

  it('режиссёр роликов — provider=qwen', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [], rowCount: 1 })) };
    const agents = { getAgents: jest.fn(async () => AGENTS) };
    const svc = new ShortsDirectorService(pg as any, relay, agents as any);
    await svc.direct(short({ status: 'directing' })).catch(() => undefined);
    expect(post).toHaveBeenCalled();
    for (const [, fd] of post.mock.calls) expect(fieldsOf(fd).provider).toBe('qwen');
    expect(get).toHaveBeenCalled();
  });
});
