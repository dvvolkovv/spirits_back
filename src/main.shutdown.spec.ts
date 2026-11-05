jest.mock('@nestjs/core', () => ({ NestFactory: { create: jest.fn() } }));
jest.mock('./app.module', () => ({ AppModule: class AppModule {} }));
jest.mock('./voice/voice-ws', () => ({ attachVoiceWs: jest.fn() }));

import { NestFactory } from '@nestjs/core';

describe('backend shutdown hooks', () => {
  it('bootstrap включает Nest shutdown hooks до listen', async () => {
    const app = {
      use: jest.fn(),
      setGlobalPrefix: jest.fn(),
      enableCors: jest.fn(),
      useGlobalPipes: jest.fn(),
      enableShutdownHooks: jest.fn(),
      listen: jest.fn().mockResolvedValue(undefined),
    };
    (NestFactory.create as jest.Mock).mockResolvedValue(app);

    await jest.isolateModulesAsync(async () => { await import('./main'); });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(app.enableShutdownHooks).toHaveBeenCalledTimes(1);
    expect(app.listen).toHaveBeenCalledTimes(1);
    expect(app.enableShutdownHooks.mock.invocationCallOrder[0]).toBeLessThan(
      app.listen.mock.invocationCallOrder[0],
    );
  });
});
