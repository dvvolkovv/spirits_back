import { Controller, Post, Get, Delete, Req, Res, UseGuards, Query } from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { JwtService } from '../common/services/jwt.service';
import { MiscService } from './misc.service';
import * as multer from 'multer';

@Controller('')
export class MiscController {
  private upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  constructor(
    private readonly jwtSvc: JwtService,
    private readonly miscService: MiscService,
  ) {}

  @Post('search-mate')
  async searchMate(@Req() req: Request, @Res() res: Response) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const userId = this.extractUser(req);
    if (!userId) return res.status(200).send('');
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Missing query' });
    await this.miscService.searchMate(userId, query, res);
  }

  @Post('analyze-compatibility')
  async analyzeCompatibility(@Req() req: Request, @Res() res: Response) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const userId = this.extractUser(req);
    if (!userId) return res.status(200).send('');
    const { users, phones } = req.body || {};
    const targets = users || phones || [];
    if (!targets.length) return res.status(400).json({ error: 'Missing users' });
    await this.miscService.analyzeCompatibility(userId, targets, res);
  }

  @Post('imagegen')
  @UseGuards(JwtGuard)
  async imageGen(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response) {
    if (!process.env.GOOGLE_AI_API_KEY) {
      return res.status(501).json({
        error: 'imagegen not configured on this server',
        capability: 'imagegen',
        configured: false,
      });
    }
    try {
      const { prompt, quality, aspect_ratio } = req.body;
      if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

      const tokenCost = quality === 'hd' ? 10000 : 5000;
      // Check balance
      const balRes = await this.miscService.checkTokenBalance(user.phone, tokenCost);
      if (!balRes.ok) return res.status(400).json({ error: 'Недостаточно токенов' });

      const result = await this.miscService.generateImage(user.phone, { prompt, quality, aspect_ratio });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Image generation failed' });
    }
  }

  @Post('imageedit')
  @UseGuards(JwtGuard)
  async imageEdit(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response) {
    try {
      const { prompt, sourceImageUrl, quality } = req.body;
      if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
      if (!sourceImageUrl) return res.status(400).json({ error: 'Missing sourceImageUrl' });

      const tokenCost = quality === 'hd' ? 10000 : 5000;
      const balRes = await this.miscService.checkTokenBalance(user.phone, tokenCost);
      if (!balRes.ok) return res.status(400).json({ error: 'Недостаточно токенов' });

      const result = await this.miscService.editImage(user.phone, { prompt, sourceImageUrl, quality });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Image edit failed' });
    }
  }

  @Post('imageupload')
  @UseGuards(JwtGuard)
  async imageUpload(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response) {
    const contentType = req.headers['content-type'] || '';

    const save = async (buffer: Buffer, mimetype: string) => {
      if (!/^image\/(png|jpe?g|webp)$/i.test(mimetype)) {
        return res.status(400).json({ error: 'Поддерживаются только PNG / JPEG / WEBP' });
      }
      try {
        const url = await this.miscService.saveUploadedImage(user.phone, buffer, mimetype);
        return res.status(200).json({ url, tokensSpent: 0 });
      } catch (e: any) {
        return res.status(500).json({ error: e.message || 'upload failed' });
      }
    };

    // Raw binary
    if (contentType.startsWith('image/') && Buffer.isBuffer(req.body) && req.body.length > 0) {
      return save(req.body, contentType);
    }

    // multipart/form-data
    return new Promise((resolve) => {
      this.upload.single('file')(req as any, res as any, async (err) => {
        if (err) return resolve(res.status(400).json({ error: err.message }));
        const file = (req as any).file;
        if (!file) return resolve(res.status(400).json({ error: 'No file uploaded' }));
        resolve(await save(file.buffer, file.mimetype));
      });
    });
  }

  @Post('imageupscale')
  @UseGuards(JwtGuard)
  async imageUpscale(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response) {
    try {
      const { sourceImageUrl } = req.body;
      if (!sourceImageUrl) return res.status(400).json({ error: 'Missing sourceImageUrl' });

      const balRes = await this.miscService.checkTokenBalance(user.phone, 10000);
      if (!balRes.ok) return res.status(400).json({ error: 'Недостаточно токенов' });

      const result = await this.miscService.upscaleImage(user.phone, { sourceImageUrl });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Image upscale failed' });
    }
  }

  @Post('imagecompose')
  @UseGuards(JwtGuard)
  async imageCompose(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response) {
    try {
      const { prompt, sourceImageUrls, quality } = req.body;
      if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
      if (!Array.isArray(sourceImageUrls) || sourceImageUrls.length < 2) {
        return res.status(400).json({ error: 'sourceImageUrls must be an array of at least 2 URLs' });
      }

      const tokenCost = quality === 'hd' ? 10000 : 5000;
      const balRes = await this.miscService.checkTokenBalance(user.phone, tokenCost);
      if (!balRes.ok) return res.status(400).json({ error: 'Недостаточно токенов' });

      const result = await this.miscService.composeImage(user.phone, { prompt, sourceImageUrls, quality });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Image compose failed' });
    }
  }

  @Get('imagegen/history')
  @UseGuards(JwtGuard)
  async imageHistory(@CurrentUser() user: any, @Res() res: Response) {
    const images = await this.miscService.getImageHistory(user.phone);
    return res.status(200).json(images);
  }

  @Delete('imagegen/history')
  @UseGuards(JwtGuard)
  async deleteImage(@CurrentUser() user: any, @Query('id') id: string, @Res() res: Response) {
    await this.miscService.deleteGeneratedImage(user.phone, parseInt(id));
    return res.status(200).json({ success: true });
  }

  private extractUser(req: Request): string | null {
    const auth = req.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) return null;
    try {
      const payload = this.jwtSvc.verify(auth.substring(7));
      return payload.type === 'access' ? payload.phone : null;
    } catch {
      return null;
    }
  }
}
