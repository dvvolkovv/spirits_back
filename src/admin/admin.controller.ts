import { Controller, Get, Post, Body, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminService } from './admin.service';
import { JwtGuard } from '../common/guards/jwt.guard';

@Controller('')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // --- Coupons (action-based POST) ---

  @Post('admin/coupons')
  @UseGuards(JwtGuard)
  async coupons(@Body() body: any, @Res() res: Response) {
    const { action, ...data } = body;
    switch (action) {
      case 'list': {
        const coupons = await this.adminService.listCoupons();
        return res.status(200).json({ coupons });
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
        const paid = await this.adminService.markPaid(data.id);
        return res.status(200).json(paid);
      }
      case 'mark_all_paid': {
        const result = await this.adminService.markAllPaid(data.leader_id);
        return res.status(200).json(result);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  }
}
