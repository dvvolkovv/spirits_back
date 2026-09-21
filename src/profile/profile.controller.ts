import { Controller, Get, Post, Delete, Body, Query, Req, Res, UseGuards, Optional, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { ProfileService } from './profile.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { Neo4jService } from '../neo4j/neo4j.service';
import { EmailService } from '../auth/email.service';
import { IdentityService } from '../identity/identity.service';

@Controller('')
export class ProfileController {
  private readonly logger = new Logger(ProfileController.name);

  constructor(
    private readonly profileService: ProfileService,
    @Optional() private readonly neo4j: Neo4jService,
    @Optional() private readonly email?: EmailService,
    @Optional() private readonly identity?: IdentityService,
  ) {}

  @Get('profile')
  @UseGuards(JwtGuard)
  async getProfile(@CurrentUser() user: any, @Res() res: Response) {
    const profile = await this.profileService.getProfile(user.userId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    // Entities (values, beliefs, etc.) live in Neo4j only
    if (this.neo4j && profile[0]?.profileJson) {
      try {
        const neo4jData = await this.neo4j.getProfileEntities(user.userId);
        if (neo4jData) {
          Object.assign(profile[0].profileJson, neo4jData);
        }
      } catch {}
    }

    return res.status(200).json(profile);
  }

  @Post('profile-update')
  @UseGuards(JwtGuard)
  async updateProfile(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const result = await this.profileService.updateProfile(user.userId, body);

    // Entities live in Neo4j only — full replace
    if (this.neo4j) {
      const entityFields: Record<string, string> = {
        values: 'value', beliefs: 'belief', desires: 'desire',
        intents: 'intent', intentions: 'intent', interests: 'interest', skills: 'skill',
      };
      for (const [field, type] of Object.entries(entityFields)) {
        if (Array.isArray(body[field])) {
          await this.neo4j.replaceEntities(user.userId, type, body[field]);
        }
      }
    }

    return res.status(200).json(result);
  }

  @Delete('profile')
  @UseGuards(JwtGuard)
  async deleteProfile(@CurrentUser() user: any, @Res() res: Response) {
    const result = await this.profileService.deleteProfile(user.userId);
    return res.status(200).json(result);
  }

  @Get('user-profile')
  @UseGuards(JwtGuard)
  async getUserProfile(@Query('userId') userId: string, @Res() res: Response) {
    const profile = await this.profileService.getUserProfile(userId);
    if (!profile) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json(profile);
  }

  /**
   * Сохранить почту пользователя.
   *
   * Зовётся НЕ из профиля, а из форм оплаты: адрес нужен для чека YooKassa.
   * Отсюда и весь инцидент 19.09.2026 — человек вводит почту, покупая токены,
   * и считает, что теперь по ней можно войти, а она ложится в анкетное поле
   * ai_profiles_consolidated.email, которое входом не является.
   *
   * Поэтому следом уходит письмо, превращающее адрес в настоящую связку.
   * Отправка сознательно не влияет на ответ: это путь оплаты, и уронить
   * покупку из-за недоступного SMTP несоизмеримо дороже непосланного письма.
   */
  @Post('set-email')
  @UseGuards(JwtGuard)
  async setEmail(@CurrentUser() user: any, @Body() body: { email: string }, @Res() res: Response) {
    const raw = (body?.email || '').trim();
    const normalized = raw.toLowerCase();
    if (!normalized || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
      return res.status(400).json({ error: 'invalid email' });
    }
    if (this.email?.isTempmail(normalized)) {
      return res.status(400).json({ error: 'tempmail_blocked' });
    }

    const result = await this.profileService.setEmail(user.userId, raw);
    await this.offerEmailAsLogin(user.userId, normalized);
    return res.status(200).json(result);
  }

  /**
   * Предложить письмом сделать этот адрес способом входа.
   *
   * Молчим в двух случаях: почта уже подтверждённый вход этого же человека
   * (иначе письмо уходило бы на каждую покупку) и почта — вход ДРУГОГО
   * аккаунта (привязка всё равно упрётся в conflict, а письмо читалось бы как
   * приглашение зайти в чужой аккаунт).
   */
  private async offerEmailAsLogin(userId: string, email: string): Promise<void> {
    try {
      if (!this.email || !this.identity) return;

      const mine = await this.identity.listIdentities(userId);
      if (mine.some((i) => i.provider === 'email' && i.email === email && i.emailVerified)) return;

      const owner = await this.identity.findIdentityByEmail(email);
      if (owner && owner.userId !== userId) return;

      if (await this.email.verifyAlreadyOffered(userId, email)) return;

      const token = await this.email.generateVerifyToken(userId, email);
      // Ждём всё, кроме самой отправки: проверки и запись в Redis быстрые и
      // локальные, а SMTP — единственное здесь, что умеет висеть секундами и
      // падать. Отрывать от ответа надо именно его, а не всю ветку.
      void this.email.sendVerifyEmail(email, token).catch((e: any) =>
        this.logger.warn(`письмо с подтверждением на ${email} не ушло: ${e?.message}`),
      );
    } catch (e: any) {
      // Ровно то место, где глотать исключение правильно: ответ уже ушёл,
      // оплата продолжается, потеряно только письмо.
      this.logger.warn(`подтверждение почты не отправлено для ${userId}: ${e?.message}`);
    }
  }

  @Post('onboarding/complete')
  @UseGuards(JwtGuard)
  async completeOnboarding(@CurrentUser() user: any, @Res() res: Response) {
    const result = await this.profileService.completeOnboarding(user.userId);
    return res.status(200).json(result);
  }
}
