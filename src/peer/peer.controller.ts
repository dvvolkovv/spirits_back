import {
  Controller, Post, Get, Delete, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { PeerService } from './peer.service';
import { CreateChatRequestDto, SendMessageDto, ReportUserDto } from './peer.dto';

@Controller('peer')
@UseGuards(JwtGuard)
export class PeerController {
  constructor(private readonly peer: PeerService) {}

  // ---------- requests ----------
  @Post('request')
  sendRequest(@CurrentUser() u: any, @Body() dto: CreateChatRequestDto) {
    return this.peer.sendRequest(u.phone, dto);
  }

  @Get('requests/incoming')
  listIncoming(@CurrentUser() u: any) {
    return this.peer.listIncoming(u.phone);
  }

  @Get('requests/outgoing')
  listOutgoing(@CurrentUser() u: any) {
    return this.peer.listOutgoing(u.phone);
  }

  @Post('request/:id/accept')
  accept(@CurrentUser() u: any, @Param('id') id: string) {
    return this.peer.acceptRequest(u.phone, id);
  }

  @Post('request/:id/decline')
  decline(@CurrentUser() u: any, @Param('id') id: string) {
    return this.peer.declineRequest(u.phone, id);
  }

  @Post('request/:id/withdraw')
  withdraw(@CurrentUser() u: any, @Param('id') id: string) {
    return this.peer.withdrawRequest(u.phone, id);
  }

  // Lookup relationship state with a user (used by profile modal)
  @Get('state/:userId')
  async state(@CurrentUser() u: any, @Param('userId') userId: string) {
    const [conv, pending] = await Promise.all([
      this.peer.getConversationBetween(u.phone, userId),
      this.peer.getPendingRequestBetween(u.phone, userId),
    ]);
    return {
      conversationId: conv?.id ?? null,
      pendingRequest: pending
        ? {
            id: pending.id,
            direction: pending.from_user_id === u.phone ? 'outgoing' : 'incoming',
            introMessage: pending.intro_message,
            createdAt: pending.created_at,
          }
        : null,
    };
  }

  // ---------- conversations ----------
  @Get('conversations')
  listConversations(@CurrentUser() u: any) {
    return this.peer.listConversations(u.phone);
  }

  @Get('conversations/:id')
  getConversation(@CurrentUser() u: any, @Param('id') id: string) {
    return this.peer.getConversation(u.phone, id);
  }

  @Get('conversations/:id/messages')
  listMessages(
    @CurrentUser() u: any,
    @Param('id') id: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? parseInt(limit, 10) : 50;
    return this.peer.listMessages(u.phone, id, before, isNaN(n) ? 50 : n);
  }

  @Post('conversations/:id/message')
  sendMessage(@CurrentUser() u: any, @Param('id') id: string, @Body() dto: SendMessageDto) {
    return this.peer.sendMessage(u.phone, id, dto);
  }

  @Post('conversations/:id/read')
  markRead(@CurrentUser() u: any, @Param('id') id: string) {
    return this.peer.markRead(u.phone, id);
  }

  // ---------- summary ----------
  @Get('unread-summary')
  unread(@CurrentUser() u: any) {
    return this.peer.getUnreadSummary(u.phone);
  }

  // ---------- block / report ----------
  @Post('block/:userId')
  block(@CurrentUser() u: any, @Param('userId') userId: string) {
    return this.peer.block(u.phone, userId);
  }

  @Delete('block/:userId')
  unblock(@CurrentUser() u: any, @Param('userId') userId: string) {
    return this.peer.unblock(u.phone, userId);
  }

  @Post('report')
  report(@CurrentUser() u: any, @Body() dto: ReportUserDto) {
    return this.peer.report(u.phone, dto);
  }
}
