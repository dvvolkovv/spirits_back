import { Controller, Get, Post, Put, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AvatarService } from './avatar.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import * as multer from 'multer';
import axios from 'axios';
import { fetchMediaBytes, ownStaticPath, OwnStaticFile } from '../common/net/own-media';
import { isUnsafeUrlError } from '../common/net/safe-fetch';

/**
 * Кеш аватарок ассистентов в памяти процесса.
 *
 * До него getAgentAvatar ходил в MinIO по HTTP на КАЖДЫЙ запрос. Замер
 * 09.09.2026: на проде одна картинка 0.8–3.1с, двенадцать параллельно — 10с; на
 * test.linkeon.io те же двенадцать — 34с, из-за чего браузерный слой smoke не
 * укладывался в navigationTimeout и трижды подряд объявил здоровый фронт
 * регрессией.
 *
 * Набор ограничен и почти не меняется: ~20 ассистентов по 30–120 КБ, полтора
 * мегабайта на всех. TTL час — аватарку меняют раз в месяцы, а лишний час
 * старой картинки безопаснее, чем поход в MinIO на каждый показ списка.
 *
 * Кешируются ТОЛЬКО успешные ответы: провал MinIO должен пробоваться заново,
 * иначе одна сетевая икота выключила бы аватарки на весь TTL.
 */
const AGENT_AVATAR_TTL_MS = 60 * 60 * 1000;
const AGENT_AVATAR_MAX_ENTRIES = 100;
const agentAvatarCache = new Map<string, { buf: Buffer; contentType: string; ts: number }>();

/** Потолок проксируемого аватара: загрузка режется на 5 МБ, берём с запасом. */
const AVATAR_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Id ассистента для пути в MinIO. Express раскодирует %2F в параметре, и без
 * проверки `..%2F..%2Fwebhook%2F…` превращал фиксированный путь аватарки в
 * запрос сервера к произвольному адресу своего же домена.
 */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** Только для тестов: сбросить кеш между кейсами. */
export function __resetAgentAvatarCache(): void {
  agentAvatarCache.clear();
}

@Controller('')
export class AvatarController {
  private upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

  constructor(private readonly avatarService: AvatarService) {}

  /**
   * Аватар текущего пользователя.
   *
   * `profile_data.avatar_url` пишет сам пользователь: POST /profile-update
   * вливает в profile_data любые ключи. Поэтому ссылка здесь недоверенная:
   *   • `/static/…` раньше склеивался в путь без проверки, и
   *     `/static/../../../etc/passwd` отдавал любой файл сервера;
   *   • внешний адрес проксировался как есть — `http://127.0.0.1:9000/…`
   *     возвращал человеку ответ внутреннего сервиса.
   * Теперь свой /static/ читается только внутри public/, а чужое — через
   * защиту от SSRF, и отдаём только то, что сервер назвал картинкой.
   */
  @Get('avatar')
  @UseGuards(JwtGuard)
  async getAvatar(@CurrentUser() user: any, @Res() res: Response) {
    const avatar = await this.avatarService.getAvatar(user.userId);
    if (!avatar) return res.status(204).end();

    // Локальный файл отдаём как файл, но только изнутри public/.
    if (avatar.url.startsWith('/static/')) {
      let own: OwnStaticFile | null = null;
      try {
        own = ownStaticPath(avatar.url);
      } catch {
        own = null;
      }
      if (!own) return res.status(204).end();
      return res.sendFile(own.file);
    }

    // Внешний адрес — проксируем байты (не redirect): см. коммент в getAgentAvatar
    // (кросс-ориджин + Authorization = префлайт, redirect за ним не следуется).
    try {
      const img = await fetchMediaBytes(avatar.url, { maxBytes: AVATAR_MAX_BYTES, timeoutMs: 15000, allowHttp: true });
      // Тип не сообщили — как и раньше, считаем JPEG (с nosniff браузер его не
      // перетолкует). Не картинка — не аватар: иначе ручка отдавала бы с
      // нашего origin любой документ. SVG — тоже нет: это документ со
      // скриптами, и nosniff его не обезвреживает.
      const contentType = (img.contentType.split(';')[0].trim() || 'image/jpeg').toLowerCase();
      if (!contentType.startsWith('image/') || contentType.includes('svg')) return res.status(204).end();
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.send(img.data);
    } catch (e) {
      // Ссылку во внутреннюю сеть не качаем и браузер туда не отправляем.
      if (isUnsafeUrlError(e)) return res.status(204).end();
      return res.redirect(avatar.url);
    }
  }

