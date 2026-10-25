export type BotTokenCheck =
  | { ok: true; id: number; username: string }
  | { ok: false; reason: 'bad_form' | 'rejected' | 'unreachable' };

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;

/**
 * getMe у Telegram: живой ли токен и какой это бот. Ответ проверяется на
 * `ok !== true`, а не на `ok === false` — тело без поля приезжает от прокси и
 * заглушек (то же правило, что в каркасе бота). Текст ошибки fetch содержит
 * адрес с токеном, поэтому наружу уходит только код причины.
 */
export async function checkBotToken(
  token: string,
  fetchFn: (url: string, init?: any) => Promise<any> = fetch as any,
  timeoutMs = 8_000,
): Promise<BotTokenCheck> {
  const t = String(token ?? '').trim();
  if (!TOKEN_RE.test(t)) return { ok: false, reason: 'bad_form' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${t}/getMe`, { signal: ctrl.signal });
    const body: any = await res.json().catch(() => null);
    if (body?.ok === true && typeof body?.result?.id === 'number') {
      return { ok: true, id: body.result.id, username: String(body.result.username ?? '') };
    }
    return { ok: false, reason: res.status === 401 || res.status === 404 ? 'rejected' : 'unreachable' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
