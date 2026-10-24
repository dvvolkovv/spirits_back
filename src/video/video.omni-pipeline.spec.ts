import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VideoService } from './video.service';
import { computeVeoQuote, computeVeoConcatQuote, needsVeoConcat } from './video.dto';

/**
 * Конвейер видео на Gemini Omni (Veo 3.1 Google закрыл 22.10.2026).
 *
 * У Omni продление идёт по previous_interaction_id и возвращает ролик целиком,
 * готовый шаг приходит прямо в ответе опроса, а цепочка ограничена 40 с.
 * Решения владельца от 24.10.2026: тариф Standard слит с Fast; горизонталь,
 * которой не хватает 40 с, собирается склейкой по цене N × база.
 */

describe('тарифы и выбор склейки', () => {
  it('veo-3.1 стоит как veo-3.1-fast — модель у Omni одна', () => {
    for (const sec of [8, 16, 36]) {
      expect(computeVeoQuote('veo-3.1', sec).totalCost).toBe(computeVeoQuote('veo-3.1-fast', sec).totalCost);
      expect(computeVeoConcatQuote('veo-3.1', sec).totalCost).toBe(computeVeoConcatQuote('veo-3.1-fast', sec).totalCost);
    }
    expect(computeVeoQuote('veo-3.1', 8).totalCost).toBe(90_000);
  });

  it.each([
    ['9:16', 8, false],
    ['9:16', 9, true],
    ['16:9', 8, false],
    ['16:9', 32, false],
    ['16:9', 36, false],   // 8 + 4×7 = 36 — помещается в 40 с
    ['16:9', 37, true],    // 8 + 5×7 = 43 — уже нет
    ['16:9', 48, true],
    ['16:9', 60, true],
  ] as const)('%s, %i с → склейка: %s', (aspect, sec, expected) => {
    expect(needsVeoConcat(aspect, sec)).toBe(expected);
  });
});

/** Сервис с базой-заглушкой: записывает SQL и параметры, баланса хватает на всё. */
function makeService(veo: any) {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const answer = (sql: string, params: any[] = []) => {
    queries.push({ sql, params });
    if (/COUNT\(\*\)::int AS n FROM video_jobs/.test(sql)) return { rows: [{ n: 0 }], rowCount: 1 };
    if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 10_000_000 }], rowCount: 1 };
    if (/INSERT INTO video_jobs/.test(sql)) return { rows: [{ id: 'job-1' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const pg = {
    query: jest.fn(async (sql: string, params?: any[]) => answer(sql, params)),
    getClient: jest.fn(async () => ({ query: async (sql: string, params?: any[]) => answer(sql, params), release() {} })),
  };
  const svc: any = new VideoService(pg as any, { isConfigured: () => true, ...veo } as any, {} as any);
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { svc, queries };
}

const charged = (queries: Array<{ sql: string; params: any[] }>) =>
  queries.find((q) => /consume_user_tokens/.test(q.sql))?.params[1];
const insertedPlan = (queries: Array<{ sql: string; params: any[] }>) =>
  JSON.parse(queries.find((q) => /INSERT INTO video_jobs/.test(q.sql))!.params[8]);

describe('createJob на Omni', () => {
  it('veo-3.1 списывает цену Fast', async () => {
    const startGenerate = jest.fn(async () => 'v1_base');
    const { svc, queries } = makeService({ startGenerate });
    await svc.createJob('u1', { mode: 'text2video', model: 'veo-3.1', prompt: 'Кот говорит в камеру: «Привет»', aspectRatio: '16:9' });

    expect(charged(queries)).toBe(90_000);
  });

  it('горизонталь 48 с — склейка по 8 с, цена N × база', async () => {
    const startGenerate = jest.fn(async () => 'v1_clip0');
    const { svc, queries } = makeService({ startGenerate });
    await svc.createJob('u1', { mode: 'text2video', prompt: 'Видео: офис, человек говорит в камеру', aspectRatio: '16:9', targetDurationSec: 48 });

    const plan = insertedPlan(queries);
    expect(plan.veo_concat).toBe(true);
    expect(plan.segments_total).toBe(6);
    expect(charged(queries)).toBe(6 * 90_000);
    expect(startGenerate).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: 8, aspectRatio: '16:9', resolution: '1080p' }));
  });

  it('горизонталь 16 с — цепочка: база 8 с в 720p, id шага уходит в задачу', async () => {
    const startGenerate = jest.fn(async () => 'v1_base');
    const { svc, queries } = makeService({ startGenerate });
    await svc.createJob('u1', { mode: 'text2video', prompt: 'Видео: офис, человек говорит в камеру', aspectRatio: '16:9', targetDurationSec: 16 });

    const plan = insertedPlan(queries);
    expect(plan.veo_concat).toBe(false);
    expect(plan.segments_total).toBe(3);   // 8 + 7 = 15 < 16 → два продления
    expect(plan.veo_last_interaction_id).toBeNull();
    expect(startGenerate).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: 8, aspectRatio: '16:9', resolution: '720p' }));
    const started = queries.find((q) => /SET kling_task_id=\$1, status='processing'/.test(q.sql));
    expect(started?.params).toEqual(['v1_base', 'job-1']);
  });
});

