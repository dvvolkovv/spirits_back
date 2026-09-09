import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TgBotService } from './tg-bot.service';

/**
 * АЛЬБОМ: НЕСКОЛЬКО ФАЙЛОВ ОДНОЙ ОТПРАВКОЙ.
 *
 * Репорт владельца 09.09.2026: «в телеге закидываю сразу несколько файлов, а
 * берёт в работу только один».
 *
 * Telegram не отдаёт альбом одним апдейтом. Он присылает N отдельных сообщений
 * с общим media_group_id — каждое со своим файлом, и только одно с подписью.
 * Контроллер отдаёт апдейты в работу параллельно (fire-and-forget), поэтому до
 * этого фикса происходило два независимых обвала:
 *
 * 1) Первое сообщение забирало per-chat advisory lock и уходило в модель ровно
 *    с ОДНИМ вложением в attachmentPaths. Остальные упирались в занятый лок и
 *    логировались как «busy, skipping» — в прод-логе 08.09.2026 такие строки
 *    стоят вплотную к парам `attachment saved`.
 *
 * 2) Даже физически на диск ложился один файл: fallback-имя строилось из
 *    первых 16 символов file_id, а у фотографий это общий заголовок. В том же
 *    прод-логе два РАЗНЫХ кадра (59546 и 70838 байт) записались в один и тот же
 *    tg-AgACAgIAAxkBAAID.jpg в одну секунду — второй затёр первый.
 *
 * Оба звена проверяются отдельно: починить склейку апдейтов и оставить
 * коллизию имён — значит получить ход, который честно перечислит пять файлов,
 * а прочитает один и тот же.
 */

const cfgId = '71e4341e-8372-47a5-8d6d-79b7be17da37';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'album-spec-'));
}

function makeBotService(grammy: any): TgBotService {
  return new TgBotService(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, grammy as any, {} as any, {} as any,
  );
}

/** Фото-часть альбома. file_id у всех кадров начинается одинаково — так их отдаёт Telegram. */
function photoPart(messageId: number, uniqueId: string, bytes: number, caption?: string) {
  return {
    chat: { id: 37948399, type: 'private' },
    from: { id: 275385039, first_name: 'Arman' },
    message_id: messageId,
    media_group_id: '13950704970834215',
    ...(caption ? { caption } : {}),
    photo: [
      { file_id: `AgACAgIAAxkBAAID${messageId}-small`, file_unique_id: `${uniqueId}s`, file_size: 900 },
      { file_id: `AgACAgIAAxkBAAID${messageId}-large`, file_unique_id: uniqueId, file_size: bytes },
    ],
  };
}

function docPart(messageId: number, fileName: string, caption?: string) {
  return {
    chat: { id: 37948399, type: 'private' },
    from: { id: 275385039, first_name: 'Arman' },
    message_id: messageId,
    media_group_id: '13950704970834216',
    ...(caption ? { caption } : {}),
    document: {
      file_id: `BQACAgIAAxkBAAID${messageId}`,
      file_unique_id: `uniq-${messageId}`,
      file_size: 16568,
      file_name: fileName,
      mime_type: 'application/vnd.ms-excel',
    },
  };
}

