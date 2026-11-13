# Память загруженных файлов и ссылок — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** исходные загрузки пользователя сохраняются в приватном MinIO и Postgres, доступны владельцу по JWT, ассистент получает короткоживущие ссылки и находит их в текущем и будущих чатах.

**Architecture:** отдельный `ChatUploadsModule` сохраняет байты до вызова релея и выдаёт их только владельцу или по часовой HMAC-подписи. `ChatService` добавляет последние записи в prompt каждого хода, `find_files` объединяет исходные загрузки, созданные ассистентом файлы и внешние ссылки. Фронтенд использует единый multipart-путь и скачивает приватные файлы через `apiClient`.

**Spec:** `docs/superpowers/specs/2026-11-13-chat-upload-memory-design.md` — читать первым.

**Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL, MinIO/S3, React 18, Jest, Node 22.

---

## Правила работы

- Локальное воркдерево: `~/Downloads/spirits_back/.worktrees/chat-upload-memory`, ветка `feat/chat-upload-memory`. Общие чекауты не трогать.
- **Тесты, tsc и сборки — только на ноде** `dv@85.192.61.231`, воркдерево `~/ci/wt/chat-upload-memory`. В каждой ssh-команде — `source ~/.nvm/nvm.sh`.
- На ноде не трогать `~/spirits_back`, `~/spirits_front`, `~/dev`; в `~/ci/spirits_back` разрешены только `git -C … fetch` и `worktree add/remove`.
- TDD: падающий тест отдельным коммитом → проверить RED → реализация следующим коммитом → проверить GREEN. Никаких amend/force/rebase.
- Коммиты заканчивать `Co-Authored-By: Kimi <noreply@anthropic.com>`. В тестах — только синтетические имена и ID, без реальных телефонов и секретов.
- Публичный `StorageService.upload()` возвращает URL, но его нельзя сохранять в историю или metadata. Исходники доступны только через `ChatUploadsController`.

Шаблон прогона после локального коммита:

```bash
cd ~/Downloads/spirits_back/.worktrees/chat-upload-memory
git push -q origin feat/chat-upload-memory
SHA=$(git rev-parse HEAD)
ssh -n dv@85.192.61.231 "cd ~/ci/wt/chat-upload-memory && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/chat/chat-uploads 2>&1 | tail -25"
```

## Карта файлов

| Файл | Ответственность |
|---|---|
| `src/chat/chat-uploads/chat-uploads.service.ts` | реестр, MinIO, подпись, поиск, удаление |
| `src/chat/chat-uploads/chat-uploads.controller.ts` | скачивание через JWT или подпись |
| `src/chat/chat-uploads/chat-uploads.module.ts` | независимый модуль для chat и profile |
| `src/chat/chat-uploads/migrations/001_chat_uploads.sql` | таблица и индексы |
| `src/common/services/storage.service.ts` | `downloadStream`, `createBucketIfAbsent` |
| `src/chat/chat.controller.ts` | сохранение до relay, history links, failure event |
| `src/chat/chat.service.ts` | prompt последних загрузок |
| `src/chat/chat-files/chat-files.service.ts` | три источника `find_files` |
| `src/chat/chat-files/find-files.ts` | `kind=link` |
| `src/chat/chat-files/find-files.tool.ts` | правила URL для модели |
| `src/products/products-cli-tool.ts` | вторая копия правил `find_files` |
| `src/chat/chat.module.ts` | импорт `ChatUploadsModule` |
| `src/profile/profile.service.ts`, `src/profile/profile.module.ts` | удаление загрузок аккаунта |
| `src/components/chat/ChatInterface.tsx` (front `src/`) | единый multipart, приватная ссылка, failure toast |
| `src/components/chat/historyMerge.ts` (front `src/`) | сохранение ссылок в истории |
| `scripts/provision-test.sh` | bucket без anonymous policy |
| `CLAUDE.md`, `src/platform-kb/articles/account.ts` | эксплуатация и удаление аккаунта |

### Task 0: воркдерево на ноде и база

- [ ] **Step 1: синхронизировать ветку и подготовить CI**

```bash
cd ~/Downloads/spirits_back/.worktrees/chat-upload-memory
git fetch -q origin
git merge --no-edit origin/main
git push -q origin feat/chat-upload-memory
ssh -n dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/chat-upload-memory origin/feat/chat-upload-memory && cd ~/ci/wt/chat-upload-memory && source ~/.nvm/nvm.sh && npm ci --no-audit --no-fund --loglevel=error && echo READY'
```

Expected: merge или `Already up to date`, `READY`. Конфликты не разрешать автоматически.

- [ ] **Step 2: снять базу**

```bash
ssh -n dv@85.192.61.231 'cd ~/ci/wt/chat-upload-memory && source ~/.nvm/nvm.sh && npx jest src/ --silent 2>&1 | tail -8 && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK'
```

