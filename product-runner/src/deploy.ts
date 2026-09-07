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
export async function checkHealth(url: string | null, fetchFn: FetchFn = fetch): Promise<boolean> {
  if (!url) return true;
  try {
    const res = await fetchFn(url, { redirect: 'manual' } as any);
    if (res.status < 200 || res.status >= 300) return false;
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/html')) return false;
    const body = await res.text();
    if (/<!doctype html|<html/i.test(body)) return false;
    return true;
  } catch {
    return false;
  }
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

  await bringUp('Правка');

  phase('Проверяю здоровье');
  if (await checkHealth(input.healthUrl, fetchFn)) {
    return { reverted: false };
  }

  // Откатить мало — надо ещё поднять откаченное. Иначе продукт останется
  // лежать на старом коде, который не собран и не запущен.
  phase('Проверка красная, откатываю');
  await input.git.resetHard(input.shaBefore);
  await bringUp('Откат');
  return { reverted: true };
}
