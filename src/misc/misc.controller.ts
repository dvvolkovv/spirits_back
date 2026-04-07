import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { JwtService } from '../common/services/jwt.service';
import { MiscService } from './misc.service';

@Controller('')
export class MiscController {
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
    return res.status(200).json({ url: '' });
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
