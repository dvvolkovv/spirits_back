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

  // Inline quick-add из виджета лаунчера [календарь-виджет]: свободная фраза → событие, без чата/карточки.
  @Post('quick-add')
  @UseGuards(JwtGuard)
  async quickAdd(@CurrentUser() user: any, @Body() body: { text?: string }) {
    return this.calendar.quickAddFromText(String(user.userId), body?.text || '');
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

  // Переподключить сохранённое (отключённое) подключение одним тапом — без повторного ввода пароля.
  @Post('reconnect')
  @UseGuards(JwtGuard)
  async reconnect(@CurrentUser() user: any) {
    return this.calendar.reconnect(String(user.userId));
  }

  // Read-only календари по ссылке (ICS): Outlook «Опубликовать календарь», Google, iCloud и т.п.
  @Get('ics')
  @UseGuards(JwtGuard)
  async listIcs(@CurrentUser() user: any) {
    return this.calendar.listIcs(String(user.userId));
  }

  @Post('ics')
  @UseGuards(JwtGuard)
  async addIcs(@CurrentUser() user: any, @Body() body: { url?: string; kind?: string }) {
    return this.calendar.addIcs(String(user.userId), body?.kind || 'outlook', body?.url || '');
  }

  @Delete('ics/:kind')
  @UseGuards(JwtGuard)
  async removeIcs(@CurrentUser() user: any, @Param('kind') kind: string) {
    await this.calendar.removeIcs(String(user.userId), kind);
    return { ok: true };
  }

  @Get('proposal/:id')
  @UseGuards(JwtGuard)
  async proposal(@CurrentUser() user: any, @Param('id') id: string) {
    const p = await this.calendar.getProposal(String(user.userId), id);
    return p ?? { error: 'not found' };
  }
}
