import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { TalerIdStoreService } from './talerid-store.service';

/**
 * TalerID reference connector (see docs/superpowers/plans/2026-07-25-talerid-connector-linkeon.md).
 * Task 1 ships the connection store only; later tasks extend this module with the
 * OAuth client/service, the MCP calendar connector, and the connect/status/disconnect
 * controller.
 */
@Module({
  imports: [CommonModule],
  providers: [TalerIdStoreService],
  exports: [TalerIdStoreService],
})
export class TalerIdModule {}
