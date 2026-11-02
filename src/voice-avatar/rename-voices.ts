import axios from 'axios';
import { cloneVoiceName } from './voice-name';

/**
 * Разовое переименование клонов голоса у ElevenLabs (спека
 * 2026-11-02-pii-out-of-prompts-design.md, п. 1). До этой правки клон
 * назывался `user_<id>`, у телефонных пользователей — номером. Новое имя —
 * то же, что у новых клонов (cloneVoiceName). voice_id не меняется, поэтому
 * user_voice трогать не нужно.
 *
 * Голоса — из user_voice: клоны делает только voice-avatar, и каждый готовый
 * клон записан там своим voice_id. Клоны, оставшиеся у ElevenLabs без строки
 * в user_voice (удаление не дошло до ElevenLabs), сюда не попадают — их
 * можно найти только в кабинете ElevenLabs.
 *
 * Запрос — как в документации ElevenLabs («Edit voice»): POST
 * /v1/voices/{voice_id}/edit, multipart/form-data, поле name обязательное,
 * ответ 200 — {"status":"ok"}. Multipart собирается так же, как у
 * VoiceAvatarService.clone (глобальный FormData, ключ в xi-api-key).
 *
 * Ключ в вывод не попадает: из ошибки берутся только код ответа и сообщение.
 */
const EL_BASE = 'https://api.elevenlabs.io/v1';

export const SELECT_VOICE_IDS_SQL = `SELECT elevenlabs_voice_id FROM user_voice
 WHERE elevenlabs_voice_id IS NOT NULL
 ORDER BY elevenlabs_voice_id`;

export interface VoicesPg {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

export async function listVoiceIds(pg: VoicesPg): Promise<string[]> {
  const { rows } = await pg.query(SELECT_VOICE_IDS_SQL);
  return rows.map((r: any) => String(r.elevenlabs_voice_id));
}

export interface RenameVoicesResult {
  voices: number;
  renamed: number;
  /** voice_id, которые переименовать не удалось. */
  failed: string[];
}

/** Почему не вышло — код ответа и сообщение, без запроса и его заголовков. */
function whyFailed(e: any): string {
  const status = e?.response?.status;
  const msg = String(e?.message || e || 'ошибка').slice(0, 200);
  return status ? `HTTP ${status}: ${msg}` : msg;
}

export async function renameVoices(p: {
  voiceIds: string[];
  apply: boolean;
  apiKey: string | undefined;
  log: (m: string) => void;
}): Promise<RenameVoicesResult> {
  p.log(`голосов в user_voice: ${p.voiceIds.length}`);
  if (!p.apply) {
    for (const id of p.voiceIds) p.log(`voice_id: ${id}`);
    return { voices: p.voiceIds.length, renamed: 0, failed: [] };
  }
  if (!p.apiKey) throw new Error('ELEVENLABS_API_KEY не задан — переименовывать нечем');

  let renamed = 0;
  const failed: string[] = [];
  for (const id of p.voiceIds) {
    const fd = new FormData();
    fd.append('name', cloneVoiceName());
    try {
      await axios.post(`${EL_BASE}/voices/${encodeURIComponent(id)}/edit`, fd, {
        headers: { 'xi-api-key': p.apiKey },
        timeout: 30_000,
      });
      renamed++;
      p.log(`переименован: ${id}`);
    } catch (e: any) {
      failed.push(id);
      p.log(`не переименован: ${id} (${whyFailed(e)})`);
    }
  }
  return { voices: p.voiceIds.length, renamed, failed };
}
