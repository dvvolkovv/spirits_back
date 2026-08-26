import { VoiceCallService } from './voice-call.service';

function makeDeps(historyRows: any[] = []) {
  const inserted: any[] = [];
  const pg = {
    inserted,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM custom_chat_history/i.test(sql)) return { rows: historyRows, rowCount: historyRows.length };
      if (/INSERT INTO custom_chat_history/i.test(sql)) { inserted.push(params); return { rows: [], rowCount: 1 }; }
      // Проверка «нет ли уже живого звонка» — по умолчанию нет.
      if (/SELECT id FROM voice_calls/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM voice_calls/i.test(sql)) {
        return { rows: [{ id: 'call-1', user_id: 'u1', room_name: 'room-1', status: 'active', started_at: new Date(Date.now() - 60_000) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const chat = { generateAgentReply: jest.fn(async () => 'краткое резюме звонка') };
  const livekit = { userToken: jest.fn(async () => 'jwt-token'), dispatchAgent: jest.fn(async () => {}), send: jest.fn(async () => {}) };
  return { pg, chat, livekit };
}

describe('VoiceCallService', () => {
  it('на пустой истории preamble пустой', async () => {
    const d = makeDeps([]);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    expect(await svc.buildPreamble('u1')).toBe('');
  });

  it('короткую историю отдаёт как есть, без похода в LLM', async () => {
    const d = makeDeps([
      { sender_type: 'human', content: 'привет' },
      { sender_type: 'ai', content: 'здравствуйте' },
    ]);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    const p = await svc.buildPreamble('u1');
    expect(p).toContain('привет');
    expect(p).toContain('здравствуйте');
    expect(d.chat.generateAgentReply).not.toHaveBeenCalled();
  });

  it('длинную историю обрезает по бюджету и НЕ ходит в LLM', async () => {
    // Сжатие через LLM стоило ~40 секунд тишины перед тем, как Роман вообще
    // входил в комнату: preamble считается до dispatchAgent. У реального
    // пользователя в последних 20 сообщениях 21 987 символов, так что
    // срабатывало всегда. Живой звонок 25.08.2026.
    const long = Array.from({ length: 20 }, () => ({ sender_type: 'human', content: 'х'.repeat(300) }));
    const d = makeDeps(long);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);

    const started = Date.now();
    const p = await svc.buildPreamble('u1');

    expect(d.chat.generateAgentReply).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(100);
    expect(p.length).toBeLessThanOrEqual(1800);
    expect(p.length).toBeGreaterThan(0);
  });

  it('в preamble попадают самые свежие реплики, а не самые старые', async () => {
    // Строки приходят из БД по created_at DESC; берём с начала списка, пока
    // хватает бюджета, и разворачиваем — иначе в контекст уехала бы древность.
    const rows = [
      { sender_type: 'human', content: 'САМОЕ СВЕЖЕЕ' },
      ...Array.from({ length: 19 }, (_, i) => ({ sender_type: 'ai', content: `старое ${i} ` + 'я'.repeat(200) })),
    ];
    const d = makeDeps(rows);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    const p = await svc.buildPreamble('u1');
    expect(p).toContain('САМОЕ СВЕЖЕЕ');
  });

  it('start отдаёт токен и зовёт воркера', async () => {
    const d = makeDeps([]);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    const res = await svc.start('u1');
    expect(res.token).toBe('jwt-token');
    expect(res.roomName).toMatch(/^voice_/);
    expect(d.livekit.dispatchAgent).toHaveBeenCalledWith(res.roomName, expect.objectContaining({ callId: res.callId }));
  });

  it('complete пишет карточку в историю чата с тегом voice_call', async () => {
    const d = makeDeps([]);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    await svc.complete('call-1', {
      transcript: [{ role: 'user', text: 'привет', ts: 1 }, { role: 'assistant', text: 'здравствуйте', ts: 2 }],
      usage: { audioInputTokens: 600, audioOutputTokens: 1200, model: 'gpt-realtime-2.1' },
    });
    const card = d.pg.inserted.find((p) => String(p[2]).includes('{{voice_call:'));
    expect(card).toBeDefined();
    expect(String(card[2])).toContain('{{voice_call: id=call-1}}');
  });

  it('стоимость считается по ставкам аудио-токенов', () => {
    const svc = new VoiceCallService({} as any, {} as any, {} as any);
    expect(svc.costUsd(600, 1200)).toBeCloseTo(600 / 1e6 * 32 + 1200 / 1e6 * 64, 6);
  });

  it('у mini свои ставки, иначе цена завышена в 3.2 раза', () => {
    const svc = new VoiceCallService({} as any, {} as any, {} as any);
    const flagship = svc.costUsd(600, 1200, 'gpt-realtime-2.1');
    const mini = svc.costUsd(600, 1200, 'gpt-realtime-2.1-mini');
    expect(mini).toBeCloseTo(600 / 1e6 * 10 + 1200 / 1e6 * 20, 6);
    expect(flagship / mini).toBeCloseTo(3.2, 5);
  });

  it('строка учёта пишется completed, иначе крон спишет токены с баланса', async () => {
    const d = makeDeps([]);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    await svc.complete('call-1', {
      transcript: [{ role: 'user', text: 'привет', ts: 1 }],
      usage: { audioInputTokens: 600, audioOutputTokens: 1200, model: 'gpt-realtime-2.1' },
    });
    const call = d.pg.query.mock.calls.find(
      (c: any[]) => /INSERT INTO token_consumption_tasks/i.test(c[0]),
    );
    expect(call).toBeDefined();
    // TokenAccountingService забирает 'pending' и при tokens_to_consume = 0
    // считает сумму сам — со 'pending' звонок списывал бы 1800 токенов в минуту.
    expect(call![0]).toContain("'completed'");
    expect(call![0]).not.toContain("'pending'");
  });

  it('повторный complete не создаёт вторую карточку', async () => {
    const d = makeDeps([]);
    d.pg.query = jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM voice_calls/i.test(sql)) {
        return { rows: [{ id: 'call-1', user_id: 'u1', room_name: 'room-1', status: 'completed', started_at: new Date() }], rowCount: 1 };
      }
      if (/INSERT INTO custom_chat_history/i.test(sql)) { d.pg.inserted.push(params); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 1 };
    }) as any;
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    await svc.complete('call-1', {
      transcript: [{ role: 'user', text: 'привет', ts: 1 }],
      usage: { audioInputTokens: 1, audioOutputTokens: 1, model: 'm' },
    });
    expect(d.pg.inserted).toHaveLength(0);
  });

  it('второй звонок при живом первом отклоняется', async () => {
    const d = makeDeps([]);
    d.pg.query = jest.fn(async (sql: string) => {
      if (/SELECT id FROM voice_calls/i.test(sql)) return { rows: [{ id: 'уже-идёт' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }) as any;
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    await expect(svc.start('u1')).rejects.toMatchObject({ status: 409 });
    expect(d.livekit.dispatchAgent).not.toHaveBeenCalled();
  });

  it('положить трубку — закрывает комнату, а не только красит строку', async () => {
    const d = makeDeps([]);
    d.pg.query = jest.fn(async (sql: string) => {
      if (/UPDATE voice_calls SET status = 'interrupted'/i.test(sql)) {
        return { rows: [{ room_name: 'room-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }) as any;
    const livekit = { ...d.livekit, closeRoom: jest.fn(async () => {}) };
    const svc = new VoiceCallService(d.pg as any, d.chat as any, livekit as any);
    await svc.markInterrupted('call-1');
    expect(livekit.closeRoom).toHaveBeenCalledWith('room-1');
  });
});
