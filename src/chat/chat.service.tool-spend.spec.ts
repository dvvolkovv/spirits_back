import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * Число «X токенов» под ответом — ход плюс то, что инструменты списали за время
 * хода (картинки, видео, озвучка).
 *
 * Видео, упавшее до конца хода, уже возвращено (failAndRefund: статус 'failed'
 * и строка 'refund' в одной транзакции), но его tokens_spent в строке задачи
 * остаётся. Без фильтра по статусу оно попадало в число под сообщением: так
 * 01.11.2026 человек видел списание, которого на балансе уже не было, и писал
 * жалобу.
 */

const TURN_USD = 0.1;
const ANSWER = 'x'.repeat(100);

/** Задачи видео, созданные за время хода. */
const JOBS = [
  { tokens_spent: 216_000, status: 'failed' },
  { tokens_spent: 90_000, status: 'processing' },
];

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/AS spent/.test(sql) && /FROM video_jobs/.test(sql)) {
        // Честная заглушка: фильтр по статусу берётся из текста запроса.
        const skipsFailed = /FROM video_jobs WHERE[^)]*status\s*<>\s*'failed'/.test(sql);
        const spent = JOBS.filter((j) => !skipsFailed || j.status !== 'failed').reduce((a, j) => a + j.tokens_spent, 0);
        return { rows: [{ spent }] };
      }
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      if (/FROM speech_clips|FROM video_jobs|FROM calendar_proposals/.test(sql)) return { rows: [] };
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  return new ChatService(
    pg as any, null as any, null as any,
    null as any, language as any, undefined, undefined, undefined, undefined,
  );
}

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

describe('число под ответом: видео, возвращённое до конца хода, не считается', () => {
  it('упавшее видео (уже возвращено) — не в числе, видео в работе — в числе', async () => {
    const svc = makeService();
    (axios.post as jest.Mock).mockResolvedValueOnce({
      data: sseStream([
        { type: 'delta', text: ANSWER },
        { type: 'done', costUsd: TURN_USD, turnCostUsd: TURN_USD },
      ]),
    });
    const written: any[] = [];
    const res: any = {
      status: jest.fn(), setHeader: jest.fn(), end: jest.fn(),
      write: jest.fn((s: string) => { try { written.push(JSON.parse(s)); } catch {} return true; }),
    };

    await (svc as any).streamUniversalAgent(
      'u1', 'сделай видео', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
    );
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));

    const end = written.find((w) => w.type === 'end');
    // Ход считается тем же методом, что и в сервисе (курс — env, числом не зашит).
    const turn = (svc as any).computeSdkCharge(null, TURN_USD, ANSWER, TURN_USD).tokens;
    expect(end.usage.total).toBe(turn + 90_000);
  });
});
