import { Module } from '@nestjs/common';
import { DozvonController } from './dozvon.controller';
import { DozvonInternalController } from './dozvon-internal.controller';
import { DozvonService } from './dozvon.service';
import { DozvonChatService } from './dozvon-chat.service';
import { SipService } from './sip.service';
import { VoiceAgentService } from './voice-agent.service';
import { DozvonSchedulerService } from './dozvon-scheduler.service';
import { RecorderService } from './recorder.service';

@Module({
  controllers: [DozvonController, DozvonInternalController],
  providers: [
    DozvonService,
    DozvonChatService,
    SipService,
    VoiceAgentService,
    DozvonSchedulerService,
    RecorderService,
  ],
})
export class DozvonModule {}
