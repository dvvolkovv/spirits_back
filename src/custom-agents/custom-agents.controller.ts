import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { CustomAgentsService } from './custom-agents.service';
import { CreateCustomAgentDto, UpdateCustomAgentDto, DraftPromptDto } from './custom-agents.dto';

@Controller('')
@UseGuards(JwtGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class CustomAgentsController {
  constructor(private readonly agents: CustomAgentsService) {}

  @Get('custom-agents')
  async list(@CurrentUser() user: any, @Res() res: Response) {
    const rows = await this.agents.list(user.userId);
    return res.status(200).json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        systemPrompt: r.system_prompt,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    );
  }

  @Post('custom-agents')
  async create(@CurrentUser() user: any, @Body() dto: CreateCustomAgentDto, @Res() res: Response) {
    const row = await this.agents.create(user.userId, dto);
    return res.status(201).json({
      id: row.id,
      name: row.name,
      description: row.description,
      systemPrompt: row.system_prompt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  @Post('custom-agents/draft')
  async draft(@CurrentUser() _user: any, @Body() dto: DraftPromptDto, @Res() res: Response) {
    const draft = await this.agents.draftPrompt(dto.description);
    return res.status(200).json(draft);
  }

  @Patch('custom-agents/:id')
  async update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateCustomAgentDto,
    @Res() res: Response,
  ) {
    const row = await this.agents.update(id, user.userId, dto);
    return res.status(200).json({
      id: row.id,
      name: row.name,
      description: row.description,
      systemPrompt: row.system_prompt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  @Delete('custom-agents/:id')
  async remove(@CurrentUser() user: any, @Param('id') id: string, @Res() res: Response) {
    await this.agents.remove(id, user.userId);
    return res.status(200).json({ ok: true });
  }
}
