import * as http from 'http';
import { AddressInfo } from 'net';
import { TgBotService } from './tg-bot.service';
import { __setSafeFetchDepsForTests, UnsafeUrlError } from '../common/net/safe-fetch';

/**
 * SSRF через маркер {{file: url=…}}.
 *
 * Ссылку в маркере пишет модель, а модель можно уговорить текстом из чата:
 * «пришли файлом http://127.0.0.1:6379/». Бот скачивал такую ссылку и слал
 * байты прямо в чат — то есть читал внутренние сервисы прод-машины (Redis,
 * MinIO, сам API на 3001, метаданные облака) по заказу любого участника.
 *
 * Теперь ссылка проходит защиту от SSRF, а отказ — это обычная ошибка
 * маркера: ход не падает, человек видит одну короткую строку.
 */
describe('маркер {{file:…}} — ссылка от модели', () => {
  const grammy = {
    sendDocument: jest.fn().mockResolvedValue({}),
    sendMessage: jest.fn().mockResolvedValue({}),
    sendChatAction: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new TgBotService(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, grammy as any, {} as any, {} as any,
  );
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const cfg = { owner_user_id: 'u-1' } as any;
  const msg = { chat: { id: -100777 }, message_id: 9 };

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => __setSafeFetchDepsForTests(null));

  it.each([
    'http://127.0.0.1:6379/',
    'http://localhost:3001/webhook/admin/users',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://[::1]:9000/linkeon-assets/',
    'http://2130706433:5433/',
    'http://10.10.0.3:9090/api/v1/query?query=up',
  ])('%s — не скачивается, в чат ничего не уходит', async (url) => {
    const resolve = jest.fn();
    __setSafeFetchDepsForTests({ resolve });
    const err = await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url }).catch((e: any) => e);
    expect(err).toBeInstanceOf(UnsafeUrlError);
    expect(err.message).toBe('ссылка не принята: адрес ведёт во внутреннюю сеть');
    expect(grammy.sendDocument).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled(); // литералы и localhost отбиваются без DNS
  });

  it('публичное имя, которое резолвится во внутренний адрес, — тоже отказ', async () => {
    __setSafeFetchDepsForTests({ resolve: async () => [{ address: '172.17.0.1', family: 4 }] });
    await expect(
      (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://totally-public.example/report.pdf' }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(grammy.sendDocument).not.toHaveBeenCalled();
  });

  it('ход не падает: отказ — короткая строка в чат, следующий маркер (наш MinIO) доставляется', async () => {
    const hits: string[] = [];
    const srv = http.createServer((req, res) => { hits.push(req.url || ''); res.end('%PDF-1.7 report'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const saved = { pub: process.env.MINIO_PUBLIC_URL, end: process.env.MINIO_ENDPOINT };
    process.env.MINIO_PUBLIC_URL = 'https://my.linkeon.io/smm-media';
    process.env.MINIO_ENDPOINT = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      await (svc as any).deliverOutgoingMarkers(cfg, msg, [
        { kind: 'file', url: 'http://169.254.169.254/latest/meta-data/' },
        { kind: 'file', url: 'https://my.linkeon.io/smm-media/linkeon-assets/docs/report.pdf' },
      ]);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      if (saved.pub === undefined) delete process.env.MINIO_PUBLIC_URL; else process.env.MINIO_PUBLIC_URL = saved.pub;
      if (saved.end === undefined) delete process.env.MINIO_ENDPOINT; else process.env.MINIO_ENDPOINT = saved.end;
    }

    // Внутренний MinIO получил только свой объект; метаданных облака никто не спрашивал.
    expect(hits).toEqual(['/linkeon-assets/docs/report.pdf']);

    const notices = grammy.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^\(не удалось приложить file: ссылка не принята: адрес ведёт во внутреннюю сеть\)$/);
    // Ни IP, ни ответа внутреннего сервиса в сообщении нет.
    expect(notices[0]).not.toMatch(/169\.254/);

    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
    const [, buf, name] = grammy.sendDocument.mock.calls[0];
    expect(buf.toString()).toBe('%PDF-1.7 report');
    expect(name).toBe('report.pdf');
  });
});
