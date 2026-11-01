import { Test } from '@nestjs/testing';
import { ChatService } from '../chat/chat.service';
import { AgentsModule } from './agents.module';
import { AgentVersionsService } from './agent-versions.service';

describe('AgentsModule', () => {
  it('provides AgentVersionsService with ChatService in the real module graph', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AgentsModule] }).compile();

    expect(moduleRef.get(ChatService)).toBeInstanceOf(ChatService);
    expect(moduleRef.get(AgentVersionsService)).toBeInstanceOf(AgentVersionsService);
    await moduleRef.close();
  });
});
