import * as fs from 'fs';
import * as path from 'path';
import { ChatFileStore, copyFailReason } from './chat-file-store';
import { storeRelayLinks } from './relay-links';

describe('copyFailReason', () => {
  it.each([
    ['Access Denied.', 'access_denied'],
    ['ответ больше допустимого (104857600 байт)', 'too_large'],
    ['сервер ответил кодом 404', 'not_found'],
    ['превышено время ожидания (30 с)', 'timeout'],
    ['бюджет хода исчерпан', 'timeout'],
    ['копия не уложилась в свои сроки — место отдано другим', 'timeout'],
    ['соединение оборвалось', 'other'],
  ])('%s → %s', (msg, want) => {
    expect(copyFailReason(new Error(msg))).toBe(want);
  });
});

describe('ChatFileStore.persist: события для статистики', () => {
  const make = () => {
    const events = { track: jest.fn() };
    const store = new ChatFileStore({} as any, events as any);
    jest.spyOn(store, 'persistOne')
      .mockResolvedValueOnce('https://pub/linkeon-chat-files/x/a.pdf')
      .mockRejectedValueOnce(new Error('сервер ответил кодом 404'));
    return { store, events };
  };
  const URLS = ['https://r.linkeon.io/files/k/a.pdf', 'https://r.linkeon.io/files/k/b.pdf'];

  it('с владельцем хода — chat_file_stored и chat_file_copy_failed с причиной', async () => {
    const { store, events } = make();
    await store.persist(URLS, { userId: 'u-1' });
    expect(events.track).toHaveBeenCalledWith('chat_file_stored', { userId: 'u-1' });
    expect(events.track).toHaveBeenCalledWith('chat_file_copy_failed', { userId: 'u-1', props: { reason: 'not_found' } });
  });

  it('без владельца (перенос старых файлов) — событий нет', async () => {
    const { store, events } = make();
    await store.persist(URLS);
    expect(events.track).not.toHaveBeenCalled();
  });
});

describe('владелец хода доходит до persist', () => {
  it('storeRelayLinks передаёт userId вместе с бюджетом', async () => {
    const store = { persist: jest.fn(async () => new Map<string, string>()) };
    await storeRelayLinks(['[Скачать a.pdf](https://r.linkeon.io/files/k/a.pdf)'], 'https://r.linkeon.io', store, () => {}, { budgetMs: 5000, userId: 'u-1' });
    expect(store.persist).toHaveBeenCalledWith(['https://r.linkeon.io/files/k/a.pdf'], { budgetMs: 5000, userId: 'u-1' });
  });

  it('chat.service и ручка загрузки передают userId', () => {
    const svc = fs.readFileSync(path.join(__dirname, '..', 'chat.service.ts'), 'utf8');
    const ctrl = fs.readFileSync(path.join(__dirname, '..', 'chat.controller.ts'), 'utf8');
    expect(svc.match(/this\.storeRelayLinks\([\s\S]{0,160}?userId \}/g) ?? []).toHaveLength(2);
    expect(ctrl).toMatch(/this\.chatService\.storeRelayLinks\([^;]*\{ userId \}\)/);
  });
});
