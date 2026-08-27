import { VoiceCallService } from './voice-call.service';

function makeDeps(historyRows: any[] = []) {
  const inserted: any[] = [];
  const charges: any[] = [];
  const pg = {
    inserted,
    charges,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM custom_chat_history/i.test(sql)) return { rows: historyRows, rowCount: historyRows.length };
      if (/INSERT INTO custom_chat_history/i.test(sql)) { inserted.push(params); return { rows: [], rowCount: 1 }; }
      if (/INSERT INTO token_consumption_tasks/i.test(sql)) {
        charges.push({ status: /'(pending|completed)'/.exec(sql)?.[1], agent_id: params[2], input: params[3], output: params[4], meta: JSON.parse(params[5] || '{}') });
        return { rows: [], rowCount: 1 };
      }
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

  it('карточка в ленте появляется ПОСЛЕ фонового резюме, а не блокирует complete', async () => {
    const d = makeDeps([]);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    await svc.complete('call-1', {
      transcript: [{ role: 'user', text: 'привет', ts: 1 }, { role: 'assistant', text: 'здравствуйте', ts: 2 }],
      usage: { audioInputTokens: 600, audioOutputTokens: 1200, model: 'gpt-realtime-2.1' },
    });

    // На момент возврата complete карточки ещё нет — резюме считается в фоне.
    expect(d.pg.inserted.find((p) => String(p[2]).includes('{{voice_call:'))).toBeUndefined();

    // Дать фоновой задаче отработать.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const card = d.pg.inserted.find((p) => String(p[2]).includes('{{voice_call:'));
    expect(card).toBeDefined();
    expect(String(card![2])).toContain('{{voice_call: id=call-1}}');
    expect(String(card![2])).toContain('краткое резюме звонка');
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

  it('строка учёта пишется pending — за разговор списывается', async () => {
    // Тест перевёрнут 27.08.2026 вместе с решением. Раньше он держал
    // обратное: 'completed', то есть «учитываем, но не списываем» — тариф за
    // минуту назначать было не из чего. После того как консультации
    // специалистов начали списываться, бесплатные минуты стали
    // непоследовательными.
    //
    // Опасность, из-за которой стоял 'completed', никуда не делась и закрыта
    // иначе: TokenAccountingService при tokens_to_consume = 0 складывает
    // input + output сам, поэтому в input идёт НОЛЬ, а в output —
    // пересчитанная цена. Сырые аудио-токены там означали бы 1800 в минуту.
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
    expect(call![0]).toContain("'pending'");
    expect(call![1][3]).toBe(0); // input_tokens
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

  it('транскрипт сохраняется СРАЗУ, не дожидаясь резюме от LLM', async () => {
    // 26.08.2026 так потерялся разговор на 11 минут: complete синхронно ждал
    // summarize (десятки секунд), воркер обрывал запрос по своему таймауту
    // в 15 секунд, и в БД оставалось interrupted с нулём реплик.
    const d = makeDeps([]);
    let resolveLlm: (v: string) => void = () => {};
    d.chat.generateAgentReply = jest.fn(() => new Promise<string>((r) => { resolveLlm = r; })) as never;
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);

    const started = Date.now();
    await svc.complete('call-1', {
      transcript: [{ role: 'user', text: 'привет', ts: 1 }],
      usage: { audioInputTokens: 600, audioOutputTokens: 1200, model: 'gpt-realtime-2.1' },
    });
    // complete вернулся, хотя LLM ещё висит.
    expect(Date.now() - started).toBeLessThan(200);

    const saved = d.pg.query.mock.calls.find(
      (c: any[]) => /UPDATE voice_calls SET status = 'completed'/i.test(c[0]),
    );
    expect(saved).toBeDefined();
    expect(String(saved![1][1])).toContain('привет');

    resolveLlm('резюме');
  });
});

describe('списание за минуты разговора', () => {
  it('в строку учёта идёт пересчитанная цена, а не сырые аудио-токены', async () => {
    // Аудио-токенов Realtime набегает 1800 на минуту (600 входящих + 1200
    // исходящих). Положи их как есть — TokenAccountingService сложит
    // input + output и спишет 1800 вместо реальных ~540.
    const d = makeDeps();
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);

    await svc.complete('call-1', {
      transcript: [{ role: 'user', text: 'привет', ts: 1 }],
      usage: { audioInputTokens: 600, audioOutputTokens: 1200, model: 'gpt-realtime-2.1' },
    });

    expect(d.pg.charges).toHaveLength(1);
    const c = d.pg.charges[0];
    expect(c.status).toBe('pending'); // с 'completed' крон строку не заберёт
    expect(c.input).toBe(0); // иначе крон сложит input с output
    expect(c.output).toBeGreaterThan(0);
    expect(c.output).toBeLessThan(1800); // не сырые аудио-токены
    // Сырые счётчики не теряются: без них не разобрать, из чего сложилась цена.
    expect(c.meta.audioInputTokens).toBe(600);
    expect(c.meta.audioOutputTokens).toBe(1200);
    expect(c.meta.kind).toBe('voice_call');
  });

  it('списанное сохраняется в самом звонке — карточка берёт цифру оттуда', async () => {
    const d = makeDeps();
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);

    await svc.complete('call-1', {
      transcript: [{ role: 'user', text: 'привет', ts: 1 }],
      usage: { audioInputTokens: 600, audioOutputTokens: 1200, model: 'gpt-realtime-2.1' },
    });

    const upd = d.pg.query.mock.calls.map((c: any[]) => c[0]).find((q: string) => /UPDATE voice_calls SET status = 'completed'/.test(q));
    expect(upd).toBeDefined();
    expect(upd).toContain('tokens_charged');
  });
});
