import { ChatFilesService } from './chat-files.service';

const BASE = 'https://my.linkeon.io/smm-media';
const saved = process.env.MINIO_PUBLIC_URL;
beforeAll(() => { process.env.MINIO_PUBLIC_URL = BASE; });
afterAll(() => { process.env.MINIO_PUBLIC_URL = saved; });

describe('GET /webhook/chat/files: миниатюры', () => {
  it('картинке из нашего бакета — thumbPath, документу и чужой картинке — нет', async () => {
    const content = [
      `![кот](${BASE}/linkeon-assets/images/1791472069716-j83id2.jpg)`,
      `[Скачать отчёт.pdf](${BASE}/linkeon-chat-files/u/report.pdf)`,
      '![чужая](https://evil.example/x.jpg)',
    ].join('\n');
    const pg = { query: jest.fn(async () => ({ rows: [{ id: 1, content, created_at: '2026-10-10T10:00:00Z' }] })) };
    const items = await new ChatFilesService(pg as any).listForSession('u-1', 'u-1_12');

    const image = items.find((i) => i.url?.endsWith('/images/1791472069716-j83id2.jpg'));
    expect(image?.thumbPath).toBe(`/webhook/chat/thumb?src=${encodeURIComponent('linkeon-assets/images/1791472069716-j83id2.jpg')}`);
    expect(items.find((i) => i.url?.endsWith('/report.pdf'))?.thumbPath).toBeUndefined();
    expect(items.find((i) => i.url?.includes('evil.example'))?.thumbPath).toBeUndefined();
  });
});
