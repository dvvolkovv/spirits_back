import { Controller, Get, Post, Param, Body, UseGuards, Res, BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { ContactsService, ContactVisibility } from './contacts.service';

// Глобальный префикс `/webhook` задан в main.ts.
@Controller('')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get('user-public/:userId')
  @UseGuards(JwtGuard)
  async publicProfile(@CurrentUser() user: any, @Param('userId') userIdRaw: string, @Res() res: Response) {
    const userId = Number(userIdRaw);
    if (!userId || Number.isNaN(userId)) throw new BadRequestException('invalid userId');
    const p = await this.contacts.getPublicProfile(user.userId, userId);
    if (!p) return res.status(404).json({ error: 'not_found' });
    return res.status(200).json(p);
  }

  /** Lookup by phone — для чат-интеграций, где peerUserId хранится как phone-строка. */
  @Get('user-public-by-phone/:phone')
  @UseGuards(JwtGuard)
  async publicProfileByPhone(@CurrentUser() user: any, @Param('phone') phone: string, @Res() res: Response) {
    const userId = await this.contacts.idByPhone(phone);
    if (!userId) return res.status(404).json({ error: 'not_found' });
    const p = await this.contacts.getPublicProfile(user.userId, userId);
    if (!p) return res.status(404).json({ error: 'not_found' });
    return res.status(200).json(p);
  }

  @Post('contact-request')
  @UseGuards(JwtGuard)
  async createRequest(
    @CurrentUser() user: any,
    @Body() body: { userId: number; message?: string },
    @Res() res: Response,
  ) {
    if (!body?.userId) throw new BadRequestException('userId required');
    try {
      const r = await this.contacts.createRequest(user.userId, Number(body.userId), body.message?.slice(0, 500) ?? null);
      return res.status(200).json(r);
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  }

  @Get('contact-requests')
  @UseGuards(JwtGuard)
  async incoming(@CurrentUser() user: any, @Res() res: Response) {
    const rows = await this.contacts.listIncoming(user.userId);
    return res.status(200).json(rows);
  }

  @Get('contact-requests/sent')
  @UseGuards(JwtGuard)
  async outgoing(@CurrentUser() user: any, @Res() res: Response) {
    const rows = await this.contacts.listOutgoing(user.userId);
    return res.status(200).json(rows);
  }

  @Post('contact-request/:id/:decision')
  @UseGuards(JwtGuard)
  async resolve(
    @CurrentUser() user: any,
    @Param('id') idRaw: string,
    @Param('decision') decision: string,
    @Res() res: Response,
  ) {
    const id = Number(idRaw);
    if (!id || Number.isNaN(id)) throw new BadRequestException('invalid id');
    if (decision !== 'approve' && decision !== 'reject') throw new BadRequestException('decision must be approve|reject');
    const r = await this.contacts.resolve(
      user.userId,
      id,
      decision === 'approve' ? 'approved' : 'rejected',
    );
    if (!r) return res.status(404).json({ error: 'not_found_or_not_pending' });
    return res.status(200).json(r);
  }

  @Get('contact-visibility')
  @UseGuards(JwtGuard)
  async getVisibility(@CurrentUser() user: any, @Res() res: Response) {
    const visibility = await this.contacts.contactVisibility(user.userId);
    return res.status(200).json({ visibility });
  }

  @Post('contact-visibility')
  @UseGuards(JwtGuard)
  async updateVisibility(
    @CurrentUser() user: any,
    @Body() body: { visibility: ContactVisibility },
    @Res() res: Response,
  ) {
    if (!['public', 'matchOnly', 'private'].includes(body?.visibility)) {
      throw new BadRequestException('visibility must be public|matchOnly|private');
    }
    await this.contacts.setContactVisibility(user.userId, body.visibility);
    return res.status(200).json({ success: true, visibility: body.visibility });
  }
}
