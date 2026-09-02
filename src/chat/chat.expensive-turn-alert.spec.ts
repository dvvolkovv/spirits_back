import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { SEAT_TOKENS_PER_USD } from '../common/billing-rates';
import { sendTelegramAlert } from '../common/telegram-alert';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
}));

const mockedAlert = sendTelegramAlert as jest.Mock;

/**
 * Порог алерта «дорогой ход».
 *
 * Считался в долларах ($1.5) — и на этом пороге алерт стал шумом: ход за $4
 * это 18 тыс. списанных токенов, для тяжёлых ассистентов норма. Решение
 * владельца 02.09.2026: считать в СПИСАННЫХ токенах и будить от 30 тысяч.
 *
 * Порог в токенах поедет при смене курса SEAT_TOKENS_PER_USD — это осознанный
 * размен: смотрим на то, что видит юзер в своём балансе, а не на нашу
 * себестоимость. Поэтому и ожидания здесь выводятся из курса, а не зашиты
 * числами: иначе смена курса покрасит тест, ничего не сказав о пороге.
 */

const usdFor = (tokens: number) => tokens / SEAT_TOKENS_PER_USD;

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

function makeHarness(costUsd: number) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/FROM speech_clips|FROM video_jobs|FROM calendar_proposals/.test(sql)) return { rows: [] };
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 743495 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, null as any, null as any,
    null as any, language as any, undefined, undefined, undefined, undefined,
  );

  (axios.post as jest.Mock).mockResolvedValue({
    data: sseStream([{ type: 'delta', text: 'ответ' }, { type: 'done', costUsd }]),
  });

  const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };

  return async () => {
    await (svc as any).streamUniversalAgent(
      'u1', 'привет', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
}

describe('алерт «дорогой ход»', () => {
  afterEach(() => jest.clearAllMocks());

  it('ход на 30 тыс. токенов будит — это и есть порог', async () => {
    const run = makeHarness(usdFor(30_000));
    await run();

    expect(mockedAlert).toHaveBeenCalledTimes(1);
    expect(String(mockedAlert.mock.calls[0][0])).toContain('Дорогой ход');
  });

  it('ход вдвое дешевле порога молчит — иначе алерт снова станет шумом', async () => {
    // Ровно тот случай, из-за которого порог и меняли: $4.03 / 18 114 токенов
    // на старом долларовом пороге поднимал тревогу.
    const run = makeHarness(usdFor(15_000));
    await run();

    expect(mockedAlert).not.toHaveBeenCalled();
  });

  it('в тексте — списанные токены и остаток баланса, а не только доллары', async () => {
    // По одной сумме в долларах непонятно, больно ли это конкретному юзеру.
    const run = makeHarness(usdFor(40_000));
    await run();

    const text = String(mockedAlert.mock.calls[0][0]);
    expect(text).toMatch(/40\s?000|40 000/);
    expect(text).toContain('743');
  });
});
