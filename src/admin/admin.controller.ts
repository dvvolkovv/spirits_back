import { Controller, Get, Post, Body, Param, Query, Req, Res, UseGuards, Optional } from '@nestjs/common';
import { Response } from 'express';
import { AdminService } from './admin.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { ProfileCompactionService } from '../scheduler/profile-compaction.service';
import { ReferralService } from '../referral/referral.service';
import { CurrentUser } from '../common/decorators/user.decorator';

// AdminGuard на уровне класса: все 13 маршрутов здесь — admin/*, и раньше
// каждый стоял под одним лишь JwtGuard, то есть был открыт ЛЮБОМУ
// залогиненному пользователю (утечка телефонов/балансов всех юзеров через
// admin/users/tokens и выпуск купонов себе через admin/coupons).
// Остальные админские контроллеры (smm, monitoring, vmm, vpm, backlog,
// support, vk-ads, dozvon) уже используют эту пару — здесь её забыли.
@Controller('')
@UseGuards(JwtGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly referralService: ReferralService,
    @Optional() private readonly compaction?: ProfileCompactionService,
  ) {}

  // --- Coupons (action-based POST) ---

  @Post('admin/coupons')
  async coupons(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const { action, ...data } = body;
    // Автор действия — тот, кто держит админский токен. Раньше не сохранялся
    // вовсе, из-за чего происхождение купонов было не выяснить.
    const actor = user?.userId ? String(user.userId) : undefined;
    switch (action) {
      case 'list': {
        const coupons = await this.adminService.listCoupons();
        return res.status(200).json(coupons);
      }
      case 'create': {
        const coupon = await this.adminService.createCoupon(data.code, data.token_amount || 60000, actor);
        return res.status(200).json(coupon);
      }
      case 'update': {
        const updated = await this.adminService.updateCoupon(data.id, data, actor);
        return res.status(200).json(updated);
      }
      case 'delete': {
        const result = await this.adminService.deleteCoupon(data.id, actor);
        return res.status(200).json(result);
      }
      case 'history': {
        const history = await this.adminService.couponHistory(Number(data.id));
        return res.status(200).json(history);
      }
      case 'audit': {
        const audit = await this.adminService.couponAudit(Number(data.limit) || 50);
        return res.status(200).json(audit);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  }

  // --- Referral Admin ---

  @Get('admin/referral/stats')
  async referralStats(@Res() res: Response) {
    const stats = await this.adminService.getReferralStats();
    return res.status(200).json(stats);
  }

  // --- Модерация ---

  @Get('admin/reports')
  async listReports(
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    const items = await this.adminService.listReports({
      status,
      limit: limit ? parseInt(limit, 10) || undefined : undefined,
    });
    return res.status(200).json(items);
  }

  @Get('admin/reports/summary')
  async reportsSummary(@Res() res: Response) {
    return res.status(200).json(await this.adminService.reportsSummary());
  }

  @Post('admin/reports/:id/resolve')
  async resolveReport(
    @Param('id') id: string,
    @Body() body: { action?: string; note?: string },
    @Req() req: any,
    @Res() res: Response,
  ) {
    const action = body?.action;
    if (action !== 'dismiss' && action !== 'content_removed' && action !== 'block') {
      return res.status(400).json({ error: 'action must be dismiss | content_removed | block' });
    }
    const result = await this.adminService.resolveReport(id, {
      action,
      note: body?.note,
      // Кто разобрал — из токена, а не из тела: иначе решение можно приписать
      // кому угодно.
      moderator: req.user?.userId || 'unknown',
    });
    if (!result.ok) return res.status(404).json({ error: 'report not found' });
    return res.status(200).json({ ok: true });
  }

  // --- Payments ---

  @Get('admin/payments')
  async listPayments(
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('includeTest') includeTest: string | undefined,
    @Res() res: Response,
  ) {
    const items = await this.adminService.listPayments({
      status,
      limit: limit ? parseInt(limit, 10) || undefined : undefined,
      includeTest: AdminController.isTruthy(includeTest),
    });
    return res.status(200).json(items);
  }

  @Get('admin/payments/stats')
  async paymentsStats(
    @Query('days') days: string | undefined,
    @Query('includeTest') includeTest: string | undefined,
    @Res() res: Response,
  ) {
    const stats = await this.adminService.getPaymentsStats({
      days: days ? parseInt(days, 10) || undefined : undefined,
      includeTest: AdminController.isTruthy(includeTest),
    });
    return res.status(200).json(stats);
  }

  /** Флаг из query-строки. Всё, кроме явного «да», считаем выключенным. */
  private static isTruthy(v: string | undefined): boolean {
    return v === '1' || v === 'true';
  }

  // --- Tokens ---

  @Get('admin/users/tokens')
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
  async assistantsUsage(@Query('days') days: string | undefined, @Res() res: Response) {
    const stats = await this.adminService.getAssistantsUsageStats({
      days: days ? parseInt(days, 10) || undefined : undefined,
    });
    return res.status(200).json(stats);
  }

  // --- Голосовые звонки ---

  @Get('admin/calls')
  async callsByUser(
    @Query('days') days: string | undefined,
    @Query('kind') kind: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    // kind не валидируем здесь: сервис сам схлопывает незнакомое значение в
    // 'call'. Проверка в двух местах разъехалась бы при добавлении провайдера.
    const stats = await this.adminService.getCallsByUser({
      days: days ? parseInt(days, 10) || undefined : undefined,
      kind: kind as 'call' | 'meeting' | 'all' | undefined,
      limit: limit ? parseInt(limit, 10) || undefined : undefined,
    });
    return res.status(200).json(stats);
  }

  /**
   * Звонки одного человека — для карточки пользователя в админке.
   *
   * Объявлен ДО admin/calls/:id/transcript намеренно: иначе литерал `user`
   * попал бы в :id и запрос ушёл бы искать звонок с таким идентификатором.
   */
  @Get('admin/calls/user/:userId')
  async userCalls(
    @Param('userId') userId: string,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    const data = await this.adminService.getUserCalls(userId, {
      limit: limit ? parseInt(limit, 10) || undefined : undefined,
    });
    return res.status(200).json(data);
  }

  @Get('admin/calls/:id/transcript')
  async callTranscript(@Param('id') id: string, @Res() res: Response) {
    const data = await this.adminService.getCallTranscript(id);
    // 404, а не пустой объект: иначе интерфейс покажет пустой диалог, и это
    // будет неотличимо от звонка, где человек молчал.
    if (!data) return res.status(404).json({ error: 'call not found' });
    return res.status(200).json(data);
  }

  // --- Устройства ---

  @Get('admin/devices/stats')
  async deviceStats(@Res() res: Response) {
    return res.status(200).json(await this.adminService.getDeviceStats());
  }

  @Get('admin/devices')
  async userDevices(@Query('userId') userId: string, @Res() res: Response) {
    if (!userId) return res.status(400).json({ error: 'userId required' });
    return res.status(200).json(await this.adminService.getUserDevices(userId));
  }

  @Post('admin/referral')
  async referralAction(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const { action, ...data } = body;
    switch (action) {
      case 'withdrawals_list': {
        const list = await this.referralService.listWithdrawals(data.status);
        return res.status(200).json(list);
      }
      case 'withdrawal_process': {
        try {
          const r = await this.referralService.processWithdrawal(data.id, data.decision, user?.userId);
          return res.status(200).json(r);
        } catch (e: any) {
          return res.status(400).json({ error: e?.message || 'Ошибка обработки' });
        }
      }
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
      case 'advocate_preview': {
        // Адвокаты (вовлечённые платящие, 0 рефералов): только черновики SMS+email.
        const out = await this.adminService.buildAdvocateOutreach();
        return res.status(200).json(out);
      }
      case 'advocate_send': {
        // Реальная рассылка адвокатам (SMS+email) — требует confirm:true.
        const out = await this.adminService.sendAdvocateOutreach(data);
        return res.status((out as any).error ? 400 : 200).json(out);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  }

  // Retention re-engagement (backlog 72cfc486). preview только строит черновики;
  // send — реальная SMS-рассылка, требует confirm:true (подтверждение владельца).
  @Post('admin/retention')
  async retentionAction(@Body() body: any, @Res() res: Response) {
    const { action, ...data } = body;
    switch (action) {
      case 'preview': {
        const out = await this.adminService.buildRetentionOutreach(data);
        return res.status(200).json(out);
      }
      case 'send': {
        const out = await this.adminService.sendRetentionOutreach(data);
        return res.status((out as any).error ? 400 : 200).json(out);
      }
      // Curious return-trigger (3a54efe4): сегмент Curious, окно 24–48ч.
      case 'curious_preview': {
        const out = await this.adminService.buildCuriousReturnOutreach();
        return res.status(200).json(out);
      }
      case 'curious_send': {
        const out = await this.adminService.sendCuriousReturnOutreach(data);
        return res.status((out as any).error ? 400 : 200).json(out);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  }

  // Activation outreach (backlog c45c71df). preview только строит черновики;
  // send — реальная SMS-рассылка новичкам, требует confirm:true (владелец).
  @Post('admin/activation')
  async activationAction(@Body() body: any, @Res() res: Response) {
    const { action, ...data } = body;
    switch (action) {
      case 'preview': {
        const out = await this.adminService.buildActivationOutreach(data);
        return res.status(200).json(out);
      }
      case 'send': {
        const out = await this.adminService.sendActivationOutreach(data);
        return res.status((out as any).error ? 400 : 200).json(out);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  }
}
