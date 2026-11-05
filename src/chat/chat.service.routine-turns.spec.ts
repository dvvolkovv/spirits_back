import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

/**
 * Бэклог e777aa94: фоновые ответы (рутины, «Путь») шли в основную сессию
 * релея мимо учёта ходов — пре-эмптили живой ход человека, а deploy.sh их
 * не видел. Теперь agentReply ждёт конца чужого хода и регистрируется в
 * activeTurns / relayRunning / activeStreams.
 */

const AGENT = { id: 12, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'business' };

function makeService() {
  const pg = { query: jest.fn(async (sql: string) => (/FROM agents WHERE id/.test(sql) ? { rows: [AGENT] } : { rows: [] })) };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined, undefined, undefined, undefined);
  return svc;
}

function sseDone(): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    s.push(`data: ${JSON.stringify({ type: 'delta', text: 'ок' })}\n`);
    s.push(`data: ${JSON.stringify({ type: 'done' })}\n`);
    s.push(null);
  });
  return s;
}

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

describe('agentReply: учёт ходов и чужая работа в той же сессии', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });
  afterEach(() => jest.useRealTimers());

  it('во время ответа виден в activeTurns, relayRunning и activeStreams; после — снят', async () => {
    const svc = makeService();
    let release!: (v: any) => void;
    (axios.post as jest.Mock).mockImplementationOnce(() => new Promise((res) => { release = res; }));

    const done = svc.generateAgentReply('u-1', '12', 'напомни');
    await flush();

    expect(svc.getActiveTurn('u-1', '12').active).toBe(true);
    expect(svc.getActiveStreamCount()).toBe(1);
    expect((svc as any).relayRunning.has('u-1_12_ru')).toBe(true);

    release({ data: sseDone() });
    await expect(done).resolves.toBe('ок');

    expect(svc.getActiveTurn('u-1', '12').active).toBe(false);
    expect(svc.getActiveStreamCount()).toBe(0);
    expect((svc as any).relayRunning.size).toBe(0);
  });

  it('живой ход человека НЕ пре-эмптит: ждёт освобождения сессии', async () => {
    const svc = makeService();
    (axios.post as jest.Mock).mockImplementation(async () => ({ data: sseDone() }));
    const humanMark = svc.beginRelayRun('u-1_12_ru');

    const done = svc.generateAgentReply('u-1', '12', 'напомни');
    await flush();
    expect(axios.post).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000);
    expect(axios.post).not.toHaveBeenCalled();

    svc.endRelayRun('u-1_12_ru', humanMark);
    await jest.advanceTimersByTimeAsync(5_000);
    await done;

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect((svc as any).relayRunning.size).toBe(0);
    expect(svc.getActiveStreamCount()).toBe(0);
  });

  it('сессия занята дольше 30 минут — пустой ответ вместо пре-эмпта', async () => {
    const svc = makeService();
    (axios.post as jest.Mock).mockImplementation(async () => ({ data: sseDone() }));
    const humanMark = svc.beginRelayRun('u-1_12_ru');

    const done = svc.generateAgentReply('u-1', '12', 'напомни');
    await flush();
    await jest.advanceTimersByTimeAsync(31 * 60 * 1000);

    await expect(done).resolves.toBe('');
    expect(axios.post).not.toHaveBeenCalled();
    expect(svc.getActiveStreamCount()).toBe(0);
    svc.endRelayRun('u-1_12_ru', humanMark);
  });

  it('своя sessionIdOverride: activeTurns не ставится, relay/activeStreams учитываются', async () => {
    const svc = makeService();
    let release!: (v: any) => void;
    (axios.post as jest.Mock).mockImplementationOnce(() => new Promise((res) => { release = res; }));

    const done = svc.generateAgentReply('u-1', '12', 'итоги', 'voice_summary_1');
    await flush();

    expect(svc.getActiveTurn('u-1', '12').active).toBe(false);
    expect(svc.getActiveStreamCount()).toBe(1);
    expect((svc as any).relayRunning.has('voice_summary_1')).toBe(true);

    release({ data: sseDone() });
    await expect(done).resolves.toBe('ок');
    expect(svc.getActiveStreamCount()).toBe(0);
    expect((svc as any).relayRunning.size).toBe(0);
  });

  it('ошибка релея метки тоже снимает', async () => {
    const svc = makeService();
    (axios.post as jest.Mock).mockRejectedValueOnce(new Error('relay down'));

    await expect(svc.generateAgentReply('u-1', '12', 'напомни')).rejects.toThrow('relay down');
    expect(svc.getActiveTurn('u-1', '12').active).toBe(false);
    expect(svc.getActiveStreamCount()).toBe(0);
    expect((svc as any).relayRunning.size).toBe(0);
  });
});
