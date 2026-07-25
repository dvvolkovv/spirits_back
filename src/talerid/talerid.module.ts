import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { TalerIdStoreService } from './talerid-store.service';
import { TalerIdOauthClient } from './talerid-oauth.client';
import { TalerIdOauthService } from './talerid-oauth.service';
import { TalerIdCalendarConnector } from './talerid-calendar.connector';
import { TalerIdController } from './talerid.controller';

/**
 * TalerID reference connector (see docs/superpowers/plans/2026-07-25-talerid-connector-linkeon.md).
 * Task 1 ships the connection store, Task 2 the HTTP client, Task 3 the token
 * service (rotation-safe refresh) gluing them together, Task 4 the MCP calendar
 * connector (list/create events over TalerID's stateless Streamable HTTP MCP).
 * Task 5 adds the co-pilot aggregation/write-routing (in CalendarModule/
 * CalendarService, which imports this module) and the connect/status/disconnect
 * controller below.
 */
@Module({
  imports: [CommonModule],
  controllers: [TalerIdController],
  providers: [TalerIdStoreService, TalerIdOauthClient, TalerIdOauthService, TalerIdCalendarConnector],
  exports: [TalerIdStoreService, TalerIdOauthService, TalerIdCalendarConnector],
})
export class TalerIdModule {}
