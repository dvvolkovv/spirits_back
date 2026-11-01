import { NestFactory } from '@nestjs/core';
import { ChatService } from '../chat/chat.service';
import { AgentsModule } from './agents.module';
import { AgentVersionsService } from './agent-versions.service';

describe('AgentsModule', () => {
  it('provides AgentVersionsService with ChatService in the real module graph', async () => {
    const moduleRef = await NestFactory.create(AgentsModule, { logger: false });

    expect(moduleRef.get(ChatService)).toBeInstanceOf(ChatService);
    expect(moduleRef.get(AgentVersionsService)).toBeInstanceOf(AgentVersionsService);
    await moduleRef.close();
  });
});
