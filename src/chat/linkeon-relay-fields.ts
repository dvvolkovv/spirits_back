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
  fs_key: string;
}

/**
 * Первые 32 hex от HMAC-SHA256 ключа сессии релея. Соль — RELAY_FS_SALT из
 * .env (у прода и стенда свои); без неё — JWT_SECRET, и тогда смена JWT_SECRET
 * переименует папки новых ходов (старые ссылки живут). Длина и алфавит —
 * контракт с релеем: relay-agent/paths.mjs, FS_KEY_RE.
 */
export function relayFsKey(sessionKey: string): string {
  const salt = (process.env.RELAY_FS_SALT || '').trim() || process.env.JWT_SECRET || 'default_secret_change_me';
  return createHmac('sha256', salt).update(String(sessionKey)).digest('hex').slice(0, 32);
}

export function linkeonRelayFields(userId: string, sessionKey: string): LinkeonRelayFields {
  const base = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
  return {
    linkeon_token: signLinkeonToolToken(userId),
    linkeon_mcp_url: `${base}/webhook/mcp/linkeon`,
    fs_key: relayFsKey(sessionKey),
  };
}

/** Три поля — в multipart-запрос к релею (form-data). */
export function appendLinkeonFields(fd: { append(name: string, value: string): void }, f: LinkeonRelayFields): void {
  fd.append('linkeon_token', f.linkeon_token);
  fd.append('linkeon_mcp_url', f.linkeon_mcp_url);
  fd.append('fs_key', f.fs_key);
}
