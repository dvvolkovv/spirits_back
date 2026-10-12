import { Module } from '@nestjs/common';
import { MiscModule } from '../misc/misc.module';
import { HumanDesignToolService } from './hd-tool.service';

/** Инструмент Райи calculate_human_design (копия модуля калькулятора — в ./lib). */
@Module({
  imports: [MiscModule],
  providers: [HumanDesignToolService],
  exports: [HumanDesignToolService],
})
export class HumanDesignModule {}
