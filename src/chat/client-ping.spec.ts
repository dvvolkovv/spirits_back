import { CLIENT_PING_IDLE_MS, startClientPing } from './client-ping';

describe('startClientPing', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('молчит, пока тишина у клиента короче порога', () => {
    const send = jest.fn();
    const ping = startClientPing(send);
    jest.advanceTimersByTime(CLIENT_PING_IDLE_MS - 1);
    expect(send).not.toHaveBeenCalled();
    ping.stop();
  });

  it('при долгой тишине пингует не реже раза в 25 секунд', () => {
    const send = jest.fn();
    const ping = startClientPing(send);
    jest.advanceTimersByTime(180_000);
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(180_000 / 25_000);
    ping.stop();
  });

  it('строка клиенту отодвигает пинг', () => {
    const send = jest.fn();
    const ping = startClientPing(send);
    for (let t = 0; t < 60_000; t += 10_000) {
      jest.advanceTimersByTime(10_000);
      ping.touch();
    }
    expect(send).not.toHaveBeenCalled();
    ping.stop();
  });

  it('после stop пингов нет', () => {
    const send = jest.fn();
    const ping = startClientPing(send);
    ping.stop();
    jest.advanceTimersByTime(120_000);
    expect(send).not.toHaveBeenCalled();
  });
});
