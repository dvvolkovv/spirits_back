import { ChatFilesService, SESSION_FILES_SQL } from './chat-files.service';

const MINIO = 'https://my.linkeon.io/smm-media';
const RELAY = 'https://r.linkeon.io/files/u1_12_ru';
const VID_OK = '11111111-2222-4333-8444-555555555555';
const VID_FAILED = '22222222-2222-4333-8444-555555555555';
const VID_ALIEN = '33333333-2222-4333-8444-555555555555';
const AUD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makePg(rows: any[], videos: any[] = [], clips: any[] = []) {
  const calls: { sql: string; params: any[] }[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql === SESSION_FILES_SQL) return { rows };
    if (/FROM video_jobs/.test(sql)) return { rows: videos.filter((v) => params[0].includes(v.id) && v.user_id === params[1]) };
    if (/FROM speech_clips/.test(sql)) return { rows: clips.filter((c) => params[0].includes(c.id) && c.user_id === params[1]) };
    return { rows: [] };
  });
  return { query, calls };
}

beforeEach(() => {
  process.env.MINIO_PUBLIC_URL = `${MINIO}/`;
  delete process.env.AGENT_URL;
  delete process.env.BACKEND_URL;
});

describe('ChatFilesService.listForSession', () => {
  it('читает только ответы ассистента этой переписки, с фильтром по признакам вложений', async () => {
    const pg = makePg([]);
    await new ChatFilesService(pg as any).listForSession('u1', 'u1_12');
    expect(pg.calls[0].sql).toBe(SESSION_FILES_SQL);
    expect(pg.calls[0].params).toEqual(['u1_12']);
    expect(SESSION_FILES_SQL).toMatch(/session_id = \$1 AND sender_type = 'ai'/);
    expect(SESSION_FILES_SQL).toMatch(/ORDER BY created_at DESC/);
    expect(pg.calls).toHaveLength(1);
  });

  it('повтор адреса — одна запись, из самого свежего ответа', async () => {
    const url = `${MINIO}/linkeon-assets/images/1.png`;
    const pg = makePg([
      { id: 20, content: `опять ![](${url})`, created_at: '2026-10-05T10:00:00Z' },
      { id: 10, content: `![](${url})`, created_at: '2026-09-20T10:00:00Z' },
    ]);
    const items = await new ChatFilesService(pg as any).listForSession('u1', 'u1_12');
    expect(items).toEqual([
      { key: url, kind: 'image', url, name: '1.png', ext: 'png', createdAt: '2026-10-05T10:00:00.000Z', messageId: 20, stored: true },
    ]);
  });

  it('у не сохранившегося файла нет адреса', async () => {
    const pg = makePg([{ id: 1, content: `[Скачать a.pdf](${RELAY}/a.pdf)`, created_at: '2026-09-01T00:00:00Z' }]);
    const [item] = await new ChatFilesService(pg as any).listForSession('u1', 'u1_12');
    expect(item).toMatchObject({ key: `${RELAY}/a.pdf`, stored: false, name: 'a.pdf' });
    expect(item.url).toBeUndefined();
  });

  it('видео: готовое — с адресом и превью, неудачное и чужое — выпадают', async () => {
    const pg = makePg(
      [{ id: 1, content: `[VIDEO_JOB:${VID_OK}] [VIDEO_JOB:${VID_FAILED}] [VIDEO_JOB:${VID_ALIEN}]`, created_at: '2026-10-01T00:00:00Z' }],
      [
        { id: VID_OK, user_id: 'u1', status: 'ready', video_url: 'https://v/ok.mp4', thumbnail_url: 'https://v/ok.jpg' },
        { id: VID_FAILED, user_id: 'u1', status: 'failed', video_url: null, thumbnail_url: null },
        { id: VID_ALIEN, user_id: 'u2', status: 'ready', video_url: 'https://v/alien.mp4', thumbnail_url: null },
      ],
    );
    const items = await new ChatFilesService(pg as any).listForSession('u1', 'u1_12');
    expect(items.map((i) => [i.key, i.url, i.thumbUrl])).toEqual([[`video_job:${VID_OK}`, 'https://v/ok.mp4', 'https://v/ok.jpg']]);
    const q = pg.calls.find((c) => /FROM video_jobs/.test(c.sql))!;
    expect(q.sql).toMatch(/id = ANY\(\$1::uuid\[\]\) AND user_id = \$2/);
    expect(q.params).toEqual([[VID_OK, VID_FAILED, VID_ALIEN], 'u1']);
  });

  it('озвучка — адрес из speech_clips, только своя', async () => {
    const pg = makePg(
      [{ id: 1, content: `{{audio:id=${AUD}}}`, created_at: '2026-10-01T00:00:00Z' }],
      [],
      [{ id: AUD, user_id: 'u1', url: 'https://a/clip.mp3' }],
    );
    const items = await new ChatFilesService(pg as any).listForSession('u1', 'u1_12');
    expect(items).toEqual([
      expect.objectContaining({ key: `audio_clip:${AUD}`, kind: 'audio', url: 'https://a/clip.mp3', stored: true }),
    ]);
    expect(pg.calls.find((c) => /FROM speech_clips/.test(c.sql))!.params).toEqual([[AUD], 'u1']);
  });
});