Expected: ноль failed и `TSC_OK`; записать числа в отчёт.

### Task 1: таблица и `ChatUploadsService`

**Files:**
- Create: `src/chat/chat-uploads/migrations/001_chat_uploads.sql`
- Create: `src/chat/chat-uploads/chat-uploads.service.ts`
- Test: `src/chat/chat-uploads/chat-uploads.service.spec.ts`

- [ ] **Step 1: написать падающие тесты**

```ts
import { createHash } from 'crypto';
import { ChatUploadsService } from './chat-uploads.service';

describe('ChatUploadsService', () => {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const storage = {
    upload: jest.fn(async () => 'https://public.invalid/should-not-be-used'),
    delete: jest.fn(async () => {}),
    createBucketIfAbsent: jest.fn(async () => {}),
  };
  const service = new ChatUploadsService(pg as any, storage as any);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'spec-secret';
    process.env.BACKEND_URL = 'https://my.linkeon.test';
  });

  it('сохраняет байты и запись без публичной ссылки', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: '11111111-1111-4111-8111-111111111111', user_id: 'u1', session_id: 'u1_12', original_name: 'a.pdf', mime: 'application/pdf', size_bytes: 3, sha256: createHash('sha256').update('abc').digest('hex'), storage_key: 'k/a.pdf', created_at: new Date('2026-01-01') }] });
    const result = await service.saveOriginals({ userId: 'u1', sessionId: 'u1_12', files: [{ buffer: Buffer.from('abc'), originalname: 'a.pdf', mimetype: 'application/pdf' }] });
    expect(result.saved[0]).toMatchObject({ originalName: 'a.pdf', sizeBytes: 3 });
    expect(result.failed).toEqual([]);
    expect(storage.upload.mock.calls[0][0].bucket).toBe('linkeon-chat-uploads');
    expect(JSON.stringify(result)).not.toContain('public.invalid');
  });

  it('при ошибке записи удаляет объект и возвращает failed', async () => {
    pg.query.mockRejectedValueOnce(new Error('db down'));
    const result = await service.saveOriginals({ userId: 'u1', sessionId: 'u1_12', files: [{ buffer: Buffer.from('x'), originalname: 'x.txt' }] });
    expect(result.failed).toEqual(['x.txt']);
    expect(storage.delete).toHaveBeenCalled();
  });

  it('подпись живёт час и не принимает чужую/просроченную', () => {
    const url = service.assistantUrl('11111111-1111-4111-8111-111111111111', 1000);
    expect(url).toContain('exp=4600');
    expect(service.verifyAssistant('11111111-1111-4111-8111-111111111111', '4600', url.split('sig=')[1], 1000)).toBe(true);
    expect(service.verifyAssistant('11111111-1111-4111-8111-111111111111', '4600', 'bad', 1000)).toBe(false);
    expect(service.verifyAssistant('11111111-1111-4111-8111-111111111111', '4600', url.split('sig=')[1], 4601)).toBe(false);
  });
});
```

Commit: `test(chat-uploads): реестр и подпись — красный`.

- [ ] **Step 2: проверить RED на ноде**

```bash
ssh -n dv@85.192.61.231 'cd ~/ci/wt/chat-upload-memory && source ~/.nvm/nvm.sh && npx jest src/chat/chat-uploads 2>&1 | tail -20'
```

Expected: FAIL `Cannot find module './chat-uploads.service'`.

- [ ] **Step 3: добавить миграцию и реализацию**

`001_chat_uploads.sql`:

```sql
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('chat-uploads/001'));
  PERFORM set_config('lock_timeout', '5s', true);
  CREATE TABLE IF NOT EXISTS chat_uploads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    session_id text NOT NULL,
    original_name text NOT NULL,
    mime text NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    storage_key text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  IF to_regclass('idx_chat_uploads_user_session_created') IS NULL THEN
    CREATE INDEX idx_chat_uploads_user_session_created ON chat_uploads (user_id, session_id, created_at DESC);
  END IF;
  IF to_regclass('idx_chat_uploads_user_created') IS NULL THEN
    CREATE INDEX idx_chat_uploads_user_created ON chat_uploads (user_id, created_at DESC);
  END IF;
END $$;
```

Реализация должна экспортировать следующие типы и класс `ChatUploadsService` с методами `saveOriginals`, `ownerUrl`, `assistantUrl`, `verifyAssistant`, `openDownload`, `recentForSession`, `searchOriginals`, `deleteForUser`, `assistantBlock`.

