import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminController } from '../../admin/admin.controller';
import { AgentsController } from '../../agents/agents.controller';
import { AdminGuard } from './admin.guard';
import { JwtGuard } from './jwt.guard';

/**
 * Регрессия на реальную дыру (обнаружена 2026-07-28).
 *
 * У всех 13 маршрутов AdminController стоял только JwtGuard — то есть
 * проверялось «залогинен», а роль не проверялась вовсе. Проверено на проде:
 * аккаунт с isadmin=false успешно прочитал GET /webhook/admin/users/tokens
 * и получил телефоны, балансы и историю платежей ВСЕХ пользователей.
 * Отдельно POST /admin/coupons {action:'create'} позволял выпустить купон
 * себе на любую сумму токенов.
 *
 * То же было у POST /agent: пишет в ОБЩУЮ таблицу agents (колонки user_id
 * там нет), а @CurrentUser() принимался и не использовался — любой
 * залогиненный мог перезаписать system_prompt любого ассистента для всех.
 *
 * Тест держит инвариант: эти маршруты закрыты AdminGuard.
 */

/** Guard'ы, действующие на метод: со самого метода + с класса. */
function guardsFor(controller: Function, method: string): unknown[] {
  const own = Reflect.getMetadata(
    GUARDS_METADATA,
    (controller.prototype as Record<string, unknown>)[method] as object,
  );
  const fromClass = Reflect.getMetadata(GUARDS_METADATA, controller);
  return [...(fromClass ?? []), ...(own ?? [])];
}

/** Публичные имена методов контроллера. */
function methodsOf(controller: Function): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter(
    (name) => name !== 'constructor',
  );
}

describe('Защита админских маршрутов', () => {
  describe('AdminController', () => {
    const methods = methodsOf(AdminController);

    it('имеет маршруты (иначе тест ничего не проверяет)', () => {
      expect(methods.length).toBeGreaterThan(0);
    });

    it.each(methods)('%s закрыт AdminGuard', (method) => {
      expect(guardsFor(AdminController, method)).toContain(AdminGuard);
    });

    it.each(methods)('%s требует JwtGuard', (method) => {
      expect(guardsFor(AdminController, method)).toContain(JwtGuard);
    });
  });

  describe('AgentsController', () => {
    // upsertAgent пишет в общую таблицу, getAgentDetails отдаёт system_prompt
    // всех ассистентов. Оба зовутся только из админ-панели веба.
    it.each(['upsertAgent', 'getAgentDetails'])(
      '%s закрыт AdminGuard',
      (method) => {
        expect(guardsFor(AgentsController, method)).toContain(AdminGuard);
      },
    );

    // Публичный список ассистентов и смена своего ассистента админом
    // быть не должны — иначе сломается обычный пользователь.
    it('getAgents остаётся доступен без прав админа', () => {
      expect(guardsFor(AgentsController, 'getAgents')).not.toContain(
        AdminGuard,
      );
    });

    it('changeAgent остаётся доступен обычному пользователю', () => {
      const guards = guardsFor(AgentsController, 'changeAgent');
      expect(guards).toContain(JwtGuard);
      expect(guards).not.toContain(AdminGuard);
    });
  });
});
