import { Controller, Get, Post, Delete, Body, Query, Req, Res, UseGuards, Optional } from '@nestjs/common';
import { Request, Response } from 'express';
import { ProfileService } from './profile.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { Neo4jService } from '../neo4j/neo4j.service';

@Controller('')
export class ProfileController {
  constructor(
    private readonly profileService: ProfileService,
    @Optional() private readonly neo4j: Neo4jService,
  ) {}

  @Get('profile')
  @UseGuards(JwtGuard)
  async getProfile(@CurrentUser() user: any, @Res() res: Response) {
    const profile = await this.profileService.getProfile(user.phone);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    // Enrich with Neo4j data
    if (this.neo4j && profile[0]?.profileJson) {
      try {
        const neo4jData = await this.neo4j.getProfileEntities(user.phone);
        if (neo4jData) {
          Object.assign(profile[0].profileJson, neo4jData);
        }
      } catch {}
    }

    return res.status(200).json(profile);
  }

  @Post('profile-update')
  @UseGuards(JwtGuard)
  async updateProfile(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const result = await this.profileService.updateProfile(user.phone, body);
    return res.status(200).json(result);
  }

  @Delete('profile')
  @UseGuards(JwtGuard)
  async deleteProfile(@CurrentUser() user: any, @Res() res: Response) {
    const result = await this.profileService.deleteProfile(user.phone);
    return res.status(200).json(result);
  }

  @Get('user-profile')
  @UseGuards(JwtGuard)
  async getUserProfile(@Query('userId') userId: string, @Res() res: Response) {
    const profile = await this.profileService.getUserProfile(userId);
    if (!profile) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json(profile);
  }

  @Post('set-email')
  @UseGuards(JwtGuard)
  async setEmail(@CurrentUser() user: any, @Body() body: { email: string }, @Res() res: Response) {
    const result = await this.profileService.setEmail(user.phone, body.email);
    return res.status(200).json(result);
  }
}
