import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { TripService } from './trip.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('trip')
export class TripController {
  constructor(private readonly trip: TripService) {}

  @Get('state')
  @UseGuards(JwtGuard)
  async state(@CurrentUser() user: any) {
    return this.trip.getState(String(user.userId));
  }

  @Post('action')
  @UseGuards(JwtGuard)
  async action(@CurrentUser() user: any, @Body() body: any) {
    const { idemKey, kind, payload } = body || {};
    return this.trip.applyAction(String(user.userId), String(idemKey), String(kind), payload);
  }
}
