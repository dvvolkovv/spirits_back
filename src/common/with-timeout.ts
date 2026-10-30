/**
 * Обещание с потолком ожидания. Нужно там, где ждать нельзя: ioredis при
 * недоступном Redis не падает, а висит десятки секунд (23–63 с в замерах).
 *
 * Общая утилита: используется из guest-trial (общие окна гостевых лимитов).
 * В voice-call/ есть две приватные копии того же приёма (specialist-job.
 * service.ts, voice-document.service.ts) — они вне этой задачи, не трогать.
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    // Сторожевой таймер не должен сам по себе держать event loop живым.
    timer.unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
