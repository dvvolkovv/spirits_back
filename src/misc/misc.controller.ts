import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { JwtService } from '../common/services/jwt.service';

@Controller('')
export class MiscController {
  constructor(private readonly jwtSvc: JwtService) {}

  // Auth checked inside — return empty if no valid token (matching n8n behavior)
  @Post('search-mate')
  async searchMate(@Req() req: Request, @Res() res: Response) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const userId = this.extractUser(req);
    if (!userId) return res.status(200).send('');
    return res.status(200).json({ results: [] });
  }

  @Post('analyze-compatibility')
  async analyzeCompatibility(@Req() req: Request, @Res() res: Response) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const userId = this.extractUser(req);
    if (!userId) return res.status(200).send('');
    return res.status(200).json({ score: 0, analysis: '' });
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
