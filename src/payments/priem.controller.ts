import { Controller, Post, Get, Body, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { PriemService } from './priem.service';
import { LanguageService } from '../common/services/language.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('')
export class PriemController {
  constructor(
    private readonly priem: PriemService,
    private readonly language: LanguageService,
  ) {}

  /**
   * Какие способы оплаты доступны этому пользователю. Решает язык профиля:
   * ru — YooKassa, остальные — «Приём». Фронт по этому ответу рисует витрину и
   * не гадает сам.
   */
  @Get('payments/methods')
  @UseGuards(JwtGuard)
  async methods(@CurrentUser() user: any, @Res() res: Response) {
    const lang = await this.language.resolveUserLanguage(user.userId);

    // Пока ключи «Приёма» не прописаны, крипто-витрину не показываем никому:
    // иначе иностранец увидел бы пакеты и получил отказ по клику. До появления
    // PRIEM_API_KEY и PRIEM_WEBHOOK_SECRET поведение ровно прежнее.
    const useCrypto = lang !== 'ru' && this.priem.configured();

    return res.status(200).json({
      language: lang,
      provider: useCrypto ? 'priem' : 'yookassa',
      currency: useCrypto ? 'USD' : 'RUB',
      // Пакеты отдаём только для крипто-витрины: рублёвые зашиты на фронте.
      packages: useCrypto ? this.priem.packages() : [],
      available: true,
    });
  }

  @Post('priem/create-payment')
  @UseGuards(JwtGuard)
  async createPayment(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const packageId = String(body?.package || body?.package_id || '');
    try {
      const result = await this.priem.createPayment(user.userId, packageId);
      return res.status(200).json({ payment_id: result.paymentId, payment_url: result.paymentUrl });
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  }

  /**
   * Коллбэк «Приёма».
   *
   * Тело здесь — Buffer, а не разобранный объект: парсер для этого пути
   * подключён в main.ts ДО глобального JSON, потому что подпись считается по
   * сырым байтам. Разобрать и собрать обратно нельзя — порядок ключей и пробелы
   * изменятся, и подпись не сойдётся.
   *
   * Отвечаем 2xx во всех случаях, кроме неверной подписи: любой другой ответ
   * «Приём» считает неудачей и повторяет семь раз в течение 33 часов. Неизвестный
   * платёж или промежуточное состояние — это не повод заставлять их повторять.
   */
  @Post('priem/callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const raw: Buffer | string = (req as any).body;
    const timestamp = req.get('X-Priem-Timestamp');
    const signature = req.get('X-Priem-Signature');

    if (!this.priem.verifySignature(raw, timestamp, signature)) {
      return res.sendStatus(401);
    }

    let payload: any;
    try {
      payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    } catch {
      // Подпись сошлась, а тело не разбирается — повторы не помогут.
      return res.sendStatus(200);
    }

    try {
      await this.priem.handleCallback(payload);
    } catch (e: any) {
      // Зачисление не удалось по нашей вине — пусть повторят.
      return res.status(500).json({ error: e.message });
    }
    return res.sendStatus(200);
  }
}