function chainJob(plan: any, klingTaskId: string | null) {
  return {
    id: 'job-1', user_id: 'u1', model: 'veo-3.1-fast', mode: 'text2video', tokens_spent: 153_000,
    prompt: 'п', negative_prompt: null, source_image_url: null, kling_task_id: klingTaskId,
    composed_plan: {
      target_duration_sec: 15, segments_total: 2, segments_done: 0,
      segment_kling_video_ids: [], segment_video_urls: [], provider: 'veo',
      veo_aspect_ratio: '16:9', veo_resolution: '720p', veo_reference_images: [],
      veo_segment_prompts: ['речь 1', 'речь 2'], veo_concat: false, veo_last_interaction_id: null,
      ...plan,
    },
  };
}

describe('опрос цепочки продлений', () => {
  const mp4 = Buffer.from('cumulative-mp4');

  it('готовая база — запоминаем её id для продления и снимаем шаг', async () => {
    const getOperation = jest.fn(async () => ({ done: true, video: mp4, error: null }));
    const { svc, queries } = makeService({ getOperation });
    await svc.pollVeoJob(chainJob({}, 'v1_base'));

    const upd = queries.find((q) => /SET kling_task_id=NULL, composed_plan=\$1/.test(q.sql));
    const plan = JSON.parse(upd!.params[0]);
    expect(plan.segments_done).toBe(1);
    expect(plan.veo_last_interaction_id).toBe('v1_base');
  });

  it('между шагами — продление от прошлого шага, 7 с, без ожидания файла', async () => {
    const startExtend = jest.fn(async () => 'v1_ext');
    const { svc, queries } = makeService({ startExtend });
    await svc.pollVeoJob(chainJob({ segments_done: 1, veo_last_interaction_id: 'v1_base' }, null));

    expect(startExtend).toHaveBeenCalledWith({
      prompt: 'речь 2', previousInteractionId: 'v1_base', durationSeconds: 7, aspectRatio: '16:9', resolution: '720p',
    });
    const upd = queries.find((q) => /SET kling_task_id=\$1, composed_plan=\$2/.test(q.sql));
    expect(upd?.params[0]).toBe('v1_ext');
  });

  it('последний шаг — финал из ролика, пришедшего в ответе', async () => {
    const getOperation = jest.fn(async () => ({ done: true, video: mp4, error: null }));
    const { svc } = makeService({ getOperation });
    svc.storeVeoFinal = jest.fn(async () => 'https://my.linkeon.io/static/videos/job-1.mp4');
    svc.extractAndUploadThumbnail = jest.fn(async () => null);
    svc.applyOwnVoiceIfNeeded = jest.fn(async () => undefined);
    await svc.pollVeoJob(chainJob({ segments_done: 1, veo_last_interaction_id: 'v1_base' }, 'v1_ext'));

    expect(svc.storeVeoFinal).toHaveBeenCalledWith('job-1', mp4, 15);
  });

  it('внутренняя ошибка Omni — повтор шага, а не провал задачи', async () => {
    const getOperation = jest.fn(async () => ({ done: true, video: null, error: 'Internal error encountered. Please retry.' }));
    const { svc } = makeService({ getOperation });
    svc.restartVeoSegment = jest.fn(async () => undefined);
    svc.failAndRefund = jest.fn(async () => undefined);
    await svc.pollVeoJob(chainJob({ segments_done: 1, veo_last_interaction_id: 'v1_base' }, 'v1_ext'));

    expect(svc.restartVeoSegment).toHaveBeenCalled();
    expect(svc.failAndRefund).not.toHaveBeenCalled();
  });
});

describe('опрос склейки', () => {
  let publicRoot: string;
  const savedPublic = process.env.PUBLIC_DIR;

  beforeEach(() => {
    publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-concat-'));
    process.env.PUBLIC_DIR = publicRoot;
  });
  afterEach(() => {
    if (savedPublic === undefined) delete process.env.PUBLIC_DIR; else process.env.PUBLIC_DIR = savedPublic;
    fs.rmSync(publicRoot, { recursive: true, force: true });
  });

  it('готовый клип ложится в part-файл байтами из ответа', async () => {
    const clip = Buffer.from('clip-0-bytes');
    const getOperation = jest.fn(async () => ({ done: true, video: clip, error: null }));
    const { svc } = makeService({ getOperation });
    await svc.pollVeoJob(chainJob({ veo_concat: true, segments_total: 3, veo_aspect_ratio: '9:16' }, 'v1_clip0'));

    const part = path.join(publicRoot, 'videos', '_veoconcat', 'job-1', 'seg_00.mp4');
    expect(fs.readFileSync(part).equals(clip)).toBe(true);
  });
});

describe('тик не берёт задачу, которую ещё опрашивает', () => {
  it('второй тик пропускает задачу, пока первый с ней не закончил', async () => {
    const job = chainJob({}, 'v1_base');
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (/SELECT \* FROM video_jobs WHERE status='processing'/.test(sql)) return { rows: [job] };
        return { rows: [] };
      }),
    };
    const svc: any = new VideoService(pg as any, { isConfigured: () => true } as any, {} as any);
    svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
    let release!: () => void;
    svc.pollJob = jest.fn(async () => undefined);
    svc.pollJob.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));

    const first = svc.tick();
    await new Promise((r) => setImmediate(r));
    await svc.tick();
    expect(svc.pollJob).toHaveBeenCalledTimes(1);

    release();
    await first;
    await svc.tick();
    expect(svc.pollJob).toHaveBeenCalledTimes(2);
  });
});
