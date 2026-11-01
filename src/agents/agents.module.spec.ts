import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ChatService } from '../chat/chat.service';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { RoutineStoreModule } from '../routine-push/routine-store.module';
import { VoiceAvatarModule } from '../voice-avatar/voice-avatar.module';
import { AgentsModule } from './agents.module';
import { AgentVersionsService } from './agent-versions.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), AgentsModule, RoutineStoreModule, VoiceAvatarModule],
})
class AgentsModuleTestModule {}

describe('AgentsModule', () => {
  it('provides AgentVersionsService with ChatService in the real module graph', async () => {
    const pgDestroy = jest.spyOn(PgService.prototype, 'onModuleDestroy').mockResolvedValue();
    const redisDestroy = jest.spyOn(RedisService.prototype, 'onModuleDestroy').mockResolvedValue();
    const moduleRef = await NestFactory.create(AgentsModuleTestModule, { logger: ['error'] });

    expect(moduleRef.get(ChatService)).toBeInstanceOf(ChatService);
    expect(moduleRef.get(AgentVersionsService)).toBeInstanceOf(AgentVersionsService);
    await moduleRef.close();
    pgDestroy.mockRestore();
    redisDestroy.mockRestore();
  });
});