```ts
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import { PgService } from '../../common/services/pg.service';
import { StorageService } from '../../common/services/storage.service';
import { contentDispositionFor, safeFileName } from '../chat-files/file-meta';

export interface ChatUploadInputFile { buffer: Buffer; originalname: string; mimetype?: string; }
export interface ChatUploadRecord {
  id: string; userId: string; sessionId: string; originalName: string;
  mime: string; sizeBytes: number; sha256: string; storageKey: string; createdAt: string;
}
export interface SaveOriginalsResult { saved: ChatUploadRecord[]; failed: string[]; }
```

```ts
private secret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET required');
  return secret;
}
private row(r: any): ChatUploadRecord {
  return { id: r.id, userId: r.user_id, sessionId: r.session_id,
    originalName: r.original_name, mime: r.mime, sizeBytes: Number(r.size_bytes),
    sha256: r.sha256, storageKey: r.storage_key, createdAt: new Date(r.created_at).toISOString() };
}
```

`StorageService.createBucketIfAbsent('linkeon-chat-uploads')` добавляется в `storage.service.ts` до `saveOriginals`: только `CreateBucketCommand`, игнорировать `BucketAlreadyOwnedByYou`/`BucketAlreadyExists`, без policy.

`openDownload` сначала проверяет UUID, затем `SELECT … WHERE id=$1`, пропускает либо `user_id=$userId`, либо `verifyAssistant`; при любой ошибке — `NotFoundException`. Возвращает `{body: await storage.downloadStream({bucket:'linkeon-chat-uploads',key:r.storage_key}), originalName:r.original_name, mime:r.mime, sizeBytes:Number(r.size_bytes)}`. `recentForSession` возвращает до 10 записей с `excludeIds`. `searchOriginals` фильтрует по пользователю и `days`. `deleteForUser` сначала удаляет объекты по `storage_key`, затем строки. `assistantBlock(records)` возвращает `Earlier user uploads:\n- <name>: <assistantUrl>` и пустую строку для пустого списка или выключенного flag.

