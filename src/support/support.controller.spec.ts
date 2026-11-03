import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtGuard } from '../common/guards/jwt.guard';
import { SupportController } from './support.controller';

function makeController() {
  const support = {
    adminListTickets: jest.fn(async () => []),
    adminOperators: jest.fn(async () => [{ id: 'admin-1', name: 'Admin One' }]),
    assign: jest.fn(async () => ({ id: 'ticket-1', assigned_to: 'admin-1' })),
  };
  const controller = new SupportController(support as any);
  return { controller, support };
}

describe('SupportController admin SLA queue', () => {
  it('forwards sla and the current actor when listing tickets', async () => {
    const { controller, support } = makeController();

    await (controller.adminList as any)({ userId: 'owner-1' }, 'all', '25', 'mine');

    expect(support.adminListTickets).toHaveBeenCalledWith({
      status: 'all', limit: 25, sla: 'mine', actorId: 'owner-1',
    });
  });

  it('returns operators from the service', async () => {
    const { controller, support } = makeController();

    await expect((controller as any).adminOperators()).resolves.toEqual([
      { id: 'admin-1', name: 'Admin One' },
    ]);
    expect(support.adminOperators).toHaveBeenCalledWith();
  });

  it('forwards actor, ticket id, and the assignment body', async () => {
    const { controller, support } = makeController();
    const body = { assigneeId: 'admin-1', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' };

    await expect((controller as any).adminAssign({ userId: 'owner-1' }, 'ticket-1', body))
      .resolves.toEqual({ id: 'ticket-1', assigned_to: 'admin-1' });
    expect(support.assign).toHaveBeenCalledWith('owner-1', 'ticket-1', body);
  });

  it.each(['adminList', 'adminOperators', 'adminAssign'])('%s requires JWT and admin guards', (method) => {
    const handler = (SupportController.prototype as any)[method];
    expect(typeof handler).toBe('function');
    if (!handler) return;
    const own = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
    const fromClass = Reflect.getMetadata(GUARDS_METADATA, SupportController) ?? [];
    expect([...fromClass, ...own]).toEqual(expect.arrayContaining([JwtGuard, AdminGuard]));
  });
});
