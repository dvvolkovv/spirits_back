import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { TalerIdStoreService } from './talerid-store.service';
import { TalerIdOauthClient } from './talerid-oauth.client';
import { TalerIdOauthService } from './talerid-oauth.service';

/**
 * TalerID reference connector (see docs/superpowers/plans/2026-07-25-talerid-connector-linkeon.md).
 * Task 1 ships the connection store, Task 2 the HTTP client, Task 3 the token
 * service (rotation-safe refresh) gluing them together. Later tasks extend
 * this module with the MCP calendar connector and the connect/status/disconnect
 * controller.
 */
@Module({
  imports: [CommonModule],
  providers: [TalerIdStoreService, TalerIdOauthClient, TalerIdOauthService],
  exports: [TalerIdStoreService, TalerIdOauthService],
})
export class TalerIdModule {}
