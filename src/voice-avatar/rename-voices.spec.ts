import axios from 'axios';
import { SELECT_VOICE_IDS_SQL, listVoiceIds, renameVoices } from './rename-voices';

jest.mock('axios');

/**
 * Разовое переименование клонов голоса у ElevenLabs (спека
 * 2026-11-02-pii-out-of-prompts-design.md, п. 1): прежние клоны названы
 * `user_<id>`. Запрос — POST /v1/voices/{voice_id}/edit, multipart, поле name
 * обязательное (документация ElevenLabs, «Edit voice»); ответ 200 —
 * {"status":"ok"}.
 */
const post = axios.post as jest.Mock;
const KEY = 'el-key-placeholder-for-spec';

beforeEach(() => {
  jest.clearAllMocks();
  post.mockResolvedValue({ status: 200, data: { status: 'ok' } });
});

describe('listVoiceIds', () => {
  it('берёт из user_voice только voice_id — без пользователей', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [{ elevenlabs_voice_id: 'v1' }, { elevenlabs_voice_id: 'v2' }] })) };

    expect(await listVoiceIds(pg)).toEqual(['v1', 'v2']);
    expect(pg.query).toHaveBeenCalledWith(SELECT_VOICE_IDS_SQL);
    expect(SELECT_VOICE_IDS_SQL).toMatch(/SELECT elevenlabs_voice_id FROM user_voice/);
    expect(SELECT_VOICE_IDS_SQL).toMatch(/elevenlabs_voice_id IS NOT NULL/);
    expect(SELECT_VOICE_IDS_SQL).not.toMatch(/user_id/);
  });
});

describe('renameVoices', () => {
  it('сухой прогон: ни одного запроса к ElevenLabs; в выводе — число голосов и их voice_id', async () => {
    const lines: string[] = [];

    const r = await renameVoices({ voiceIds: ['v1', 'v2'], apply: false, apiKey: KEY, log: (m) => lines.push(m) });

    expect(post).not.toHaveBeenCalled();
    expect(r).toEqual({ voices: 2, renamed: 0, failed: [] });
    expect(lines[0]).toMatch(/\b2\b/);
    expect(lines.slice(1)).toEqual([expect.stringContaining('v1'), expect.stringContaining('v2')]);
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('сухой прогон без ключа тоже работает', async () => {
    const r = await renameVoices({ voiceIds: ['v1'], apply: false, apiKey: undefined, log: () => {} });

    expect(r).toEqual({ voices: 1, renamed: 0, failed: [] });
    expect(post).not.toHaveBeenCalled();
  });

  it('--apply: POST /v1/voices/{voice_id}/edit, multipart с новым именем linkeon-<8 hex>, ключ в xi-api-key', async () => {
    const r = await renameVoices({ voiceIds: ['v1'], apply: true, apiKey: KEY, log: () => {} });

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/voices/v1/edit');
    expect(body).toBeInstanceOf(FormData);
    expect([...(body as FormData).keys()]).toEqual(['name']);
    expect(String((body as FormData).get('name'))).toMatch(/^linkeon-[0-9a-f]{8}$/);
    expect(config.headers['xi-api-key']).toBe(KEY);
    expect(r).toEqual({ voices: 1, renamed: 1, failed: [] });
  });

  it('voice_id в адресе кодируется', async () => {
    await renameVoices({ voiceIds: ['a/b?c'], apply: true, apiKey: KEY, log: () => {} });

    expect(post.mock.calls[0][0]).toBe('https://api.elevenlabs.io/v1/voices/a%2Fb%3Fc/edit');
  });

  it('--apply без ключа — отказ до первого запроса', async () => {
    await expect(renameVoices({ voiceIds: ['v1'], apply: true, apiKey: '', log: () => {} })).rejects.toThrow(
      /ELEVENLABS_API_KEY/,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('сбой одного голоса не останавливает остальные, ключ в вывод не попадает', async () => {
    post.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 422'), {
        response: { status: 422, data: { detail: [{ msg: 'invalid' }] } },
        config: { headers: { 'xi-api-key': KEY } },
      }),
    );
    const lines: string[] = [];

    const r = await renameVoices({ voiceIds: ['v1', 'v2'], apply: true, apiKey: KEY, log: (m) => lines.push(m) });

    expect(post).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ voices: 2, renamed: 1, failed: ['v1'] });
    expect(lines.join('\n')).toContain('422');
    expect(lines.join('\n')).not.toContain(KEY);
  });
});
