import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { TalerIdNotesConnector } from '../talerid/talerid-notes.connector';
import { VoiceImproveService } from '../voice/voice-improve.service';

/**
 * Заметки пользователя [da5290c7]. Read-only витрина для панели заметок лаунчера — просмотр в
 * лаунчере, создание/правка на десктопе (web). Источник — TalerID (`mcp:notes`) через коннектор;
 * best-effort: не подключён / MCP down → []. Приложение периодически тянет этот эндпоинт и кэширует
 * сырой JSON для custodian-канала (как tripState), лаунчер читает готовое.
 */
@Controller('notes')
export class NotesController {
  constructor(
    private readonly notes: TalerIdNotesConnector,
    private readonly improveService: VoiceImproveService,
  ) {}

  @Get()
  @UseGuards(JwtGuard)
  async list(@CurrentUser() user: any) {
    return this.notes.listNotes(String(user.userId));
  }

  /**
   * Создать заметку [голосовая диктовка из панели заметок лаунчера, 2026-08-22]. Клиент шлёт {text}
   * (надиктованный текст); заголовок берём из первой строки (или явный title). Приложение-хранителя
   * POST-ит это, лаунчер токена не имеет. Ответ {ok,id,title,error} — панель показывает подтверждение.
   */
  @Post()
  @UseGuards(JwtGuard)
  async create(@CurrentUser() user: any, @Body() body: { text?: string; title?: string; content?: string }) {
    const content = String(body?.content ?? body?.text ?? '').trim();
    if (!content) return { ok: false, error: 'Пустая заметка' };
    const explicit = String(body?.title ?? '').trim();
    const title = explicit || NotesController.deriveTitle(content);
    return this.notes.createNote(String(user.userId), title, content);
  }

  /**
   * «Улучшить» существующую заметку [2026-08-23]: причесать её текст (пунктуация/падежи) внешним ИИ
   * и СОХРАНИТЬ обратно (update_note). Вызывается ТОЛЬКО по явному согласию пользователя (кнопка ✨ +
   * предупреждение — на клиенте). Fail-safe: при сбое улучшения/обновления возвращаем исходный текст.
   */
  @Post('improve')
  @UseGuards(JwtGuard)
  async improve(@CurrentUser() user: any, @Body() body: { id?: string; content?: string }) {
    const id = String(body?.id || '').trim();
    const content = String(body?.content || '').trim();
    if (!id || !content) return { ok: false, error: 'Нет заметки для улучшения' };
    const improved = await this.improveService.improve(content);
    if (improved === content) return { ok: true, id, title: NotesController.deriveTitle(content), content }; // без изменений
    const title = NotesController.deriveTitle(improved);
    const r = await this.notes.updateNote(String(user.userId), id, title, improved);
    if (!r.ok) return { ok: false, error: r.error || 'Не удалось сохранить улучшение', content };
    return { ok: true, id, title, content: improved };
  }

  /** Заголовок из текста: первая строка, до ~50 символов (по границе слова). */
  private static deriveTitle(content: string): string {
    const firstLine = content.split(/\r?\n/)[0].trim();
    if (firstLine.length <= 50) return firstLine;
    const cut = firstLine.slice(0, 50);
    const sp = cut.lastIndexOf(' ');
    return (sp > 20 ? cut.slice(0, sp) : cut).trim() + '…';
  }
}
