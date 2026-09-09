import axios from 'axios';
import { AvatarController } from './avatar.controller';
import { __resetAgentAvatarCache } from './avatar.controller';

jest.mock('axios');

/**
 * Аватарки ассистентов ходили в MinIO на КАЖДЫЙ запрос.
 *
 * `getAgentAvatar` проксирует байты вместо 302 (инцидент 2026-07-13: браузер не
 * идёт за редиректом на префлайтнутом запросе, и в вебвью аватарки не грузились).
 * Но проксировал он без кеша: axios.get в MinIO на каждое обращение.
 *
 * Замер 09.09.2026: на проде одна картинка 0.8–3.1с, двенадцать параллельно —
 * 10с; на test.linkeon.io те же двенадцать — 34с, из-за чего браузерный слой
 * smoke не укладывался в navigationTimeout и трижды подряд объявил здоровый
 * фронт регрессией.
 *
 * Ассистентов ~20, картинки по 30–120 КБ — полтора мегабайта на всех. Держим в
 * памяти процесса: первый запрос идёт в MinIO, дальше отдаём из кеша.
 */

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    body: null as any,
    statusCode: 200,
    redirectedTo: null as string | null,
    setHeader(k: string, v: string) { headers[k] = v; },
    send(b: any) { this.body = b; return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(o: any) { this.body = o; return this; },
    redirect(u: string) { this.redirectedTo = u; return this; },
  };
}

function makeController(avatarUrl: string | null = 'https://minio.example/avatars/agents/12.jpg') {
  const service = { getAgentAvatar: jest.fn(async () => avatarUrl) };
  return { ctrl: new AvatarController(service as any), service };
}

describe('кеш аватарок ассистентов', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetAgentAvatarCache();
  });

  it('второй запрос той же аватарки не идёт в MinIO', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: Buffer.from('картинка'),
      headers: { 'content-type': 'image/jpeg' },
    });
    const { ctrl } = makeController();

    const r1 = makeRes();
    await ctrl.getAgentAvatar('12', r1 as any);
    const r2 = makeRes();
    await ctrl.getAgentAvatar('12', r2 as any);

    expect((axios.get as jest.Mock).mock.calls.length).toBe(1);
    expect(Buffer.from(r2.body).toString()).toBe('картинка');
    expect(r2.headers['Content-Type']).toBe('image/jpeg');
    expect(r2.headers['Cache-Control']).toBe('public, max-age=86400');
  });

  it('разные ассистенты кешируются раздельно, а не затирают друг друга', async () => {
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({ data: Buffer.from('двенадцатый'), headers: { 'content-type': 'image/jpeg' } })
      .mockResolvedValueOnce({ data: Buffer.from('четырнадцатый'), headers: { 'content-type': 'image/png' } });
    const service = { getAgentAvatar: jest.fn(async (id: string) => `https://minio.example/${id}.jpg`) };
    const ctrl = new AvatarController(service as any);

    const a = makeRes(); await ctrl.getAgentAvatar('12', a as any);
    const b = makeRes(); await ctrl.getAgentAvatar('14', b as any);
    const aAgain = makeRes(); await ctrl.getAgentAvatar('12', aAgain as any);

    expect((axios.get as jest.Mock).mock.calls.length).toBe(2);
    expect(Buffer.from(aAgain.body).toString()).toBe('двенадцатый');
    expect(aAgain.headers['Content-Type']).toBe('image/jpeg');
    expect(Buffer.from(b.body).toString()).toBe('четырнадцатый');
    expect(b.headers['Content-Type']).toBe('image/png');
  });

  it('провал похода в MinIO НЕ кешируется: следующий запрос пробует снова', async () => {
    (axios.get as jest.Mock)
      .mockRejectedValueOnce(new Error('minio лёг'))
      .mockResolvedValueOnce({ data: Buffer.from('ожила'), headers: { 'content-type': 'image/jpeg' } });
    const { ctrl } = makeController();

    const fail = makeRes();
    await ctrl.getAgentAvatar('12', fail as any);
    expect(fail.redirectedTo).toBe('https://minio.example/avatars/agents/12.jpg');

    const ok = makeRes();
    await ctrl.getAgentAvatar('12', ok as any);
    expect(Buffer.from(ok.body).toString()).toBe('ожила');
    expect((axios.get as jest.Mock).mock.calls.length).toBe(2);
  });

  it('отсутствующая аватарка отдаёт 404 и не кешируется как пустая', async () => {
    const { ctrl, service } = makeController(null);
    const r = makeRes();
    await ctrl.getAgentAvatar('99', r as any);

    expect(r.statusCode).toBe(404);
    expect(axios.get as jest.Mock).not.toHaveBeenCalled();
    expect(service.getAgentAvatar).toHaveBeenCalledTimes(1);
  });

  it('кеш не растёт без предела: старые записи вытесняются', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: Buffer.from('x'),
      headers: { 'content-type': 'image/jpeg' },
    });
    const service = { getAgentAvatar: jest.fn(async (id: string) => `https://minio.example/${id}.jpg`) };
    const ctrl = new AvatarController(service as any);

    // Заполняем сверх потолка (100), затем просим самую первую — она должна
    // быть вытеснена и уехать в MinIO повторно.
    for (let i = 0; i < 105; i++) {
      await ctrl.getAgentAvatar(String(i), makeRes() as any);
    }
    const callsAfterFill = (axios.get as jest.Mock).mock.calls.length;
    await ctrl.getAgentAvatar('0', makeRes() as any);

    expect(callsAfterFill).toBe(105);
    expect((axios.get as jest.Mock).mock.calls.length).toBe(106);
  });
});
