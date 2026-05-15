// worker/src/publish/publishers/tiktok.publisher.ts
import { Publisher, PublishInput, PublishResult } from '../publisher.interface';

export const tiktokPublisher: Publisher = {
  async publish(_input: PublishInput): Promise<PublishResult> {
    throw new Error('tiktok publisher not yet implemented (Plan 4 Task TBD)');
  },
};
