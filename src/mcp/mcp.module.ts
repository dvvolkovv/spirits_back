import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { ProductsMcpController } from './products-mcp.controller';
import { ChatModule } from '../chat/chat.module';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [ChatModule, ProductsModule],
  controllers: [McpController, ProductsMcpController],
})
export class McpModule {}
