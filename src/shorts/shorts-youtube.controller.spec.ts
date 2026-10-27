import 'reflect-metadata';
import { Logger, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import * as fs from 'fs';
import * as path from 'path';
import { ShortsYoutubeController } from './shorts-youtube.controller';
import { CALLBACK_PATH } from './youtube/youtube-oauth';

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
    expect(r.set).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
    expect(r.set).toHaveBeenCalledWith('Content-Security-Policy', expect.stringContaining("default-src 'none'"));
    expect(r.type).toHaveBeenCalledWith('html');
    expect(r.send).toHaveBeenCalledWith('<h1>ok</h1>');
  });

  it('повторённые параметры (массивы) не передаются', async () => {
    const youtube = { completeConnect: jest.fn(async () => ({ status: 400, html: 'x' })) };
    await new ShortsYoutubeController(youtube as any).callback({ code: ['a', 'b'], state: ['s'], error: 'access_denied' }, res());
    expect(youtube.completeConnect).toHaveBeenCalledWith({ code: undefined, state: undefined, error: 'access_denied' });
  });

  it('маршрут — GET shorts/youtube/oauth/callback, без guard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ShortsYoutubeController)).toBe('shorts/youtube');
    expect(Reflect.getMetadata(PATH_METADATA, ShortsYoutubeController.prototype.callback)).toBe('oauth/callback');
    expect(Reflect.getMetadata(METHOD_METADATA, ShortsYoutubeController.prototype.callback)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(GUARDS_METADATA, ShortsYoutubeController.prototype.callback)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, ShortsYoutubeController)).toBeUndefined();
  });

  it('маршрут с глобальным префиксом — ровно CALLBACK_PATH, зарегистрированный в Google', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
    const prefix = main.match(/setGlobalPrefix\('([^']+)'/)[1];
    const controller = Reflect.getMetadata(PATH_METADATA, ShortsYoutubeController);
    const method = Reflect.getMetadata(PATH_METADATA, ShortsYoutubeController.prototype.callback);
    expect(`/${prefix}/${controller}/${method}`).toBe(CALLBACK_PATH);
  });

  it('сервис бросил — страница 500 вместо JSON, заголовки на месте', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const youtube = { completeConnect: jest.fn(async () => { throw new Error('boom'); }) };
    const r = res();
    await new ShortsYoutubeController(youtube as any).callback({ code: 'c', state: 's' }, r);
    expect(r.status).toHaveBeenCalledWith(500);
    expect(r.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(String(r.send.mock.calls[0][0])).toContain('Не получилось подключить канал');
  });
});
