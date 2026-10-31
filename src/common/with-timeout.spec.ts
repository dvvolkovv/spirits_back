import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('отдаёт значение, если успели', async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
  });
  it('бросает по сроку, если висит', async () => {
    await expect(withTimeout(new Promise(() => {}), 20)).rejects.toThrow('timeout after 20ms');
  });
  it('пробрасывает ошибку', async () => {
    await expect(withTimeout(Promise.reject(new Error('нет')), 50)).rejects.toThrow('нет');
  });
});
