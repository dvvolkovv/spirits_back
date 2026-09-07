import { translateEvent, ClaudeTranslator } from './claude';

describe('ClaudeTranslator', () => {
  it('system/init → begin', () => {
    const t = new ClaudeTranslator();

    expect(t.translate({ type: 'system', subtype: 'init' })).toEqual([{ type: 'begin' }]);
  });

  it('текстовая дельта → item', () => {
    const t = new ClaudeTranslator();

    const out = t.translate({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'правлю ' } },
    });

    expect(out).toEqual([{ type: 'item', content: 'правлю ' }]);
  });

  it('имя инструмента доезжает до результата', () => {
    // Соответствие tool_use_id → имя живёт в инстансе транслятора: SDK в
    // событии результата отдаёт только id. Без этой памяти клиент увидит
    // «unknown» вместо имени инструмента.
    const t = new ClaudeTranslator();

    t.translate({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Edit', input: {} }] } });
    const out = t.translate({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] },
    });

    expect(out).toEqual([{ type: 'tool_result', tool: 'Edit', result: 'ok' }]);
  });

  it('result → end с расходом токенов', () => {
    const t = new ClaudeTranslator();

    const out = t.translate({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 20 } });

    expect(out[0]).toMatchObject({ type: 'end' });
    expect((out[0] as any).usage.total).toBe(30);
  });

  it('неизвестное событие не роняет и не шумит', () => {
    const t = new ClaudeTranslator();

    expect(t.translate({ type: 'wat' })).toEqual([]);
  });

  it('мусор вместо объекта не роняет', () => {
    const t = new ClaudeTranslator();

    expect(t.translate(null)).toEqual([]);
    expect(t.translate('строка' as any)).toEqual([]);
  });
});

describe('translateEvent — потоковый разбор строк', () => {
  it('склеивает разорванную по границе чанка строку', () => {
    // stdout приходит кусками произвольного размера, граница чанка режет
    // JSON посередине. Без буфера такая строка теряется целиком.
    const t = new ClaudeTranslator();
    const out: any[] = [];

    out.push(...translateEvent(t, '{"type":"system","subty'));
    out.push(...translateEvent(t, 'pe":"init"}\n'));

    expect(out).toEqual([{ type: 'begin' }]);
  });

  it('не-JSON строка в потоке игнорируется, а не роняет ход', () => {
    // CLI иногда пишет в stdout служебные сообщения помимо stream-json.
    const t = new ClaudeTranslator();

    expect(translateEvent(t, 'какой-то текст\n')).toEqual([]);
  });
});
