import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ChatService } from '../chat/chat.service';
import { VoiceAvatarModule } from '../voice-avatar/voice-avatar.module';
import { AgentsModule } from './agents.module';
import { AgentVersionsService } from './agent-versions.service';

@Module({
  imports: [AgentsModule, VoiceAvatarModule],
})
class AgentsModuleTestModule {}

describe('AgentsModule', () => {
  it('provides AgentVersionsService with ChatService in the real module graph', async () => {
    const moduleRef = await NestFactory.create(AgentsModuleTestModule, { logger: ['error'] });

    expect(moduleRef.get(ChatService)).toBeInstanceOf(ChatService);
    expect(moduleRef.get(AgentVersionsService)).toBeInstanceOf(AgentVersionsService);
    await moduleRef.close();
  });
});
