import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/user.decorator';
import { JwtGuard } from '../common/guards/jwt.guard';
import { clientIp } from './client-ip';
import { RoomRateLimit } from './room-rate-limit';
import { RoomService } from './room.service';

@Controller('room')
export class RoomController {
  constructor(
    private readonly rooms: RoomService,
    private readonly limit: RoomRateLimit,
  ) {}

  /**
   * Создание комнаты. v1 админский, как и весь голосовой блок.
   *
   * Проверка серверная: скрытая кнопка на фронте это удобство, а не защита.
   */
  @Post()
  @UseGuards(JwtGuard)
  async create(@CurrentUser() u: any, @Body() body: { title?: string }) {
    return this.rooms.create(u.userId, body?.title);
  }

  /**
   * Справка о комнате — публично: гости не пользователи Linkeon, токена у них
   * нет и взяться ему неоткуда.
   *
   * Ответ на несуществующую и на закрытую комнату ОДИНАКОВЫЙ. Различать их
   * означало бы подсказывать перебирающему, что код угадан верно, а встреча
   * просто закончилась.
   */
  @Get('public/:code')
  async info(@Param('code') code: string, @Req() req: Request) {
    if (!(await this.limit.checkLookup(clientIp(req)))) {
      throw new NotFoundException('room not found');
    }
    const room = await this.rooms.info(code);
    if (!room || !room.active) throw new NotFoundException('room not found');
    return { title: room.title, active: true };
  }

  @Post('public/:code/join')
  async join(
    @Param('code') code: string,
    @Body() body: { name?: string },
    @Req() req: Request,
  ) {
    if (!(await this.limit.checkJoin(clientIp(req)))) {
      throw new NotFoundException('room not found');
    }
    return this.rooms.joinGuest(code, body?.name || '');
  }
}
