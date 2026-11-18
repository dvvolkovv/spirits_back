import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/user.decorator';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { ActionPlansService } from './action-plans.service';

function assistantIdOf(value: unknown): string {
  const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, 100) : '';
  if (!id) throw new BadRequestException('assistantId is required');
  return id;
}

@Controller('chat/action-plans')
@UseGuards(JwtGuard)
export class ActionPlansController {
  constructor(private readonly plans: ActionPlansService) {}

  @Post('generate')
  generate(@CurrentUser() user: any, @Body() body: any) {
    // Лента одна (spec 2026-11-17-context-reset): freshTs старых клиентов не
    // читаем — план по основной ленте, после точки «Чистого листа».
    return this.plans.generate(user.userId, assistantIdOf(body?.assistantId));
  }

  @Get()
  async find(@CurrentUser() user: any, @Query('assistantId') assistantId: string) {
    const plan = await this.plans.findForConversation(user.userId, assistantIdOf(assistantId));
    return { plan };
  }

  @Patch(':id')
  async update(@CurrentUser() user: any, @Param('id') planId: string, @Body() body: any) {
    const plan = await this.plans.update(user.userId, planId, body || {});
    if (!plan) throw new NotFoundException('action plan not found');
    return { plan };
  }

  @Delete(':id')
  async remove(@CurrentUser() user: any, @Param('id') planId: string) {
    if (!await this.plans.remove(user.userId, planId)) throw new NotFoundException('action plan not found');
    return { removed: true };
  }
}
