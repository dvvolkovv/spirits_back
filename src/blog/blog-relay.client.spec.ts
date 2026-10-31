import 'reflect-metadata';
import axios from 'axios';
import { Readable } from 'stream';
import { BlogRelayClient, collectRelayText } from './blog-relay.client';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';

jest.mock('axios');

describe('collectRelayText', () => {
  it('склеивает delta-события', () => {
    const sse = 'data: {"type":"delta","text":"При"}\ndata: {"type":"delta","text":"вет"}\ndata: {"type":"done"}\n';
    expect(collectRelayText(sse)).toBe('Привет');
  });

  it('берёт result, если delta не было', () => {
    const sse = 'data: {"type":"result","text":"Готовый ответ"}\ndata: {"type":"done"}\n';
    expect(collectRelayText(sse)).toBe('Готовый ответ');
  });

  it('result игнорируется, если delta уже были: иначе ответ задвоится', () => {
    const sse = 'data: {"type":"delta","text":"А"}\ndata: {"type":"result","text":"А"}\n';
    expect(collectRelayText(sse)).toBe('А');
  });

  it('битые строки пропускаются, а не роняют разбор', () => {
    const sse = 'data: не json\ndata: {"type":"delta","text":"Б"}\nмусор\n';
    expect(collectRelayText(sse)).toBe('Б');
  });

  it('пустой поток даёт пустую строку', () => {
    expect(collectRelayText('')).toBe('');
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

describe('BlogRelayClient: модель общего рубильника (spec 2026-10-31-global-llm-switch)', () => {
  const post = axios.post as jest.Mock;
  beforeEach(() => {
    post.mockReset();
    post.mockImplementation(async () => ({ data: Readable.from(['data: {"type":"delta","text":"пост"}\n\n']) }));
  });

  it('рубильник Qwen — provider=qwen', async () => {
    const c = new BlogRelayClient({ get: jest.fn(async () => 'qwen') } as any);
    expect(await c.ask('sys', 'msg', 's-1')).toBe('пост');
    expect(fieldsOf(post.mock.calls[0][1]).provider).toBe('qwen');
  });

  it('рубильник Claude — без provider', async () => {
    const c = new BlogRelayClient({ get: jest.fn(async () => 'claude') } as any);
    await c.ask('sys', 'msg', 's-1');
    expect(fieldsOf(post.mock.calls[0][1]).provider).toBeUndefined();
  });

  it('без сервиса рубильника — без provider', async () => {
    await new BlogRelayClient().ask('sys', 'msg', 's-1');
    expect(fieldsOf(post.mock.calls[0][1]).provider).toBeUndefined();
  });
});

/**
 * Фоновые посты автоблога не должны молча застыть на Claude при поломке графа
 * DI: конструктор объявляет globalProvider БЕЗ @Optional() (параметр остаётся
 * TS-опциональным — тесты выше создают клиент через `new` без аргумента, как
 * и раньше). design:paramtypes не видит сам декоратор @Optional() — он
 * сторожит только то, что параметр объявлен КЛАССОМ GlobalLlmProviderService,
 * а не интерфейсом/Object (та же ловушка, что в
 * user-llm-provider.service.spec.ts и chat.service.guest-carry.spec.ts) —
 * необходимое условие, чтобы Nest вообще мог найти провайдер по типу.
 */
describe('BlogRelayClient: DI-тип рубильника', () => {
  it('конструктор объявляет зависимость классом GlobalLlmProviderService', () => {
    expect(Reflect.getMetadata('design:paramtypes', BlogRelayClient)).toEqual([GlobalLlmProviderService]);
  });
});
