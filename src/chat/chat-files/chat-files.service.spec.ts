import { ChatFilesService, SESSION_FILES_SQL } from './chat-files.service';
import { ChatUploadRecord, ChatUploadsService } from '../chat-uploads/chat-uploads.service';

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

// CHAT_UPLOADS_ENABLED — гейт загрузок в панели. По умолчанию выключен,
// включает его только блок «с CHAT_UPLOADS_ENABLED»; исходное значение
// воркера возвращаем, чтобы флаг не протёк в соседние файлы.
const savedUploadsFlag = process.env.CHAT_UPLOADS_ENABLED;
afterAll(() => {
  if (savedUploadsFlag === undefined) delete process.env.CHAT_UPLOADS_ENABLED;
  else process.env.CHAT_UPLOADS_ENABLED = savedUploadsFlag;
});

beforeEach(() => {
  process.env.MINIO_PUBLIC_URL = `${MINIO}/`;
  delete process.env.AGENT_URL;
  delete process.env.BACKEND_URL;
  delete process.env.CHAT_UPLOADS_ENABLED;
});

describe('ChatFilesService.listForSession', () => {
  it('флаг выключен: только ответы ассистента этой переписки, одним запросом, реестр загрузок не трогается', async () => {
    const pg = makePg([]);
    // uploads = null: любое обращение к реестру при выключенном флаге уронило бы тест.
    await new ChatFilesService(pg as any, null as any).listForSession('u1', 'u1_12');
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
    const items = await new ChatFilesService(pg as any, null as any).listForSession('u1', 'u1_12');
    expect(items).toEqual([
      {
        key: url, kind: 'image', url, name: '1.png', ext: 'png', createdAt: '2026-10-05T10:00:00.000Z', messageId: 20, stored: true,
        // Картинка из нашего бакета — ручка миниатюры (chat-files-thumbs.spec.ts).
        thumbPath: `/webhook/chat/thumb?src=${encodeURIComponent('linkeon-assets/images/1.png')}`,
      },
    ]);
  });

  it('у не сохранившегося файла нет адреса', async () => {
    const pg = makePg([{ id: 1, content: `[Скачать a.pdf](${RELAY}/a.pdf)`, created_at: '2026-09-01T00:00:00Z' }]);
    const [item] = await new ChatFilesService(pg as any, null as any).listForSession('u1', 'u1_12');
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
    const items = await new ChatFilesService(pg as any, null as any).listForSession('u1', 'u1_12');
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
    const items = await new ChatFilesService(pg as any, null as any).listForSession('u1', 'u1_12');
    expect(items).toEqual([
      expect.objectContaining({ key: `audio_clip:${AUD}`, kind: 'audio', url: 'https://a/clip.mp3', stored: true }),
    ]);
    expect(pg.calls.find((c) => /FROM speech_clips/.test(c.sql))!.params).toEqual([[AUD], 'u1']);
  });
});

