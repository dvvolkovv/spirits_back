import { VoiceCallService } from './voice-call.service';
import { ContextService } from '../context/context.service';
import { ChatContextResetService } from '../chat/context-reset/context-reset.service';

/**
 * «Чистый лист» (spec 2026-11-17-context-reset) у голоса Романа.
 *
 * Преамбула звонка — профиль собеседника и последние сообщения основной ленты
 * `${userId}_12`. После точки в ней остаётся профиль и только разговор после
 * неё: иначе Роман по телефону вспомнил бы то, что в чате уже забыто.
 *
 * Конструктор VoiceCallService: pg, chat, livekit, neo4j?, businessProfile?,
 * attendee?, context?, contextResets? — сервис точки восьмой, последний.
 * Без ContextService преамбулу собирает старая сборка (buildPreambleLegacy);
 * с ним — ContextService, раздел «Из переписки».
 */
const RESET = new Date('2026-11-17T00:00:00Z');

const ROWS = () => [
  { sender_type: 'human', content: 'НОВОЕ', created_at: '2026-11-17T09:00:00Z' },
  { sender_type: 'ai', content: 'ОТВЕТ-НОВЫЙ', created_at: new Date('2026-11-17T00:00:01Z') },
  { sender_type: 'human', content: 'СТАРОЕ', created_at: '2026-11-10T09:00:00Z' },
  { sender_type: 'ai', content: 'ОТВЕТ-СТАРЫЙ', created_at: new Date('2026-11-16T23:59:59Z') },
];

