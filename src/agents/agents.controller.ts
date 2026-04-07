import { Controller, Get, Post, Body, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AgentsService } from './agents.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Get('agent-details')
  @UseGuards(JwtGuard)
  async getAgentDetails(@Res() res: Response) {
    const agents = await this.agentsService.getAgentDetails();
    return res.status(200).json(agents);
  }

  @Get('agents')
  async getAgents(@Res() res: Response) {
    const agents = await this.agentsService.getAgents();
    return res.status(200).json(agents);
  }

  @Post('change-agent')
  @UseGuards(JwtGuard)
  async changeAgent(@CurrentUser() user: any, @Body() body: { agent: string }, @Res() res: Response) {
    const result = await this.agentsService.changeAgent(user.phone, body.agent);
    return res.status(200).json(result);
  }

  @Post('agent')
  @UseGuards(JwtGuard)
  async upsertAgent(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    await this.agentsService.upsertAgent(body);
    return res.status(200).json({ success: 'agent updated' });
  }
}
