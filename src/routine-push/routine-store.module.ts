import { Global, Module } from '@nestjs/common';
import { RoutineStore } from './routine-store.service';

// @Global — RoutineStore нужен и RoutinePushService, и ChatToolsService
// (MCP-инструмент), в разных модулях; глобальность снимает цикл импортов.
@Global()
@Module({
  providers: [RoutineStore],
  exports: [RoutineStore],
})
export class RoutineStoreModule {}
