import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { TalerIdNotesConnector } from '../talerid/talerid-notes.connector';

/**
 * Заметки пользователя [da5290c7]. Read-only витрина для панели заметок лаунчера — просмотр в
 * лаунчере, создание/правка на десктопе (web). Источник — TalerID (`mcp:notes`) через коннектор;
 * best-effort: не подключён / MCP down → []. Приложение периодически тянет этот эндпоинт и кэширует
 * сырой JSON для custodian-канала (как tripState), лаунчер читает готовое.
 */
@Controller('notes')
export class NotesController {
  constructor(private readonly notes: TalerIdNotesConnector) {}

  @Get()
  @UseGuards(JwtGuard)
  async list(@CurrentUser() user: any) {
    return this.notes.listNotes(String(user.userId));
  }
}
