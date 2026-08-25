import { VoiceCallService } from './voice-call.service';

function makeDeps(historyRows: any[] = []) {
  const inserted: any[] = [];
  const pg = {
    inserted,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM custom_chat_history/i.test(sql)) return { rows: historyRows, rowCount: historyRows.length };
      if (/INSERT INTO custom_chat_history/i.test(sql)) { inserted.push(params); return { rows: [], rowCount: 1 }; }
      if (/FROM voice_calls/i.test(sql)) {
        return { rows: [{ id: 'call-1', user_id: 'u1', room_name: 'room-1', started_at: new Date(Date.now() - 60_000) }], rowCount: 1 };
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

  it('длинную историю сжимает через LLM', async () => {
    const long = Array.from({ length: 20 }, () => ({ sender_type: 'human', content: 'х'.repeat(300) }));
    const d = makeDeps(long);
    const svc = new VoiceCallService(d.pg as any, d.chat as any, d.livekit as any);
    const p = await svc.buildPreamble('u1');
    expect(d.chat.generateAgentReply).toHaveBeenCalled();
    expect(p).toBe('краткое резюме звонка');
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
});