  @Post('avatar')
  @UseGuards(JwtGuard)
  async uploadAvatar(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response) {
    const contentType = req.headers['content-type'] || '';

    // If raw binary (not multipart) — body is already Buffer from body-parser raw
    if (contentType.startsWith('image/') && Buffer.isBuffer(req.body) && req.body.length > 0) {
      try {
        const result = await this.avatarService.uploadAvatar(user.userId, req.body, contentType);
        return res.status(200).json(result);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // Otherwise use multer for multipart/form-data
    return new Promise((resolve) => {
      this.upload.single('file')(req as any, res as any, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        const file = (req as any).file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });
        try {
          const result = await this.avatarService.uploadAvatar(user.userId, file.buffer, file.mimetype);
          resolve(res.status(200).json(result));
        } catch (e) {
          resolve(res.status(500).json({ error: e.message }));
        }
      });
    });
  }

  @Put('avatar')
  @UseGuards(JwtGuard)
  async uploadAvatarPut(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response) {
    return this.uploadAvatar(user, req, res);
  }

  @Get('0cdacf32-7bfd-4888-b24f-3a6af3b5f99e/agent/avatar/:agentId')
  async getAgentAvatar(@Param('agentId') agentId: string, @Res() res: Response) {
    if (!AGENT_ID_RE.test(String(agentId ?? ''))) return res.status(404).json({ error: 'No avatar' });
    // Кеш проверяем до похода в сервис: он лезет в БД за URL, а нам и это лишнее.
    const cached = agentAvatarCache.get(agentId);
    if (cached && Date.now() - cached.ts < AGENT_AVATAR_TTL_MS) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(cached.buf);
    }
    if (cached) agentAvatarCache.delete(agentId); // протух

    const url = await this.avatarService.getAgentAvatar(agentId);
    if (!url) return res.status(404).json({ error: 'No avatar' });
    // Проксируем байты изображения вместо 302-редиректа: кросс-ориджин клиенты
    // (натив-приложение, WebView) шлют Authorization → запрос префлайтится, а
    // браузер НЕ следует за redirect на префлайтнутом запросе → CORS-ошибка →
    // аватарки не грузятся. Прямая отдача байтов убирает redirect (инцидент
    // 2026-07-13). Веб (same-origin) не затронут. Клиент кэширует в IndexedDB.
    try {
      const img = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
      // Типы axios допускают boolean среди значений заголовка, а setHeader его
      // не принимает — сужаем явно, иначе сборка не проходит.
      const contentType = img.headers['content-type'];
      const resolvedType = typeof contentType === 'string' ? contentType : 'image/jpeg';
      const buf = Buffer.from(img.data);

      // Потолок держим простым FIFO: набор фиксирован (~20 ассистентов), до
      // вытеснения дело в проде не доходит — это страховка от роста, а не
      // алгоритм. Первый ключ Map — самый давно вставленный.
      if (agentAvatarCache.size >= AGENT_AVATAR_MAX_ENTRIES) {
        const oldest = agentAvatarCache.keys().next().value;
        if (oldest !== undefined) agentAvatarCache.delete(oldest);
      }
      agentAvatarCache.set(agentId, { buf, contentType: resolvedType, ts: Date.now() });

      res.setHeader('Content-Type', resolvedType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    } catch {
      return res.redirect(url); // fallback — если апстрим недоступен
    }
  }
}
