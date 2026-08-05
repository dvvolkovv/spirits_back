import { Controller, Get, Post, Body, Req, Res, UseGuards, Query } from '@nestjs/common';
import { Response } from 'express';
import { AgentsService } from './agents.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  // Только админ: отдаёт system_prompt всех ассистентов, то есть
  // внутреннюю кухню продукта. Зовётся из AdminAssistantsView.
  @Get('agent-details')
  @UseGuards(JwtGuard, AdminGuard)
  async getAgentDetails(@Res() res: Response) {
    const agents = await this.agentsService.getAgentDetails();
    return res.status(200).json(agents);
  }

  @Get('agents')
  async getAgents(@Query('lang') lang: string, @Res() res: Response) {
    const agents = await this.agentsService.getAgents(lang);
    return res.status(200).json(agents);
  }

  @Post('change-agent')
  @UseGuards(JwtGuard)
  async changeAgent(@CurrentUser() user: any, @Body() body: { agent: string }, @Res() res: Response) {
    const result = await this.agentsService.changeAgent(user.userId, body.agent);
    return res.status(200).json(result);
  }

  // Только админ. Раньше стоял один JwtGuard, а @CurrentUser() принимался
  // и не использовался — при том, что upsertAgent пишет в ОБЩУЮ таблицу
  // agents (колонки user_id там нет). То есть любой залогиненный мог
  // перезаписать system_prompt любого ассистента для всех пользователей.
  // Зовётся из AdminAssistantsView, поэтому ограничение ничего не ломает.
  @Post('agent')
  @UseGuards(JwtGuard, AdminGuard)
  async upsertAgent(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    await this.agentsService.upsertAgent(body);
    return res.status(200).json({ success: 'agent updated' });
  }
}
