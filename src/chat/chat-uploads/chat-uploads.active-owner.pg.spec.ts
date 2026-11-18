import { NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { ChatUploadsService } from './chat-uploads.service';
import * as uploadThumb from './upload-thumb';
import { uploadThumbKey } from './upload-thumb';

/**
 * Гейт живого владельца в saveOriginals и setNote против живого Postgres:
 * настоящие миграции 001+002 (ChatUploadsService.migrate) и минимальная
 * фикстура user_id (internal_id text, state, deleted_at, deletion_id — как в
 * chat-upload-account-deletion.pg.spec.ts). Значения state — те, что пишет код:
 * 'active' (identity.service), 'deleted' (account-deletion.lifecycle),
 * 'blocked' (admin.service); NULL встречается у старых строк (FU-T11-2).
 *
 * Своя схема на прогон (search_path — опцией соединения, приём
 * chat-uploads.delete.pg.spec.ts): соседние pg-спеки делят ту же одноразовую
 * базу и TRUNCATE-ят chat_uploads и user_id в public.
 *
 * Главное, чего не видят юнит-тесты: INSERT … SELECT с одним и тем же $1 в
 * списке значений и в EXISTS настоящий Postgres принимает (типы параметра
 * сходятся), а неактивному владельцу строка не достаётся.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const SCHEMA = `chat_uploads_owner_${process.pid}_${Date.now()}`;
const SHA = 'e'.repeat(64);
const DELETION_ID = '22222222-2222-4222-8222-222222222222';

maybe('гейт живого владельца chat_uploads против живого Postgres', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  let service: ChatUploadsService;
  let thumb: jest.SpyInstance;
  const storage = {
    upload: jest.fn(async (_input: { bucket: string; key: string }): Promise<string> => 'https://public.invalid/x'),
    delete: jest.fn(async (_input: { bucket: string; key: string }): Promise<void> => undefined),
    createBucketIfAbsent: jest.fn(async (_bucket: string): Promise<void> => undefined),
  };
  const db = {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]),
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    await pool.query(`CREATE TABLE user_id (
      internal_id text PRIMARY KEY,
      state text,
      deleted_at timestamptz,
      deletion_id uuid
    )`);
    service = new ChatUploadsService(db as any, storage as any);
    await service.migrate();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE chat_uploads, user_id');
    storage.upload.mockReset().mockResolvedValue('https://public.invalid/x');
    storage.delete.mockReset().mockResolvedValue(undefined);
    storage.createBucketIfAbsent.mockReset().mockResolvedValue(undefined);
    // Миниатюра без sharp: проверяется уборка её ключа, а не рендер.
    thumb = jest
      .spyOn(uploadThumb, 'makeUploadThumb')
      .mockResolvedValue({ ok: true, webp: Buffer.from('synthetic-webp') });
  });

  afterEach(() => thumb.mockRestore());

  async function seedUser(internalId: string, state: string | null): Promise<void> {
    const deleted = state === 'deleted';
    await pool.query(
      'INSERT INTO user_id (internal_id, state, deleted_at, deletion_id) VALUES ($1, $2, $3, $4)',
      [internalId, state, deleted ? new Date('2026-11-18T05:00:00.000Z') : null, deleted ? DELETION_ID : null],
    );
  }

  async function uploadsOf(userId: string): Promise<Array<{ original_name: string; note: string | null }>> {
    const { rows } = await pool.query(
      'SELECT original_name, note FROM chat_uploads WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
    return rows;
  }

  async function seedUpload(userId: string, key: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO chat_uploads (user_id, session_id, original_name, mime, size_bytes, sha256, storage_key)
       VALUES ($1, $1 || '_12', 'скан.pdf', 'application/pdf', 10, $2, $3)
       RETURNING id`,
      [userId, SHA, key],
    );
    return String(rows[0].id);
  }

  const photo = (name: string) => ({ buffer: Buffer.from('jpeg-bytes'), originalname: name, mimetype: 'image/jpeg' });
  const uploadedKeys = () => storage.upload.mock.calls.map((call) => call[0].key);
  const deletedKeys = () => storage.delete.mock.calls.map((call) => call[0].key);

  describe('saveOriginals', () => {
    it('живой владелец: строка записана со всеми полями, уборки нет', async () => {
      await seedUser('u-active', 'active');

      const result = await service.saveOriginals({
        userId: 'u-active',
        sessionId: 'u-active_12',
        files: [photo('гостиная.jpg')],
      });

      expect(result.failed).toEqual([]);
      expect(result.saved).toHaveLength(1);
      const [originalKey] = uploadedKeys();
      expect(result.saved[0]).toMatchObject({
        userId: 'u-active',
        sessionId: 'u-active_12',
        originalName: 'гостиная.jpg',
        mime: 'image/jpeg',
        sizeBytes: 10,
        storageKey: originalKey,
        source: 'web',
        thumbKey: uploadThumbKey(originalKey),
      });
      expect(await uploadsOf('u-active')).toEqual([{ original_name: 'гостиная.jpg', note: null }]);
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it.each([
      ['deleted', 'deleted'],
      ['blocked', 'blocked'],
      ['state NULL', null],
    ])('владелец %s: строки нет, оригинал и миниатюра убраны, файл в failed', async (_label, state) => {
      await seedUser('u-gone', state);

      const result = await service.saveOriginals({
        userId: 'u-gone',
        sessionId: 'u-gone_12',
        files: [photo('паспорт.jpg')],
      });

      expect(result).toEqual({ saved: [], failed: ['паспорт.jpg'] });
      expect(await uploadsOf('u-gone')).toEqual([]);
      const [originalKey, thumbKey] = uploadedKeys();
      expect(thumbKey).toBe(uploadThumbKey(originalKey));
      expect(deletedKeys()).toEqual([originalKey, thumbKey]);
    });

    it('строки user_id нет вовсе — тоже ничего не записано', async () => {
      const result = await service.saveOriginals({
        userId: 'u-missing',
        sessionId: 'u-missing_12',
        files: [{ buffer: Buffer.from('%PDF-1.4 synthetic'), originalname: 'скан.pdf', mimetype: 'application/pdf' }],
      });

      expect(result).toEqual({ saved: [], failed: ['скан.pdf'] });
      expect(await uploadsOf('u-missing')).toEqual([]);
      expect(deletedKeys()).toEqual(uploadedKeys());
    });

    it('аккаунт удалён, пока объект ложился в MinIO: INSERT строку не пишет, объекты убраны', async () => {
      await seedUser('u-race', 'active');
      // Удаление коммитится между загрузкой объекта и INSERT — та же форма,
      // что account-deletion.lifecycle (state, deleted_at, deletion_id).
      storage.upload.mockImplementationOnce(async () => {
        await pool.query(
          `UPDATE user_id SET state = 'deleted', deleted_at = now(), deletion_id = $2 WHERE internal_id = $1`,
          ['u-race', DELETION_ID],
        );
        return 'https://public.invalid/x';
      });

      const result = await service.saveOriginals({
        userId: 'u-race',
        sessionId: 'u-race_12',
        files: [photo('фото.jpg')],
      });

      expect(result).toEqual({ saved: [], failed: ['фото.jpg'] });
      expect(await uploadsOf('u-race')).toEqual([]);
      expect(deletedKeys()).toEqual(uploadedKeys());
    });

    it('гейт смотрит на владельца, а не на соседей: живой рядом с удалённым пишет', async () => {
      await seedUser('u-active', 'active');
      await seedUser('u-gone', 'deleted');

      await service.saveOriginals({ userId: 'u-gone', sessionId: 'u-gone_12', files: [photo('a.jpg')] });
      await service.saveOriginals({ userId: 'u-active', sessionId: 'u-active_12', files: [photo('b.jpg')] });

      expect(await uploadsOf('u-gone')).toEqual([]);
      expect(await uploadsOf('u-active')).toEqual([{ original_name: 'b.jpg', note: null }]);
    });
  });

  describe('setNote', () => {
    it('живой владелец: комментарий записан', async () => {
      await seedUser('u-active', 'active');
      const id = await seedUpload('u-active', 'k-1/скан.pdf');

      const record = await service.setNote({ id, userId: 'u-active', note: 'Скан договора', assistantId: '3' });

      expect(record).toMatchObject({ id, note: 'Скан договора', noteAssistantId: '3' });
      expect(await uploadsOf('u-active')).toEqual([{ original_name: 'скан.pdf', note: 'Скан договора' }]);
    });

    it.each([
      ['deleted', 'deleted'],
      ['blocked', 'blocked'],
    ])('владелец %s: NotFound как у несуществующего id, строка не тронута', async (_label, state) => {
      await seedUser('u-gone', state);
      const id = await seedUpload('u-gone', 'k-2/скан.pdf');

      const inactive = await service
        .setNote({ id, userId: 'u-gone', note: 'Скан договора', assistantId: '3' })
        .then(() => null, (e) => e);
      const missing = await service
        .setNote({ id: '99999999-9999-4999-8999-999999999999', userId: 'u-gone', note: 'Скан договора', assistantId: '3' })
        .then(() => null, (e) => e);

      expect(inactive).toBeInstanceOf(NotFoundException);
      expect(missing).toBeInstanceOf(NotFoundException);
      expect(inactive.getResponse()).toEqual(missing.getResponse());
      expect(await uploadsOf('u-gone')).toEqual([{ original_name: 'скан.pdf', note: null }]);
    });
  });
});
