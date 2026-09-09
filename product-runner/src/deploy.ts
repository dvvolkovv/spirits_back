import { exec } from 'child_process';
import { promisify } from 'util';
import { Git } from './git';

const execAsync = promisify(exec);

export type Shell = (cmd: string) => Promise<void>;
export type FetchFn = typeof fetch;

/**
 * Здоровье определяется телом ответа, а не кодом. На доменах проекта
 * SPA-фолбэк отдаёт 200 с index.html на любой путь, включая несуществующий:
 * проверка по коду будет зелёной на мёртвом сервисе.
 */
export async function checkHealth(
  url: string | null,
  fetchFn: FetchFn = fetch,
  expectedSha?: string | null,
): Promise<boolean> {
  if (!url) return true;
  try {
    const res = await fetchFn(url, { redirect: 'manual' } as any);
    if (res.status < 200 || res.status >= 300) return false;
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/html')) return false;
    const body = await res.text();
    if (/<!doctype html|<html/i.test(body)) return false;
    if (!expectedSha) return true;

    // Сверка того, ЧТО ИМЕННО отвечает. Без неё проверка здоровья доказывает
    // лишь «на порту кто-то живой» — и этого достаточно, чтобы выкат считался
    // удачным, когда новый код не поднялся, а порт держит процесс от прошлой
    // версии.
    //
    // Так и случилось дважды: pm2 в состоянии errored с 93 и 32 перезапусками,
    // EADDRINUSE у новой копии, сайт отдаёт 200 со старого кода, ход помечен
    // «Готово». Сироту оставлял то pm2 через оболочку, то сам агент, запустив
    // сервер руками во время хода.
    //
    // Продукт обязан вычислять sha ОДИН РАЗ при старте процесса. Если читать
    // его на каждый запрос, сирота прочитает свежий файл и подделает ответ —
    // проверка снова станет бессмысленной.
    let reported: unknown;
    try {
      reported = JSON.parse(body)?.sha;
    } catch {
      return false;
    }
    if (typeof reported !== 'string' || !reported) return false;
    return reported.startsWith(expectedSha) || expectedSha.startsWith(reported);
  } catch {
    return false;
  }
}

export interface WaitHealthyOptions {
  timeoutMs?: number;
  probeEveryMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  /** sha, который обязан отдавать поднявшийся продукт. */
  expectedSha?: string | null;
}

/**
 * Ждёт, пока продукт поднимется, вместо одной пробы сразу после рестарта.
 *
 * Замерено на живой VM: сразу после `pm2 restart` порт отвергает соединение,
 * продукт слушает через ~200 мс. Одиночная проба в этот момент всегда красная,
 * то есть автооткат срабатывал бы на КАЖДОМ успешном ходе и ни одна правка
 * клиента не доезжала бы до прода.
 *
 * Красным считается только то, что не поднялось за весь срок: неудачная проба
 * это ещё не отказ, а отказом становится исчерпанное ожидание.
 */
export async function waitHealthy(
  url: string | null,
  fetchFn: FetchFn,
  opts: WaitHealthyOptions = {},
): Promise<boolean> {
  if (!url) return true;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const probeEveryMs = opts.probeEveryMs ?? 500;
  const wait = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const attempts = Math.max(1, Math.ceil(timeoutMs / probeEveryMs));
  for (let i = 0; i < attempts; i++) {
    if (await checkHealth(url, fetchFn, opts.expectedSha)) return true;
    if (i < attempts - 1) await wait(probeEveryMs);
  }
  return false;
}

export interface DeployInput {
  git: Git;
  shaBefore: string;
  buildCmd: string | null;
  restartCmd: string | null;
  healthUrl: string | null;
  cwd?: string;
  shell?: Shell;
  fetchFn?: FetchFn;
  onPhase?: (phase: string) => void;
  /** Сколько всего ждать подъёма после рестарта, прежде чем считать ход красным. */
  healthTimeoutMs?: number;
  /** Как часто пробовать health-check внутри окна ожидания. */
  healthProbeEveryMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  /**
   * sha правки, который обязан отдавать поднявшийся продукт. Отличает
   * «на порту кто-то живой» от «работает именно этот код».
   */
  expectedSha?: string | null;
}

export async function deploy(input: DeployInput): Promise<{ reverted: boolean }> {
  const shell: Shell =
    input.shell ??
    (async (cmd: string) => {
      // exec, а не execFile: build/restart-команды приходят из реестра
      // продуктов строкой вида "npm run build && pm2 restart web", их шелл
      // обязан разобрать. Их задаёт владелец при заведении продукта, а не
      // клиент напрямую — в отличие от сообщения коммита в git.ts.
      await execAsync(cmd, { cwd: input.cwd, maxBuffer: 16 * 1024 * 1024 });
    });
  const fetchFn = input.fetchFn ?? fetch;
  const phase = input.onPhase ?? (() => {});

  const bringUp = async (label: string) => {
    if (input.buildCmd) {
      phase(`${label}: сборка`);
      await shell(input.buildCmd);
    }
    if (input.restartCmd) {
      phase(`${label}: перезапуск`);
      await shell(input.restartCmd);
    }
  };

  let healthy = false;
  try {
    await bringUp('Правка');
    phase('Проверяю здоровье');
    healthy = await waitHealthy(input.healthUrl, fetchFn, {
      timeoutMs: input.healthTimeoutMs,
      probeEveryMs: input.healthProbeEveryMs,
      sleep: input.sleep,
      expectedSha: input.expectedSha,
    });
  } catch (e: any) {
    // Сборка или рестарт не отработали. Без отката коммит агента остаётся в
    // дереве, а запущен старый код: чекаут молча расходится с тем, что
    // работает, и следующий ход стартует с чужой недоделанной правки.
    // sha_after при этом не записывается, значит кнопка отката до этого
    // коммита не дотянется — вернуть можно только руками на VM.
    phase(`Сборка или перезапуск не удались: ${e?.message ?? e}`);
    healthy = false;
  }

  if (healthy) return { reverted: false };

  // Откатить мало — надо ещё поднять откаченное. Иначе продукт останется
  // лежать на старом коде, который не собран и не запущен.
  phase('Возвращаю как было');
  await input.git.resetHard(input.shaBefore);
  // Поднять откаченное надо в любом случае, но если и это не удалось —
  // деваться некуда: продукт останется лежать, и об этом обязан узнать
  // клиент, а не только лог.
  try {
    await bringUp('Откат');
  } catch (e: any) {
    phase(`Откат поднять не удалось: ${e?.message ?? e}`);
  }
  return { reverted: true };
}
