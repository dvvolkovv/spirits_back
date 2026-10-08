import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import { ChatFilesService } from './chat-files.service';
import { chatSessionId } from './session-id';

/**
 * Панель «Медиа и файлы» в чате с ассистентом. Переписка — только своя:
 * userId из JWT, а не из запроса.
 */
@Controller('chat/files')
export class ChatFilesController {
  constructor(private readonly files: ChatFilesService) {}

  @Get()
  @UseGuards(JwtGuard)
  async list(
    @CurrentUser() user: any,
    @Query('assistantId') assistantId?: string,
    @Query('freshTs') freshTs?: string,
  ) {
    if (!assistantId) throw new BadRequestException('assistantId обязателен');
    const sessionId = chatSessionId(user.userId, String(assistantId), freshTs);
    return { items: await this.files.listForSession(user.userId, sessionId) };
  }
}
