// worker/src/publish/publishers/telegram.publisher.ts
import { Publisher, PublishInput, PublishResult } from '../publisher.interface';

export const telegramPublisher: Publisher = {
  async publish(_input: PublishInput): Promise<PublishResult> {
    throw new Error('telegram publisher not yet implemented (Plan 4 Task TBD)');
  },
};
