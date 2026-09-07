import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ProductsController } from './products.controller';
import { RunnerController } from './runner.controller';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RunnerGuard } from './runner.guard';

/**
 * Регрессия по образцу src/common/guards/admin-routes.spec.ts.
 *
 * Клиентские маршруты продуктов отдают чужой код и историю правок; маршруты
 * раннера позволяют завершить ход и списать токены. Незакрытый маршрут здесь
 * стоит дороже, чем в большинстве мест кодовой базы.
 */
const guardsOf = (ctrl: any) => Reflect.getMetadata(GUARDS_METADATA, ctrl) ?? [];

describe('охрана маршрутов products', () => {
  it('клиентские маршруты закрыты JwtGuard', () => {
    expect(guardsOf(ProductsController)).toContain(JwtGuard);
  });

  it('маршруты раннера закрыты RunnerGuard и НЕ пускают по JWT пользователя', () => {
    const guards = guardsOf(RunnerController);
    expect(guards).toContain(RunnerGuard);
    expect(guards).not.toContain(JwtGuard);
  });
});
