import 'reflect-metadata';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AgentVersionsController } from './agent-versions.controller';

function makeController() {
  const service = {
    getState: jest.fn().mockResolvedValue({ published: null, draft: null }),
    listVersions: jest.fn().mockResolvedValue([]),
    getVersion: jest.fn().mockResolvedValue({ id: 'version-1' }),
    createDraft: jest.fn().mockResolvedValue({ id: 'draft-1' }),
    publish: jest.fn().mockResolvedValue({ id: 'published-1' }),
    testVersion: jest.fn().mockResolvedValue({ text: 'reply' }),
  };
  const controller = new AgentVersionsController(service as any);
  return { controller, service };
}

describe('AgentVersionsController', () => {
  it('is mounted at admin/agents with exactly JwtGuard and AdminGuard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AgentVersionsController)).toBe('admin/agents');
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentVersionsController)).toEqual([
      JwtGuard,
      AdminGuard,
    ]);
  });

  it('returns the current state for the parsed agent id', async () => {
    const { controller, service } = makeController();

    await expect(controller.getState(7)).resolves.toEqual({ published: null, draft: null });
    expect(service.getState).toHaveBeenCalledWith(7);
  });

  it('normalizes the versions limit and defaults it to 50', async () => {
    const { controller, service } = makeController();

    await controller.listVersions(7, '2' as any);
    await controller.listVersions(7, undefined as any);
    await controller.listVersions(7, 'invalid' as any);
    await controller.listVersions(7, '0' as any);

    expect(service.listVersions.mock.calls).toEqual([[7, 2], [7, 50], [7, NaN], [7, 0]]);
  });

  it('returns one version by agent and version ids', async () => {
    const { controller, service } = makeController();

    await expect(controller.getVersion(7, 'version-1')).resolves.toEqual({ id: 'version-1' });
    expect(service.getVersion).toHaveBeenCalledWith(7, 'version-1');
  });

  it('forwards the actor and complete draft body', async () => {
    const { controller, service } = makeController();
    const body = {
      description: 'new description',
      system_prompt: 'new prompt',
      base_version_id: 'version-1',
    };

    await controller.createDraft({ userId: 'admin-1' }, 7, body);

    expect(service.createDraft).toHaveBeenCalledWith('admin-1', 7, body);
  });

  it('forwards the actor and optimistic publication id', async () => {
    const { controller, service } = makeController();

    await controller.publish(
      { userId: 'admin-1' },
      7,
      'draft-1',
      { expected_published_version_id: 'version-1' },
    );

    expect(service.publish).toHaveBeenCalledWith(
      'admin-1',
      7,
      'draft-1',
      'version-1',
    );
  });

  it('forwards every agent test argument from the body', async () => {
    const { controller, service } = makeController();

    await controller.test(
      { userId: 'admin-1' },
      7,
      { version_id: 'draft-1', message: 'hello', session_id: 'session-1' },
    );

    expect(service.testVersion).toHaveBeenCalledWith(
      'admin-1',
      7,
      'draft-1',
      'hello',
      'session-1',
    );
  });
});
