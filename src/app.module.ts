import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { ProfileModule } from './profile/profile.module';
import { AgentsModule } from './agents/agents.module';
import { ChatModule } from './chat/chat.module';
import { TokensModule } from './tokens/tokens.module';
import { PaymentsModule } from './payments/payments.module';
import { ReferralModule } from './referral/referral.module';
import { AvatarModule } from './avatar/avatar.module';
import { Neo4jModule } from './neo4j/neo4j.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { MiscModule } from './misc/misc.module';
import { VideoModule } from './video/video.module';
import { AdminModule } from './admin/admin.module';
import { DozvonModule } from './dozvon/dozvon.module';
import { PeerModule } from './peer/peer.module';
import { SupportModule } from './support/support.module';
import { ContactsModule } from './contacts/contacts.module';
import { McpModule } from './mcp/mcp.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    CommonModule,
    AuthModule,
    ProfileModule,
    AgentsModule,
    ChatModule,
    TokensModule,
    PaymentsModule,
    ReferralModule,
    AvatarModule,
    Neo4jModule,
    SchedulerModule,
    MiscModule,
    VideoModule,
    AdminModule,
    DozvonModule,
    PeerModule,
    SupportModule,
    ContactsModule,
    McpModule,
  ],
})
export class AppModule {}
