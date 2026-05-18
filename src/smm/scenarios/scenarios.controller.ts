// src/smm/scenarios/scenarios.controller.ts
import {
  Body, Controller, Delete, Get, NotFoundException, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { ScenarioService } from '../producer/scenario.service';
import { ApprovalService } from '../producer/approval.service';
import { PgService } from '../../common/services/pg.service';

@Controller('smm/scenarios')
@UseGuards(JwtGuard, AdminGuard)
export class ScenariosController {
  constructor(
    private readonly scenarios: ScenarioService,
    private readonly approval: ApprovalService,
    private readonly pg: PgService,
  ) {}

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const s = await this.scenarios.getById(id);
    if (!s) throw new NotFoundException(`scenario ${id} not found`);
    // Attach latest rendered video id (if any) — frontend uses this to embed
    // the player on page reload, since ScenarioCard's local state is lost.
    const v = await this.pg.query(
      `SELECT id FROM smm_video
        WHERE scenario_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    return { ...s, videoId: v.rows[0]?.id ?? null };
  }

  @Post(':id/approve')
  async approveOne(@Req() req: any, @Param('id') id: string) {
    return this.approval.approveScenarios({ userId: req.user.phone, scenarioIds: [id] });
  }

  @Post(':id/regenerate')
  async regen(@Param('id') id: string, @Body() body: { feedback: string }) {
    await this.scenarios.regenerate(id, body.feedback || '');
    return { ok: true };
  }

  @Delete(':id')
  async reject(@Param('id') id: string) {
    await this.approval.rejectScenario(id);
    return { ok: true };
  }
}
