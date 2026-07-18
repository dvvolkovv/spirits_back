import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { TripService } from './trip.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { TripPlan } from './trip.types';

@Controller('webhook/trip')
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

  @Get('plan')
  @UseGuards(JwtGuard)
  async getPlan(@CurrentUser() user: any) {
    return this.trip.getPlan(String(user.userId));
  }

  @Post('plan')
  @UseGuards(JwtGuard)
  async upsertPlan(@CurrentUser() user: any, @Body() body: TripPlan) {
    return this.trip.upsertPlan(String(user.userId), body);
  }
}