```ts
@Injectable()
export class ChatUploadsService {
  constructor(private readonly pg: PgService, private readonly storage: StorageService) {}

  async saveOriginals(p: { userId: string; sessionId: string; files: readonly ChatUploadInputFile[] }): Promise<SaveOriginalsResult> {
    const saved: ChatUploadRecord[] = [];
    const failed: string[] = [];
    await this.storage.createBucketIfAbsent('linkeon-chat-uploads');
    for (const file of p.files) {
      const id = randomUUID();
      const key = `${id}/${safeFileName(file.originalname)}`;
      let uploaded = false;
      try {
        const sha256 = createHash('sha256').update(file.buffer).digest('hex');
        await this.storage.upload({ bucket: 'linkeon-chat-uploads', key, body: file.buffer,
          contentType: file.mimetype || 'application/octet-stream',
          contentDisposition: contentDispositionFor(file.originalname),
          cacheControl: 'private, no-store' });
        uploaded = true;
        const r = await this.pg.query(
          `INSERT INTO chat_uploads (id,user_id,session_id,original_name,mime,size_bytes,sha256,storage_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id,user_id,session_id,original_name,mime,size_bytes,sha256,storage_key,created_at`,
          [id, p.userId, p.sessionId, file.originalname, file.mimetype || 'application/octet-stream', file.buffer.byteLength, sha256, key]);
        saved.push(this.row(r.rows[0]));
      } catch {
        if (uploaded) await this.storage.delete({ bucket: 'linkeon-chat-uploads', key }).catch(() => {});
        failed.push(file.originalname);
      }
    }
    return { saved, failed };
  }

  ownerUrl(id: string): string { return `/webhook/chat-uploads/${id}`; }

  assistantUrl(id: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
    const exp = nowSeconds + 3600;
    const sig = createHmac('sha256', this.secret()).update(`chat-upload:v1:${id}:${exp}`).digest('hex');
    return `${process.env.BACKEND_URL || 'https://my.linkeon.io'}${this.ownerUrl(id)}?exp=${exp}&sig=${sig}`;
  }

  verifyAssistant(id: string, exp: string, sig: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    const expires = Number(exp);
    if (!Number.isSafeInteger(expires) || expires < nowSeconds || expires > nowSeconds + 3600) return false;
    const expected = createHmac('sha256', this.secret()).update(`chat-upload:v1:${id}:${expires}`).digest('hex');
    const a = Buffer.from(sig || '', 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
```

`openDownload` делает `SELECT … WHERE id=$1`, затем пропускает либо `user_id=$userId`, либо `verifyAssistant`; при любой ошибке — `NotFoundException`. `recentForSession` возвращает до 10 записей с исключениями `excludeIds`. `searchOriginals` фильтрует по пользователю и `days`. `deleteForUser` сначала удаляет объекты по `storage_key`, затем строки.

- [ ] **Step 4: проверить GREEN и tsc**

```bash
ssh -n dv@85.192.61.231 'cd ~/ci/wt/chat-upload-memory && source ~/.nvm/nvm.sh && npx jest src/chat/chat-uploads && npx tsc -p tsconfig.build.json --noEmit && echo TSC_OK'
```

Expected: 3 tests PASS, `TSC_OK`.

- [ ] **Step 5: commit**

```bash
git add src/chat/chat-uploads && git commit -m "feat(chat-uploads): реестр исходных загрузок и приватные подписи

Co-Authored-By: Kimi <noreply@anthropic.com>"
```

### Task 2: приватное скачивание и модуль

**Files:**
- Modify: `src/common/services/storage.service.ts`
- Modify: `src/chat/chat-uploads/chat-uploads.service.ts` (метод `migrate()`)
- Create: `src/chat/chat-uploads/chat-uploads.controller.ts`
- Create: `src/chat/chat-uploads/chat-uploads.module.ts`
- Modify: `src/chat/chat.module.ts`
- Test: `src/chat/chat-uploads/chat-uploads.controller.spec.ts`, `src/chat/chat-uploads/chat-uploads.module.spec.ts`

- [ ] **Step 1: написать падающий HTTP-тест**

Поднять Nest с `ChatUploadsController`, реальным `JwtService` и замоканным `ChatUploadsService.openDownload`. Проверить:

```ts
it('JWT владельца скачивает, чужой JWT и неверная подпись — 404', async () => {
  const owner = jwtService.signAccess('u1');
  const other = jwtService.signAccess('u2');
  expect((await request(app).get('/webhook/chat-uploads/11111111-1111-4111-8111-111111111111').set('Authorization', `Bearer ${owner}`)).status).toBe(200);
  expect((await request(app).get('/webhook/chat-uploads/11111111-1111-4111-8111-111111111111').set('Authorization', `Bearer ${other}`)).status).toBe(404);
  expect((await request(app).get('/webhook/chat-uploads/11111111-1111-4111-8111-111111111111?exp=1&sig=bad')).status).toBe(404);
});
```

Также проверить `Content-Type`, `Content-Length`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` и `Content-Disposition` от `contentDispositionFor`.

Commit: `test(chat-uploads): приватное скачивание — красный`; проверить RED.

- [ ] **Step 2: проверить `downloadStream` и `createBucketIfAbsent` (уже добавлены в Task 1)**

Оба метода уже реализованы в `StorageService` в Task 1 (`storage.service.ts:78` `createBucketIfAbsent`, `:114` `downloadStream` через `GetObjectCommand`, возврат `response.Body as Readable`, без policy). Шаг сводится к проверке, что они на месте и соответствуют контракту; повторно не реализовывать.

- [ ] **Step 3: реализовать контроллер и модуль**

```ts
@Controller('chat-uploads')
export class ChatUploadsController {
  constructor(private readonly uploads: ChatUploadsService, private readonly jwt: JwtService) {}

  @Get(':id')
  async download(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    let userId: string | undefined;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const payload = this.jwt.verifyAccess(auth.slice(7));
      userId = payload.sub || payload.userId;
    }
    const file = await this.uploads.openDownload({ id, userId, exp: req.query.exp as string, sig: req.query.sig as string });
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', file.sizeBytes);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', contentDispositionFor(file.originalName));
    file.body.pipe(res);
  }
}
```

`ChatUploadsModule` импортирует `CommonModule`, объявляет контроллер и сервис, экспортирует сервис. `ChatModule` только импортирует `ChatUploadsModule`; `ProfileModule` сможет импортировать его позже без цикла.

Модуль обязан применить миграцию при старте — без этого таблица `chat_uploads` не существует ни на стенде, ни на проде. Паттерн тот же, что в `alert-bot.store.ts:169` (`AlertBotStore.migrate` + `AlertBotLifecycle.onModuleInit`): nest assets не копируют SQL в `dist` (в `nest-cli.json` только `human-design/data/*.json`), поэтому нужен fallback `dist → src`.

В `ChatUploadsService` добавить:

```ts
async migrate(): Promise<void> {
  const candidates = [
    path.join(__dirname, 'migrations', '001_chat_uploads.sql'),
    path.join(__dirname, '..', '..', '..', 'src', 'chat', 'chat-uploads', 'migrations', '001_chat_uploads.sql'),
  ];
  const migrationPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!migrationPath) throw new Error('chat-uploads migration 001_chat_uploads.sql not found');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  await this.pg.query(sql);
}
```

⚠️ В отличие от alert-bot здесь **три** `..`: сервис после сборки лежит в `dist/chat/chat-uploads/`, а не в `dist/alert-bot/`.

Модуль:

```ts
@Module({
  imports: [CommonModule],
  controllers: [ChatUploadsController],
  providers: [ChatUploadsService],
  exports: [ChatUploadsService],
})
export class ChatUploadsModule implements OnModuleInit {
  constructor(private readonly uploads: ChatUploadsService) {}
  async onModuleInit(): Promise<void> {
    await this.uploads.migrate();
  }
}
```

В `chat-uploads.module.spec.ts` проверить: (1) `onModuleInit` вызывает `uploads.migrate()`; (2) `migrate()` с mock-`pg` отправляет SQL, содержащий `CREATE TABLE IF NOT EXISTS chat_uploads`, а при отсутствии файла бросает `chat-uploads migration ... not found` (не глотает ошибку молча); (3) сбой `migrate()` прокидывается из `onModuleInit` — приложение не стартует с несозданной таблицей.

- [ ] **Step 4: проверить GREEN и wiring**

Прогнать controller/module specs и `tsc`. Дополнительно проверить, что `ChatModule` и `ProfileModule` могут импортировать `ChatUploadsModule` без цикла. Проверить, что SQL-файл реально читается из ts-окружения (`npx jest src/chat/chat-uploads/chat-uploads.module.spec.ts` — тест `migrate()` проходит по fallback-пути `src/`).

- [ ] **Step 5: commit**

```bash
git add src/common/services/storage.service.ts src/chat/chat-uploads src/chat/chat.module.ts && git commit -m "feat(chat-uploads): приватное скачивание и независимый модуль

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: сохранение multipart до релея и история

**Files:**
- Modify: `src/chat/chat.controller.ts`
- Test: `src/chat/chat.upload-session.spec.ts`, `src/chat/chat.upload-chat-files.spec.ts`

- [ ] **Step 1: добавить failing tests**

Проверить на существующем harness:

```ts
it('сохраняет исходник до relay и кладёт ссылку в историю даже при пустом ответе', async () => {
  process.env.CHAT_UPLOADS_ENABLED = 'true';
  chatUploads.saveOriginals.mockResolvedValue({ saved: [record], failed: [] });
  relay.post.mockResolvedValue(emptyNdjsonStream());
  await controller.uploadAndChat(req, res);
  expect(chatUploads.saveOriginals).toHaveBeenCalledBefore(relay.post);
  expect(chatUploads.saveOriginals.mock.calls[0][0].sessionId).toBe('u1_12');
  expect(history.userMsg).toContain('📎 [a.pdf](/webhook/chat-uploads/11111111-1111-4111-8111-111111111111)');
});
```

Второй тест: `saveOriginals` возвращает `failed:['bad.pdf']`, relay продолжает работу, `safeWrite` получает `type:'upload_persist_failed'`, а `catch` не вызывается.

Commit: `test(chat-uploads): сохранение до relay — красный`; проверить RED.

- [ ] **Step 2: внедрить сохранение**

Добавить trailing `@Optional() private readonly chatUploads?: ChatUploadsService` в `ChatController`. Сразу после `finalizeUploadHandoffForDispatch` и до `new FormData()`:

```ts
const uploadSessionId = freshSessionId || `${userId}_${assistantId}`;
let saved: ChatUploadRecord[] = [];
let uploadPersistFailed = false;
if (process.env.CHAT_UPLOADS_ENABLED === 'true' && this.chatUploads) {
  const result = await this.chatUploads.saveOriginals({ userId, sessionId: uploadSessionId, files });
  saved = result.saved;
  uploadPersistFailed = result.failed.length > 0;
}
```

После создания `safeWrite`:

```ts
if (uploadPersistFailed) safeWrite({ type: 'upload_persist_failed', content: 'Файл не сохранён для будущих разговоров' });
```

- [ ] **Step 3: записать ссылки в историю**

Для каждого сохранённого файла использовать `ownerUrl(record.id)`. Имя экранировать `\`, `[`, `]`. Для неуспешных — прежний `📎 names`. Пример:

```ts
function markdownName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}
const links = saved.map((r) => `📎 [${markdownName(r.originalName)}](${this.chatUploads!.ownerUrl(r.id)})`);
const failedNames = files.filter((f) => !saved.some((r) => r.originalName === f.originalname)).map((f) => f.originalname);
const userMsgForHistory = [...links, ...(failedNames.length ? [`📎 ${failedNames.join(', ')}`] : []), message].join('\n');
```

`persistUploadTurn` и `sessionIdOverride` не менять. Пустой ответ не удаляет запись.

- [ ] **Step 4: проверить GREEN и существующие upload suites**

Прогнать `chat.upload-session`, `chat.upload-chat-files`, `chat.upload-billing` и tsc.

- [ ] **Step 5: commit**

```bash
git add src/chat/chat.controller.ts src/chat/chat.upload-session.spec.ts src/chat/chat.upload-chat-files.spec.ts && git commit -m "feat(chat-uploads): сохранять исходники до релея и ссылки в истории

Co-Authored-By: Kimi <noreply@anthropic.com>"
```

### Task 4: единый frontend multipart и приватная ссылка

**Files:**
- Modify (front): `src/components/chat/ChatInterface.tsx`
- Modify (front): `src/components/chat/historyMerge.ts`
- Test (front): `src/components/chat/historyMerge.test.ts`, `src/components/chat/uploadMemory.test.tsx`

- [ ] **Step 1: добавить failing frontend tests**

Проверить:

```ts
it('маленький текстовый файл идёт через multipart, а не inline', async () => {
  await handleFileTaskSubmit(new File(['hello'], 'note.txt', { type: 'text/plain' }), 'ответь');
  expect(uploadAndChat).toHaveBeenCalled();
  expect(sendMessageToAI).not.toHaveBeenCalled();
});

it('приватная ссылка скачивается через apiClient с JWT, а не window.open', async () => {
  await handleLinkNavigation('/webhook/chat-uploads/11111111-1111-4111-8111-111111111111');
  expect(apiClient.get).toHaveBeenCalledWith('/webhook/chat-uploads/11111111-1111-4111-8111-111111111111', { responseType: 'blob' });
  expect(window.open).not.toHaveBeenCalled();
});
```

Commit: `test(chat-uploads): frontend multipart и приватная ссылка — красный`; прогнать на ноде front tests.

- [ ] **Step 2: убрать inline-обход маленьких текстовых файлов**

В `handleFileTaskSubmit` удалить ветку, которая читает файл через `file.text()` и формирует fenced prompt. Все файлы направлять в существующий multipart `uploadAndChat`, чтобы исходник попадал в реестр. `attachmentTurnText()` оставить для optimistic bubble; `stripAttachmentLines()` не менять, поскольку оно уже дедуплицирует строки `📎`.

- [ ] **Step 3: открывать приватную ссылку через apiClient**

В `handleLinkNavigation` до общего `navigate()` добавить:

```ts
if (href.startsWith('/webhook/chat-uploads/')) {
  const response = await apiClient.get(href, { responseType: 'blob' });
  const url = URL.createObjectURL(response.data);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return;
}
```

Для `📎 [name](/webhook/chat-uploads/<uuid>)` использовать attachment-specific renderer: распарсить имя и URL и отрисовать ссылку как React-элемент, а не plain text. Не добавлять общий Markdown для пользовательских сообщений.

- [ ] **Step 4: обработать `upload_persist_failed`**

В multipart NDJSON parser добавить отдельную ветку, показывающую nonfatal warning `t('chat.upload_persist_failed')`. Не отправлять её в общий catch с `chat.file_error_fallback`. Добавить ключи локалей `chat.upload_persist_failed` минимум ru/en, без изменения остальных событий.

- [ ] **Step 5: проверить frontend tests и commit**

```bash
git add src/components/chat/ChatInterface.tsx src/components/chat/historyMerge.ts src/components/chat/historyMerge.test.ts src/components/chat/uploadMemory.test.tsx src/i18n/locales && git commit -m "feat(chat-uploads): единый multipart и приватное скачивание в кабинете

Co-Authored-By: Kimi <noreply@anthropic.com>"
```

### Task 5: `find_files` для исходников и внешних ссылок

**Files:**
- Modify: `src/chat/chat-files/chat-files.service.ts`
- Modify: `src/chat/chat-files/find-files.ts`
- Modify: `src/chat/chat-files/find-files.tool.ts`
- Modify: `src/products/products-cli-tool.ts`
- Test: `src/chat/chat-files/chat-files.search.spec.ts`, `src/chat/chat-files/find-files.spec.ts`, `src/chat/chat-files/find-files.tool.spec.ts`

- [ ] **Step 1: добавить failing tests**

```ts
it('возвращает исходную загрузку с owner и assistant URL', async () => {
  const result = await service.searchForUser('u1', { query: 'отчёт' });
  expect(result.files[0]).toMatchObject({ origin: 'upload', stored: true });
  expect(result.files[0].url).toBe('/webhook/chat-uploads/11111111-1111-4111-8111-111111111111');
  expect(result.files[0].assistantUrl).toContain('sig=');
});

it('возвращает внешнюю ссылку как адрес без скачивания', async () => {
  const fetchMock = jest.spyOn(global, 'fetch');
  const result = await service.searchForUser('u1', { query: 'example.com' });
  expect(result.files[0]).toMatchObject({ kind: 'link', url: 'https://example.com/a.pdf' });
  expect(fetchMock).not.toHaveBeenCalled();
});
```

Также проверить глобальные `days`, `limit`, `total`, `kind=link`, фильтр assistant и сортировку всех источников вместе.

Commit: `test(chat-uploads): find_files исходников и внешних ссылок — красный`; проверить RED.

- [ ] **Step 2: добавить `origin`, `assistantUrl` и `kind=link`**

В `FoundForTool` добавить `origin: 'upload'|'assistant'|'link'`, `assistantUrl?: string`. В `KINDS` добавить `link`. Существующие assistant-файлы пометить `origin:'assistant'`, не меняя их URL.

- [ ] **Step 3: добавить два независимых источника и объединить до limit**

`searchOriginals(userId, days)` читает `chat_uploads` по владельцу и дате. Для каждой записи `url=ownerUrl(id)`, `assistantUrl=assistantUrl(id)`, `origin:'upload'`, `stored:true`, assistant label через существующий `assistantNames()`.

`USER_LINKS_SQL` читает `custom_chat_history` только `sender_type='human'` и `content ~ 'https?://'` с тем же session-prefix и датой. Новый чистый extractor использует `stripCode()`, поддерживает Markdown и bare HTTP(S), нормализует trailing punctuation и дедуплицирует по URL. Не включать внутренние `/webhook/chat-uploads/` внешние дубликаты. Для них `kind:'link'`, `origin:'link'`, `url` оригинальный адрес, `note` — человеческая реплика. Не выполнять fetch.

Слить три набора до `scoreFile`, recency, `total` и `limit`.

- [ ] **Step 4: обновить инструкции модели**

В `find-files.tool.ts` и `FIND_FILES_CLI_PROMPT` написать: для исходников читать через `assistantUrl`; пользователю показывать только `url`; подписанный `assistantUrl` не выводить; внешние ссылки не скачивать автоматически.

- [ ] **Step 5: проверить GREEN и commit**

```bash
git add src/chat/chat-files src/products/products-cli-tool.ts && git commit -m "feat(chat-uploads): искать исходные загрузки и внешние ссылки

Co-Authored-By: Kimi <noreply@anthropic.com>"
```

### Task 6: последние загрузки в prompt каждого хода

**Files:**
- Modify: `src/chat/chat-uploads/chat-uploads.service.ts`
- Modify: `src/chat/chat.service.ts`
- Modify: `src/chat/chat.controller.ts`
- Test: `src/chat/chat-uploads/chat-uploads.prompt.spec.ts`, `src/chat/chat.upload-session.spec.ts`

- [ ] **Step 1: добавить failing prompt tests**

```ts
it('после ротации prompt снова содержит имя и подписанную ссылку', async () => {
  chatUploads.recentForSession.mockResolvedValue([record]);
  await service.streamUniversalAgent({ userId: 'u1', assistantId: '12', message: 'что в файле?' });
  expect(relayBody.message).toContain('Earlier user uploads');
  expect(relayBody.message).toContain('a.pdf');
  expect(relayBody.message).toContain('sig=');
  expect(relayBody.systemPrompt).not.toContain('sig=');
});

it('текущий multipart не дублирует только что загруженный файл', async () => {
  await controller.uploadAndChat(req, res);
  expect(chatUploads.recentForSession).toHaveBeenCalledWith(expect.objectContaining({ excludeIds: [record.id] }));
});
```

Проверить обычный resume, cold start, fresh session и `CHAT_UPLOADS_ENABLED=false` (блока нет).

Commit: `test(chat-uploads): prompt последних загрузок — красный`; проверить RED.

- [ ] **Step 2: реализовать `recentForSession`**

```ts
async recentForSession(userId: string, sessionId: string, excludeIds: string[] = []): Promise<ChatUploadRecord[]> {
  const r = await this.pg.query(
    `SELECT * FROM chat_uploads WHERE user_id=$1 AND session_id=$2
       AND NOT (id = ANY($3::uuid[])) ORDER BY created_at DESC LIMIT 10`,
    [userId, sessionId, excludeIds]);
  return r.rows.map((row) => this.row(row));
}
```

`assistantBlock(records)` возвращает `Earlier user uploads:\n- <name>: <assistantUrl>` и пустую строку для пустого списка или выключенного flag.

- [ ] **Step 3: добавить блок в обычные текстовые ходы**

В `streamUniversalAgent` сформировать `uploadContext` после `buildUploadHandoff`/перед `contextPrefix`, используя raw PostgreSQL session ID (`freshSessionId` или `${userId}_${assistantId}`), а не relay key с языком. Добавить его в `contextPrefix` перед response-style и финальной языковой строкой. Подписанные ссылки не помещать в `buildRelayStablePrefix()` и не полагаться только на `renderHistoryBlock()`.

Добавить trailing optional `chatUploads` в `ChatService`.

- [ ] **Step 4: добавить блок в multipart без изменения текущего prompt**

В `UploadHandoff` добавить `uploadContext?: string`. `buildUploadHandoff()` заполняет его через `recentForSession`, `fullMessage` в `ChatController` получает `handoff.uploadContext + fullMessage`. При сохранении новых файлов передать их IDs в `excludeIds`, чтобы текущий multipart prompt остался прежним.

- [ ] **Step 5: проверить GREEN и commit**

```bash
git add src/chat/chat-uploads src/chat/chat.service.ts src/chat/chat.controller.ts && git commit -m "feat(chat-uploads): восстанавливать последние загрузки в prompt каждого хода

Co-Authored-By: Kimi <noreply@anthropic.com>"
```

### Task 7: удаление аккаунта и эксплуатационная документация

**Files:**
- Modify: `src/profile/profile.service.ts`, `src/profile/profile.module.ts`
- Modify: `src/platform-kb/articles/account.ts`
- Modify: `scripts/provision-test.sh`
- Modify: `CLAUDE.md`
- Test: `src/chat/chat-uploads/chat-uploads.delete.spec.ts`, `src/profile/profile.service.spec.ts`

- [ ] **Step 1: добавить failing deletion tests**

Проверить `deleteForUser`: сначала `storage.delete` для всех ключей владельца, затем `DELETE FROM chat_uploads WHERE user_id=$1`. Проверить, что `ProfileService.deleteProfile` вызывает его перед удалением истории и что `ProfileModule` импортирует `ChatUploadsModule`, а не `ChatModule`.

Commit: `test(chat-uploads): удаление аккаунта — красный`; проверить RED.

- [ ] **Step 2: реализовать удаление**

В `ProfileService` добавить trailing optional `chatUploads` и вызвать `await this.chatUploads.deleteForUser(userId)` до удаления истории. `ChatUploadsModule` импортировать в `ProfileModule`, не `ChatModule`.

- [ ] **Step 3: обновить тексты и provisioning**

В `account.ts` явно отличить: исходные загрузки удаляются с аккаунтом; созданные ассистентом файлы сохраняются по прежним правилам. В `provision-test.sh` добавить только `mc mb --ignore-existing local/linkeon-chat-uploads`, без `mc anonymous set-json`. В `CLAUDE.md` описать bucket, `CHAT_UPLOADS_ENABLED`, JWT/HMAC и откат.

- [ ] **Step 4: проверить GREEN и commit**

```bash
git add src/profile src/platform-kb/articles/account.ts scripts/provision-test.sh CLAUDE.md src/chat/chat-uploads && git commit -m "feat(chat-uploads): удаление исходников при удалении аккаунта и эксплуатация

Co-Authored-By: Kimi <noreply@anthropic.com>"
```

### Task 8: полные гейты и выкат

- [ ] **Step 1: полный прогон на ноде**

```bash
cd ~/Downloads/spirits_back/.worktrees/chat-upload-memory && git push -q origin feat/chat-upload-memory && SHA=$(git rev-parse HEAD)
ssh -n dv@85.192.61.231 "cd ~/ci/wt/chat-upload-memory && git fetch -q origin && git checkout -q --detach ${SHA} && source ~/.nvm/nvm.sh && npx jest src/ --runInBand --silent 2>&1 | tail -10 && npx tsc -p tsconfig.build.json --noEmit && npm run build && npx jest tests/unit --runInBand"
```

Expected: ноль failed, `TSC_OK`, `BUILD_OK`, 108/108 unit. Front tests и build запускать на ноде в `~/ci/wt/chat-upload-front` по тем же правилам.

- [ ] **Step 2: независимое ревью**

Проверить весь diff на утечки URL, циклы DI, скачивание внешних ссылок, потерю текущего multipart prompt, удаление аккаунта и feature flag. Critical/Important закрыть до слияния.

- [ ] **Step 3: слить и выкатить**

После OK владельца: влить актуальный `origin/main`, повторить гейты, запушить `main`, запустить `SKIP_BOTS=1 bash scripts/deploy.sh` из свежих клонов. Фронт включён в выкат; `BACK_ONLY` не использовать.

- [ ] **Step 4: включить feature и живую приёмку**

После green smoke сделать backup `.env`, добавить `CHAT_UPLOADS_ENABLED=true` без изменения других ключей и перезапустить через `deploy.sh`. Проверить загрузку, следующий вопрос, ротацию, новый чат, владельца/чужого пользователя, просроченную подпись и внешнюю ссылку как адрес.

- [ ] **Step 5: откат и уборка**

Откат — `CHAT_UPLOADS_ENABLED=false` и повторный `deploy.sh`; байты и записи не удалять. Удалить только свои CI worktrees/deploy-clones после проверки владельца. Ветки и старые файлы не удалять автоматически.

## Самопроверка покрытия

- Таблица и bucket: Task 1–2.
- Сохранение до relay и пустой ответ: Task 3.
- JWT владельца и HMAC ассистента: Task 1–2 и Task 4.
- Единый multipart маленького текста: Task 4.
- Текущий чат, ротация, холодный старт: Task 6.
- Новые чаты, `find_files`, внешние ссылки без скачивания: Task 5.
- Удаление аккаунта: Task 7.
- Feature flag, тесты, выкат и откат: Task 8.
