import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ProblemReportService } from './problem-report.service';

/**
 * Сообщения о сбоях ассистентов в «Поддержку linkeon».
 * Зависит только от CommonModule: сюда ходят контроллеры MCP, а не наоборот,
 * поэтому цикла с ChatModule нет.
 *
 * Сервис хранит состояние в памяти (склейка, лимиты): подключать только
 * импортом этого модуля и не объявлять в providers других модулей — иначе
 * экземпляров станет несколько, и лимиты разделятся.
 */
@Module({
  imports: [CommonModule],
  providers: [ProblemReportService],
  exports: [ProblemReportService],
})
export class ProblemReportModule {}
