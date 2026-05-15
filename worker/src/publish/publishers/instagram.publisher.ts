// worker/src/publish/publishers/instagram.publisher.ts
import { Publisher, PublishInput, PublishResult } from '../publisher.interface';

export const instagramPublisher: Publisher = {
  async publish(_input: PublishInput): Promise<PublishResult> {
    throw new Error('instagram publisher not yet implemented (Plan 4 Task TBD)');
  },
};
