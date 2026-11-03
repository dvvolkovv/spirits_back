import axios from 'axios';
import { SELECT_VOICE_IDS_SQL, listVoiceIds, renameVoices } from './rename-voices';

jest.mock('axios');

/**
 * Разовое переименование клонов голоса у ElevenLabs (спека
 * 2026-11-02-pii-out-of-prompts-design.md, п. 1): прежние клоны названы
 * `user_<id>`. Запрос — POST /v1/voices/{voice_id}/edit, multipart, поле name
 * обязательное (документация ElevenLabs, «Edit voice»); ответ 200 —
 * {"status":"ok"}.
 *
 * Ревью ветки (m7): клоны, оставшиеся у ElevenLabs без строки в user_voice
 * (сироты), видны только в перечне голосов аккаунта — GET /v2/voices,
 * постранично (page_size до 100, has_more и next_page_token; v1 в
 * документации больше не описан). В выводе — только число и voice_id, имён
 * целиком нет: в них номер.
 */
const post = axios.post as jest.Mock;
const get = axios.get as jest.Mock;
const KEY = 'el-key-placeholder-for-spec';
const UUID_USER = 'aaaaaaaa-0000-4000-8000-000000000001';

const ACCOUNT = {
  data: {
    voices: [
      { voice_id: 'v1', name: 'user_70000000000', category: 'cloned' },
      { voice_id: 'v9', name: `user_${UUID_USER}`, category: 'cloned' },
      { voice_id: 'p1', name: 'Rachel', category: 'premade' },
      { voice_id: 'v2', name: 'linkeon-0a0b0c0d', category: 'cloned' },
    ],
    has_more: false,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  post.mockResolvedValue({ status: 200, data: { status: 'ok' } });
  get.mockResolvedValue({ data: { voices: [], has_more: false } });
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
  it('сухой прогон: ElevenLabs не меняется; голоса user_voice и голоса user_* аккаунта — числом и voice_id, сироты отдельно, имён нет', async () => {
    get.mockResolvedValue(ACCOUNT);
    const lines: string[] = [];

    const r = await renameVoices({ voiceIds: ['v1', 'v2'], apply: false, apiKey: KEY, log: (m) => lines.push(m) });

    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
    const [url, config] = get.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v2/voices');
    expect(config.headers['xi-api-key']).toBe(KEY);
    expect(config.params).toEqual({ page_size: 100 });
    expect(r).toEqual({ voices: 2, accountUserVoices: 2, orphans: 1, renamed: 0, orphansRenamed: 0, failed: [] });
    const out = lines.join('\n');
    expect(lines[0]).toMatch(/user_voice: 2$/);
    for (const id of ['v1', 'v2', 'v9']) expect(out).toContain(`voice_id: ${id}`);
    expect(out).toMatch(/сироты\): 1/);
    for (const secret of ['user_70000000000', UUID_USER, 'Rachel', 'linkeon-0a0b0c0d', KEY]) expect(out).not.toContain(secret);
  });

  // Ревью ветки: сирота — только клон (category=cloned) с именем строго
  // user_<номер> или user_<uuid>, — иначе под переименование попал бы чужой
  // голос аккаунта, названный похоже.
  it('сироты — только клоны с именем строго user_<номер|uuid>', async () => {
    get.mockResolvedValue({
      data: {
        voices: [
          { voice_id: 'ok-phone', name: 'user_70000000000', category: 'cloned' },
          { voice_id: 'ok-uuid', name: `user_${UUID_USER}`, category: 'cloned' },
          { voice_id: 'premade', name: 'user_70000000000', category: 'premade' },
          { voice_id: 'generated', name: 'user_70000000000', category: 'generated' },
          { voice_id: 'word', name: 'user_test', category: 'cloned' },
          { voice_id: 'tail', name: 'user_70000000000 copy', category: 'cloned' },
          { voice_id: 'short', name: 'user_123', category: 'cloned' },
          { voice_id: 'upper', name: 'USER_70000000000', category: 'cloned' },
        ],
        has_more: false,
      },
    });
    const lines: string[] = [];

    const r = await renameVoices({ voiceIds: [], apply: false, apiKey: KEY, log: (m) => lines.push(m) });

    expect(r).toMatchObject({ accountUserVoices: 2, orphans: 2 });
    const out = lines.join('\n');
    expect(out).toContain('voice_id: ok-phone');
    expect(out).toContain('voice_id: ok-uuid');
    for (const id of ['premade', 'generated', 'word', 'tail', 'short', 'upper']) expect(out).not.toContain(`voice_id: ${id}`);
  });

  it('перечень аккаунта — постранично, по has_more и next_page_token', async () => {
    get
      .mockResolvedValueOnce({
        data: { voices: [{ voice_id: 'v1', name: 'user_70000000000', category: 'cloned' }], has_more: true, next_page_token: 't2' },
      })
      .mockResolvedValueOnce({
        data: { voices: [{ voice_id: 'v7', name: 'user_70000000007', category: 'cloned' }], has_more: false, next_page_token: null },
      });

    const r = await renameVoices({ voiceIds: ['v1'], apply: false, apiKey: KEY, log: () => {} });

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][1].params).toEqual({ page_size: 100, next_page_token: 't2' });
    expect(r).toMatchObject({ accountUserVoices: 2, orphans: 1 });
  });

  it('сухой прогон без ключа: перечень аккаунта не запрашивается', async () => {
    const r = await renameVoices({ voiceIds: ['v1'], apply: false, apiKey: undefined, log: () => {} });

    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(r).toEqual({ voices: 1, accountUserVoices: null, orphans: 0, renamed: 0, orphansRenamed: 0, failed: [] });
  });

  it('перечень аккаунта не получен — сирот не видно, в выводе код ошибки без ключа', async () => {
    get.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 401'), {
        response: { status: 401 },
        config: { headers: { 'xi-api-key': KEY } },
      }),
    );
    const lines: string[] = [];

    const r = await renameVoices({ voiceIds: ['v1'], apply: false, apiKey: KEY, log: (m) => lines.push(m) });

    expect(r).toMatchObject({ accountUserVoices: null, orphans: 0 });
    expect(lines.join('\n')).toContain('401');
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('--apply: переименовывает и голоса user_voice, и сирот — отдельным счётчиком', async () => {
    get.mockResolvedValue(ACCOUNT);

    const r = await renameVoices({ voiceIds: ['v1', 'v2'], apply: true, apiKey: KEY, log: () => {} });

    expect(post.mock.calls.map((c) => c[0])).toEqual([
      'https://api.elevenlabs.io/v1/voices/v1/edit',
      'https://api.elevenlabs.io/v1/voices/v2/edit',
      'https://api.elevenlabs.io/v1/voices/v9/edit',
    ]);
    expect(r).toEqual({ voices: 2, accountUserVoices: 2, orphans: 1, renamed: 2, orphansRenamed: 1, failed: [] });
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
    expect(r).toMatchObject({ voices: 1, renamed: 1, orphansRenamed: 0, failed: [] });
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
    expect(get).not.toHaveBeenCalled();
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
    expect(r).toMatchObject({ voices: 2, renamed: 1, failed: ['v1'] });
    expect(lines.join('\n')).toContain('422');
    expect(lines.join('\n')).not.toContain(KEY);
  });
});
