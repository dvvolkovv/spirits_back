import { randomBytes } from 'crypto';

/**
 * Имя клона голоса у ElevenLabs: `linkeon-<8 случайных hex>`.
 *
 * Без идентификатора пользователя (спека 2026-11-02-pii-out-of-prompts-design.md,
 * п. 1): прежнее `user_<id>` у телефонных пользователей было номером и лежало
 * у ElevenLabs. Имя нигде не читается — клон связан с пользователем через
 * user_voice.elevenlabs_voice_id, — поэтому оно может быть любым.
 */
export function cloneVoiceName(): string {
  return `linkeon-${randomBytes(4).toString('hex')}`;
}
