import 'reflect-metadata';
import { ShortsYoutubeController } from './shorts-youtube.controller';

function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.set = jest.fn(() => r);
  r.type = jest.fn(() => r);
  r.send = jest.fn(() => r);
  return r;
}

describe('ShortsYoutubeController', () => {
  it('отдаёт страницу сервиса: статус, html, без кеша', async () => {
    const youtube = { completeConnect: jest.fn(async () => ({ status: 200, html: '<h1>ok</h1>' })) };
    const r = res();
    await new ShortsYoutubeController(youtube as any).callback({ code: 'c', state: 's' }, r);
    expect(youtube.completeConnect).toHaveBeenCalledWith({ code: 'c', state: 's', error: undefined });
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(r.type).toHaveBeenCalledWith('html');
    expect(r.send).toHaveBeenCalledWith('<h1>ok</h1>');
  });

  it('повторённые параметры (массивы) не передаются', async () => {
    const youtube = { completeConnect: jest.fn(async () => ({ status: 400, html: 'x' })) };
    await new ShortsYoutubeController(youtube as any).callback({ code: ['a', 'b'], state: ['s'], error: 'access_denied' }, res());
    expect(youtube.completeConnect).toHaveBeenCalledWith({ code: undefined, state: undefined, error: 'access_denied' });
  });

  it('маршрут — GET shorts/youtube/oauth/callback, без guard', () => {
    expect(Reflect.getMetadata('path', ShortsYoutubeController)).toBe('shorts/youtube');
    expect(Reflect.getMetadata('path', ShortsYoutubeController.prototype.callback)).toBe('oauth/callback');
    expect(Reflect.getMetadata('method', ShortsYoutubeController.prototype.callback)).toBe(0); // RequestMethod.GET
    expect(Reflect.getMetadata('__guards__', ShortsYoutubeController.prototype.callback)).toBeUndefined();
    expect(Reflect.getMetadata('__guards__', ShortsYoutubeController)).toBeUndefined();
  });
});
