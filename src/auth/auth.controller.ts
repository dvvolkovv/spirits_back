import { Controller, Get, Post, Param, Req, Res, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
};

@Controller('')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

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

  /**
   * Whitelist тестовых телефонов для всех debug-эндпоинтов.
   * Фиксированный список + pattern для динамических referral-аккаунтов.
   */
  private isTestPhone(phone: string): boolean {
    const FIXED = ['70000000000', '79030169187'];
    if (FIXED.includes(phone)) return true;
    return /^790300\d{5}$/.test(phone);
  }
}
