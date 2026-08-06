import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ЗАГЛУШКА приёма коллбэков Changelly PAY на https://linkeon.io/callbacks/changelly.
 *
 * Зачем: настоящий обработчик живёт в отдельном приложении (проект Priem,
 * ветка stage-2-payment-flow) и ещё не выкачен. Его разбор тела коллбэка —
 * допущение: в спеке Changelly схема тела объявлена, но не определена.
 * Чтобы снять эту неизвестность, не выкатывая на прод целое приложение
 * с Postgres/миграциями/systemd, здесь стоит заглушка: она НИЧЕГО не проверяет
 * и ничего не обрабатывает — только фиксирует сырые байты тела и заголовки
 * (в первую очередь X-Signature) и отвечает 200.
 *
 * Тело приходит сюда нетронутым: в main.ts на этот путь смонтирован
 * bodyParser.raw() ДО json-парсера, поэтому req.body — Buffer, байт в байт
 * как прислал Changelly. Это важно: подпись считается по байтам, любое
 * пере-сериализование JSON её ломает.
 *
 * nginx на linkeon.io проксирует ровно один путь:
 *   location = /callbacks/changelly -> http://127.0.0.1:3001/webhook/callbacks/changelly
 *
 * Снятые тела: logs/changelly-callbacks.log (JSONL) + pm2-лог по метке
 * [changelly-callback]. Смотреть: pm2 logs linkeon-api | grep changelly-callback
 *
 * УДАЛИТЬ, когда настоящий обработчик выкачен и форма тела подтверждена.
 * Пока заглушка отвечает 200, Changelly считает коллбэк доставленным и НЕ ретраит —
 * то есть эти события до настоящего обработчика уже не доедут.
 */
@Controller('callbacks')
export class ChangellyCallbackController {
  /** Дальше этого размера файл не растёт: эндпоинт открыт наружу без аутентификации. */
  private static readonly MAX_LOG_BYTES = 2 * 1024 * 1024;

  private logPath() {
    return path.join(process.cwd(), 'logs', 'changelly-callbacks.log');
  }

  /** Живость маршрута: проверить снаружи, что запрос доходит до приложения, а не до статики. */
  @Get('changelly')
  alive(@Res() res: Response) {
    return res.status(200).json({ stub: 'changelly-callback', ok: true });
  }

  @Post('changelly')
  capture(@Req() req: Request, @Res() res: Response) {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const text = raw.toString('utf8');

    const entry = {
      at: new Date().toISOString(),
      ip: req.headers['x-real-ip'] || req.ip,
      query: req.query,
      headers: req.headers,
      bodyLength: raw.length,
      body: text,
      // base64 нужен, только если тело не пережило round-trip через utf8
      // (бинарь или битая кодировка) — тогда `body` выше читать нельзя.
      bodyBase64: Buffer.from(text, 'utf8').equals(raw) ? undefined : raw.toString('base64'),
    };

    console.log('[changelly-callback]', JSON.stringify(entry));
    this.persist(entry);

    return res.status(200).json({ ok: true });
  }

  private persist(entry: unknown) {
    try {
      const file = this.logPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size >= ChangellyCallbackController.MAX_LOG_BYTES) {
        console.warn('[changelly-callback] log file is full, entry only in pm2 log');
        return;
      }
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (e: any) {
      // Заглушка не имеет права упасть из-за диска: тело уже ушло в pm2-лог.
      console.error('[changelly-callback] persist failed:', e?.message);
    }
  }
}
