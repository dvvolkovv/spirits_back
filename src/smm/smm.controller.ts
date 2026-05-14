// src/smm/smm.controller.ts
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PgService } from '../common/services/pg.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { rowToCampaign, SmmCampaign } from './entities/smm-campaign.entity';

@Controller('smm')
@UseGuards(JwtGuard, AdminGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class SmmController {
  constructor(private readonly pg: PgService) {}

  @Post('campaigns')
  async createCampaign(
    @Req() req: any,
    @Body() dto: CreateCampaignDto,
  ): Promise<SmmCampaign> {
    const userId = req.user.phone;
    const res = await this.pg.query(
      `INSERT INTO smm_campaign
          (user_id, conversation_id, topic, source_mode, requested_count)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        userId,
        dto.conversationId ?? null,
        dto.topic ?? null,
        dto.sourceMode,
        dto.requestedCount,
      ],
    );
    return rowToCampaign(res.rows[0]);
  }

  @Get('campaigns/:id')
  async getCampaign(@Param('id') id: string): Promise<SmmCampaign> {
    const res = await this.pg.query(
      `SELECT * FROM smm_campaign WHERE id = $1`, [id],
    );
    if (res.rows.length === 0) throw new NotFoundException(`campaign ${id} not found`);
    return rowToCampaign(res.rows[0]);
  }
}
