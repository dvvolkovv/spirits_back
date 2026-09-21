import { collectRelayText } from './blog-relay.client';

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
