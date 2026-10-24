import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ProblemReportService } from './problem-report.service';

/**
 * Сообщения о сбоях ассистентов в «Поддержку linkeon».
 * Зависит только от CommonModule: сюда ходят контроллеры MCP, а не наоборот,
 * поэтому цикла с ChatModule нет.
 */
@Module({
  imports: [CommonModule],
  providers: [ProblemReportService],
  exports: [ProblemReportService],
})
export class ProblemReportModule {}
