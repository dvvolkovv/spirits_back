/**
 * Redis в памяти со своими часами — для спеков лимитов (SMS и письма).
 *
 * Имя оканчивается на `spec.ts`, но не на `.spec.ts`: сборка его исключает
 * (tsconfig.build.json, `**\/*spec.ts`), а jest не принимает за набор тестов.
 *
 * Ключи истекают по часам фейка (advance), TTL/INCR/SET ведут себя как у
 * Redis: INCR на отсутствующем ключе заводит его без срока, SET без срока
 * срок снимает. `eval` понимает только QUOTA_SCRIPT — тот же алгоритм на JS,
 * синхронно, то есть атомарно, как в Redis. Что он совпадает с настоящим
 * Lua, проверяет quota.redis.spec.ts против живого redis-server.
 *
 * breakAfter(n): после n записей все следующие падают — «обрыв связи».
 * EVAL — одна запись: скрипт либо выполнился целиком, либо нет.
 */
import { QUOTA_SCRIPT } from './quota';

export function clockRedis() {
  let now = 0; // мс
  let writesLeft = Infinity;
  const data = new Map<string, string>();
  const expiresAt = new Map<string, number>();

  const alive = (key: string) => {
    const exp = expiresAt.get(key);
    if (exp !== undefined && exp <= now) {
      data.delete(key);
      expiresAt.delete(key);
    }
    return data.has(key);
  };
  const pttl = (key: string) => {
    if (!alive(key)) return -2;
    const exp = expiresAt.get(key);
    return exp === undefined ? -1 : exp - now;
  };
  const write = () => {
    if (writesLeft <= 0) throw new Error('fake redis: connection lost');
    writesLeft--;
  };
  const add = (key: string, delta: number) => {
    const n = Number(alive(key) ? data.get(key) : 0) + delta;
    data.set(key, String(n));
    return n;
  };

  /** JS-двойник QUOTA_SCRIPT (quota.ts) — строка в строку. */
  const runQuota = (keys: string[], args: Array<string | number>): number[] => {
    const out = [0];
    let full = false;
    keys.forEach((key, i) => {
      const value = Number(alive(key) ? data.get(key) : '0');
      if (Number.isNaN(value)) throw new Error('ERR user_script: attempt to compare nil with number');
      let left = -1;
      if (value >= Number(args[2 * i])) {
        full = true;
        left = pttl(key);
        if (left < 0) {
          if (alive(key)) expiresAt.set(key, now + Number(args[2 * i + 1]) * 1000);
          left = Number(args[2 * i + 1]) * 1000;
        }
      }
      out.push(left);
    });
    if (full) return out;
    keys.forEach((key, i) => {
      add(key, 1);
      if (pttl(key) < 0) expiresAt.set(key, now + Number(args[2 * i + 1]) * 1000);
    });
    return [1];
  };

  return {
    advance(sec: number) { now += sec * 1000; },
    breakAfter(writes: number) { writesLeft = writes; },
    /** Значение без побочных эффектов — для проверок. */
    peek(key: string) { return alive(key) ? data.get(key)! : null; },
    /** Живые ключи с префиксом и их значения. */
    snapshot(prefix: string) {
      return new Map([...data.keys()].filter((k) => k.startsWith(prefix) && alive(k)).map((k) => [k, data.get(k)!]));
    },
    async get(key: string) { return alive(key) ? data.get(key)! : null; },
    async set(key: string, value: string, ttlSeconds?: number) {
      write();
      data.set(key, value);
      if (ttlSeconds) expiresAt.set(key, now + ttlSeconds * 1000); else expiresAt.delete(key);
    },
    async del(key: string) { write(); data.delete(key); expiresAt.delete(key); },
    async incr(key: string) { write(); return add(key, 1); },
    async decr(key: string) { write(); return add(key, -1); },
    async expire(key: string, seconds: number) { write(); if (alive(key)) expiresAt.set(key, now + seconds * 1000); },
    /** Как PTTL в Redis: мс, -1 — без срока, -2 — ключа нет. */
    async pttl(key: string) { return pttl(key); },
    /** Как TTL в Redis: секунды, -1 — без срока, -2 — ключа нет. */
    async ttl(key: string) {
      const ms = pttl(key);
      return ms < 0 ? ms : Math.round(ms / 1000);
    },
    async setNx(key: string, value: string, ttlMs: number) {
      write();
      if (alive(key)) return false;
      data.set(key, value);
      expiresAt.set(key, now + ttlMs);
      return true;
    },
    async eval(script: string, keys: string[], args: Array<string | number>) {
      write();
      if (script !== QUOTA_SCRIPT) throw new Error('fake redis: unknown script');
      return runQuota(keys, args);
    },
  };
}

export type FakeRedis = ReturnType<typeof clockRedis>;
