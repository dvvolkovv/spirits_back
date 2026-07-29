import { Controller, Get, Post, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { ProposedEvent, ProposedTask } from './calendar.types';

@Controller('calendar') // global prefix 'webhook' → /webhook/calendar/*
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('status')
  @UseGuards(JwtGuard)
  async status(@CurrentUser() user: any) {
    return this.calendar.getStatus(String(user.userId));
  }

  @Post('connect')
  @UseGuards(JwtGuard)
  async connect(@CurrentUser() user: any, @Body() body: { provider?: string; username: string; appPassword: string }) {
    return this.calendar.connect(String(user.userId), body?.provider || 'yandex', body?.username, body?.appPassword);
  }

  @Post('events')
  @UseGuards(JwtGuard)
  async createEvent(@CurrentUser() user: any, @Body() body: ProposedEvent) {
    return this.calendar.createEvent(String(user.userId), body);
  }

  @Post('tasks')
  @UseGuards(JwtGuard)
  async createTask(@CurrentUser() user: any, @Body() body: ProposedTask) {
    return this.calendar.createTask(String(user.userId), body);
  }

  @Post('tasks/:uid/done')
  @UseGuards(JwtGuard)
  async setTaskDone(@CurrentUser() user: any, @Param('uid') uid: string, @Body() body: { done: boolean }) {
    return this.calendar.setTaskDone(String(user.userId), uid, body?.done);
  }

  @Delete('connect')
  @UseGuards(JwtGuard)
  async disconnect(@CurrentUser() user: any) {
    await this.calendar.disconnect(String(user.userId));
    return { ok: true };
  }

  @Get('proposal/:id')
  @UseGuards(JwtGuard)
  async proposal(@CurrentUser() user: any, @Param('id') id: string) {
    const p = await this.calendar.getProposal(String(user.userId), id);
    return p ?? { error: 'not found' };
  }
}
