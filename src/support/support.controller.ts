import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { SupportService } from './support.service';
import { PostUserMessageDto } from './support.dto';

@Controller('support')
@UseGuards(JwtGuard)
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get('ticket')
  async getTicket(@CurrentUser() u: any) {
    const t = await this.support.getLatestOrCreateTicket(u.phone);
    return {
      id: t.id,
      status: t.status,
      urgency: t.urgency,
      topic: t.topic,
      createdAt: t.created_at,
      lastMessageAt: t.last_message_at,
    };
  }

  @Get('tickets')
  async listTickets(@CurrentUser() u: any, @Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 10;
    return this.support.listUserTicketsWithMessages(u.phone, isNaN(n) ? 10 : n);
  }

  @Get('ticket/:id/messages')
  async getMessages(@CurrentUser() u: any, @Param('id') id: string) {
    const rows = await this.support.listMessages(u.phone, id, false);
    return rows.map((m) => ({
      id: m.id,
      senderType: m.sender_type,
      content: m.content,
      createdAt: m.created_at,
    }));
  }

  @Post('message')
  async postMessage(@CurrentUser() u: any, @Body() dto: PostUserMessageDto) {
    return this.support.postUserMessage(u.phone, dto);
  }

  @Get('health')
  async health() {
    return this.support.getServiceHealth();
  }

  // -------------------- Admin-only --------------------

  @Get('admin/stats')
  @UseGuards(AdminGuard)
  async adminStats(@Query('windowDays') windowDays?: string) {
    const n = windowDays ? parseInt(windowDays, 10) : 7;
    return this.support.adminStats(isNaN(n) ? 7 : n);
  }

  @Get('admin/tickets')
  @UseGuards(AdminGuard)
  async adminList(@Query('status') status?: string, @Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 50;
    return this.support.adminListTickets({ status, limit: isNaN(n) ? 50 : n });
  }

  @Get('admin/ticket/:id')
  @UseGuards(AdminGuard)
  async adminDetail(@Param('id') id: string) {
    return this.support.adminGetTicket(id);
  }

  @Post('admin/ticket/:id/reply')
  @UseGuards(AdminGuard)
  async adminReply(
    @CurrentUser() u: any,
    @Param('id') id: string,
    @Body() body: { content: string; visibleToUser?: boolean },
  ) {
    await this.support.adminReply(id, u.phone, body.content, body.visibleToUser !== false);
    return { ok: true };
  }

  @Post('admin/ticket/:id/status')
  @UseGuards(AdminGuard)
  async adminStatus(
    @CurrentUser() u: any,
    @Param('id') id: string,
    @Body() body: { status: string; note?: string },
  ) {
    await this.support.adminSetStatus(id, u.phone, body.status, body.note);
    return { ok: true };
  }
}
