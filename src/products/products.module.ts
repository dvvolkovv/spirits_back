import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { MiscModule } from '../misc/misc.module';
import { ProductsController } from './products.controller';
import { RunnerController } from './runner.controller';
import { ProductsService } from './products.service';
import { TurnsService } from './turns.service';
import { TurnEventsService } from './turn-events.service';
import { RunnerGuard } from './runner.guard';

@Module({
  imports: [CommonModule, MiscModule],
  controllers: [ProductsController, RunnerController],
  providers: [ProductsService, TurnsService, TurnEventsService, RunnerGuard],
  exports: [ProductsService, TurnsService],
})
export class ProductsModule {}
