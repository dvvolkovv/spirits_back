import axios from 'axios';
import { cloneVoiceName } from './voice-name';

/**
 * Разовое переименование клонов голоса у ElevenLabs (спека
 * 2026-11-02-pii-out-of-prompts-design.md, п. 1). До этой правки клон
 * назывался `user_<id>`, у телефонных пользователей — номером. Новое имя —
 * то же, что у новых клонов (cloneVoiceName). voice_id не меняется, поэтому
 * user_voice трогать не нужно.
 *
 * Голоса — из user_voice (клоны делает только voice-avatar, и каждый готовый
 * клон записан там своим voice_id) и сироты: голоса аккаунта с именем user_*,
 * которых в user_voice нет (удаление строки дошло, а удаление у ElevenLabs —
 * нет: deleteClone только пишет предупреждение). Сирот видно только в
 * перечне голосов аккаунта — GET /v2/voices, постранично (page_size до 100,
 * has_more и next_page_token; v1 в документации ElevenLabs больше не
 * описан). Имена из перечня наружу не выходят — в них номер; в выводе только
 * число и voice_id.
 *
 * Переименование — как в документации ElevenLabs («Edit voice»): POST
 * /v1/voices/{voice_id}/edit, multipart/form-data, поле name обязательное,
 * ответ 200 — {"status":"ok"}. Multipart собирается так же, как у
 * VoiceAvatarService.clone (глобальный FormData, ключ в xi-api-key).
 *
 * Ключ в вывод не попадает: из ошибки берутся только код ответа и сообщение.
 */
const EL_BASE = 'https://api.elevenlabs.io/v1';
const EL_BASE_V2 = 'https://api.elevenlabs.io/v2';
/** Прежнее имя клона — `user_<id>`. */
const LEGACY_NAME_PREFIX = 'user_';
/** Потолок страниц перечня: 100 × 100 голосов — с запасом, а зациклиться нельзя. */
const MAX_PAGES = 100;

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

/** voice_id голосов аккаунта с прежним именем user_*. Сами имена не возвращаются. */
async function listAccountLegacyVoiceIds(apiKey: string): Promise<string[]> {
  const ids = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await axios.get(`${EL_BASE_V2}/voices`, {
      headers: { 'xi-api-key': apiKey },
      params: token ? { page_size: 100, next_page_token: token } : { page_size: 100 },
      timeout: 30_000,
    });
    for (const v of data?.voices ?? []) {
      if (typeof v?.name === 'string' && v.name.startsWith(LEGACY_NAME_PREFIX) && v?.voice_id) ids.add(String(v.voice_id));
    }
    if (!data?.has_more || !data?.next_page_token) break;
    token = String(data.next_page_token);
  }
  return [...ids];
}

export interface RenameVoicesResult {
  /** Голосов в user_voice. */
  voices: number;
  /** Голосов аккаунта с именем user_*; null — перечень не получен (нет ключа или ошибка). */
  accountUserVoices: number | null;
  /** Из них нет в user_voice. */
  orphans: number;
  /** Переименовано голосов user_voice. */
  renamed: number;
  /** Переименовано сирот. */
  orphansRenamed: number;
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
  if (p.apply && !p.apiKey) throw new Error('ELEVENLABS_API_KEY не задан — переименовывать нечем');

  p.log(`голосов в user_voice: ${p.voiceIds.length}`);
  if (!p.apply) for (const id of p.voiceIds) p.log(`voice_id: ${id}`);

  let account: string[] | null = null;
  if (p.apiKey) {
    try {
      account = await listAccountLegacyVoiceIds(p.apiKey);
    } catch (e: any) {
      p.log(`перечень голосов у ElevenLabs не получен (${whyFailed(e)}) — сирот не видно`);
    }
  } else {
    p.log('ключа ElevenLabs нет — перечень голосов у ElevenLabs не запрашивался');
  }
  const inDb = new Set(p.voiceIds);
  const orphans = account ? account.filter((id) => !inDb.has(id)) : [];
  if (account) {
    p.log(`голосов у ElevenLabs с именем user_*: ${account.length}`);
    if (!p.apply) for (const id of account) p.log(`voice_id: ${id}`);
    p.log(`из них нет в user_voice (сироты): ${orphans.length}`);
  }
  const result: RenameVoicesResult = {
    voices: p.voiceIds.length,
    accountUserVoices: account ? account.length : null,
    orphans: orphans.length,
    renamed: 0,
    orphansRenamed: 0,
    failed: [],
  };
  if (!p.apply) return result;

  const rename = async (id: string): Promise<boolean> => {
    const fd = new FormData();
    fd.append('name', cloneVoiceName());
    try {
      await axios.post(`${EL_BASE}/voices/${encodeURIComponent(id)}/edit`, fd, {
        headers: { 'xi-api-key': p.apiKey },
        timeout: 30_000,
      });
      p.log(`переименован: ${id}`);
      return true;
    } catch (e: any) {
      result.failed.push(id);
      p.log(`не переименован: ${id} (${whyFailed(e)})`);
      return false;
    }
  };
  for (const id of p.voiceIds) if (await rename(id)) result.renamed++;
  for (const id of orphans) if (await rename(id)) result.orphansRenamed++;
  return result;
}
