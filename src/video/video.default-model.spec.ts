/**
 * Движок видео один — Veo 3.1.
 *
 * Kling снят 22.10.2026: провайдер вывел kling-v1-6 из эксплуатации, пакет
 * сгорел, а живых роликов на нём с июля не было. Вместе с ним ушли режимы
 * extend и lipsync — у Veo их нет.
 *
 * Важно не только «куда уходит запрос без модели», но и что старые запросы
 * (мобилка шлёт model=kling-v1-6, ИИ может написать kling в инструменте, поддержка
 * перезапускает старую задачу) отбиваются ДО списания токенов, а не после.
 */
import { BadRequestException } from '@nestjs/common';
import { VideoService } from './video.service';

function stubbedVeo() {
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

/** Настоящий createVeoJob; любое обращение к базе — это попытка списать. */
function realVeo() {
  const touched: string[] = [];
  const pg = {
    async getClient() { touched.push('getClient'); throw new Error('must not reach billing'); },
    async query(sql: string) { touched.push(sql); throw new Error('must not reach billing'); },
  };
  const veo = { isConfigured: () => true };
  const svc: any = new (VideoService as any)(pg, veo);
  return { svc, touched };
}

describe('VideoService.createJob — модель по умолчанию', () => {
  it('text2video без модели уходит в veo-3.1-fast', async () => {
    const { svc, veoCalls } = stubbedVeo();
    await svc.createJob('u1', { mode: 'text2video', prompt: 'кот на подоконнике' });

    expect(veoCalls).toHaveLength(1);
    expect(veoCalls[0].dto.model).toBe('veo-3.1-fast');
  });

  it('image2video без модели тоже уходит в Veo', async () => {
    const { svc, veoCalls } = stubbedVeo();
    await svc.createJob('u1', { mode: 'image2video', sourceImageUrl: 'https://x/y.jpg' });

    expect(veoCalls).toHaveLength(1);
    expect(veoCalls[0].dto.model).toBe('veo-3.1-fast');
  });

  it('явно выбранный veo-3.1 так и уходит в Veo', async () => {
    const { svc, veoCalls } = stubbedVeo();
    await svc.createJob('u1', { mode: 'text2video', model: 'veo-3.1', prompt: 'п' });

    expect(veoCalls[0].dto.model).toBe('veo-3.1');
  });
});

describe('VideoService.createJob — Kling снят', () => {
  it.each(['kling-v1-6', 'kling-v2-master'])('модель %s отклоняется до списания', async (model) => {
    const { svc, touched } = realVeo();

    await expect(
      svc.createJob('u1', { mode: 'image2video', model, prompt: 'п', sourceImageUrl: 'https://x/y.jpg' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.createJob('u1', { mode: 'image2video', model, prompt: 'п', sourceImageUrl: 'https://x/y.jpg' }),
    ).rejects.toThrow(/unsupported video model/);
    expect(touched).toEqual([]);
  });

  it.each(['extend', 'lipsync'])('режим %s отклоняется до списания', async (mode) => {
    const { svc, touched } = realVeo();

    await expect(svc.createJob('u1', { mode, prompt: 'п', sourceVideoId: 'v1' }))
      .rejects.toThrow(/text2video or image2video/);
    expect(touched).toEqual([]);
  });
});
