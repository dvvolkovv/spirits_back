import { relayFsKey } from '../chat/linkeon-relay-fields';

/**
 * Папка голосовых документов пользователя в бакете — солёный хэш его
 * идентификатора той же функцией, что папки релея (relayFsKey, соль
 * RELAY_FS_SALT). Спека 2026-11-02-pii-out-of-prompts-design.md, п. 2.
 *
 * Прежде папкой был сам идентификатор: documents/<id>/<docId>.md, у
 * телефонных пользователей — номер. Ссылка на документ лежит в истории чата и
 * оттуда уходит в промпты (хвост истории, план действий, извлечение профиля,
 * итоги встреч).
 *
 * Без секретов — undefined: папки без идентификатора тогда не сделать, а
 * фиктивная защита хуже честного отсутствия (как у relayFsKey). Разовый
 * перенос прежних документов (voice-document-migration.ts) берёт ту же
 * функцию — новые и перенесённые документы ложатся в одну папку.
 */
export function voiceDocumentFolder(userId: string): string | undefined {
  return relayFsKey(userId);
}

/** Ключ документа в бакете; null — без секретов (см. voiceDocumentFolder). */
export function voiceDocumentKey(userId: string, docId: string): string | null {
  const folder = voiceDocumentFolder(userId);
  return folder ? `documents/${folder}/${docId}.md` : null;
}
