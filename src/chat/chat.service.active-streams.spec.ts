import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');

/**
 * Счётчик ходов в полёте — чтобы деплой знал, кого он вот-вот порвёт.
 *
 * 2026-08-10 в 20:22:12 UTC выкат перезапустил linkeon-api через 58 секунд
 * после того, как пользователь отправил вопрос на 27 274 символа. Ход убило
 * посреди стрима: ответа не появилось вообще (заглушка «попробуйте ещё раз»
 * пишется в persistResponse того же процесса), пользователь полтора часа ждал
 * молча, а релей ещё три минуты доделывал работу на ≈$25 в никуда.
 *
 * inflight-мапа для этого не годится: её TTL 10 минут, а рвать опаснее всего
 * как раз двадцатиминутные ходы юридических ассистентов.
 *
 * Во всех сценариях поток отдаёт хотя бы одну delta. Пустой поток уводит код в
 * self-heal-ретрай (повторный запрос к upstream), и тест мерил бы уже не то.
 */

const DELTA = 'data: ' + JSON.stringify({ type: 'delta', text: 'ответ' }) + '\n';
const DONE = 'data: ' + JSON.stringify({ type: 'done', costUsd: 0.1 }) + '\n';

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  return new ChatService(
    pg as any, null as any, null as any, null as any, null as any,
    null as any, null as any, language as any, undefined /* balanceCtx */,
    undefined, undefined, undefined,
  );
}

/** Запускает ход и возвращает поток, которым можно управлять руками. */
function startTurn(svc: ChatService, userId: string) {
  const upstream = new Readable({ read() {} });
  (axios.post as jest.Mock).mockResolvedValueOnce({ data: upstream });
  const res: any = {
    status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn(),
  };
  const done = (svc as any).streamUniversalAgent(
    userId, 'привет', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
  );
  return { upstream, done };
}

/** Прокручивает микротаски, пока ход не доберётся до upstream. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

describe('счётчик ходов в полёте', () => {
  afterEach(() => jest.clearAllMocks());

  it('до первого хода никого нет', () => {
    expect(makeService().getActiveStreamCount()).toBe(0);
  });

  it('пока ход идёт — считается, после завершения освобождается', async () => {
    const svc = makeService();
    const t = startTurn(svc, 'u1');
    t.upstream.push(DELTA);
    await settle();

    expect(svc.getActiveStreamCount()).toBe(1);

    t.upstream.push(DONE);
    t.upstream.push(null);
    await t.done;

    expect(svc.getActiveStreamCount()).toBe(0);
  });

  it('оборванный upstream не залипает в счётчике', async () => {
    // Иначе одна ошибка сети навсегда заблокировала бы деплой.
    const svc = makeService();
    const t = startTurn(svc, 'u1');
    t.upstream.push(DELTA);
    await settle();
    expect(svc.getActiveStreamCount()).toBe(1);

    t.upstream.destroy(new Error('upstream оборвался'));
    await t.done;

    expect(svc.getActiveStreamCount()).toBe(0);
  });

  it('параллельные ходы считаются по одному', async () => {
    const svc = makeService();
    const first = startTurn(svc, 'u1');
    first.upstream.push(DELTA);
    await settle();

    const second = startTurn(svc, 'u2');
    second.upstream.push(DELTA);
    await settle();

    expect(svc.getActiveStreamCount()).toBe(2);

    second.upstream.push(DONE);
    second.upstream.push(null);
    await second.done;
    expect(svc.getActiveStreamCount()).toBe(1);

    first.upstream.push(DONE);
    first.upstream.push(null);
    await first.done;
    expect(svc.getActiveStreamCount()).toBe(0);
  });
});
