/**
 * Модель по умолчанию — Veo, но не для всех режимов.
 *
 * Причина смены: Kling тянет 8 генераций за три месяца, Veo — около 56, и при
 * этом Kling стоял дефолтом. Пустой счёт Kling ломал дефолтный путь, а Veo
 * продолжал работать — поэтому недельный простой 13–20.08.2026 никто не
 * заметил: в сводке было 17 успешных роликов.
 *
 * Ограничение: Veo умеет только text2video и image2video. Режимы lipsync и
 * extend существуют исключительно у Kling (lipsync вообще требует kling-v1-6),
 * и слепая смена дефолта их бы сломала — запрос без явной модели уходил бы в
 * Veo и падал на «Veo supports mode text2video or image2video».
 */
import { VideoService } from './video.service';

function makeService() {
  const veoCalls: any[] = [];
  const svc: any = new (VideoService as any)(
    { async getClient() { return { query: async () => ({ rows: [], rowCount: 0 }), release() {} }; },
      async query() { return { rows: [] }; } },
  );
  svc.createVeoJob = async (userId: string, dto: any) => {
    veoCalls.push({ userId, dto });
    return { jobId: 'veo-1', status: 'processing', tokensSpent: 90000 };
  };
  return { svc, veoCalls };
}

describe('VideoService.createJob — модель по умолчанию', () => {
  it('text2video без модели уходит в Veo', async () => {
    const { svc, veoCalls } = makeService();
    await svc.createJob('u1', { mode: 'text2video', prompt: 'кот на подоконнике' });

    expect(veoCalls).toHaveLength(1);
    expect(veoCalls[0].dto.model).toMatch(/^veo-/);
  });

  it('image2video без модели тоже уходит в Veo', async () => {
    const { svc, veoCalls } = makeService();
    await svc.createJob('u1', { mode: 'image2video', sourceImageUrl: 'https://x/y.jpg' });

    expect(veoCalls).toHaveLength(1);
    expect(veoCalls[0].dto.model).toMatch(/^veo-/);
  });

  it('lipsync без модели остаётся на Kling — у Veo такого режима нет', async () => {
    const { svc, veoCalls } = makeService();

    // Без sourceVideoId Kling-ветка отказывает рано — это и есть признак,
    // что запрос пошёл именно туда, а не в Veo.
    await expect(svc.createJob('u1', { mode: 'lipsync' })).rejects.toThrow(/sourceVideoId|source/i);
    expect(veoCalls).toHaveLength(0);
  });

  it('extend без модели остаётся на Kling', async () => {
    const { svc, veoCalls } = makeService();

    await expect(svc.createJob('u1', { mode: 'extend' })).rejects.toThrow(/sourceVideoId|source/i);
    expect(veoCalls).toHaveLength(0);
  });

  it('явно выбранный Kling дефолтом не перебивается', async () => {
    const { svc, veoCalls } = makeService();

    await expect(
      svc.createJob('u1', { mode: 'lipsync', model: 'kling-v1-6' }),
    ).rejects.toThrow(/sourceVideoId|source/i);
    expect(veoCalls).toHaveLength(0);
  });

  it('явно выбранный Veo так и уходит в Veo', async () => {
    const { svc, veoCalls } = makeService();
    await svc.createJob('u1', { mode: 'text2video', model: 'veo-3.1', prompt: 'п' });

    expect(veoCalls[0].dto.model).toBe('veo-3.1');
  });
});
