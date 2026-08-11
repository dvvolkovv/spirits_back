import { Controller, Post, Get, Body, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { PriemService } from './priem.service';
import { PACKAGES } from './packages';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('')
export class PriemController {
  constructor(private readonly priem: PriemService) {}

  /**
   * Какие способы оплаты доступны. Решает язык: ru — YooKassa в рублях,
   * остальные — «Приём» в долларах. Фронт по этому ответу рисует витрину и не
   * дублирует правило у себя.
   */
  @Get('payments/methods')
  async methods(@Query('lang') langParam: string, @Res() res: Response) {
    // БЕЗ JwtGuard намеренно. Страница /tokens открывается по прямой ссылке с
    // лендинга, то есть посетитель ещё не авторизован: под гардом запрос
    // отвечал бы 401, витрина откатывалась бы к рублёвой, и англоязычный гость
    // видел бы рубли.
    //
    // Язык берём из параметра — фронт передаёт свой текущий. Для авторизованного
    // это и есть язык профиля: AuthContext синхронизирует i18n с ним при входе.
    // Секретов эндпоинт не отдаёт: только список пакетов и имя провайдера.
    const lang = (langParam || 'ru').split('-')[0].toLowerCase();

    // Пока ключи «Приёма» не прописаны, крипто-витрину не показываем никому:
    // иначе иностранец увидел бы пакеты и получил отказ по клику. До появления
    // PRIEM_API_KEY и PRIEM_WEBHOOK_SECRET поведение ровно прежнее.
    const useCrypto = lang !== 'ru' && this.priem.configured();

    // Прайс отдаётся обоим путям. Рублёвый берётся из общего модуля: раньше
    // здесь стояло `packages: []` с пометкой «рублёвые зашиты на фронте», и
    // ровно из-за этого прайс расходился между витриной, лендингом и
    // контроллером оплаты.
    //
    // Поле `price` — в валюте ответа. У валютных пакетов рядом сохраняется
    // `usd`: его читают уже выложенные витрины, и убрать его можно только
    // после того, как все они перейдут на `price`.
    const packages = useCrypto
      ? this.priem.packages().map((p) => ({ ...p, price: p.usd }))
      : PACKAGES.map((p) => ({
          id: p.id,
          tokens: p.tokens,
          price: p.priceRub,
          savingsPct: p.savingsPct,
        }));

    return res.status(200).json({
      language: lang,
      provider: useCrypto ? 'priem' : 'yookassa',
      currency: useCrypto ? 'USD' : 'RUB',
      packages,
      available: true,
    });
  }

  @Post('priem/create-payment')
  @UseGuards(JwtGuard)
  async createPayment(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const packageId = String(body?.package || body?.package_id || '');
    try {
      const result = await this.priem.createPayment(user.userId, packageId);
      // Обе ссылки — на ОДИН платёж: карточный путь не заводит второго счёта и
      // коллбэк придёт с тем же paymentId. Клиент выбирает способ у нас, мы
      // ведём его на соответствующую страницу.
      return res.status(200).json({
        payment_id: result.paymentId,
        payment_url: result.paymentUrl,
        card_url: result.cardUrl,
      });
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