function makeDeps(historyRows: any[], startedAt = new Date(Date.now() - 600_000)) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/FROM custom_chat_history/i.test(sql)) return { rows: historyRows, rowCount: historyRows.length };
      if (/SELECT id FROM voice_calls/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM voice_calls/i.test(sql)) {
        return { rows: [{ id: 'call-1', user_id: 'u1', room_name: 'room-1', status: 'active', started_at: startedAt }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const chat = {
    generateAgentReply: jest.fn(async () => 'резюме'),
    consolidateAfterChatPublic: jest.fn(async () => {}),
  };
  const livekit = { userToken: jest.fn(async () => 'jwt'), dispatchAgent: jest.fn(async () => {}), send: jest.fn(async () => {}) };
  const neo4j = { getProfileDescription: jest.fn(async () => 'ПРОФИЛЬ: основатель голосового сервиса') };
  return { pg, chat, livekit, neo4j };
}

const resetsWith = (get: jest.Mock) => ({ get }) as unknown as ChatContextResetService;

/** Старая сборка: ContextService не поднят. */
function legacySvc(d: ReturnType<typeof makeDeps>, resets?: ChatContextResetService) {
  return new VoiceCallService(
    d.pg as any, d.chat as any, d.livekit as any, d.neo4j as any, undefined, undefined, undefined, resets,
  );
}

describe('голос Романа: преамбула после точки «Чистого листа»', () => {
  it('после точки в преамбуле нет старых сообщений, профиль остаётся', async () => {
    const d = makeDeps(ROWS());
    const get = jest.fn(async () => RESET);

    const p = await legacySvc(d, resetsWith(get)).buildPreamble('u1');

    expect(p).toContain('ПРОФИЛЬ: основатель голосового сервиса');
    expect(p).toContain('НОВОЕ');
    expect(p).toContain('ОТВЕТ-НОВЫЙ');
    expect(p).not.toContain('СТАРОЕ');
    expect(p).not.toContain('ОТВЕТ-СТАРЫЙ');
    expect(get).toHaveBeenCalledWith('u1', '12');
  });

  it('created_at выбирается из базы — без него точка отбросила бы всё', async () => {
    const d = makeDeps(ROWS());
    await legacySvc(d, resetsWith(jest.fn(async () => RESET))).buildPreamble('u1');

    const sql = d.pg.query.mock.calls.map((c: any[]) => String(c[0])).find((q) => /FROM custom_chat_history/i.test(q))!;
    expect(sql).toMatch(/SELECT\s[^]*?\bcreated_at\b[^]*?\bFROM custom_chat_history/);
  });

  it('после точки ничего нового — преамбула из одного профиля', async () => {
    const d = makeDeps(ROWS().filter((r) => /СТАР/.test(r.content)));

    const p = await legacySvc(d, resetsWith(jest.fn(async () => RESET))).buildPreamble('u1');

    expect(p).toBe('Что известно о собеседнике:\nПРОФИЛЬ: основатель голосового сервиса');
  });

  it('без точки — переписка целиком, как раньше', async () => {
    const d = makeDeps(ROWS());

    const p = await legacySvc(d, resetsWith(jest.fn(async () => null))).buildPreamble('u1');

    expect(p).toContain('НОВОЕ');
    expect(p).toContain('СТАРОЕ');
  });

  it('сбой чтения точки — преамбула без фильтра, звонок не срывается', async () => {
    const d = makeDeps(ROWS());
    const svc = legacySvc(d, resetsWith(jest.fn(async () => { throw new Error('pg прилёг'); })));
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    const p = await svc.buildPreamble('u1');

    expect(p).toContain('НОВОЕ');
    expect(p).toContain('СТАРОЕ');
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('u1_12');
    expect(logged).not.toContain('СТАРОЕ');
  });

  it('через ContextService (прод): старой переписки в преамбуле нет', async () => {
    const d = makeDeps(ROWS());
    const resets = resetsWith(jest.fn(async () => RESET));
    const context = new ContextService(d.pg as any, undefined, undefined, undefined, undefined, resets);
    const svc = new VoiceCallService(
      d.pg as any, d.chat as any, d.livekit as any, undefined, undefined, undefined, context, resets,
    );

    const p = await svc.buildPreamble('u1');

    expect(p).toContain('НОВОЕ');
    expect(p).not.toContain('СТАРОЕ');
  });

  it('сервис точки в конструкторе — класс, а не import type (сторож design:paramtypes)', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', VoiceCallService);
    expect(paramTypes).toContain(ChatContextResetService);
  });
});

describe('голос Романа: задачи из звонка датируются началом звонка', () => {
  const talk = [
    { role: 'user' as const, text: 'Надо до пятницы отправить договор', ts: 1 },
    { role: 'assistant' as const, text: 'Записал, напомню', ts: 2 },
  ];
  const usage = { audioInputTokens: 600, audioOutputTokens: 1200, model: 'gpt-realtime-2.1' };

  it('consolidateAfterChatPublic получает пятым аргументом момент начала звонка', async () => {
    // Задача, извлечённая в фоне после звонка, иначе получила бы created_at =
    // now() вставки — и проскочила бы точку, поставленную после разговора.
    const startedAt = new Date(Date.now() - 600_000);
    const d = makeDeps([], startedAt);
    const svc = legacySvc(d);

    const before = Date.now();
    await svc.complete('call-1', { transcript: talk, usage });
    await new Promise((r) => setImmediate(r));

    expect(d.chat.consolidateAfterChatPublic).toHaveBeenCalledTimes(1);
    const turnAt = (d.chat.consolidateAfterChatPublic.mock.calls[0] as any[])[4];
    expect(turnAt).toBeInstanceOf(Date);
    expect((turnAt as Date).getTime()).toBe(startedAt.getTime());
    // Не момент сохранения.
    expect((turnAt as Date).getTime()).toBeLessThan(before);
  });

  it('начало звонка строкой (как бывает у драйвера) — тоже Date', async () => {
    const startedAt = new Date(Date.now() - 300_000);
    const d = makeDeps([], startedAt.toISOString() as any);
    const svc = legacySvc(d);

    await svc.complete('call-1', { transcript: talk, usage });
    await new Promise((r) => setImmediate(r));

    const turnAt = (d.chat.consolidateAfterChatPublic.mock.calls[0] as any[])[4];
    expect(turnAt).toBeInstanceOf(Date);
    expect((turnAt as Date).getTime()).toBe(startedAt.getTime());
  });
});
