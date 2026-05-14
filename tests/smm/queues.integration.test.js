const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { RenderQueueService } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'render', 'render-queue.service'),
);
const { PublishQueueService } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'publication', 'publish-queue.service'),
);

async function withSvc(Cls, fn) {
  const svc = new Cls();
  svc.onModuleInit();
  try {
    await fn(svc);
  } finally {
    await svc.onModuleDestroy();
  }
}

module.exports = {
  'queues: render enqueue returns job id, state=waiting': async () => {
    await withSvc(RenderQueueService, async (svc) => {
      const jobId = await svc.enqueue({
        videoId: '00000000-0000-0000-0000-000000000001',
        scenarioId: '00000000-0000-0000-0000-000000000002',
      });
      if (!jobId) throw new Error('No job id returned');
      const state = await svc.getJobState(jobId);
      if (state !== 'waiting' && state !== 'delayed') {
        throw new Error(`Expected waiting/delayed, got: ${state}`);
      }
      // cleanup
      const job = await svc.getQueue().getJob(jobId);
      if (job) await job.remove();
    });
  },

  'queues: render delayed job is in delayed state': async () => {
    await withSvc(RenderQueueService, async (svc) => {
      const jobId = await svc.enqueue(
        { videoId: 'v', scenarioId: 's' },
        { delay: 60_000 },
      );
      const state = await svc.getJobState(jobId);
      if (state !== 'delayed') throw new Error(`Expected delayed, got: ${state}`);
      const job = await svc.getQueue().getJob(jobId);
      if (job) await job.remove();
    });
  },

  'queues: publish cancel removes the job': async () => {
    await withSvc(PublishQueueService, async (svc) => {
      const jobId = await svc.enqueue(
        { publicationId: 'p', videoId: 'v', platform: 'telegram' },
        { delay: 60_000 },
      );
      const ok = await svc.cancel(jobId);
      if (!ok) throw new Error('cancel returned false');
      const state = await svc.getJobState(jobId);
      if (state !== null) throw new Error(`Expected null state after cancel, got: ${state}`);
    });
  },
};
