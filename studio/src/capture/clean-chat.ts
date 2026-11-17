import type { StudioConfig } from '../config';
import { StudioError } from '../errors';
import { assertDemoPhone } from '../guard';
import type { Session } from './login';

/** Вид сетевого сбоя для сообщения: код из cause (ECONNREFUSED и т.п.) или имя ошибки — без её текста. */
function netKind(e: unknown): string {
  const code = (e as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
  return e instanceof Error ? e.name : 'сбой сети';
}

/**
 * «Чистый лист» перед съёмкой (spec 2026-11-17-context-reset): лента у
 * ассистента одна, метку fresh_ts_<id> кабинет больше не читает. Поэтому два
 * запроса от имени демо-аккаунта, по порядку:
 *  1. DELETE ленты — иначе прошлые сцены попадут в высокий кадр над чертой;
 *  2. POST точки отсчёта — иначе не сменится ключ релея и ассистент через
 *     --resume будет помнить прошлые сцены.
 * Пустая лента — кабинет сам пришлёт приветствие (ChatInterface), его ждёт waitIdle.
 * Любой сбой — blocked с повтором; в сообщении шаг и код ответа, без токена и
 * без текста ошибки fetch.
 */
export async function prepareCleanChat(cfg: StudioConfig, session: Session, assistantId: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  // Ленту живого человека студия не чистит никогда — только номер 790300XXXXX.
  assertDemoPhone(cfg.demoPhone);
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  const step = async (what: string, url: string, init: RequestInit): Promise<void> => {
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      throw new StudioError('blocked', `capture: ${what} — сеть: ${netKind(e)}`, true);
    }
    if (!res.ok) throw new StudioError('blocked', `capture: ${what} — ${res.status}`, true);
  };
  await step('очистка ленты демо-аккаунта', `${cfg.apiUrl}/webhook/chat/history?assistantId=${encodeURIComponent(String(assistantId))}`, {
    method: 'DELETE',
    headers: auth,
  });
  await step('точка «Чистого листа»', `${cfg.apiUrl}/webhook/chat/reset-context`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assistantId }),
  });
}
