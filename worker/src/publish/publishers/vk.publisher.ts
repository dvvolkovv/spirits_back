// worker/src/publish/publishers/vk.publisher.ts
import { Publisher, PublishInput, PublishResult } from '../publisher.interface';

export const vkPublisher: Publisher = {
  async publish(_input: PublishInput): Promise<PublishResult> {
    throw new Error('vk publisher not yet implemented (Plan 4 Task TBD)');
  },
};
