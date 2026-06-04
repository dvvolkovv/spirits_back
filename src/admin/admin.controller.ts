import { Controller, Get, Post, Body, Param, Query, Res, UseGuards, Optional } from '@nestjs/common';
import { Response } from 'express';
import { AdminService } from './admin.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { ProfileCompactionService } from '../scheduler/profile-compaction.service';

@Controller('')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    @Optional() private readonly compaction?: ProfileCompactionService,
  ) {}

  // --- Coupons (action-based POST) ---

  @Post('admin/coupons')
  @UseGuards(JwtGuard)
  async coupons(@Body() body: any, @Res() res: Response) {
    const { action, ...data } = body;
    switch (action) {
      case 'list': {
        const coupons = await this.adminService.listCoupons();
        return res.status(200).json(coupons);
      }
      case 'create': {
        const coupon = await this.adminService.createCoupon(data.code, data.token_amount || 60000);
        return res.status(200).json(coupon);
      }
      case 'update': {
        const updated = await this.adminService.updateCoupon(data.id, data);
        return res.status(200).json(updated);
      }
      case 'delete': {
        const result = await this.adminService.deleteCoupon(data.id);
        return res.status(200).json(result);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  }

  // --- Referral Admin ---

  @Get('admin/referral/stats')
  @UseGuards(JwtGuard)
  async referralStats(@Res() res: Response) {
    const stats = await this.adminService.getReferralStats();
    return res.status(200).json(stats);
  }

  // --- Payments ---

  @Get('admin/payments')
  @UseGuards(JwtGuard)
  async listPayments(
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    const items = await this.adminService.listPayments({
      status,
      limit: limit ? parseInt(limit, 10) || undefined : undefined,
    });
    return res.status(200).json(items);
  }

  @Get('admin/payments/stats')
  @UseGuards(JwtGuard)
  async paymentsStats(@Query('days') days: string | undefined, @Res() res: Response) {
    const stats = await this.adminService.getPaymentsStats({
      days: days ? parseInt(days, 10) || undefined : undefined,
    });
    return res.status(200).json(stats);
  }

  // --- Tokens ---

  @Get('admin/users/tokens')
  @UseGuards(JwtGuard)
  async usersTokens(
    @Query('limit') limit: string | undefined,
    @Query('sort') sort: string | undefined,
    @Query('hours') hours: string | undefined,
    @Res() res: Response,
  ) {
    const data = await this.adminService.getUsersTokensList({
      limit: limit ? parseInt(limit, 10) || undefined : undefined,
      sortBy: sort === 'spent_period' ? 'spent_period' : 'balance',
      hours: hours ? parseInt(hours, 10) || undefined : undefined,
    });
    return res.status(200).json(data);
  }

  @Get('admin/tokens/stats')
  @UseGuards(JwtGuard)
  async tokensStats(
    @Query('bucket') bucket: string | undefined,
    @Query('days') days: string | undefined,
    @Res() res: Response,
  ) {
    const stats = await this.adminService.getTokensSpendStats({
      bucket: bucket === 'hour' ? 'hour' : 'day',
      days: days ? parseInt(days, 10) || undefined : undefined,
    });
    return res.status(200).json(stats);
  }

  @Get('admin/users/:phone/activity')
  @UseGuards(JwtGuard)
  async userActivity(
    @Param('phone') phone: string,
    @Query('days') days: string | undefined,
    @Res() res: Response,
  ) {
    const data = await this.adminService.getUserActivity(phone, {
      days: days ? parseInt(days, 10) || undefined : undefined,
    });
    return res.status(200).json(data);
  }

  @Post('admin/profile/compact')
  @UseGuards(JwtGuard)
  async profileCompact(@Body() body: any, @Res() res: Response) {
    if (!this.compaction) return res.status(503).json({ error: 'compaction not configured' });
    const userId = String(body?.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const stats = await this.compaction.compactUser(userId);
      return res.status(200).json(stats);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'compact failed' });
    }
  }

  @Get('admin/users/active')
  @UseGuards(JwtGuard)
  async usersActive(
    @Query('days') days: string | undefined,
    @Query('bucket') bucket: string | undefined,
    @Res() res: Response,
  ) {
    const stats = await this.adminService.getActiveUsersStats({
      days: days ? parseInt(days, 10) || undefined : undefined,
      bucket: bucket === 'week' ? 'week' : 'day',
    });
    return res.status(200).json(stats);
  }

  // --- Usage stats ---

  @Get('admin/usage/assistants')
  @UseGuards(JwtGuard)
  async assistantsUsage(@Query('days') days: string | undefined, @Res() res: Response) {
    const stats = await this.adminService.getAssistantsUsageStats({
      days: days ? parseInt(days, 10) || undefined : undefined,
    });
    return res.status(200).json(stats);
  }

  @Post('admin/referral')
  @UseGuards(JwtGuard)
  async referralAction(@Body() body: any, @Res() res: Response) {
    const { action, ...data } = body;
    switch (action) {
      case 'create': {
        const leader = await this.adminService.createReferralLeader(data);
        return res.status(200).json(leader);
      }
      case 'toggle': {
        const toggled = await this.adminService.toggleReferralLeader(data.id);
        return res.status(200).json(toggled);
      }
      case 'mark_paid': {
        const paid = await this.adminService.markPaid(data.commission_id || data.id);
        return res.status(200).json(paid);
      }
      case 'mark_all_paid': {
        const result = await this.adminService.markAllPaid(data.leader_id);
        return res.status(200).json(result);
      }
      case 'outreach_preview': {
        // Только строит персональные черновики (ничего не шлёт) — backlog 82cda5af.
        const out = await this.adminService.buildReferralOutreach();
        return res.status(200).json(out);
      }
      case 'outreach_send': {
        // Реальная SMS-рассылка лидерам — требует confirm:true (подтверждение владельца).
        const out = await this.adminService.sendReferralOutreach(data);
        return res.status((out as any).error ? 400 : 200).json(out);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  }
}
