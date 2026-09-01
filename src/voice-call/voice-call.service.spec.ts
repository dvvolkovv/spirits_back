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
        // input_tokens в запросе — литеральный ноль, а не параметр, поэтому
        // берём его из самого SQL, а из params — только то, что подставляется.
        charges.push({
          status: /VALUES[^)]*'(pending|completed)'/.exec(sql)?.[1],
          sql,
          agent_id: params[2],
          output: params[3],
          meta: JSON.parse(params[4] || '{}'),
        });
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
  const chat = {
    generateAgentReply: jest.fn(async () => 'краткое резюме звонка'),
    consolidateAfterChatPublic: jest.fn(async () => {}),
  };
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
    // input_tokens — литеральный ноль в самом запросе: если положить туда
    // сырые аудио-токены, крон сложит их с output и спишет вдвое больше.
    expect(call![0]).toMatch(/VALUES[^)]*,\s*0,\s*\$4/);
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

  it('новый звонок при незакрытом старом ВЫТЕСНЯЕТ его (не 409), закрывает старую комнату', async () => {
    // Грязный конец (краш/убитое приложение/оборванный disconnect) оставлял старый звонок в
    // 'dialing'/'active', и новый упирался в 409 без выхода. Теперь новый вытесняет старый.
    const d = makeDeps([]);
    d.pg.query = jest.fn(async (sql: string) => {
      if (/SELECT id FROM voice_calls/i.test(sql)) return { rows: [{ id: 'старый' }], rowCount: 1 };
      if (/UPDATE voice_calls SET status = 'interrupted'/i.test(sql)) return { rows: [{ room_name: 'old-room' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }) as any;
    const livekit = { ...d.livekit, closeRoom: jest.fn(async () => {}) };
    const svc = new VoiceCallService(d.pg as any, d.chat as any, livekit as any);
    const res = await svc.start('u1');
    expect(res.callId).toBeTruthy();
    expect(livekit.closeRoom).toHaveBeenCalledWith('old-room');   // старый звонок погашен
    expect(livekit.dispatchAgent).toHaveBeenCalled();             // новый — поднят
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
    // input_tokens зашит нулём в запросе — иначе крон сложит его с output.
    expect(c.sql).toMatch(/VALUES[^)]*,\s*0,\s*\$4/);
    // 600 входящих и 1200 исходящих аудио-токенов флагманской модели — это
    // $0.096, то есть 432 токена по общему курсу. Никак не 1800.
    expect(c.output).toBe(432);
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

describe('разговор наполняет профиль', () => {
  const talk = [
    { role: 'user' as const, text: 'Мы запускаем сервис голосовых ассистентов', ts: 1 },
    { role: 'assistant' as const, text: 'Понял, расскажите про рынок', ts: 2 },
    { role: 'user' as const, text: 'Целимся в малый бизнес', ts: 3 },
  ];

  it('после звонка разговор уходит в консолидацию', async () => {
    // До 27.08.2026 звонок не доходил ни до Neo4j, ни до задач, ни до
    // бизнес-профиля: разговор на 84 реплики не менял о человеке ничего.
    const d = makeDeps();
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);

    await svc.complete('call-1', {
      transcript: talk,
      usage: { audioInputTokens: 600, audioOutputTokens: 1200, model: 'gpt-realtime-2.1' },
    });
    await new Promise((r) => setImmediate(r));

    expect(d.chat.consolidateAfterChatPublic).toHaveBeenCalledTimes(1);
    const [, , said, answered] = d.chat.consolidateAfterChatPublic.mock.calls[0] as any[];
    // Стороны разложены по ролям, а не свалены в кучу.
    expect(said).toContain('запускаем сервис');
    expect(said).toContain('малый бизнес');
    expect(said).not.toContain('расскажите про рынок');
    expect(answered).toContain('расскажите про рынок');
  });

  it('молчаливый звонок в профиль не идёт — извлекать нечего', async () => {
    const d = makeDeps();
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);

    await svc.complete('call-1', {
      transcript: [{ role: 'assistant', text: 'Алло, я на связи', ts: 1 }],
      usage: { audioInputTokens: 10, audioOutputTokens: 10, model: 'gpt-realtime-2.1' },
    });
    await new Promise((r) => setImmediate(r));

    expect(d.chat.consolidateAfterChatPublic).not.toHaveBeenCalled();
  });

  it('падение консолидации не срывает сохранение разговора', async () => {
    // Транскрипт уже записан к этому моменту; профиль — дело фоновое.
    const d = makeDeps();
    d.chat.consolidateAfterChatPublic = jest.fn(async () => { throw new Error('Neo4j лёг'); }) as any;
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);

    await expect(svc.complete('call-1', {
      transcript: talk,
      usage: { audioInputTokens: 600, audioOutputTokens: 1200, model: 'gpt-realtime-2.1' },
    })).resolves.toBeUndefined();
  });

  it('Роман видит профиль собеседника, а не только переписку', async () => {
    const d = makeDeps([{ sender_type: 'human', content: 'привет' }]);
    const neo4j = { getProfileDescription: jest.fn(async () => 'Основатель, запускает голосовой сервис') };
    const biz = { renderForPrompt: jest.fn(async () => 'Бизнес: B2B SaaS') };
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any, neo4j as any, biz as any);

    const preamble = await svc.buildPreamble('u1');

    expect(preamble).toContain('Основатель, запускает голосовой сервис');
    expect(preamble).toContain('Бизнес: B2B SaaS');
    expect(preamble).toContain('привет'); // переписка на месте
    // Категорию передаём настоящую, а не подменяем на business.
    expect(biz.renderForPrompt.mock.calls.map((c: any[]) => c[1])[0]).toBe('assistant');
  });

  it('без профиля звонок не ломается — преамбула просто короче', async () => {
    const d = makeDeps([{ sender_type: 'human', content: 'привет' }]);
    const neo4j = { getProfileDescription: jest.fn(async () => { throw new Error('Neo4j недоступен'); }) };
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any, neo4j as any, undefined);

    await expect(svc.buildPreamble('u1')).resolves.toContain('привет');
  });

  // --- защита транскрипта от потери при сбое Realtime API / пересоздании сессии
  //     (owner 2026-09-01: потерялся 20-мин разговор — осталось только приветствие) ---

  function completeDeps(stagedTranscript: any[]) {
    let updatedTranscript: any[] | null = null;
    const pg = {
      get updatedTranscript() { return updatedTranscript; },
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (/UPDATE voice_calls SET status = 'completed'/i.test(sql)) {
          updatedTranscript = JSON.parse(params[1]);
          return { rows: [], rowCount: 1 };
        }
        if (/FROM voice_calls/i.test(sql)) {
          return { rows: [{ id: 'call-1', user_id: 'u1', room_name: 'room-1', status: 'active',
            started_at: new Date(Date.now() - 600_000), transcript: stagedTranscript }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const chat = { generateAgentReply: jest.fn(async () => 'резюме'), consolidateAfterChatPublic: jest.fn(async () => {}) };
    const livekit = { userToken: jest.fn(), dispatchAgent: jest.fn(), send: jest.fn(async () => {}) };
    return { pg, chat, livekit };
  }
  const usage = { audioInputTokens: 100, audioOutputTokens: 200, model: 'gpt-realtime' };

  it('complete: короткий финальный транскрипт НЕ затирает полный staged (пересозданная сессия)', async () => {
    const staged = [
      { role: 'user', text: 'первая', ts: 1 },
      { role: 'assistant', text: 'ответ', ts: 2 },
      { role: 'user', text: 'вторая', ts: 3 },
    ];
    const d = completeDeps(staged);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    // Финализатор донёс лишь приветствие — но staged содержит весь разговор.
    await svc.complete('call-1', { transcript: [{ role: 'assistant', text: 'Роман на связи', ts: 9 }], usage });
    expect(d.pg.updatedTranscript).toHaveLength(3);
    expect(d.pg.updatedTranscript!.map((t: any) => t.text)).toContain('вторая');
  });

  it('complete: если финальный полнее staged — берём финальный', async () => {
    const d = completeDeps([{ role: 'assistant', text: 'приветствие', ts: 1 }]);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    const full = [
      { role: 'assistant', text: 'приветствие', ts: 1 },
      { role: 'user', text: 'вопрос', ts: 2 },
      { role: 'assistant', text: 'ответ', ts: 3 },
    ];
    await svc.complete('call-1', { transcript: full, usage });
    expect(d.pg.updatedTranscript).toHaveLength(3);
  });

  it('progress: стейджит только если реплик больше сохранённого; пустой — no-op', async () => {
    const seen: { sql: string; params: any[] }[] = [];
    const pg = { query: jest.fn(async (sql: string, params: any[] = []) => { seen.push({ sql, params }); return { rows: [], rowCount: 1 }; }) };
    const svc = new VoiceCallService(pg as any, {} as any, {} as any);
    await svc.progress('call-1', [{ role: 'user', text: 'a', ts: 1 }, { role: 'assistant', text: 'b', ts: 2 }]);
    const updates = seen.filter((s) => /UPDATE voice_calls SET transcript/i.test(s.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0].params[2]).toBe(2); // length-guard: пишем только если < 2 сохранено
    await svc.progress('call-2', []); // пустой транскрипт — не трогаем БД
    expect(seen.filter((s) => /UPDATE voice_calls SET transcript/i.test(s.sql))).toHaveLength(1);
  });
});
