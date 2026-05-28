import { Body, Controller, Get, Post, Param, Query, Req, Res, HttpStatus, Logger, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { EmailService } from './email.service';
import { IdentityService } from '../identity/identity.service';
import { JwtService } from '../common/services/jwt.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RedisService } from '../common/services/redis.service';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
};

@Controller('')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly email: EmailService,
    private readonly identity: IdentityService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
  ) {}

  // SMS OTP request — UUID hardcoded to match frontend
  @Get('898c938d-f094-455c-86af-969617e62f7a/sms/:phone')
  async sendSms(@Param('phone') phone: string, @Res() res: Response) {
    const result = await this.authService.requestSmsCode(phone);
    if (result.status === 'blocked') {
      return res.set(CORS).status(403).send('User blocked');
    }
    return res.set(CORS).status(200).send('SMS sent');
  }

  // Check OTP code — UUID hardcoded
  @Get('a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/:phone/:code')
  async checkCode(
    @Param('phone') phone: string,
    @Param('code') code: string,
    @Res() res: Response,
  ) {
    const tokens = await this.authService.checkCode(phone, code);
    if (!tokens) {
      return res.set(CORS).status(401).json({ error: 'Invalid or expired code' });
    }
    return res.set(CORS).status(200).json(tokens);
  }

  // Refresh token
  @Post('auth/refresh')
  async refresh(@Req() req: Request, @Res() res: Response) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing token' });
    }
    const token = authHeader.substring(7);
    const tokens = await this.authService.refreshTokens(token);
    if (!tokens) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    return res.status(200).json(tokens);
  }

  // Debug endpoint — returns SMS code from Redis (only when DEBUG_SMS_CODES=true)
  @Get('debug/sms-code/:phone')
  async debugSmsCode(@Param('phone') phone: string, @Res() res: Response) {
    if (process.env.DEBUG_SMS_CODES !== 'true') {
      return res.status(404).json({ error: 'Not found' });
    }
    if (!this.isTestPhone(phone)) {
      return res.status(403).json({ error: 'Phone not in whitelist' });
    }
    const code = await this.authService.getDebugCode(phone);
    if (!code) return res.status(404).json({ error: 'No code' });
    return res.status(200).json({ code });
  }

  @Get('debug/email-token/:email')
  async debugEmailToken(@Param('email') email: string, @Res() res: Response) {
    if (process.env.DEBUG_SMS_CODES !== 'true') {
      return res.status(404).json({ error: 'not enabled' });
    }
    const normalized = email.trim().toLowerCase();
    // Search active ml-* tokens for this email
    const allKeys = await this.redis.keys('ml-*');
    for (const key of allKeys) {
      // Skip rate-limit keys (ml-rate-*)
      if (key.startsWith('ml-rate-')) continue;
      const v = await this.redis.get(key);
      if (v === normalized) {
        return res.status(200).json({ token: key.slice(3), email: v });
      }
    }
    return res.status(404).json({ error: 'no active token' });
  }

  /**
   * Debug: изменить баланс тестового пользователя (только для E2E-тестов).
   */
  @Post('debug/add-tokens/:phone/:amount')
  async debugAddTokens(
    @Param('phone') phone: string,
    @Param('amount') amount: string,
    @Res() res: Response,
  ) {
    if (process.env.DEBUG_SMS_CODES !== 'true') {
      return res.status(404).json({ error: 'Not found' });
    }
    if (!this.isTestPhone(phone)) {
      return res.status(403).json({ error: 'Phone not in whitelist' });
    }
    const delta = parseInt(amount, 10);
    if (Number.isNaN(delta)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    try {
      const result = await this.authService.debugAddTokens(phone, delta);
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Internal error' });
    }
  }

  @Post('auth/email/request')
  async emailRequest(@Body() body: { email?: string }, @Req() req: Request, @Res() res: Response) {
    const rawEmail = (body?.email || '').trim().toLowerCase();
    if (!rawEmail || !rawEmail.includes('@')) {
      return res.set(CORS).status(400).json({ error: 'invalid email' });
    }
    if (this.email.isTempmail(rawEmail)) {
      return res.set(CORS).status(400).json({ error: 'tempmail_blocked', message: 'Используйте постоянную почту' });
    }
    const ip = ((req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown') as string).split(',')[0].trim();
    const rl = await this.email.checkRateLimit(rawEmail, ip);
    if (!rl.ok) {
      return res.set(CORS).status(429).json({ error: 'rate_limit', reason: (rl as { ok: false; reason: string }).reason });
    }
    const token = await this.email.generateMagicToken(rawEmail);
    await this.email.sendMagicLink(rawEmail, token);
    return res.set(CORS).status(200).json({ sent: true });
  }

  @Get('auth/email/confirm')
  async emailConfirm(@Query('token') token: string, @Req() req: Request, @Res() res: Response) {
    if (!token) {
      return res.set(CORS).status(400).type('html').send('<html><body><h1>Ссылка устарела</h1></body></html>');
    }
    const email = await this.email.consumeMagicToken(token);
    if (!email) {
      return res.set(CORS).status(400).type('html').send('<html><body><h1>Ссылка устарела или уже использована</h1></body></html>');
    }
    const { userId } = await this.identity.resolveOrCreate('email', { email });
    const tokens = {
      'access-token':  this.jwt.signAccess(userId),
      'refresh-token': this.jwt.signRefresh(userId),
    };
    // JSON для XHR-ответа, HTML с inline-script для прямого клика по ссылке
    if ((req.headers['accept'] || '').includes('application/json')) {
      return res.set(CORS).status(200).json(tokens);
    }
    const escapedAccess  = JSON.stringify(tokens['access-token']);
    const escapedRefresh = JSON.stringify(tokens['refresh-token']);
    res.set(CORS).status(200).type('html').send(`
<!doctype html>
<html><head><meta charset="utf-8"><title>Вход выполнен</title></head>
<body style="font-family:system-ui;padding:40px;text-align:center">
<p>Заходим...</p>
<script>
try {
  localStorage.setItem('jwt_access_token', ${escapedAccess});
  localStorage.setItem('jwt_refresh_token', ${escapedRefresh});
  localStorage.setItem('authToken', ${escapedAccess});
} catch(e) {}
location.replace('/chat');
</script>
</body></html>
    `);
  }

  @Post('auth/email/login')
  async emailLogin(@Body() body: { email?: string; password?: string }, @Res() res: Response) {
    const email = (body?.email || '').trim().toLowerCase();
    const password = body?.password;
    if (!email || !password) return res.set(CORS).status(400).json({ error: 'missing fields' });

    const idResult = await this.identity.findIdentityByEmail(email);
    if (!idResult) return res.set(CORS).status(401).json({ error: 'invalid credentials' });
    const userId = idResult.userId;

    const hash = await this.identity.getUserPasswordHash(userId);
    if (!hash) return res.set(CORS).status(401).json({ error: 'no password set' });

    const ok = await this.email.verifyPassword(password, hash);
    if (!ok) return res.set(CORS).status(401).json({ error: 'invalid credentials' });

    await this.identity.touchIdentity('email', email);

    return res.set(CORS).status(200).json({
      'access-token':  this.jwt.signAccess(userId),
      'refresh-token': this.jwt.signRefresh(userId),
    });
  }

  @UseGuards(JwtGuard)
  @Post('auth/email/set-password')
  async setPassword(@Body() body: { password?: string }, @Req() req: any, @Res() res: Response) {
    const password = body?.password;
    if (!password || password.length < 8) {
      return res.set(CORS).status(400).json({ error: 'password must be 8+ chars' });
    }
    const userId = req.user?.userId;
    if (!userId) return res.set(CORS).status(401).json({ error: 'unauthorized' });

    const hash = await this.email.hashPassword(password);
    await this.identity.setUserPasswordHash(userId, hash);
    return res.set(CORS).status(200).json({ ok: true });
  }

  /**
   * Whitelist тестовых телефонов для всех debug-эндпоинтов.
   * Фиксированный список + pattern для динамических referral-аккаунтов.
   */
  private isTestPhone(phone: string): boolean {
    const FIXED = ['70000000000', '79030169187', '79169403771'];
    if (FIXED.includes(phone)) return true;
    return /^790300\d{5}$/.test(phone);
  }
}
