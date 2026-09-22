import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { MiscModule } from '../misc/misc.module';
import { ProductsController } from './products.controller';
import { RunnerController } from './runner.controller';
import { HostController } from './host.controller';
import { ProductsService } from './products.service';
import { TurnsService } from './turns.service';
import { TurnEventsService } from './turn-events.service';
import { RunnerGuard } from './runner.guard';
import { HostGuard } from './host.guard';
import { SecretsService } from './secrets.service';
import { ProvisioningService } from './provisioning.service';
import { HostsService } from './hosts.service';
import { LimitsService } from './limits.service';
import { RentService } from './rent.service';

@Module({
  imports: [CommonModule, MiscModule],
  // HostController обязан быть ЗДЕСЬ, а не только существовать: маршруты
  // незарегистрированного контроллера отдают 404, а все тесты вида
  // `new HostController(mock)` остаются зелёными. Сторож — products.routes.spec.ts.
  controllers: [ProductsController, RunnerController, HostController],
  providers: [
    ProductsService,
    TurnsService,
    TurnEventsService,
    RunnerGuard,
    HostGuard,
    SecretsService,
    ProvisioningService,
    // Реестр машин. Без него ProvisioningService не инжектируется вовсе, и
    // падение это ГРОМКОЕ — Nest не поднимет модуль. Наружу не экспортируется:
    // вопрос «куда уедет новый продукт» задаёт только заведение, и второго
    // места, где он задаётся, быть не должно.
    HostsService,
    // Предел числа продуктов на аккаунт. Здесь по той же причине, что и
    // реестр машин: без него ProvisioningService не инжектируется вовсе, и
    // падение это ГРОМКОЕ — Nest не поднимет модуль. Наружу не
    // экспортируется: вопрос «можно ли этому аккаунту ещё один» задаёт только
    // заведение, и второго места, где он задаётся, быть не должно.
    LimitsService,
    // Аренда. Своим провайдером, а не дописью в ProvisioningService: тот уже
    // 900 строк и отвечает за заведение, а у аренды другой жизненный цикл.
    // Включён здесь сразу: сервис, которого нет в модуле, не инжектируется
    // никуда — а звать его будут и сборщик, и пополнение баланса.
    RentService,
  ],
  exports: [ProductsService, TurnsService, ProvisioningService, RentService],
})
export class ProductsModule {}
