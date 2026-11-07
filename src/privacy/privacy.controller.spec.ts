import 'reflect-metadata';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { JwtGuard } from '../common/guards/jwt.guard';
import { PrivacyController } from './privacy.controller';

function makeController() {
  const pg = { query: jest.fn() };
  return { pg, controller: new PrivacyController(pg as any) };
}

async function getRejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the controller call to reject');
}

async function expectHttpError(
  promise: Promise<unknown>,
  type: any,
  status: number,
  code: string,
) {
  const error = await getRejection(promise);
  expect(error).toBeInstanceOf(type);
  expect(error.getStatus()).toBe(status);
  expect(error.getResponse()).toEqual({ code });
}

describe('PrivacyController', () => {
  it('is a dedicated JWT-protected privacy-settings controller', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PrivacyController)).toBe('privacy-settings');
    expect(Reflect.getMetadata(GUARDS_METADATA, PrivacyController)).toContain(JwtGuard);
  });

  it('returns HTTP 200 for successful settings updates', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, PrivacyController.prototype.updateSettings)).toBe(200);
  });

  it.each([
    {},
    { unknown: true },
    { automaticProfiling: 'false' },
    { discoverable: null },
    null,
    [],
  ])('rejects an invalid POST with 400 before any database query: %j', async (body) => {
    const { pg, controller } = makeController();

    await expectHttpError(
      controller.updateSettings({ userId: 'u1' }, body),
      BadRequestException,
      400,
      'INVALID_PRIVACY_SETTINGS',
    );
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('reads only the current user settings and returns them directly', async () => {
    const { pg, controller } = makeController();
    pg.query.mockResolvedValue({
      rows: [{ profile_data: { automaticProfiling: false } }],
    });

    await expect(controller.getSettings({ userId: 'current-user' })).resolves.toEqual({
      automaticProfiling: false,
      discoverable: true,
    });
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE user_id = $1'),
      ['current-user'],
    );
  });

  it('writes only the current user settings and returns them directly', async () => {
    const { pg, controller } = makeController();
    pg.query.mockResolvedValue({
      rows: [{ profile_data: { automaticProfiling: false, discoverable: false } }],
    });

    await expect(controller.updateSettings(
      { userId: 'current-user' },
      { automaticProfiling: false, discoverable: false },
    )).resolves.toEqual({ automaticProfiling: false, discoverable: false });
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(pg.query.mock.calls[0][1]).toEqual(['current-user', false, false]);
  });

  it('maps a missing profile on GET to 404', async () => {
    const { pg, controller } = makeController();
    pg.query.mockResolvedValue({ rows: [] });

    await expectHttpError(
      controller.getSettings({ userId: 'absent' }),
      NotFoundException,
      404,
      'PROFILE_NOT_AVAILABLE',
    );
  });

  it('maps a missing profile on POST to 404', async () => {
    const { pg, controller } = makeController();
    pg.query.mockResolvedValue({ rows: [] });

    await expectHttpError(
      controller.updateSettings({ userId: 'absent' }, { discoverable: false }),
      NotFoundException,
      404,
      'PROFILE_NOT_AVAILABLE',
    );
  });

  it.each(['get', 'post'])('maps own %s infrastructure errors to 503', async (method) => {
    const { pg, controller } = makeController();
    pg.query.mockRejectedValue(new Error('database unavailable'));

    const call = method === 'get'
      ? controller.getSettings({ userId: 'u1' })
      : controller.updateSettings({ userId: 'u1' }, { automaticProfiling: false });
    await expectHttpError(
      call,
      ServiceUnavailableException,
      503,
      'PRIVACY_SETTINGS_UNAVAILABLE',
    );
  });

  it.each(['get', 'post'])('maps malformed stored data on %s to 503', async (method) => {
    const { pg, controller } = makeController();
    pg.query.mockResolvedValue({
      rows: [{ profile_data: { automaticProfiling: 'not-a-boolean' } }],
    });

    const call = method === 'get'
      ? controller.getSettings({ userId: 'u1' })
      : controller.updateSettings({ userId: 'u1' }, { discoverable: false });
    await expectHttpError(
      call,
      ServiceUnavailableException,
      503,
      'PRIVACY_SETTINGS_UNAVAILABLE',
    );
  });
});
