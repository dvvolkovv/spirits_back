import { Module, forwardRef } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { TgBotModule } from '../tg-bot/tg-bot.module';
import { BlogSettingsService } from './blog-settings.service';
import { BlogApprovalService } from './blog-approval.service';

/**
 * Минимальная сборка модуля блога: ровно то, что нужно врезке в tg-бота.
 *
 * Бот зависит от BlogApprovalService, значит граф модулей должен сходиться уже
 * сейчас, иначе приложение просто не поднимется («доделаем в следующей
 * задаче» для DI не работает). Кроном, контроллером и остальными сервисами
 * блога модуль дополняется отдельно — здесь их намеренно нет, они ещё не
 * написаны.
 *
 * Кольцо BlogModule ↔ TgBotModule (блогу нужен TgGrammyClient, боту —
 * BlogApprovalService) разорвано forwardRef с обеих сторон.
 *
 * В app.module.ts модуль намеренно не подключён: в граф он попадает через
 * импорт из TgBotModule, а собственных контроллеров и таймеров у него пока
 * нет — подключать отдельно нечего.
 */
@Module({
  imports: [CommonModule, forwardRef(() => TgBotModule)],
  providers: [BlogSettingsService, BlogApprovalService],
  exports: [BlogApprovalService],
})
export class BlogModule {}