describe('ChatFilesService.listForSession с CHAT_UPLOADS_ENABLED: загрузки пользователя', () => {
  const UP_PHOTO = 'c1c1c1c1-1111-4111-8111-111111111111';
  const UP_CLIP = 'c2c2c2c2-2222-4222-8222-222222222222';
  const UP_SCAN = 'c3c3c3c3-3333-4333-8333-333333333333';
  const AI_IMG = `${MINIO}/linkeon-assets/images/1.png`;

  /** Запись реестра после миграции 002 — как её отдаёт ChatUploadsService. */
  const upload = (p: Partial<ChatUploadRecord> = {}): ChatUploadRecord => ({
    id: UP_PHOTO,
    userId: 'u1',
    sessionId: 'u1_12',
    originalName: 'гостиная.jpg',
    mime: 'image/jpeg',
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    storageKey: `${UP_PHOTO}/гостиная.jpg`,
    createdAt: '2026-10-10T10:00:00.000Z',
    source: 'web',
    thumbKey: `thumbs/${UP_PHOTO}/гостиная.jpg.webp`,
    note: 'Фото гостиной: выбрали светлые обои',
    noteUpdatedAt: '2026-10-10T10:05:00.000Z',
    noteAssistantId: '12',
    ...p,
  });

  /**
   * Настоящий ChatUploadsService — адрес ownerUrl берётся у него, а не
   * переписывается в тесте; подменена только выборка реестра (её SQL
   * закрепляет chat-uploads.panel.spec.ts).
   */
  function makeUploads(records: ChatUploadRecord[]) {
    const uploads = new ChatUploadsService(null as any, null as any);
    const list = jest.spyOn(uploads, 'listForSessionPanel').mockResolvedValue(records);
    return { uploads, list };
  }

  beforeEach(() => {
    process.env.CHAT_UPLOADS_ENABLED = 'true';
  });

  it('файлы ассистента и загрузки — один список от новых к старым; поля загрузки — по контракту панели', async () => {
    const pg = makePg([
      { id: 20, content: `![](${AI_IMG})`, created_at: '2026-10-05T10:00:00Z' },
      { id: 10, content: `[Скачать a.pdf](${RELAY}/a.pdf)`, created_at: '2026-09-01T00:00:00Z' },
    ]);
    const { uploads, list } = makeUploads([
      upload(),
      upload({
        id: UP_CLIP,
        originalName: 'прогулка.mp4',
        mime: 'video/mp4',
        storageKey: `${UP_CLIP}/прогулка.mp4`,
        createdAt: '2026-09-20T08:00:00.000Z',
        source: 'telegram',
        thumbKey: null,
        note: null,
        noteUpdatedAt: null,
        noteAssistantId: null,
      }),
      upload({
        id: UP_SCAN,
        originalName: 'Договор.pdf',
        mime: 'application/pdf',
        storageKey: `${UP_SCAN}/Договор.pdf`,
        createdAt: '2026-09-15T12:00:00.000Z',
        source: 'scan',
        thumbKey: null,
        note: 'Договор аренды: нашли пункт о залоге',
        noteAssistantId: '3',
      }),
    ]);

    const items = await new ChatFilesService(pg as any, uploads).listForSession('u1', 'u1_12');

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith('u1', 'u1_12');
    // История читается тем же единственным запросом, что и без флага.
    expect(pg.calls.map((c) => c.sql)).toEqual([SESSION_FILES_SQL]);
    expect(items).toEqual([
      {
        key: `upload:${UP_PHOTO}`, kind: 'image', name: 'гостиная.jpg', ext: 'jpg',
        createdAt: '2026-10-10T10:00:00.000Z',
        url: `/webhook/chat-uploads/${UP_PHOTO}`,
        thumbUrl: `/webhook/chat-uploads/${UP_PHOTO}/thumb`,
        stored: true, origin: 'upload', source: 'web',
        note: 'Фото гостиной: выбрали светлые обои', uploadId: UP_PHOTO,
      },
      {
        key: AI_IMG, kind: 'image', url: AI_IMG, name: '1.png', ext: 'png',
        createdAt: '2026-10-05T10:00:00.000Z', messageId: 20, stored: true, origin: 'assistant',
        thumbPath: `/webhook/chat/thumb?src=${encodeURIComponent('linkeon-assets/images/1.png')}`,
      },
      {
        key: `upload:${UP_CLIP}`, kind: 'video', name: 'прогулка.mp4', ext: 'mp4',
        createdAt: '2026-09-20T08:00:00.000Z',
        url: `/webhook/chat-uploads/${UP_CLIP}`,
        stored: true, origin: 'upload', source: 'telegram', note: null, uploadId: UP_CLIP,
      },
      {
        key: `upload:${UP_SCAN}`, kind: 'document', name: 'Договор.pdf', ext: 'pdf',
        createdAt: '2026-09-15T12:00:00.000Z',
        url: `/webhook/chat-uploads/${UP_SCAN}`,
        stored: true, origin: 'upload', source: 'scan',
        note: 'Договор аренды: нашли пункт о залоге', uploadId: UP_SCAN,
      },
      {
        key: `${RELAY}/a.pdf`, kind: 'document', name: 'a.pdf', ext: 'pdf',
        createdAt: '2026-09-01T00:00:00.000Z', messageId: 10, stored: false, origin: 'assistant',
      },
    ]);
  });

  it('картинка-загрузка без миниатюры: ни thumbUrl, ни thumbPath — приватный бакет ручка /webhook/chat/thumb не откроет', async () => {
    const pg = makePg([]);
    const { uploads } = makeUploads([upload({ thumbKey: null })]);

    const items = await new ChatFilesService(pg as any, uploads).listForSession('u1', 'u1_12');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: `upload:${UP_PHOTO}`, kind: 'image', origin: 'upload', stored: true });
    expect('thumbUrl' in items[0]).toBe(false);
    expect('thumbPath' in items[0]).toBe(false);
    // У загрузки нет строки истории — и поля messageId.
    expect('messageId' in items[0]).toBe(false);
  });

  it('сбой реестра загрузок не роняет панель: файлы ассистента отдаются без загрузок', async () => {
    const pg = makePg([{ id: 20, content: `![](${AI_IMG})`, created_at: '2026-10-05T10:00:00Z' }]);
    const { uploads, list } = makeUploads([]);
    list.mockRejectedValue(new Error('registry down'));

    const items = await new ChatFilesService(pg as any, uploads).listForSession('u1', 'u1_12');

    expect(list).toHaveBeenCalledTimes(1);
    expect(items.map((i) => i.key)).toEqual([AI_IMG]);
    expect(items[0].origin).toBe('assistant');
  });

  it('флаг не «true» (например «1») — реестр не опрашивается, ответ прежний', async () => {
    process.env.CHAT_UPLOADS_ENABLED = '1';
    const pg = makePg([{ id: 20, content: `![](${AI_IMG})`, created_at: '2026-10-05T10:00:00Z' }]);
    const { uploads, list } = makeUploads([upload()]);

    const items = await new ChatFilesService(pg as any, uploads).listForSession('u1', 'u1_12');

    expect(list).not.toHaveBeenCalled();
    expect(items.map((i) => i.key)).toEqual([AI_IMG]);
    expect(items[0].origin).toBeUndefined();
    expect(pg.calls).toHaveLength(1);
  });
});
