import { toActivity, ActivityKind } from './activity-map';

const PHONE = '79030169187';
const WHO = { userId: PHONE, relaySessionId: `${PHONE}_12_ru` };
const UUID = '0b7c2a4e-1f3d-4c8a-9e2b-5d6f7a8b9c0d';
const json = (o: unknown) => JSON.stringify(o);

describe('toActivity — что видит человек вместо трёх точек', () => {
  it('поиск в интернете — с запросом', () => {
    expect(toActivity('WebSearch', json({ query: 'аренда офиса Казань' }), WHO))
      .toEqual({ type: 'activity', kind: 'web_search', detail: 'аренда офиса Казань' });
  });

  it('чтение страницы — только хост, без пути и параметров', () => {
    expect(toActivity('WebFetch', json({ url: 'https://www.avito.ru/kazan?id=1&token=abc', prompt: 'цены' }), WHO))
      .toEqual({ type: 'activity', kind: 'web_fetch', detail: 'avito.ru' });
  });

  it('input, обрезанный релеем до 300 символов, всё равно даёт закрытое поле', () => {
    const cut = json({ file_path: `/tmp/agent-output/${PHONE}_12_ru/Отчёт.pdf`, content: 'x'.repeat(500) }).slice(0, 300);
    expect(() => JSON.parse(cut)).toThrow();
    expect(toActivity('Write', cut, WHO)).toEqual({ type: 'activity', kind: 'write_file', detail: 'Отчёт.pdf' });
  });

  it('оборванное посередине значение не показывается', () => {
    expect(toActivity('WebSearch', '{"query":"очень длинный запрос, который обре', WHO))
      .toEqual({ type: 'activity', kind: 'web_search' });
  });

  it('загрузка: префикс сессии релея срезан, латинское имя видно', () => {
    expect(toActivity('Read', json({ file_path: `/tmp/agent-uploads/${PHONE}_12_ru_egrul.pdf` }), WHO))
      .toEqual({ type: 'activity', kind: 'read_upload', detail: 'egrul.pdf' });
  });

  it('загрузка с кириллическим именем — без имени: релей заменил буквы подчёркиваниями', () => {
    expect(toActivity('Read', json({ file_path: `/tmp/agent-uploads/${PHONE}_12_ru_______.pdf` }), WHO))
      .toEqual({ type: 'activity', kind: 'read_upload' });
    expect(toActivity('Read', json({ file_path: `/tmp/agent-uploads/${PHONE}_12_ru_2024______.pdf` }), WHO))
      .toEqual({ type: 'activity', kind: 'read_upload' });
  });

  it('незнакомый префикс загрузки: телефон остался в имени — имени нет', () => {
    expect(toActivity('Read', json({ file_path: `/tmp/agent-uploads/${PHONE}_12_report.pdf` }), WHO))
      .toEqual({ type: 'activity', kind: 'read_upload' });
  });

  it('UUID пользователя с почтовым входом тоже не уходит наружу', () => {
    const a = toActivity('Read', json({ file_path: `/tmp/agent-uploads/${UUID}_5_report.pdf` }), { userId: UUID });
    expect(a).toEqual({ type: 'activity', kind: 'read_upload' });
  });

  it('ключ сессии релея обрезается до 48 символов (relay-agent/paths.mjs, SESSION_KEY_MAX) — из имени файла длинный ключ целиком не собрать', () => {
    const longSession = `${UUID}_123456789_ru_fresh_start_of_a_very_long_relay_session_key`;
    expect(longSession.length).toBeGreaterThan(48);
    const fsKey = longSession.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
    const who = { userId: PHONE, relaySessionId: longSession };
    const a = toActivity('Read', json({ file_path: `/tmp/agent-uploads/${fsKey}_report.pdf` }), who);
    expect(a).toEqual({ type: 'activity', kind: 'read_upload', detail: 'report.pdf' });
    expect(JSON.stringify(a)).not.toContain(longSession);
  });

  it('релей-фолбэк «<ключ>_<uuid>», когда основное имя не легло на диск — тоже без имени', () => {
    const fallbackUuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    expect(toActivity('Read', json({ file_path: `/tmp/agent-uploads/${PHONE}_12_ru_${fallbackUuid}.pdf` }), WHO))
      .toEqual({ type: 'activity', kind: 'read_upload' });
  });

  it('Edit — тоже запись, имя видно из результатов', () => {
    expect(toActivity('Edit', json({ file_path: `/tmp/agent-output/${WHO.relaySessionId}/report.docx` }), WHO))
      .toEqual({ type: 'activity', kind: 'write_file', detail: 'report.docx' });
  });

  it('чтение результата — имя видно', () => {
    expect(toActivity('Read', json({ file_path: `/tmp/agent-output/${WHO.relaySessionId}/summary.txt` }), WHO))
      .toEqual({ type: 'activity', kind: 'read_file', detail: 'summary.txt' });
  });

  it('телефон пользователя в человеческом форматировании тоже не уходит наружу', () => {
    expect(toActivity('WebSearch', json({ query: 'кто звонил с +7 903 016-91-87 вчера' }), WHO))
      .toEqual({ type: 'activity', kind: 'web_search' });
  });

  it('внутренние хосты и IP-адреса не показываем', () => {
    expect(toActivity('WebFetch', json({ url: 'http://127.0.0.1:3033/x' }), WHO))
      .toEqual({ type: 'activity', kind: 'web_fetch' });
    expect(toActivity('WebFetch', json({ url: 'http://localhost/x' }), WHO))
      .toEqual({ type: 'activity', kind: 'web_fetch' });
  });

  it('пути вне папок загрузок и результатов — без имени', () => {
    expect(toActivity('Read', json({ file_path: '/home/dv/file-agent/scripts/hd_bodygraph.py' }), WHO))
      .toEqual({ type: 'activity', kind: 'read_file' });
    expect(toActivity('Write', json({ file_path: '/home/dv/.bashrc' }), WHO))
      .toEqual({ type: 'activity', kind: 'write_file' });
  });

  it('служебный sleep не показывается вовсе', () => {
    expect(toActivity('Bash', json({ command: 'sleep 4' }), WHO)).toBeNull();
  });

  it('прочий Bash — без команды', () => {
    expect(toActivity('Bash', json({ command: `python3 /tmp/x.py ${PHONE}` }), WHO))
      .toEqual({ type: 'activity', kind: 'compute' });
  });

  it('уточнение — в одну строку и не длиннее 80 символов', () => {
    const a = toActivity('WebSearch', json({ query: `строка\nперевод ${'я'.repeat(200)}` }), WHO)!;
    expect(a.detail!.length).toBeLessThanOrEqual(80);
    expect(a.detail).not.toMatch(/\n/);
  });

  it('запрос с телефоном пользователя — без уточнения', () => {
    expect(toActivity('WebSearch', json({ query: `кто звонил с ${PHONE}` }), WHO))
      .toEqual({ type: 'activity', kind: 'web_search' });
  });

  it.each<[string, ActivityKind]>([
    ['Glob', 'search_files'], ['Grep', 'search_files'],
    ['mcp__linkeon__generate_image', 'image_generate'], ['mcp__linkeon__generate_banner', 'image_generate'],
    ['mcp__linkeon__edit_image', 'image_edit'], ['mcp__linkeon__compose_image', 'image_edit'],
    ['mcp__linkeon__upscale_image', 'image_edit'], ['mcp__linkeon__generate_video', 'video'],
    ['mcp__linkeon__generate_speech', 'speech'], ['mcp__linkeon__read_calendar', 'calendar_read'],
    ['mcp__linkeon__propose_calendar_event', 'calendar_propose'], ['mcp__linkeon__manage_routine', 'routine'],
    ['mcp__talerid__list_notes', 'notes'], ['mcp__talerid__create_note', 'notes'],
    ['mcp__talerid__update_note', 'notes'], ['mcp__talerid__delete_note', 'notes'],
    ['mcp__talerid__list_contacts', 'messages_read'], ['mcp__talerid__list_conversations', 'messages_read'],
    ['mcp__talerid__get_messages', 'messages_read'], ['mcp__talerid__search_messages', 'messages_read'],
    ['mcp__talerid__send_message', 'message_send'], ['mcp__talerid__check_mail', 'mail_read'],
    ['mcp__talerid__read_mail', 'mail_read'], ['mcp__talerid__send_mail', 'mail_send'],
    ['mcp__products__manage_product', 'product'],
    ['mcp__linkeon__something_new', 'other'], ['TodoWrite', 'other'],
  ])('%s → %s', (tool, kind) => {
    expect(toActivity(tool, '{}', WHO)).toEqual({ type: 'activity', kind });
  });

  it('в событии нет полей, которые Flutter вклеил бы в текст ответа', () => {
    const input = json({ query: 'q', url: 'https://a.b/c', file_path: '/tmp/agent-output/s/a.txt', command: 'ls' });
    for (const tool of ['WebSearch', 'WebFetch', 'Read', 'Write', 'Bash', 'Glob', 'mcp__products__manage_product', 'x']) {
      const a = toActivity(tool, input, WHO);
      expect(a).not.toBeNull();
      for (const k of ['text', 'content', 'delta']) expect(a).not.toHaveProperty(k);
    }
  });

  it('без имени инструмента шага нет', () => {
    expect(toActivity(undefined, '{}', WHO)).toBeNull();
    expect(toActivity('', '{}', WHO)).toBeNull();
  });
});
