import { Readable } from 'stream';
import { ChatService } from './chat.service';
import { INTERRUPTED_TURN_NOTE, relayUndeliveredNote } from './interrupted-turn';
import { RelayDrainingError } from './relay-drain-retry';

jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * Пункт aa27b1d5: ход, который ждёт релей за шлагбаумом выката, не прерван —
 * его сообщение до модели ещё не дошло. Следующее сообщение той же сессии
 * говорит модели «не дошло» и несёт текст ждущего, а не «тот ход прерван».
 * Здесь — сами примитивы; проводка веба и загрузки — chat.relay-drain.spec.ts.
 */

const SID = 'u1_7_ru';

function makeService() {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const language = { resolveUserLanguage: jest.fn(async (_uid: string, hint?: string) => hint || 'ru') };
  return new ChatService(
    pg as any, null as any, null as any, null as any, language as any,
    undefined, undefined, undefined, undefined,
  );
}

const note = (svc: ChatService) => (svc as any).relayPendingNote(SID) as string;
const err503 = () => Object.assign(new Error('503'), { response: { status: 503, data: Readable.from([]) } });
const carry = { message: 'первое', files: ['a.pdf'] };

describe('ожидание релея за шлагбаумом', () => {
  it('свободная сессия — без заметки', () => {
    expect(note(makeService())).toBe('');
  });

  it('идущий ход — «тот ход прерван»', () => {
    const svc = makeService();
    svc.beginRelayRun(SID);
    expect(note(svc)).toBe(INTERRUPTED_TURN_NOTE);
  });

  it('ждущий ход — заметка о недошедшем с его текстом и файлами', () => {
    const svc = makeService();
    const mark = svc.beginRelayRun(SID);
    svc.markRelayWaiting(SID, mark, carry);
    expect(note(svc)).toBe(relayUndeliveredNote(carry));
    expect(svc.relayCarryNote(SID)).toBe(relayUndeliveredNote(carry));
    expect(svc.relayCarryFor(SID, { message: 'второе', files: ['b.png'] }))
      .toEqual({ message: 'первое\n\nвторое', files: ['a.pdf', 'b.png'] });
  });

  it('ждущий фоновый ход (carry = null) — без заметки, своё сообщение как есть', () => {
    const svc = makeService();
    const mark = svc.beginRelayRun(SID);
    svc.markRelayWaiting(SID, mark, null);
    expect(note(svc)).toBe('');
    expect(svc.relayCarryNote(SID)).toBe('');
    const own = { message: 'второе', files: [] };
    expect(svc.relayCarryFor(SID, own)).toBe(own);
  });

  it('устаревшая метка ожидания — ход уже другой, снова «прерван»', () => {
    const svc = makeService();
    const mark = svc.beginRelayRun(SID);
    svc.markRelayWaiting(SID, mark, carry);
    svc.beginRelayRun(SID);
    expect(note(svc)).toBe(INTERRUPTED_TURN_NOTE);
    expect(svc.relayCarryNote(SID)).toBe('');
  });

  it('clearRelayWaiting с чужой меткой ничего не снимает', () => {
    const svc = makeService();
    const mark = svc.beginRelayRun(SID);
    svc.markRelayWaiting(SID, mark, carry);
    svc.clearRelayWaiting(SID, mark + 1000);
    expect(note(svc)).toBe(relayUndeliveredNote(carry));
  });

  it('postRelayTurn снимает ожидание и при успехе, и при исчерпанном бюджете', async () => {
    const svc = makeService();
    svc.relayDrainDelaysMs = [0];
    const mark = svc.beginRelayRun(SID);

    const ok = jest.fn().mockRejectedValueOnce(err503()).mockResolvedValueOnce('ok');
    await expect(svc.postRelayTurn(SID, mark, carry, ok)).resolves.toBe('ok');
    expect(note(svc)).toBe(INTERRUPTED_TURN_NOTE);

    const bad = jest.fn(async () => { throw err503(); });
    await expect(svc.postRelayTurn(SID, mark, carry, bad)).rejects.toBeInstanceOf(RelayDrainingError);
    expect(note(svc)).toBe(INTERRUPTED_TURN_NOTE);
  });

  it('ожидание ставится только на повторе: первая попытка — ход идёт', async () => {
    const svc = makeService();
    svc.relayDrainDelaysMs = [0];
    const mark = svc.beginRelayRun(SID);
    const seen: string[] = [];
    let calls = 0;
    await svc.postRelayTurn(SID, mark, carry, async () => {
      seen.push(note(svc));
      if (++calls === 1) throw err503();
      return 'ok';
    });
    expect(seen).toEqual([INTERRUPTED_TURN_NOTE, relayUndeliveredNote(carry)]);
  });

  it('новое сообщение во время ожидания — ход сдаётся как перебитый', async () => {
    const svc = makeService();
    let wake: () => void = () => {};
    svc.relayDrainDelaysMs = [1000];
    svc.relayDrainSleep = () => new Promise<void>((r) => { wake = () => r(); });
    const mark = svc.beginRelayRun(SID);
    const post = jest.fn(async () => { throw err503(); });

    const p = svc.postRelayTurn(SID, mark, carry, post).catch((e) => e);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    // Новый ход читает состояние сессии, как настоящий, — и забирает перенос.
    svc.relayCarryFor(SID, { message: 'второе', files: [] });
    svc.beginRelayRun(SID);
    wake();

    const err = await p;
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

/**
 * Окно гонки: новый ход прочитал состояние сессии ДО того, как старый встал
 * в ожидание (первый POST старого ещё в полёте), — переноса не получил. Тогда
 * перебитый старый ход не может закончиться молча: его текст никуда не ушёл.
 * Он сдаётся как «не доставлено» (superseded = false) — веб и загрузка
 * покажут заглушку «обновляется — отправьте ещё раз». Фоновый ход (carry =
 * null) остаётся перебитым: agentReply превратит это в «сессия занята».
 */
describe('перебитый ход без переноса', () => {
  const ticks = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

  /** Сон под шлагбаумом вручную: каждый ждущий ход спит, пока его не разбудят. */
  function manualSleep(svc: ChatService): Array<() => void> {
    const wakers: Array<() => void> = [];
    svc.relayDrainDelaysMs = [1000];
    svc.relayDrainSleep = () => new Promise<void>((r) => { wakers.push(() => r()); });
    return wakers;
  }

  it('ждущий ход перебит, но перенос никто не забрал — «не доставлено», а не молча', async () => {
    const svc = makeService();
    const wakers = manualSleep(svc);
    const mark = svc.beginRelayRun(SID);
    const post = jest.fn(async () => { throw err503(); });

    const p = svc.postRelayTurn(SID, mark, carry, post).catch((e) => e);
    await ticks();
    svc.beginRelayRun(SID);
    wakers[0]();

    const err = await p;
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(false);
    // Пересозданная ошибка не теряет последний отказ: по нему журнал и
    // телеметрия отличают выкат от аварии.
    expect(err.lastRefusal).toBe(503);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('перебит во время первой попытки — «не доставлено»', async () => {
    const svc = makeService();
    manualSleep(svc);
    const mark = svc.beginRelayRun(SID);
    const post = jest.fn(async () => {
      svc.beginRelayRun(SID);
      throw err503();
    });

    const err = await svc.postRelayTurn(SID, mark, carry, post).catch((e) => e);
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('фоновый ход (carry = null) перебит без чтения — остаётся перебитым', async () => {
    const svc = makeService();
    const wakers = manualSleep(svc);
    const mark = svc.beginRelayRun(SID);
    const post = jest.fn(async () => { throw err503(); });

    const p = svc.postRelayTurn(SID, mark, null, post).catch((e) => e);
    await ticks();
    svc.beginRelayRun(SID);
    wakers[0]();

    const err = await p;
    expect(err).toBeInstanceOf(RelayDrainingError);
    expect(err.superseded).toBe(true);
  });

  it('цепочка: B забрал перенос A и сам ждёт — A сдаётся молча, у B оба текста', async () => {
    const svc = makeService();
    const wakers = manualSleep(svc);
    const markA = svc.beginRelayRun(SID);
    const postA = jest.fn(async () => { throw err503(); });
    const pA = svc.postRelayTurn(SID, markA, carry, postA).catch((e) => e);
    await ticks();

    const merged = svc.relayCarryFor(SID, { message: 'второе', files: [] });
    const markB = svc.beginRelayRun(SID);
    const postB = jest.fn(async () => { throw err503(); });
    const pB = svc.postRelayTurn(SID, markB, merged, postB).catch((e) => e);
    await ticks();
    expect(wakers).toHaveLength(2);

    wakers[0]();
    const errA = await pA;
    expect(errA).toBeInstanceOf(RelayDrainingError);
    expect(errA.superseded).toBe(true);

    const pending = (svc as any).relayPendingNote(SID) as string;
    expect(pending).toContain('первое');
    expect(pending).toContain('второе');

    wakers[1]();
    const errB = await pB;
    expect(errB).toBeInstanceOf(RelayDrainingError);
    expect(errB.superseded).toBe(false);
    expect((svc as any).relayWaiting.size).toBe(0);
    expect((svc as any).relayCarryTaken.size).toBe(0);
  });

  it('после перебитого хода — ни ожидания, ни отметки о переносе (без утечки)', async () => {
    const svc = makeService();
    const wakers = manualSleep(svc);
    const mark = svc.beginRelayRun(SID);
    const post = jest.fn(async () => { throw err503(); });

    const p = svc.postRelayTurn(SID, mark, carry, post).catch((e) => e);
    await ticks();
    svc.relayCarryFor(SID, { message: 'второе', files: [] });
    svc.beginRelayRun(SID);
    wakers[0]();

    expect((await p).superseded).toBe(true);
    expect((svc as any).relayWaiting.size).toBe(0);
    expect((svc as any).relayCarryTaken.size).toBe(0);
  });
});
