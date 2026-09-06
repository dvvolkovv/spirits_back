import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TgBotService } from './tg-bot.service';
import { TgRouterService } from './tg-router.service';

/**
 * ПАМЯТЬ ЧАТА НА ФАЙЛЫ.
 *
 * Инцидент 06.09.2026, владелец 79235216999 (бот «Фин директор»). Прислал xlsx
 * с реестром расходов, ассистент его разобрал — а дальше четыре хода подряд
 * отвечал агрегатами и в итоге написал пользователю прямым текстом: «Файл до
 * меня не доходит — четвёртый раз подряд. Проверил и рабочую папку, и весь
 * диск: твоего исходника нет».
 *
 * Ассистент не выдумывал. Транскрипты Claude CLI на проде
 * (~/.claude/projects/-tmp-tg-bot-71e4341e-*) показывают строку
 * «Приложенные файлы: @/tmp/tg-attach-….docx» ровно в ОДНОМ ходе из семи, а в
 * pm2-логе за тот период ноль срабатываний `attachment download failed` и
 * `skip oversized attachment` — то есть по дороге ничего не терялось.
 *
 * Причина: вложение и рабочая папка жили ровно один ход. Файл качался в
 * os.tmpdir() и удалялся в `finally`, песочница сносилась через rmSync, а в
 * `tg_bot_messages` попадал только текст — без имени файла. Следующий ход
 * получал пустую папку и историю, в которой о файле ни слова, поэтому «сделай
 * как в файле» уходило в модель без файла: быстро, дёшево и мимо задачи.
 *
 * Тесты проверяют ТРИ независимых звена памяти. Проверять одно бессмысленно:
 * файл на диске без упоминания в истории модель не найдёт, а упоминание в
 * истории без файла на диске — ровно та ложь, из-за которой ассистент
 * оправдывался перед владельцем.
 */

const cfgId = '71e4341e-8372-47a5-8d6d-79b7be17da37';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-spec-'));
}

function makeBotService(grammy: any): TgBotService {
  return new TgBotService(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, grammy as any, {} as any, {} as any,
  );
}

describe('рабочая папка чата переживает ход', () => {
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

  it('вложение ложится в папку чата, а не в os.tmpdir()', async () => {
    const grammy = {
      getFile: jest.fn(async () => ({ file_path: 'documents/file_7.xlsx' })),
      downloadFile: jest.fn(async () => Buffer.from('xlsx-bytes')),
    };
    const svc = makeBotService(grammy);

    const ws = (svc as any).chatWorkspace(cfgId);
    const msg = {
      document: { file_id: 'BQACAgIAAxkBAAIC', file_size: 16568, file_name: 'dds.xlsx', mime_type: 'application/vnd.ms-excel' },
    };

    const paths: string[] = await (svc as any).downloadIncomingAttachments(msg, ws);

    expect(paths).toHaveLength(1);
    // Внутри папки чата — значит следующий ход, у которого cwd тот же, его увидит.
    expect(path.dirname(paths[0])).toBe(ws);
    expect(fs.existsSync(paths[0])).toBe(true);
    // Имя сохраняем: юзер говорит «в файле dds.xlsx», модель должна найти его по имени.
    expect(path.basename(paths[0])).toBe('dds.xlsx');
  });

  it('папка одна и та же для двух ходов одного чата', () => {
    const svc = makeBotService({});
    expect((svc as any).chatWorkspace(cfgId)).toBe((svc as any).chatWorkspace(cfgId));
  });

  it('разные чаты не видят файлы друг друга', () => {
    const svc = makeBotService({});
    const a = (svc as any).chatWorkspace(cfgId);
    const b = (svc as any).chatWorkspace('3496b73f-7855-496d-801b-cda8459c2ca3');
    expect(a).not.toBe(b);
  });
});

describe('исходящие артефакты: только то, что сделано в этом ходе', () => {
  let dir: string;

  beforeEach(() => { dir = tmpRoot(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (name: string, mtimeMs: number) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'x');
    fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
    return p;
  };

  it('файл прошлого хода второй раз не отправляется', () => {
    const svc = makeBotService({});
    const turnStart = Date.now();

    write('dogovor-proshlyj-hod.docx', turnStart - 60_000);
    const fresh = write('dogovor.docx', turnStart + 1000);

    const out: string[] = (svc as any).scanSandboxOutputs(dir, turnStart, new Set());

    expect(out).toEqual([fresh]);
  });

  it('присланный юзером файл не возвращается ему эхом', () => {
    const svc = makeBotService({});
    const turnStart = Date.now();

    // Вложение пишется в ту же папку и в этом же ходе — по одному mtime его от
    // результата не отличить, поэтому входящие исключаются явным списком.
    const incoming = write('dds.xlsx', turnStart + 500);
    const produced = write('dds-svod.xlsx', turnStart + 900);

    const out: string[] = (svc as any).scanSandboxOutputs(dir, turnStart, new Set([incoming]));

    expect(out).toEqual([produced]);
  });
});

describe('история чата помнит, что файл был приложен', () => {
  it('в tg_bot_messages попадает имя файла, а не только текст', async () => {
    const calls: { sql: string; params: any[] }[] = [];
    const pg = { query: jest.fn(async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return { rows: [] }; }) };
    const router = new TgRouterService(pg as any, {} as any, {} as any, {} as any, {} as any);

    await router.persistUserMessage({ id: cfgId } as any, {
      chatId: 777, msgId: 42, fromTgUserId: 275385039, fromTgUserName: 'Arman',
      text: 'Сделай таблицу исходя из данных в файле',
      isVoice: false,
      attachmentPaths: ['/srv/ws/71e4341e/dds.xlsx'],
    });

    const row = calls.find(c => /INSERT INTO tg_bot_messages/.test(c.sql));
    expect(row).toBeDefined();
    const content = String(row!.params[5]);
    // Без имени файла модель на следующем ходу не знает, что в папке лежит dds.xlsx.
    expect(content).toContain('dds.xlsx');
    expect(content).toContain('Сделай таблицу исходя из данных в файле');
  });
});
