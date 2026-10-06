/**
 * Счётчики в фиксированных окнах — общий механизм для лимитов отправки SMS
 * (sms-limits.ts) и писем со ссылкой входа (email.service.ts).
 *
 * Проверка и учёт — один Lua-скрипт: Redis выполняет его атомарно, никакой
 * другой запрос между шагами не вклинится. Отсюда три свойства, которых не
 * было у последовательных INCR с откатом:
 *  - отказ ничего не пишет — ни счётчиков этого запроса, ни «нулей» после
 *    отката, и счётчик не может уйти в минус;
 *  - пачка параллельных запросов не проскакивает порог;
 *  - обрыв связи с Redis не оставляет полу-насчитанных ключей: скрипт либо
 *    выполнился целиком, либо не выполнился.
 */

/**
 * KEYS[i] — счётчик, ARGV[2i-1] — порог, ARGV[2i] — окно в секундах.
 *
 * Сначала проверяются все окна. Если хоть одно заполнено — ничего не
 * считаем и отвечаем {0, остаток_1, …, остаток_n}: остаток окна в мс для
 * заполненных, -1 для остальных. Иначе INCR всех счётчиков, срок окна — тем,
 * у кого его нет, ответ {1}.
 *
 * Единственная запись при отказе — срок заполненному счётчику, если тот его
 * потерял (ключ, поставленный руками без срока): иначе такое окно не
 * открылось бы никогда.
 */
export const QUOTA_SCRIPT = `
local out = {0}
local full = false
for i = 1, #KEYS do
  local left = -1
  if tonumber(redis.call('GET', KEYS[i]) or '0') >= tonumber(ARGV[2 * i - 1]) then
    full = true
    left = redis.call('PTTL', KEYS[i])
    if left < 0 then
      redis.call('EXPIRE', KEYS[i], ARGV[2 * i])
      left = tonumber(ARGV[2 * i]) * 1000
    end
  end
  out[i + 1] = left
end
if full then return out end
for i = 1, #KEYS do
  redis.call('INCR', KEYS[i])
  if redis.call('PTTL', KEYS[i]) < 0 then
    redis.call('EXPIRE', KEYS[i], ARGV[2 * i])
  end
end
return {1}
`;

export interface QuotaRule {
  key: string;
  max: number;
  windowSec: number;
}

/** Тот метод RedisService, который нужен квотам. */
export interface QuotaStore {
  eval(script: string, keys: string[], args: Array<string | number>): Promise<unknown>;
}

/**
 * `counted` — запрос учтён во всех окнах; иначе не учтён нигде, а
 * `leftMs[i]` — остаток окна правила i в мс, если оно заполнено, или -1.
 * При учёте `leftMs` пуст. Не союз типов: без strictNullChecks булев
 * признак его не сужает.
 */
export interface QuotaReply {
  counted: boolean;
  leftMs: number[];
}

/**
 * Пороги с переопределениями из окружения.
 *
 * Читать при каждом запросе, а не при загрузке модуля: .env подхватывает
 * ConfigModule уже после импорта, и прочитанная заранее константа молча
 * осталась бы значением по умолчанию. Принимается только целое больше нуля;
 * остальное игнорируется и попадает в `ignored`, чтобы опечатку было видно
 * в логе, а не по тому, что лимит «не поднялся».
 */
export function limitsFromEnv<T extends { [K in keyof T]: number }>(
  defaults: Readonly<T>,
  names: Readonly<Record<keyof T, string>>,
  env: NodeJS.ProcessEnv = process.env,
): { limits: T; ignored: string[] } {
  const limits = { ...defaults } as T;
  const ignored: string[] = [];
  for (const field of Object.keys(names) as Array<keyof T>) {
    const name = names[field];
    const raw = env[name]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) limits[field] = n as T[keyof T];
    else ignored.push(`${name}=${raw}`);
  }
  return { limits, ignored };
}

export async function takeQuota(store: QuotaStore, rules: QuotaRule[]): Promise<QuotaReply> {
  const keys = rules.map((r) => r.key);
  const args = rules.flatMap((r) => [r.max, r.windowSec]);
  const reply = (await store.eval(QUOTA_SCRIPT, keys, args)) as number[];
  if (Number(reply[0]) === 1) return { counted: true, leftMs: [] };
  return { counted: false, leftMs: rules.map((_, i) => Number(reply[i + 1])) };
}
