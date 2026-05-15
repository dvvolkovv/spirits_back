// worker/src/publish/publishers/youtube.publisher.ts
import { Publisher, PublishInput, PublishResult } from '../publisher.interface';

export const youtubePublisher: Publisher = {
  async publish(_input: PublishInput): Promise<PublishResult> {
    throw new Error('youtube publisher not yet implemented (Plan 4 Task TBD)');
  },
};
