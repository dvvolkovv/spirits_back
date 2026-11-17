import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { ProductsMcpController } from './products-mcp.controller';
import { ChatModule } from '../chat/chat.module';
import { ChatUploadsModule } from '../chat/chat-uploads/chat-uploads.module';
import { ProductsModule } from '../products/products.module';
import { ProblemReportModule } from '../problem-report/problem-report.module';

@Module({
  // ChatUploadsModule — ради note_file на точке продуктов: ChatModule
  // импортирует его, но ChatUploadsService наружу не экспортирует. Модуль один
  // на приложение, его миграция (onModuleInit) от второго импорта не
  // запускается повторно.
  imports: [ChatModule, ProductsModule, ProblemReportModule, ChatUploadsModule],
  controllers: [McpController, ProductsMcpController],
})
export class McpModule {}
