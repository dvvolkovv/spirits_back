import { Readable } from 'stream';
import axios from 'axios';
import { ChatService, RelaySessionBusyError } from './chat.service';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

/**
 * Бэклог e777aa94: фоновые ответы (рутины, «Путь») шли в основную сессию
 * релея мимо учёта ходов и пре-эмптили живой ход человека. Теперь agentReply
 * регистрируется в relayRunning/activeStreams, а занятой сессии — атомарно
 * отказывает (RelaySessionBusyError): человек важнее, routine-push откладывает.
 * activeTurns сознательно НЕ ставится — кабинет человека не блокируется.
 */

const AGENT = { id: 12, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'business' };

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/FROM agents WHERE id/.test(sql)) return { rows: [AGENT] };
      if (/SELECT profile_data FROM ai_profiles_consolidated/.test(sql)) {
        return { rows: [{ profile_data: {} }] };
      }
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  return new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined, undefined, undefined, undefined);
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
  beforeEach(() => jest.clearAllMocks());

  it('виден в relayRunning/activeStreams, но НЕ в activeTurns; после — снят', async () => {
    const svc = makeService();
    let release!: (v: any) => void;
    (axios.post as jest.Mock).mockImplementationOnce(() => new Promise((res) => { release = res; }));

    const done = svc.generateAgentReply('u-1', '12', 'напомни');
    await flush();

    expect(svc.getActiveStreamCount()).toBe(1);
    expect((svc as any).relayRunning.has('u-1_12_ru')).toBe(true);
    // Кабинет человека фоновая работа не блокирует.
    expect(svc.getActiveTurn('u-1', '12').active).toBe(false);

    release({ data: sseDone() });
    await expect(done).resolves.toBe('ок');

    expect(svc.getActiveStreamCount()).toBe(0);
    expect((svc as any).relayRunning.size).toBe(0);
  });

  it('занятая сессия — RelaySessionBusyError без вызова релея (не пре-эмптим)', async () => {
    const svc = makeService();
    (axios.post as jest.Mock).mockImplementation(async () => ({ data: sseDone() }));
    const humanMark = svc.beginRelayRun('u-1_12_ru');

    await expect(svc.generateAgentReply('u-1', '12', 'напомни')).rejects.toBeInstanceOf(RelaySessionBusyError);
    expect(axios.post).not.toHaveBeenCalled();
    // Метка человека не тронута.
    expect((svc as any).relayRunning.get('u-1_12_ru')).toBe(humanMark);
    expect(svc.getActiveStreamCount()).toBe(0);

    svc.endRelayRun('u-1_12_ru', humanMark);
    // Освободилась — проходит.
    await expect(svc.generateAgentReply('u-1', '12', 'напомни')).resolves.toBe('ок');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('два фоновых подряд: второй получает busy, первый не пострадал', async () => {
    const svc = makeService();
    let release!: (v: any) => void;
    (axios.post as jest.Mock).mockImplementationOnce(() => new Promise((res) => { release = res; }));
    const first = svc.generateAgentReply('u-1', '12', 'первая');
    await flush();

    await expect(svc.generateAgentReply('u-1', '12', 'вторая')).rejects.toBeInstanceOf(RelaySessionBusyError);

    release({ data: sseDone() });
    await expect(first).resolves.toBe('ок');
    expect((svc as any).relayRunning.size).toBe(0);
  });

  it('своя sessionIdOverride: relay/activeStreams учитываются, activeTurns — нет', async () => {
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
    expect(svc.getActiveStreamCount()).toBe(0);
    expect((svc as any).relayRunning.size).toBe(0);
  });

  it('EOF без done в основной сессии — busy, обрезанный текст не уходит', async () => {
    const svc = makeService();
    (axios.post as jest.Mock).mockImplementationOnce(async () => {
      const s = new Readable({ read() {} });
      process.nextTick(() => {
        s.push(`data: ${JSON.stringify({ type: 'delta', text: 'обрыв на полус' })}\n`);
        s.push(null); // EOF без done — человек пре-эмптил или релей упал
      });
      return { data: s };
    });

    await expect(svc.generateAgentReply('u-1', '12', 'напомни')).rejects.toBeInstanceOf(RelaySessionBusyError);
    expect(svc.getActiveStreamCount()).toBe(0);
    expect((svc as any).relayRunning.size).toBe(0);
  });

  it('done с failed в основной сессии — busy на повтор', async () => {
    const svc = makeService();
    (axios.post as jest.Mock).mockImplementationOnce(async () => {
      const s = new Readable({ read() {} });
      process.nextTick(() => {
        s.push(`data: ${JSON.stringify({ type: 'delta', text: 'часть' })}\n`);
        s.push(`data: ${JSON.stringify({ type: 'done', failed: true, failReason: 'preempted' })}\n`);
        s.push(null);
      });
      return { data: s };
    });

    await expect(svc.generateAgentReply('u-1', '12', 'напомни')).rejects.toBeInstanceOf(RelaySessionBusyError);
  });

  it('EOF без done в СВОЕЙ сессии — прежнее поведение: текст как есть', async () => {
    const svc = makeService();
    (axios.post as jest.Mock).mockImplementationOnce(async () => {
      const s = new Readable({ read() {} });
      process.nextTick(() => {
        s.push(`data: ${JSON.stringify({ type: 'delta', text: 'итоги' })}\n`);
        s.push(null);
      });
      return { data: s };
    });

    await expect(svc.generateAgentReply('u-1', '12', 'итоги', 'voice_summary_1')).resolves.toBe('итоги');
  });
});