describe('альбом уезжает в модель целиком, а не первым файлом', () => {
  let root: string;
  let prevRoot: string | undefined;

  beforeEach(() => {
    root = tmpRoot();
    prevRoot = process.env.TG_WORKSPACE_ROOT;
    process.env.TG_WORKSPACE_ROOT = root;
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.TG_WORKSPACE_ROOT;
    else process.env.TG_WORKSPACE_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('три документа из одного альбома скачиваются все три', async () => {
    const grammy = {
      getFile: jest.fn(async (id: string) => ({ file_path: `documents/${id}.xlsx` })),
      downloadFile: jest.fn(async () => Buffer.from('xlsx-bytes')),
    };
    const svc = makeBotService(grammy);
    const ws = (svc as any).chatWorkspace(cfgId);

    const parts = [docPart(101, 'dds.xlsx'), docPart(102, 'plan.xlsx'), docPart(103, 'fakt.xlsx')];
    const merged = { ...parts[0], albumParts: parts };

    const paths: string[] = await (svc as any).downloadIncomingAttachments(merged, ws);

    expect(paths).toHaveLength(3);
    expect(paths.map(p => path.basename(p))).toEqual(['dds.xlsx', 'plan.xlsx', 'fakt.xlsx']);
    for (const p of paths) expect(fs.existsSync(p)).toBe(true);
  });

  it('фото из одного альбома не затирают друг друга', async () => {
    // Размер отличается — значит это разные кадры, и на диске их должно быть два.
    const sizes: Record<string, number> = { 'ph-a': 59546, 'ph-b': 70838 };
    const grammy = {
      getFile: jest.fn(async (id: string) => ({ file_path: `photos/${id}.jpg` })),
      downloadFile: jest.fn(async (p: string) => {
        const uid = p.includes('201') ? 'ph-a' : 'ph-b';
        return Buffer.alloc(sizes[uid], 1);
      }),
    };
    const svc = makeBotService(grammy);
    const ws = (svc as any).chatWorkspace(cfgId);

    const parts = [photoPart(201, 'ph-a', 59546, 'что тут по цифрам?'), photoPart(202, 'ph-b', 70838)];
    const merged = { ...parts[0], albumParts: parts };

    const paths: string[] = await (svc as any).downloadIncomingAttachments(merged, ws);

    expect(paths).toHaveLength(2);
    // Именно это ломалось на проде: два разных кадра — один файл.
    expect(new Set(paths).size).toBe(2);
    expect(fs.statSync(paths[0]).size).toBe(59546);
    expect(fs.statSync(paths[1]).size).toBe(70838);
  });
});

describe('части альбома копятся и уходят одним ходом', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('три апдейта с общим media_group_id дают один вызов обработки', async () => {
    const svc = makeBotService({});
    const turns: any[] = [];
    (svc as any).handleChatMessage = jest.fn(async (msg: any) => { turns.push(msg); });

    const cfg = { id: cfgId } as any;
    const parts = [docPart(101, 'dds.xlsx', 'сведи эти три'), docPart(102, 'plan.xlsx'), docPart(103, 'fakt.xlsx')];
    for (const p of parts) (svc as any).bufferAlbumPart(cfg, p);

    // До истечения дебаунса ход не стартует: иначе он уедет с одним файлом.
    expect(turns).toHaveLength(0);

    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();

    expect(turns).toHaveLength(1);
    expect(turns[0].albumParts).toHaveLength(3);
  });

  it('подпись берётся с той части альбома, где она есть', async () => {
    const svc = makeBotService({});
    const turns: any[] = [];
    (svc as any).handleChatMessage = jest.fn(async (msg: any) => { turns.push(msg); });

    // Апдейты приезжают параллельно и не по порядку, подпись — на втором файле.
    const cfg = { id: cfgId } as any;
    (svc as any).bufferAlbumPart(cfg, docPart(103, 'fakt.xlsx'));
    (svc as any).bufferAlbumPart(cfg, docPart(102, 'plan.xlsx', 'сведи эти три в одну'));
    (svc as any).bufferAlbumPart(cfg, docPart(101, 'dds.xlsx'));

    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();

    expect(turns).toHaveLength(1);
    // Потерять подпись — это ход «(юзер прислал файл без подписи)» вместо задачи.
    expect(turns[0].caption).toBe('сведи эти три в одну');
    // Порядок — тот, в котором пользователь отправлял, а не в котором приехали апдейты.
    expect(turns[0].albumParts.map((p: any) => p.document.file_name))
      .toEqual(['dds.xlsx', 'plan.xlsx', 'fakt.xlsx']);
  });

  it('альбомы разных чатов не смешиваются', async () => {
    const svc = makeBotService({});
    const turns: any[] = [];
    (svc as any).handleChatMessage = jest.fn(async (msg: any) => { turns.push(msg); });

    const a = docPart(101, 'a.xlsx');
    const b = { ...docPart(102, 'b.xlsx'), chat: { id: -100500, type: 'group' } };
    (svc as any).bufferAlbumPart({ id: cfgId } as any, a);
    (svc as any).bufferAlbumPart({ id: 'other-cfg' } as any, b);

    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();

    expect(turns).toHaveLength(2);
    expect(turns.every(t => t.albumParts.length === 1)).toBe(true);
  });
});
