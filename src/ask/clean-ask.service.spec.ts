import 'reflect-metadata';
import axios from 'axios';
import { Readable } from 'stream';
import { CleanAskService } from './clean-ask.service';
import { AgentsService } from '../agents/agents.service';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';

jest.mock('axios');

/**
 * firstContact() — the engine of the first-contact момент-отклик (spec
 * 2026-08-27-first-contact-experience-design.md). We verify the composed prompt (persona +
 * first-contact rules + conversation) and the mode branching; the relay itself is mocked.
 */
describe('CleanAskService.firstContact', () => {
  const ROMAN = { name: 'Роман', system_prompt: 'Ты — Роман, тёплый личный помощник.' };

  function make(agent: any) {
    const agents = {
      getAgentByName: jest.fn().mockResolvedValue(agent),
      getAgentById: jest.fn().mockResolvedValue(agent),
    } as any;
    const svc = new CleanAskService(agents);
    const relay = jest.spyOn(svc as any, 'callRelay').mockResolvedValue('ОТВЕТ');
    return { svc, agents, relay };
  }

  it('question mode: persona + friendly-interest rules + one-question + carries conversation', async () => {
    const { svc, relay } = make(ROMAN);
    const out = await svc.firstContact(
      [{ from: 'roman', text: 'Привет, расскажи о себе' }, { from: 'user', text: 'Я устал от работы' }],
      false,
    );
    expect(out).toBe('ОТВЕТ');
    const msg = relay.mock.calls[0][0] as string;
    expect(msg).toContain('Роман'); // persona name
    expect(msg).toContain('Ты — Роман, тёплый личный помощник.'); // persona system_prompt
    expect(msg).toMatch(/доброжелат|дружелюб|интерес/i); // friendly, personal interest
    expect(msg).toMatch(/один вопрос|ОДИН/i); // one question at a time
    expect(msg).toContain('Я устал от работы'); // conversation carried
    expect(msg).not.toMatch(/отрази/i); // NOT the finish/reflection instruction
  });

  it('finish mode: reflection + ONE concrete offer + anti-fluff', async () => {
    const { svc, relay } = make(ROMAN);
    await svc.firstContact([{ from: 'user', text: 'Много работы и мало сна' }], true);
    const msg = relay.mock.calls[0][0] as string;
    expect(msg).toMatch(/отрази/i); // reflect what they said
    expect(msg).toMatch(/одну конкретную|давай я/i); // one concrete offer
    expect(msg).toMatch(/без общих|конкретн/i); // anti-fluff
    expect(msg).toContain('Много работы и мало сна');
  });

  it('no persona found → still composes + relays (neutral fallback)', async () => {
    const { svc, relay } = make(null);
    const out = await svc.firstContact([{ from: 'user', text: 'привет' }], false);
    expect(out).toBe('ОТВЕТ');
    expect(relay).toHaveBeenCalledTimes(1);
  });

  it('drops empty messages from the conversation', async () => {
    const { svc, relay } = make(ROMAN);
    await svc.firstContact([{ from: 'user', text: '  ' }, { from: 'user', text: 'реальный ответ' }], false);
    const msg = relay.mock.calls[0][0] as string;
    expect(msg).toContain('реальный ответ');
  });
});

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

describe('CleanAskService: модель общего рубильника в запросе к релею', () => {
  const post = axios.post as jest.Mock;
  beforeEach(() => {
    post.mockReset();
    post.mockImplementation(async () => ({ data: Readable.from(['data: {"type":"delta","text":"ок"}\n']) }));
  });

  it('рубильник Kimi — provider=kimi', async () => {
    const svc = new CleanAskService({} as any, { get: jest.fn(async () => 'kimi') } as any);
    expect(await (svc as any).callRelay('вопрос')).toBe('ок');
    expect(fieldsOf(post.mock.calls[0][1]).provider).toBe('kimi');
  });

  it('рубильник Claude — без provider', async () => {
    const svc = new CleanAskService({} as any, { get: jest.fn(async () => 'claude') } as any);
    await (svc as any).callRelay('вопрос');
    expect(fieldsOf(post.mock.calls[0][1]).provider).toBeUndefined();
  });
});

/**
 * Эфемерный путь «поговорить начисто» не должен молча застыть на Claude при
 * поломке графа DI: конструктор объявляет globalProvider БЕЗ @Optional()
 * (параметр остаётся TS-опциональным — тесты выше и в describe
 * CleanAskService.firstContact создают сервис через `new` с одним
 * аргументом). design:paramtypes не видит сам декоратор @Optional() — он
 * сторожит только то, что параметры объявлены КЛАССАМИ AgentsService и
 * GlobalLlmProviderService, а не интерфейсом/Object (та же ловушка, что в
 * user-llm-provider.service.spec.ts).
 */
describe('CleanAskService: DI-тип рубильника', () => {
  it('конструктор объявляет зависимости классами AgentsService и GlobalLlmProviderService', () => {
    expect(Reflect.getMetadata('design:paramtypes', CleanAskService)).toEqual([AgentsService, GlobalLlmProviderService]);
  });
});
