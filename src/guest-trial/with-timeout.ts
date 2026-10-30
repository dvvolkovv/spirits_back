/**
 * Обещание с потолком ожидания. Нужно там, где ждать нельзя: ioredis при
 * недоступном Redis не падает, а висит десятки секунд (23–63 с в замерах).
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
