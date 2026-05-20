// src/smm/branding/branding.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as multer from 'multer';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { PgService } from '../../common/services/pg.service';
import { CreatorCampaignService } from '../producer/creator-campaign.service';

@Controller('smm/campaigns')
@UseGuards(JwtGuard)
export class BrandingController {
  private upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  });

  constructor(
    private readonly pg: PgService,
    private readonly creators: CreatorCampaignService,
  ) {}

  /**
   * Owner-or-admin check for a campaign. Throws 404 if missing, 403 if not yours.
   */
  private async assertCanAccessCampaign(campaignId: string, req: any): Promise<void> {
    const r = await this.pg.query(
      `SELECT user_id FROM smm_campaign WHERE id = $1`,
      [campaignId],
    );
    if (r.rows.length === 0) throw new NotFoundException(`campaign ${campaignId} not found`);
    if (req.user?.isAdmin) return;
    if (r.rows[0].user_id !== req.user?.phone) {
      throw new ForbiddenException('not your campaign');
    }
  }

  /**
   * Upload creator logo. multipart/form-data with field `file`.
   * Saves to public/smm-logos/<campaignId>.<ext> served via nginx /static/.
   * Updates smm_creator_campaign.logo_url to the absolute URL.
   */
  @Post(':id/logo')
  async uploadLogo(@Req() req: Request, @Res() res: Response, @Param('id') id: string) {
    await this.assertCanAccessCampaign(id, req);
    return new Promise<void>((resolve, reject) => {
      this.upload.single('file')(req as any, res as any, async (err: any) => {
        if (err) {
          res.status(400).json({ error: err.message ?? 'upload failed' });
          return resolve();
        }
        const file = (req as any).file;
        if (!file) {
          res.status(400).json({ error: 'no file' });
          return resolve();
        }
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
          res.status(400).json({ error: 'expected png/jpeg/webp' });
          return resolve();
        }
        try {
          const ext = file.mimetype === 'image/png' ? 'png'
            : file.mimetype === 'image/webp' ? 'webp'
            : 'jpg';
          const dir = path.join(process.cwd(), 'public', 'smm-logos');
          await fs.promises.mkdir(dir, { recursive: true });
          const filename = `${id}.${ext}`;
          const target = path.join(dir, filename);
          await fs.promises.writeFile(target, file.buffer);
          // Absolute URL so the worker can fetch the image during render.
          const base = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
          const url = `${base}/static/smm-logos/${filename}?t=${Date.now()}`;
          const updated = await this.creators.updateBranding(id, { logoUrl: url });
          res.status(200).json({ ok: true, logoUrl: url, settings: updated });
          resolve();
        } catch (e: any) {
          res.status(500).json({ error: e.message });
          resolve();
        }
      });
    });
  }

  /**
   * Update text-only branding fields (slogan, default publish caption, bg color).
   * Passing `null` clears the field; omitting it leaves it unchanged.
   */
  @Patch(':id/branding')
  async updateBranding(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: {
      ctaHandle?: string;
      ctaLabel?: string;
      ctaSlogan?: string | null;
      publishCaption?: string | null;
      bgColor?: string | null;
    },
  ) {
    await this.assertCanAccessCampaign(id, req);
    if (typeof body.ctaHandle === 'string') {
      if (!body.ctaHandle.trim()) throw new BadRequestException('ctaHandle cannot be empty');
      if (body.ctaHandle.length > 120) throw new BadRequestException('ctaHandle max 120 chars');
    }
    if (typeof body.ctaLabel === 'string') {
      if (!body.ctaLabel.trim()) throw new BadRequestException('ctaLabel cannot be empty');
      if (body.ctaLabel.length > 60) throw new BadRequestException('ctaLabel max 60 chars');
    }
    if (typeof body.ctaSlogan === 'string' && body.ctaSlogan.length > 120) {
      throw new BadRequestException('ctaSlogan max 120 chars');
    }
    if (typeof body.publishCaption === 'string' && body.publishCaption.length > 2000) {
      throw new BadRequestException('publishCaption max 2000 chars');
    }
    if (typeof body.bgColor === 'string') {
      if (body.bgColor.length > 200 || /["<>]|javascript:/i.test(body.bgColor)) {
        throw new BadRequestException('bgColor: max 200 chars, no quotes/script tokens');
      }
    }
    const updated = await this.creators.updateBranding(id, {
      ctaHandle: body.ctaHandle === undefined ? undefined : body.ctaHandle.trim(),
      ctaLabel: body.ctaLabel === undefined ? undefined : body.ctaLabel.trim(),
      ctaSlogan: body.ctaSlogan === undefined ? undefined : (body.ctaSlogan || null),
      publishCaption: body.publishCaption === undefined ? undefined : (body.publishCaption || null),
      bgColor: body.bgColor === undefined ? undefined : (body.bgColor || null),
    });
    return { ok: true, settings: updated };
  }

  /**
   * Clear the uploaded logo (revert to Linkeon-only branding).
   */
  @Post(':id/logo/clear')
  async clearLogo(@Req() req: any, @Param('id') id: string) {
    await this.assertCanAccessCampaign(id, req);
    const updated = await this.creators.updateBranding(id, { logoUrl: null });
    return { ok: true, settings: updated };
  }

  /**
   * Upload custom background image. Replaces bg_image_url; bg_color is left as-is
   * (renderer prefers image if both set, so уже хранимый цвет — это fallback).
   */
  @Post(':id/background')
  async uploadBackground(@Req() req: Request, @Res() res: Response, @Param('id') id: string) {
    await this.assertCanAccessCampaign(id, req);
    return new Promise<void>((resolve) => {
      this.upload.single('file')(req as any, res as any, async (err: any) => {
        if (err) {
          res.status(400).json({ error: err.message ?? 'upload failed' });
          return resolve();
        }
        const file = (req as any).file;
        if (!file) {
          res.status(400).json({ error: 'no file' });
          return resolve();
        }
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
          res.status(400).json({ error: 'expected png/jpeg/webp' });
          return resolve();
        }
        try {
          const ext = file.mimetype === 'image/png' ? 'png'
            : file.mimetype === 'image/webp' ? 'webp'
            : 'jpg';
          const dir = path.join(process.cwd(), 'public', 'smm-backgrounds');
          await fs.promises.mkdir(dir, { recursive: true });
          const filename = `${id}.${ext}`;
          const target = path.join(dir, filename);
          await fs.promises.writeFile(target, file.buffer);
          const base = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
          const url = `${base}/static/smm-backgrounds/${filename}?t=${Date.now()}`;
          const updated = await this.creators.updateBranding(id, { bgImageUrl: url });
          res.status(200).json({ ok: true, bgImageUrl: url, settings: updated });
          resolve();
        } catch (e: any) {
          res.status(500).json({ error: e.message });
          resolve();
        }
      });
    });
  }

  @Post(':id/background/clear')
  async clearBackground(@Req() req: any, @Param('id') id: string) {
    await this.assertCanAccessCampaign(id, req);
    const updated = await this.creators.updateBranding(id, { bgImageUrl: null });
    return { ok: true, settings: updated };
  }
}
