import type { StudioConfig } from '../config';
import { StudioError } from '../errors';
import { assertDemoPhone } from '../guard';
import type { Session } from './login';

/** Как часто спрашивать, идёт ли ещё прежний ход. */
export const ACTIVE_TURN_POLL_MS = 5000;
/**
 * Пауза после active:false. Метка хода снимается чуть раньше, чем ответ
 * ложится в базу (persistResponse идёт через setImmediate): DELETE сразу после
 * снятия метки опередил бы запись, и ответ лёг бы сиротой после новой точки.
 */
export const PERSIST_GRACE_MS = 8000;

export interface CleanChatDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Вид сетевого сбоя для сообщения: код из cause (ECONNREFUSED и т.п.) или имя ошибки — без её текста. */
function netKind(e: unknown): string {
  const code = (e as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
  return e instanceof Error ? e.name : 'сбой сети';
}

/** Запрос от имени демо-аккаунта; сбой сети и не-2xx — blocked с повтором, без токена и текста ошибки fetch. */
async function call(fetchImpl: typeof fetch, what: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    throw new StudioError('blocked', `capture: ${what} — сеть: ${netKind(e)}`, true);
  }
  if (!res.ok) throw new StudioError('blocked', `capture: ${what} — ${res.status}`, true);
  return res;
}

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => null)) as unknown;
  if (!body || typeof body !== 'object') throw new StudioError('blocked', `capture: ${what} — ответ не JSON`, true);
  return body as Record<string, unknown>;
}

const bearer = (session: Session) => ({ Authorization: `Bearer ${session.accessToken}` });

/** «7 мин», «40 с» — сколько ждали, для сообщения владельцу. */
const took = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} мин` : `${Math.round(ms / 1000)} с`);

/**
 * «Чистый лист» перед съёмкой (spec 2026-11-17-context-reset): лента у
 * ассистента одна, метку fresh_ts_<id> кабинет больше не читает. От имени
 * демо-аккаунта, по порядку:
 *  0. дождаться конца прежнего хода (GET active-turn раз в 5 с до deadline —
 *     срока всей съёмки) и ещё PERSIST_GRACE_MS. Повтор съёмки после
 *     question_hidden/answer_timeout/idle_timeout стартует, пока прежний ход
 *     ещё идёт (до 12 мин): DELETE стёр бы его вопрос, а ответ лёг бы позже
 *     сиротой после новой точки — кабинет дописал бы его в ленту до нашего
 *     вопроса, в кадр и в память ассистента;
 *  1. DELETE ленты — иначе прошлые сцены попадут в высокий кадр над чертой;
 *  2. POST точки отсчёта — иначе не сменится ключ релея и ассистент через
 *     --resume будет помнить прошлые сцены.
 * В пустой ленте кабинет показывает локальный welcomeMessage (с 13.11.2026 —
 * не ход ассистента и не запись в базе); по этому пузырю проходит waitIdle.
 */
export async function prepareCleanChat(cfg: StudioConfig, session: Session, assistantId: number, deadline: number, deps: CleanChatDeps = {}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  // Ленту живого человека студия не чистит никогда — только номер 790300XXXXX.
  // Это настройка, повтор не поможет; сам номер в текст не идёт.
  try {
    assertDemoPhone(cfg.demoPhone);
  } catch {
    throw new StudioError('no_input', 'capture: DEMO_PHONE не подходит под 790300XXXXX — ленту не чищу', false);
  }
  const id = encodeURIComponent(String(assistantId));
  const auth = bearer(session);

  const started = now();
  for (;;) {
    const res = await call(fetchImpl, 'проверка прежнего хода', `${cfg.apiUrl}/webhook/chat/active-turn?assistantId=${id}`, { headers: auth });
    const body = await readJson(res, 'проверка прежнего хода');
    if (typeof body.active !== 'boolean') throw new StudioError('blocked', 'capture: проверка прежнего хода — в ответе нет active', true);
    if (!body.active) break;
    const left = deadline - now();
    if (left <= 0) {
      throw new StudioError('idle_timeout', `capture: прежний ход ассистента не закончился за ${took(now() - started)} — ленту не чищу`, true);
    }
    await sleep(Math.min(ACTIVE_TURN_POLL_MS, left));
  }
  // И когда хода не было с первого опроса: метка могла сняться за миг до него.
  await sleep(PERSIST_GRACE_MS);

  await call(fetchImpl, 'очистка ленты демо-аккаунта', `${cfg.apiUrl}/webhook/chat/history?assistantId=${id}`, { method: 'DELETE', headers: auth });

  const what = 'точка «Чистого листа»';
  const url = `${cfg.apiUrl}/webhook/chat/reset-context`;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ assistantId }) });
  } catch (e) {
    throw new StudioError('blocked', `capture: ${what} — сеть: ${netKind(e)}`, true);
  }
  if (res.status === 404 || res.status === 400) {
    // Бэкенд без ручки (не выкачен) или не принял id — настройка, как у login.ts:
    // повтор не поможет, доктор no_input не лечит, владелец узнает сразу.
    throw new StudioError('no_input', `capture: ${what} — ${res.status}: бэкенд без /webhook/chat/reset-context или не принял assistantId`, false);
  }
  if (!res.ok) throw new StudioError('blocked', `capture: ${what} — ${res.status}`, true);
}

/**
 * Страховка перед вопросом: лента демо-аккаунта у ассистента всё ещё пуста.
 * Сирота прежнего хода, легшая после очистки, попала бы в высокий кадр над
 * вопросом и в хвост памяти ассистента. В пробе не вызывать — там ленту не
 * чистят.
 */
export async function assertEmptyFeed(cfg: StudioConfig, session: Session, assistantId: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const what = 'проверка пустой ленты';
  const res = await call(fetchImpl, what, `${cfg.apiUrl}/webhook/chat/history?assistantId=${encodeURIComponent(String(assistantId))}&limit=1`, {
    headers: bearer(session),
  });
  const body = await readJson(res, what);
  if (!Array.isArray(body.messages)) throw new StudioError('blocked', `capture: ${what} — в ответе нет messages`, true);
  if (body.messages.length > 0) throw new StudioError('blocked', 'capture: лента не пуста перед вопросом', true);
}
