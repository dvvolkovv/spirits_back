import { readFileSync } from 'fs';
import { join } from 'path';
import { PM2_APP } from './orphans';

const dockerfile = readFileSync(join(__dirname, '..', 'docker', 'Dockerfile'), 'utf8');
const entrypoint = readFileSync(join(__dirname, '..', 'docker', 'entrypoint.sh'), 'utf8');

/** Инструкции стадии целиком: строки с `\` в конце склеены с продолжением. */
function instructions(stage: string): string[] {
  return stage
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

describe('образ продукта', () => {
  it('в итоговой стадии есть ps (procps)', () => {
    // pm2 7 гасит процесс через свой TreeKill, а тот зовёт `ps -e -o pid=,ppid=`.
    // Без ps spawn падает с ENOENT, и обратный вызов срабатывает ДВАЖДЫ — на
    // 'error' и на 'close'. restartProcessId от этого запускает продукт два
    // раза: одна копия занимает порт и выпадает из учёта pm2, вторая крутится
    // в EADDRINUSE до errored. Сняты оба конца: pm2.log demo 23.09.2026 («pid=32
    // msg=process tree killed» дважды на один Stopping) и проба 24.09.2026 —
    // без procps сирота на каждом рестарте живого продукта, с procps ни одной.
    //
    // Проверяется итоговая стадия, а не весь файл: procps в стадии сборки
    // раннера в образ продукта не попадает.
    const stages = dockerfile.split(/^FROM /m);
    const runtime = stages[stages.length - 1];
    const apt = instructions(runtime).filter((i) => /apt-get install/.test(i));

    expect(apt.some((i) => /\bprocps\b/.test(i))).toBe(true);
  });

  it('entrypoint заводит продукт в pm2 под тем именем, которое перезапускает раннер', () => {
    // Раннер сам зовёт `pm2 restart product` при пустом restart_cmd и спрашивает
    // `pm2 pid product`, кто законно держит порт. Разойдись имя — перезапуск
    // упадёт, а законным держателем не окажется никто.
    expect(entrypoint).toMatch(new RegExp(`pm2 start [^\\n]*--name ${PM2_APP}(\\s|$)`, 'm'));
  });
});
