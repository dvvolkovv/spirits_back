import { createHmac } from 'crypto';
import { signLinkeonToolToken } from '../mcp/linkeon-tool.token';

/**
 * Поля, которыми бэк передаёт релею инструменты Linkeon (mcp__linkeon__*) и
 * папку хода. Спека: docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md.
 *
 *   linkeon_token   — токен хода: пользователь в подписи, модели он не виден;
 *   linkeon_mcp_url — /webhook/mcp/linkeon (подпуть mcp под глобальным
 *                     префиксом, как /webhook/mcp/products); без BACKEND_URL —
 *                     адрес прода;
 *   fs_key          — имя папки хода на релее вместо ключа сессии, где у
 *                     телефонных пользователей номер. Постоянен для сессии.
 *
 * Чистые функции по той же причине, что products-relay-fields.ts: конструктор
 * ChatService и так на 26 зависимостей.
 *
 * Шлются только на путях с известным пользователем: ход веб-ассистента, ход с
 * вложениями, agentReply с пользователем. Анонимным и служебным ходам
 * (clean-ask, первый контакт, автоблог, проба качества) — нет; сторож —
 * linkeon-fields-anonymous.spec.ts.
 */
export interface LinkeonRelayFields {
  linkeon_token: string;
  linkeon_mcp_url: string;
  /** Нет, когда нет ни RELAY_FS_SALT, ни JWT_SECRET — см. relayFsKey. */
  fs_key?: string;
}

/**
 * Первые 32 hex от HMAC-SHA256 ключа сессии релея. Соль — RELAY_FS_SALT из
 * .env (у прода и стенда свои); без неё — JWT_SECRET (с предупреждением в
 * лог), и тогда смена JWT_SECRET переименует папки новых ходов (старые
 * ссылки живут). Без обоих секретов fs_key не выдаётся вовсе (ревью
 * 26.10.2026): HMAC на вшитой в код константе ничего не защищает — она в
 * открытом репозитории, — и честное отсутствие ключа лучше фиктивной защиты;
 * релей в этом случае просто берёт прежнее имя папки (sessionId). Длина и
 * алфавит — контракт с релеем: relay-agent/paths.mjs, FS_KEY_RE.
 */
export function relayFsKey(sessionKey: string): string | undefined {
  const salt = (process.env.RELAY_FS_SALT || '').trim();
  const secret = salt || process.env.JWT_SECRET;
  if (!secret) {
    console.warn('linkeon-relay-fields: ни RELAY_FS_SALT, ни JWT_SECRET не заданы — fs_key не выдан');
    return undefined;
  }
  if (!salt) {
    console.warn('linkeon-relay-fields: RELAY_FS_SALT не задан, fs_key считается на JWT_SECRET');
  }
  return createHmac('sha256', secret).update(String(sessionKey)).digest('hex').slice(0, 32);
}

export function linkeonRelayFields(userId: string, sessionKey: string): LinkeonRelayFields {
  const base = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
  const fields: LinkeonRelayFields = {
    linkeon_token: signLinkeonToolToken(userId),
    linkeon_mcp_url: `${base}/webhook/mcp/linkeon`,
  };
  const fsKey = relayFsKey(sessionKey);
  if (fsKey) fields.fs_key = fsKey;
  return fields;
}

/** Поля — в multipart-запрос к релею (form-data). fs_key — только если есть. */
export function appendLinkeonFields(fd: { append(name: string, value: string): void }, f: LinkeonRelayFields): void {
  fd.append('linkeon_token', f.linkeon_token);
  fd.append('linkeon_mcp_url', f.linkeon_mcp_url);
  if (f.fs_key) fd.append('fs_key', f.fs_key);
}
